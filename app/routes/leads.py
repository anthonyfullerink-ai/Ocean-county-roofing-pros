import logging
from datetime import datetime
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from app.config import settings
from app.services.db import create_lead, get_bool_setting
from app.services.comms import send_customer_sms, alert_business_owner
from app.services.tenant_manager import TenantManager
from app.services.vapi_service import trigger_outbound_speed_to_lead_call

router = APIRouter(prefix="/api/leads", tags=["Leads"])
logger = logging.getLogger(__name__)


class WebFormLead(BaseModel):
    first_name: str = Field(..., description="Lead first name")
    last_name: Optional[str] = Field("", description="Lead last name")
    phone: str = Field(..., description="Phone number in standard or E.164 format")
    email: Optional[str] = Field("", description="Email address")
    service: str = Field(default="Roof Replacement", description="Type of roofing service requested")
    address: Optional[str] = Field("", description="Street address or town")
    city: Optional[str] = Field("", description="Town or city in Ocean/Monmouth County")
    zip_code: Optional[str] = Field("", description="Postal code")
    urgency: Optional[str] = Field("Standard", description="Low, Standard, High, or Emergency")
    diagnostic_situation: Optional[str] = Field("", description="Quiz step 1 situation")
    home_architecture: Optional[str] = Field("", description="Quiz step 2 architecture")
    notes: Optional[str] = Field("", description="Additional details from homeowner")
    consent_given: bool = Field(True, description="TCPA and A2P opt-in consent confirmation")


@router.post("/webform")
async def submit_webform(lead: WebFormLead, background_tasks: BackgroundTasks):
    """
    Unified Inbound Web Form Handler:
    1. Validates and generates Lead ID.
    2. Writes record immediately to Unified Supabase CRM (`leads` table).
    3. Fires instant SMS confirmation to the homeowner (with A2P compliance).
    4. Sends SMS notification to the business owner/on-call dispatcher.
    5. (If enabled) Triggers Vapi outbound AI callback within 30 seconds for speed-to-lead.
    """
    if not lead.phone or not lead.phone.strip():
        raise HTTPException(status_code=400, detail="Phone number is required.")

    full_name_parts = (lead.first_name or "Homeowner").strip().split(" ", 1)
    first_name = full_name_parts[0]
    last_name = lead.last_name or (full_name_parts[1] if len(full_name_parts) > 1 else "")

    lead_id = f"WEB-{int(datetime.now().timestamp() * 1000) % 100000000}"
    lead_dict = {
        "id": lead_id,
        "lead_source": "Website Form",
        "created_at": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "first_name": first_name,
        "last_name": last_name,
        "phone": lead.phone,
        "email": lead.email or "",
        "street_address": lead.address or "",
        "city": lead.city or "",
        "zip_code": lead.zip_code or "",
        "service_requested": lead.service,
        "urgency": lead.urgency or "Standard",
        "diagnostic_situation": lead.diagnostic_situation or "",
        "home_architecture": lead.home_architecture or "",
        "status": "New Lead",
        "notes": lead.notes or "",
    }

    # 1. Write synchronously to Unified Supabase + Local SQLite Mirror so lead is immediately visible
    saved_lead = create_lead(lead_dict)

    active_tenant = TenantManager.get_active_tenant()
    booking_url = active_tenant.booking_url if (active_tenant.scheduling_type == "external_link" and active_tenant.booking_url) else None

    # 2. Background task: Send instant SMS confirmation to customer (with booking_url if third-party calendar)
    background_tasks.add_task(send_customer_sms, lead.phone, first_name, lead.service, booking_url=booking_url)

    # 3. Background task: Send alert to business owner / active contractor
    background_tasks.add_task(alert_business_owner, saved_lead)

    # 4. Background task: (Optional) 30-sec instant AI Voice callback
    vapi_callback_enabled = settings.ENABLE_OUTBOUND_CALLBACK and get_bool_setting("enable_vapi_callback", True)
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
        "outbound_callback_queued": vapi_callback_enabled,
    }
