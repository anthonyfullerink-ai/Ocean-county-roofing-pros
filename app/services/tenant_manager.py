import os
import yaml
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

from app.services.db import (
    list_tenants as db_list_tenants,
    get_active_tenant_record,
    switch_active_tenant_db,
    get_tenant as db_get_tenant,
)

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
TENANTS_DIR = PROJECT_ROOT / "config" / "tenants"
ACTIVE_TENANT_FILE = PROJECT_ROOT / "config" / "active_tenant.yaml"


class TenantConfig(BaseModel):
    tenant_id: str
    company_name: str
    contact_person: str = "Dispatcher"
    assigned_estimator: str = "Hannah"
    dispatch_phone: str = "+17326609121"
    notification_email: str = "dispatch@example.com"
    portal_pin: str = "732100"
    scheduling_type: str = "google_calendar"  # "google_calendar" or "external_link"
    booking_url: Optional[str] = ""            # e.g. "https://calendly.com/joe-the-roofer/inspection"
    google_calendar_id: str = "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com"
    service_license: str = "Fully Licensed & Insured NJ HIC"
    billing_type: str = "flat_monthly_retainer"
    monthly_rate: float = 1500.00
    lead_fee: float = 0.00
    status: str = "active"
    notes: Optional[str] = ""


def _record_to_tenant_config(rec: Dict[str, Any]) -> TenantConfig:
    return TenantConfig(
        tenant_id=rec.get("tenant_id", "client_joe_the_roofer"),
        company_name=rec.get("company_name", "Joe The Roofer LLC"),
        contact_person=rec.get("contact_name") or rec.get("contact_person") or "Joe",
        assigned_estimator=rec.get("estimator_name") or rec.get("assigned_estimator") or "Hannah",
        dispatch_phone=rec.get("dispatch_phone") or "+17326609121",
        notification_email=rec.get("email") or rec.get("notification_email") or "powurnj@gmail.com",
        portal_pin=str(rec.get("portal_pin") or "732100"),
        scheduling_type=rec.get("scheduling_type") or "google_calendar",
        booking_url=rec.get("booking_url") or "",
        google_calendar_id=rec.get("calendar_id") or rec.get("google_calendar_id") or "primary",
        service_license=rec.get("service_license") or "Fully Licensed & Insured NJ HIC",
        monthly_rate=float(rec.get("monthly_retainer") or rec.get("monthly_rate") or 1500.00),
        status="active" if rec.get("is_active") else "standby",
        notes=rec.get("notes") or "",
    )


class TenantManager:
    """
    Central Multi-Tenant Switching Engine for Rank-and-Rent Assets:
    Synchronizes active contractor state across Supabase/SQLite and YAML configs.
    """
    _cached_tenant: Optional[TenantConfig] = None
    _cached_id: Optional[str] = None

    @classmethod
    def get_active_tenant_id(cls) -> str:
        env_tenant = os.environ.get("ACTIVE_TENANT_ID")
        if env_tenant and env_tenant.strip():
            return env_tenant.strip()
        rec = get_active_tenant_record()
        if rec and rec.get("tenant_id"):
            return rec["tenant_id"]
        if ACTIVE_TENANT_FILE.exists():
            try:
                with open(ACTIVE_TENANT_FILE, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                    return data.get("active_tenant_id", "client_joe_the_roofer")
            except Exception as e:
                logger.error(f"Error reading active tenant pointer: {e}")
        return "client_joe_the_roofer"

    @classmethod
    def get_active_tenant(cls) -> TenantConfig:
        rec = get_active_tenant_record()
        if rec:
            cfg = _record_to_tenant_config(rec)
            cls._cached_tenant = cfg
            cls._cached_id = cfg.tenant_id
            return cfg
        return TenantConfig(
            tenant_id="client_joe_the_roofer",
            company_name="Joe The Roofer LLC",
            contact_person="Joe",
            assigned_estimator="Hannah",
            dispatch_phone="+17326609121",
            notification_email="powurnj@gmail.com",
            google_calendar_id="7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com",
        )

    @classmethod
    def list_all_tenants(cls) -> List[TenantConfig]:
        db_rows = db_list_tenants()
        if db_rows:
            return [_record_to_tenant_config(r) for r in db_rows]
        tenants = []
        if TENANTS_DIR.exists():
            for f in sorted(TENANTS_DIR.glob("*.yaml")):
                try:
                    with open(f, "r", encoding="utf-8") as tf:
                        data = yaml.safe_load(tf) or {}
                        tenants.append(TenantConfig(**data))
                except Exception as e:
                    logger.error(f"Failed loading tenant from {f}: {e}")
        return tenants

    @classmethod
    def switch_tenant(cls, new_tenant_id: str, switched_by: str = "admin") -> bool:
        ok = switch_active_tenant_db(new_tenant_id)
        if not ok:
            target_file = TENANTS_DIR / f"{new_tenant_id}.yaml"
            if not target_file.exists():
                logger.error(f"Cannot switch to tenant '{new_tenant_id}': not found in DB or YAML.")
                return False

        target_cal = "primary"
        rec = db_get_tenant(new_tenant_id)
        if rec and (rec.get("calendar_id") or rec.get("google_calendar_id")):
            target_cal = rec.get("calendar_id") or rec.get("google_calendar_id")
        else:
            target_file = TENANTS_DIR / f"{new_tenant_id}.yaml"
            if target_file.exists():
                try:
                    with open(target_file, "r", encoding="utf-8") as tf:
                        tdata = yaml.safe_load(tf) or {}
                        target_cal = tdata.get("google_calendar_id", "primary")
                except Exception:
                    pass

        payload = {
            "active_tenant_id": new_tenant_id,
            "google_calendar_id": target_cal,
            "last_switched_at": datetime.now().isoformat(),
            "switched_by": switched_by,
        }
        try:
            ACTIVE_TENANT_FILE.parent.mkdir(parents=True, exist_ok=True)
            with open(ACTIVE_TENANT_FILE, "w", encoding="utf-8") as f:
                yaml.dump(payload, f, default_flow_style=False)
        except Exception as e:
            logger.warning(f"Could not write active_tenant.yaml (non-fatal): {e}")

        cls._cached_tenant = None
        cls._cached_id = None
        logger.info(f"Successfully switched active tenant to: {new_tenant_id}")
        return True
