import logging
from datetime import datetime
from fastapi import APIRouter, BackgroundTasks, HTTPException
from pydantic import BaseModel, Field
from typing import Optional

from app.config import settings
from app.services.sheets import append_lead_to_sheet
from app.services.comms import send_customer_sms, alert_business_owner
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
    urgency: Optional[str] = Field("Standard", description="Low, Standard, High, or Emergency")
    notes: Optional[str] = Field("", description="Additional details from homeowner")
    consent_given: bool = Field(True, description="TCPA and A2P opt-in consent confirmation")

@router.post("/webform")
async def submit_webform(lead: WebFormLead, background_tasks: BackgroundTasks):
    """
    Unified Inbound Web Form Handler:
    1. Validates and generates Lead ID.
    2. Writes record immediately to the Google Sheet CRM (Leads_Inbox).
    3. Fires instant SMS confirmation to the homeowner (with A2P compliance).
    4. Sends SMS notification to the business owner/on-call dispatcher.
    5. (If enabled) Triggers Vapi outbound AI callback within 30 seconds for speed-to-lead.
    """
    if not lead.phone:
        raise HTTPException(status_code=400, detail="Phone number is required.")

    lead_id = f"WEB-{int(datetime.now().timestamp())}"
    lead_dict = {
        "lead_id": lead_id,
        "lead_source": "Website Form",
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "first_name": lead.first_name,
        "last_name": lead.last_name,
        "phone_number": lead.phone,
        "email": lead.email,
        "street_address": lead.address,
        "city": settings.PRIMARY_CITY,
        "service_requested": lead.service,
        "urgency": lead.urgency,
        "status": "New Lead",
        "notes": lead.notes
    }

    # 1. Background task: Append to Google Sheet CRM
    background_tasks.add_task(append_lead_to_sheet, lead_dict)

    # 2. Background task: Send instant SMS confirmation to customer
    background_tasks.add_task(send_customer_sms, lead.phone, lead.first_name, lead.service)

    # 3. Background task: Send alert to business owner
    background_tasks.add_task(alert_business_owner, lead_dict)

    # 4. Background task: (Optional) 30-sec instant AI Voice callback
    if settings.ENABLE_OUTBOUND_CALLBACK:
        background_tasks.add_task(
            trigger_outbound_speed_to_lead_call,
            customer_phone=lead.phone,
            customer_name=lead.first_name,
            service_requested=lead.service,
            address=lead.address or settings.PRIMARY_CITY
        )

    return {
        "status": "success",
        "message": "Lead received successfully. Estimator dispatch initiated.",
        "lead_id": lead_id,
        "outbound_callback_queued": settings.ENABLE_OUTBOUND_CALLBACK
    }
