import logging
from datetime import datetime, timedelta, time as dt_time
from fastapi import APIRouter, BackgroundTasks, HTTPException, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from typing import Optional

from app.config import settings
from app.services.db import create_lead, update_lead, get_bool_setting, get_setting, get_tenant
from app.services.comms import send_customer_sms, alert_business_owner
from app.services.tenant_manager import TenantManager
from app.services.calendar_service import (
    NY_TZ,
    get_live_calendar_events,
    is_time_window_free,
    book_calendar_appointment,
)
from app.services.vapi_service import trigger_outbound_speed_to_lead_call

router = APIRouter(prefix="/api/leads", tags=["Leads"])
calendar_router = APIRouter(prefix="/api/calendar", tags=["Calendar"])
logger = logging.getLogger(__name__)

CURATED_WINDOWS = [
    ("09:00", dt_time(9, 0), "9:00 AM", "Morning"),
    ("11:30", dt_time(11, 30), "11:30 AM", "Midday"),
    ("14:00", dt_time(14, 0), "2:00 PM", "Afternoon"),
    ("16:30", dt_time(16, 30), "4:30 PM", "Late Day"),
]


class WebFormLead(BaseModel):
    first_name: str = Field(..., description="Lead first name")
    last_name: Optional[str] = Field("", description="Lead last name")
    phone: Optional[str] = Field("", description="Phone number in standard or E.164 format")
    email: Optional[str] = Field("", description="Email address")
    contact_preference: Optional[str] = Field("calendar_flow", description="calendar_flow | email | phone")
    service: str = Field(default="Roof Replacement", description="Type of roofing service requested")
    address: Optional[str] = Field("", description="Street address or town")
    city: Optional[str] = Field("", description="Town or city in Ocean/Monmouth County")
    zip_code: Optional[str] = Field("", description="Postal code")
    urgency: Optional[str] = Field("Standard", description="Low, Standard, High, or Emergency")
    diagnostic_situation: Optional[str] = Field("", description="Quiz step 1 situation")
    home_architecture: Optional[str] = Field("", description="Quiz step 2 architecture")
    notes: Optional[str] = Field("", description="Additional details from homeowner")
    consent_given: bool = Field(True, description="TCPA and A2P opt-in consent confirmation")


class CalendarBookRequest(BaseModel):
    lead_id: Optional[str] = Field("", description="Existing lead ID from Step 3")
    date: str = Field(..., description="Target YYYY-MM-DD date")
    time: str = Field(..., description="Window label e.g. 9:00 AM")
    display_day: Optional[str] = Field("", description="Human readable date label")
    name: Optional[str] = Field("Homeowner", description="Customer name")
    phone: Optional[str] = Field("", description="Customer phone")
    email: Optional[str] = Field("", description="Customer email")
    address: Optional[str] = Field("", description="Street address")
    city: Optional[str] = Field("Toms River", description="City or town")
    service: Optional[str] = Field("21-Point Roof & Attic Inspection", description="Service requested")


def _compute_emergency_summary(tenant_id: str, company_name: str, fallback_phone: str) -> dict:
    import json as _json
    raw = get_setting(f"tenant_emergency_{tenant_id}", "{}")
    try:
        cfg = _json.loads(raw) if raw else {}
    except Exception:
        cfg = {}
    if not isinstance(cfg, dict):
        cfg = {}

    enabled = bool(cfg.get("emergency_enabled", False))
    mode = "live_transfer" if cfg.get("emergency_mode") == "live_transfer" else "sms_callback"
    hours = cfg.get("emergency_hours") or "24_7"
    now_ny = datetime.now(NY_TZ)
    within_hours = enabled and (hours != "extended_7am_9pm" or (7 <= now_ny.hour < 21))

    is_overflow = False
    resolved_company = company_name
    if not within_hours:
        pol_raw = get_setting("emergency_dispatch_policy", "{}")
        try:
            pol = _json.loads(pol_raw) if pol_raw else {}
        except Exception:
            pol = {}
        ov_id = str(pol.get("overflow_tenant_id") or "").strip()
        if ov_id and ov_id != tenant_id:
            ov_raw = get_setting(f"tenant_emergency_{ov_id}", "{}")
            try:
                ov_cfg = _json.loads(ov_raw) if ov_raw else {}
            except Exception:
                ov_cfg = {}
            ov_hours = ov_cfg.get("emergency_hours") or "24_7"
            if ov_cfg.get("emergency_enabled") and (ov_hours != "extended_7am_9pm" or (7 <= now_ny.hour < 21)):
                within_hours = True
                is_overflow = True
                mode = "live_transfer" if ov_cfg.get("emergency_mode") == "live_transfer" else "sms_callback"
                cfg = ov_cfg
                ov_rec = get_tenant(ov_id)
                if ov_rec:
                    resolved_company = ov_rec.get("company_name", resolved_company)

    return {
        "available_now": within_hours,
        "is_overflow": is_overflow,
        "mode": mode if within_hours else "morning_priority",
        "after_hours_quiet": bool(enabled and not within_hours),
        "dispatch_company": resolved_company,
        "tarping_fee_note": cfg.get("tarping_fee_note") or (
            "Free daytime emergency inspection; after-hours tarping quote provided upfront before any work begins."
        ),
    }


@router.post("/webform")
async def submit_webform(lead: WebFormLead, background_tasks: BackgroundTasks):
    """
    Unified Inbound Web Form Handler:
    1. Validates phone (or valid email when contact_preference='email') and generates Lead ID.
    2. Writes record immediately to Unified Supabase CRM (`leads` table).
    3. Fires instant SMS confirmation to the homeowner (when phone is supplied).
    4. Sends notification to the business owner/on-call dispatcher.
    5. (If enabled) Triggers Vapi outbound AI callback within 30 seconds for speed-to-lead.
    """
    import re as _re
    raw_phone = (lead.phone or "").strip()
    clean_email = (lead.email or "").strip()
    is_email_valid = bool(_re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", clean_email))
    is_email_mode = (lead.contact_preference == "email") and is_email_valid

    if not is_email_valid:
        raise HTTPException(status_code=400, detail="Valid email address is required.")

    if not raw_phone and not is_email_mode:
        raise HTTPException(status_code=400, detail="Phone number is required.")

    full_name_parts = (lead.first_name or "Homeowner").strip().split(" ", 1)
    first_name = full_name_parts[0]
    last_name = lead.last_name or (full_name_parts[1] if len(full_name_parts) > 1 else "")
    is_emergency = (
        lead.urgency == "Emergency"
        or lead.diagnostic_situation == "Active Water Leak"
        or ("emergency" in (lead.service or "").lower())
        or ("active water leak" in (lead.service or "").lower())
    )

    lead_id = f"WEB-{int(datetime.now().timestamp() * 1000) % 100000000}"
    lead_dict = {
        "id": lead_id,
        "lead_source": "Website Email Inquiry" if is_email_mode else "Website Form",
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "first_name": first_name,
        "last_name": last_name,
        "phone": raw_phone or "Email Inquiry",
        "email": clean_email,
        "street_address": lead.address or "",
        "city": lead.city or "",
        "zip_code": lead.zip_code or "",
        "service_requested": lead.service,
        "urgency": "Emergency" if is_emergency else (lead.urgency or "Standard"),
        "diagnostic_situation": lead.diagnostic_situation or "",
        "home_architecture": lead.home_architecture or "",
        "status": "Emergency Priority" if is_emergency else "New Lead",
        "notes": lead.notes or "",
    }

    # 1. Write synchronously to Unified Supabase + Local SQLite Mirror so lead is immediately visible
    saved_lead = create_lead(lead_dict)

    active_tenant = TenantManager.get_active_tenant()
    booking_url = active_tenant.booking_url if (active_tenant.scheduling_type == "external_link" and active_tenant.booking_url) else None

    # 2. Background task: Send instant SMS confirmation to customer when phone number is present
    if raw_phone:
        background_tasks.add_task(send_customer_sms, raw_phone, first_name, lead.service, booking_url=booking_url)

    # 3. Background task: Send alert to business owner / active contractor
    background_tasks.add_task(alert_business_owner, saved_lead)

    # 4. Background task: (Optional) 30-sec instant AI Voice callback
    vapi_callback_enabled = bool(raw_phone) and settings.ENABLE_OUTBOUND_CALLBACK and get_bool_setting("enable_vapi_callback", True)
    if vapi_callback_enabled:
        background_tasks.add_task(
            trigger_outbound_speed_to_lead_call,
            customer_phone=saved_lead["phone"],
            customer_name=first_name,
            service_requested=lead.service,
            address=lead.address or settings.PRIMARY_CITY,
        )

    return {
        "status": "success",
        "message": "Lead received successfully. Estimator dispatch initiated.",
        "lead_id": saved_lead["id"],
        "scheduling_type": active_tenant.scheduling_type,
        "booking_url": booking_url,
        "emergency_dispatch": _compute_emergency_summary(
            active_tenant.tenant_id, active_tenant.company_name, active_tenant.dispatch_phone
        ) if is_emergency else None,
        "outbound_callback_queued": vapi_callback_enabled,
    }


@calendar_router.get("/availability")
async def get_calendar_availability(
    city: str = Query("", description="Town/city for tenant lookup"),
    urgent: bool = Query(False, description="Include today urgent slots when true"),
    days: int = Query(6, ge=1, le=10, description="Number of open days to return"),
):
    import json as _json
    tenant = TenantManager.get_active_tenant()
    emerg_summary = _compute_emergency_summary(tenant.tenant_id, tenant.company_name, tenant.dispatch_phone)
    if tenant.scheduling_type == "external_link" and tenant.booking_url:
        return {
            "status": "success",
            "scheduling_type": "external_link",
            "booking_url": tenant.booking_url,
            "company_name": tenant.company_name,
            "emergency_dispatch": emerg_summary,
            "days": [],
        }

    sched_raw = get_setting(f"tenant_schedule_{tenant.tenant_id}", "{}")
    try:
        sched_extras = _json.loads(sched_raw) if sched_raw else {}
    except Exception:
        sched_extras = {}
    avail_rules = sched_extras.get("availability") or {}
    allowed_days = avail_rules.get("days_of_week") or ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
    allowed_win_labels = avail_rules.get("windows") or [w[2] for w in CURATED_WINDOWS]
    blackout_dates = set(avail_rules.get("blackout_dates") or [])
    min_notice = avail_rules.get("min_notice") or "next_day"

    now_ny = datetime.now(NY_TZ)
    start_offset = 0 if (urgent or min_notice == "same_day_2h") else (2 if min_notice == "48h" else 1)
    out_days = []
    offset = start_offset

    while len(out_days) < days and offset <= start_offset + days + 7:
        target_dt = (now_ny + timedelta(days=offset)).date()
        offset += 1
        iso_date = target_dt.strftime("%Y-%m-%d")
        weekday_short = target_dt.strftime("%a")
        if weekday_short not in allowed_days or iso_date in blackout_dates:
            continue

        events = get_live_calendar_events(iso_date)
        open_slots = []
        for slot_id, t_val, label, tag in CURATED_WINDOWS:
            if label not in allowed_win_labels:
                continue
            slot_start = datetime.combine(target_dt, t_val, tzinfo=NY_TZ)
            slot_end = slot_start + timedelta(minutes=60)
            if slot_start < now_ny + timedelta(minutes=90):
                continue
            if is_time_window_free(slot_start, slot_end, events):
                open_slots.append({
                    "id": slot_id,
                    "time": label,
                    "tag": tag,
                    "start_iso": slot_start.isoformat(),
                })

        if open_slots:
            rel = "Today" if target_dt == now_ny.date() else ("Tomorrow" if target_dt == (now_ny + timedelta(days=1)).date() else weekday_short)
            out_days.append({
                "date": iso_date,
                "relative_label": rel,
                "display_label": target_dt.strftime("%a, %b %d").replace(" 0", " "),
                "slots": open_slots,
            })

    return {
        "status": "success",
        "scheduling_type": "google_calendar",
        "company_name": tenant.company_name,
        "calendar_id": tenant.google_calendar_id or settings.GOOGLE_CALENDAR_ID,
        "live_calendar_checked": True,
        "emergency_dispatch": emerg_summary,
        "days": out_days,
    }


@calendar_router.post("/book")
async def book_calendar_slot(payload: CalendarBookRequest):
    import re as _re
    clean_email = (payload.email or "").strip()
    if not _re.match(r"^[^\s@]+@[^\s@]+\.[^\s@]+$", clean_email):
        raise HTTPException(status_code=400, detail="Valid email address is required.")

    result = book_calendar_appointment(
        customer_name=payload.name or "Homeowner",
        phone=payload.phone or "",
        address=payload.address or f"{payload.city}, NJ",
        service=payload.service or "21-Point Roof & Attic Inspection",
        date_str=payload.date,
        time_str=payload.time,
        customer_email=clean_email,
    )

    if result.get("status") == "conflict":
        return JSONResponse(status_code=409, content={"status": "conflict", "message": result.get("message")})

    appointment_slot = f"{payload.date} {payload.time}".strip()
    if payload.lead_id:
        update_lead(payload.lead_id, {
            "appointment_slot": appointment_slot,
            "status": "Inspection Booked",
        })

    return {
        "status": "success",
        "lead_id": payload.lead_id,
        "appointment_slot": appointment_slot,
        "display_day": payload.display_day or payload.date,
        "time": payload.time,
        "event_id": result.get("event_id"),
    }


@calendar_router.post("/webhook")
async def external_calendar_webhook(request: Request):
    """Receives Calendly / Cal.com / HubSpot / inline postMessage booking syncs and updates lead status."""
    body = await request.json()
    lead_id = ""
    start_iso = ""
    provider = body.get("provider") or "external_scheduler"

    if body.get("event") == "invitee.created" and isinstance(body.get("payload"), dict):
        provider = "calendly"
        p = body["payload"]
        start_iso = (p.get("scheduled_event") or {}).get("start_time") or ""
        lead_id = (p.get("tracking") or {}).get("utm_content") or ""
    elif body.get("triggerEvent") == "BOOKING_CREATED" and isinstance(body.get("payload"), dict):
        provider = "cal.com"
        p = body["payload"]
        start_iso = p.get("startTime") or ""
        lead_id = (p.get("metadata") or {}).get("lead_id") or ""
    else:
        lead_id = body.get("lead_id") or ""
        start_iso = body.get("start_time") or body.get("startTime") or ""

    slot_text = start_iso or f"Confirmed via {provider}"
    if lead_id:
        update_lead(lead_id, {
            "status": "Inspection Booked",
            "appointment_slot": slot_text,
        })

    return {
        "status": "success",
        "provider": provider,
        "lead_id": lead_id or None,
        "appointment_slot": slot_text,
    }
