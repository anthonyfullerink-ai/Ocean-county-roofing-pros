import io
import csv
import json
import logging
from datetime import datetime
from typing import Dict, Any, List, Optional, Tuple

from app.config import settings, get_output_path
from app.services.db import (
    list_leads,
    get_lead,
    create_lead,
    update_lead,
    normalize_phone,
)

logger = logging.getLogger(__name__)

UNIVERSAL_COLUMNS = [
    "id",
    "created_at",
    "updated_at",
    "lead_source",
    "first_name",
    "last_name",
    "phone",
    "email",
    "street_address",
    "city",
    "state",
    "zip_code",
    "service_requested",
    "urgency",
    "diagnostic_situation",
    "home_architecture",
    "appointment_slot",
    "status",
    "estimated_value",
    "assigned_tenant_id",
    "notes",
    "call_recording_url",
    "call_transcript",
    "call_duration_sec",
    "review_request_sent",
]

GHL_COLUMNS = [
    "First Name",
    "Last Name",
    "Phone",
    "Email",
    "Address1",
    "City",
    "State",
    "Postal Code",
    "Tags",
    "Pipeline Stage",
    "Lead Value",
    "Source",
    "Notes",
]

JOBNIMBUS_COLUMNS = [
    "Display Name",
    "First Name",
    "Last Name",
    "Mobile Phone",
    "Email",
    "Address Line 1",
    "City",
    "State",
    "Zip",
    "Status Name",
    "Estimated Value",
    "Description",
    "Lead Source",
]

HUBSPOT_COLUMNS = [
    "First Name",
    "Last Name",
    "Phone Number",
    "Email",
    "Street Address",
    "City",
    "State/Region",
    "Postal Code",
    "Deal Name",
    "Deal Stage",
    "Amount",
    "Lead Status",
    "Notes",
]


def export_leads(
    export_format: str = "universal_csv",
    tenant_id: Optional[str] = None,
    status: Optional[str] = None,
) -> Tuple[str, str, str]:
    """
    Exports CRM leads in the requested universal or platform-specific preset.
    Returns (content_string, media_type, download_filename).
    """
    fmt = (export_format or "universal_csv").strip().lower()
    leads = list_leads(status=status, tenant_id=tenant_id)
    date_tag = datetime.now().strftime("%Y%m%d")

    if fmt in ("universal_json", "json"):
        payload = {
            "exported_at": datetime.now().isoformat(),
            "business_name": settings.BUSINESS_NAME,
            "format": "universal_json",
            "total_records": len(leads),
            "leads": leads,
        }
        content = json.dumps(payload, indent=2)
        filename = f"ocean_county_roofing_leads_{date_tag}.json"
        _save_export_copy(filename, content)
        return content, "application/json", filename

    output = io.StringIO()
    writer = csv.writer(output, lineterminator="\n")

    if fmt in ("gohighlevel_csv", "ghl", "gohighlevel"):
        writer.writerow(GHL_COLUMNS)
        for l in leads:
            tags = f"OceanCountyRoofing,{l.get('service_requested', '')},{l.get('urgency', 'Standard')}".strip(",")
            writer.writerow([
                l.get("first_name", ""),
                l.get("last_name", ""),
                l.get("phone", ""),
                l.get("email", ""),
                l.get("street_address", ""),
                l.get("city", ""),
                l.get("state", "NJ"),
                l.get("zip_code", ""),
                tags,
                l.get("status", "New Lead"),
                f"{float(l.get('estimated_value') or 0):.2f}",
                l.get("lead_source", "Website Form"),
                l.get("notes", ""),
            ])
        filename = f"ghl_contacts_opportunities_{date_tag}.csv"

    elif fmt in ("jobnimbus_csv", "jobnimbus"):
        writer.writerow(JOBNIMBUS_COLUMNS)
        for l in leads:
            display_name = f"{l.get('first_name', '')} {l.get('last_name', '')}".strip() or "Homeowner"
            writer.writerow([
                display_name,
                l.get("first_name", ""),
                l.get("last_name", ""),
                l.get("phone", ""),
                l.get("email", ""),
                l.get("street_address", ""),
                l.get("city", ""),
                l.get("state", "NJ"),
                l.get("zip_code", ""),
                l.get("status", "New Lead"),
                f"{float(l.get('estimated_value') or 0):.2f}",
                f"[{l.get('service_requested', '')}] {l.get('notes', '')}".strip(),
                l.get("lead_source", "Website Form"),
            ])
        filename = f"jobnimbus_contacts_jobs_{date_tag}.csv"

    elif fmt in ("hubspot_csv", "hubspot"):
        writer.writerow(HUBSPOT_COLUMNS)
        for l in leads:
            deal_name = f"{l.get('first_name', '')} {l.get('last_name', '')} - {l.get('city', 'NJ')} ({l.get('service_requested', 'Roof')})".strip()
            writer.writerow([
                l.get("first_name", ""),
                l.get("last_name", ""),
                l.get("phone", ""),
                l.get("email", ""),
                l.get("street_address", ""),
                l.get("city", ""),
                l.get("state", "NJ"),
                l.get("zip_code", ""),
                deal_name,
                l.get("status", "New Lead"),
                f"{float(l.get('estimated_value') or 0):.2f}",
                l.get("urgency", "Standard"),
                l.get("notes", ""),
            ])
        filename = f"hubspot_crm_deals_{date_tag}.csv"

    else:
        # Default: universal_csv
        writer.writerow(UNIVERSAL_COLUMNS)
        for l in leads:
            writer.writerow([l.get(col, "") for col in UNIVERSAL_COLUMNS])
        filename = f"universal_crm_leads_{date_tag}.csv"

    content = output.getvalue()
    _save_export_copy(filename, content)
    return content, "text/csv", filename


def _save_export_copy(filename: str, content: str) -> None:
    try:
        out_path = get_output_path("leads", filename)
        with open(out_path, "w", encoding="utf-8", newline="") as f:
            f.write(content)
    except Exception as e:
        logger.warning(f"Could not write backup export to OUTPUT_DIR: {e}")


def _map_external_row_to_lead(raw_row: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """
    Maps any external CRM row (Universal, GoHighLevel, JobNimbus, HubSpot, or custom CSV/JSON)
    into the unified Supabase `leads` schema.
    """
    norm_row: Dict[str, Any] = {}
    for k, v in raw_row.items():
        if k is not None:
            norm_key = str(k).strip().lower().replace("-", "_").replace(" ", "_").replace("/", "_")
            norm_row[norm_key] = v

    def pick(*keys: str, default: Any = "") -> Any:
        for k in keys:
            val = norm_row.get(k)
            if val is not None and str(val).strip() != "":
                return str(val).strip()
        return default

    phone = pick("phone", "mobile_phone", "phone_number", "mobile", "tel", "primary_phone", "contact_phone")
    if not phone:
        return None

    first_name = pick("first_name", "fname", "firstname", "given_name")
    last_name = pick("last_name", "lname", "lastname", "family_name", "surname")
    display_name = pick("display_name", "full_name", "name", "customer_name", "contact_name")

    if not first_name and display_name:
        parts = display_name.split(" ", 1)
        first_name = parts[0]
        if not last_name and len(parts) > 1:
            last_name = parts[1]

    lead_id = pick("id", "lead_id", "contact_id", "record_id")
    email = pick("email", "email_address", "customer_email")
    street_address = pick("street_address", "address1", "address_line_1", "address")
    city = pick("city", "town", "locality", default=settings.PRIMARY_CITY)
    state = pick("state", "state_region", "province", default=settings.PRIMARY_STATE)
    zip_code = pick("zip_code", "postal_code", "zip", default="08753")
    status = pick("status", "pipeline_stage", "status_name", "deal_stage", "lead_status", default="New Lead")
    est_val = pick("estimated_value", "lead_value", "amount", "deal_value", "value")
    service = pick("service_requested", "service", "service_type", "deal_name", "tags", default="Full Roof Replacement")
    notes = pick("notes", "description", "ai_summary", "comments")
    source = pick("lead_source", "source", default="CRM Import")
    urgency = pick("urgency", default="Standard")
    tenant_id = pick("assigned_tenant_id", "tenant_id")

    mapped: Dict[str, Any] = {
        "first_name": first_name or "Homeowner",
        "last_name": last_name,
        "phone": phone,
        "email": email,
        "street_address": street_address,
        "city": city,
        "state": state,
        "zip_code": zip_code,
        "status": status,
        "service_requested": service,
        "notes": notes,
        "lead_source": source,
        "urgency": urgency,
    }
    if lead_id:
        mapped["id"] = lead_id
    if est_val:
        mapped["estimated_value"] = est_val
    if tenant_id:
        mapped["assigned_tenant_id"] = tenant_id
    return mapped


def import_leads_payload(raw_content: str, filename: str = "import.csv") -> Dict[str, Any]:
    """
    Universal CRM Import Engine:
    Accepts CSV or JSON string content, auto-detects schema & column aliases,
    and upserts records into the unified Supabase/SQLite database.
    """
    text = (raw_content or "").strip()
    if not text:
        return {"status": "error", "message": "Empty import payload", "imported_count": 0, "updated_count": 0, "skipped_count": 0}

    rows: List[Dict[str, Any]] = []
    is_json = filename.lower().endswith(".json") or text.startswith("{") or text.startswith("[")

    if is_json:
        try:
            parsed = json.loads(text)
            if isinstance(parsed, list):
                rows = [r for r in parsed if isinstance(r, dict)]
            elif isinstance(parsed, dict):
                if isinstance(parsed.get("leads"), list):
                    rows = [r for r in parsed["leads"] if isinstance(r, dict)]
                elif isinstance(parsed.get("data"), list):
                    rows = [r for r in parsed["data"] if isinstance(r, dict)]
                else:
                    rows = [parsed]
        except Exception as e:
            logger.error(f"JSON import parse error: {e}")
            return {"status": "error", "message": f"Invalid JSON format: {e}", "imported_count": 0, "updated_count": 0, "skipped_count": 0}
    else:
        reader = csv.DictReader(io.StringIO(text))
        rows = [dict(r) for r in reader]

    imported_count = 0
    updated_count = 0
    skipped_count = 0
    saved_leads = []

    for raw_row in rows:
        mapped = _map_external_row_to_lead(raw_row)
        if not mapped:
            skipped_count += 1
            continue

        lookup_key = mapped.get("id") or normalize_phone(mapped.get("phone", ""))
        existing = get_lead(lookup_key) if lookup_key else None

        if existing:
            mapped["id"] = existing["id"]
            saved = update_lead(existing["id"], mapped)
            updated_count += 1
        else:
            saved = create_lead(mapped)
            imported_count += 1

        if saved:
            saved_leads.append(saved)

    return {
        "status": "success",
        "imported_count": imported_count,
        "updated_count": updated_count,
        "skipped_count": skipped_count,
        "total_processed": imported_count + updated_count,
        "leads": saved_leads,
    }
