import logging
import re
from datetime import datetime
from fastapi import APIRouter, Request, HTTPException
from typing import Dict, Any, Optional

from app.config import settings
from app.services.sheets import (
    append_lead_to_sheet,
    append_booking_to_sheet,
    update_lead_with_call_recording,
    update_lead_email_and_address,
    normalize_phone
)
from app.services.calendar_service import (
    check_available_slots,
    book_calendar_appointment,
    update_calendar_event
)
from app.services.address_validator import verify_address_online
from app.services.comms import alert_business_owner, send_customer_sms

router = APIRouter(prefix="/api/vapi", tags=["Vapi Voice Engine"])
logger = logging.getLogger(__name__)

# Registry of call bookings: {norm_phone: {"lead_id": str, "event_id": str, "email": str, "address": str}}
BOOKED_CALL_REGISTRY = {}

def clean_spoken_email(raw_email: str) -> str:
    """
    Normalizes spoken email addresses transcribed by STT.
    Handles spelled-out characters like 'p o w u r n j at g mail dot com' -> 'powurnj@gmail.com'
    """
    if not raw_email:
        return ""
    
    s = raw_email.strip().lower()
    s = s.replace(" at ", "@").replace(" dot ", ".").replace(" dot", ".").replace("dot ", ".")
    if "@" not in s and "gmail" in s:
        s = s.replace("gmail.com", "@gmail.com")
    s = s.replace("@@", "@")
    
    parts = s.split("@")
    local_part = parts[0]
    domain_part = parts[1] if len(parts) > 1 else "gmail.com"
    
    # Strip spaces between individual letters
    local_clean = re.sub(r"\s+", "", local_part)
    domain_clean = re.sub(r"\s+", "", domain_part)
    
    return f"{local_clean}@{domain_clean}"


@router.post("/tools")
async def handle_vapi_tool_calls(request: Request):
    """
    Synchronous Server Tool Endpoint for Vapi:
    Handles 'check_availability', 'verify_address', 'book_inspection', and 'update_booking'.
    """
    body = await request.json()
    message = body.get("message", {})
    tool_calls = message.get("toolCalls", [])

    if not tool_calls:
        tool_calls = body.get("toolCalls", [])

    call_obj = message.get("call") or body.get("call") or {}
    customer_obj = call_obj.get("customer") or {}
    inbound_caller_phone = customer_obj.get("number", "")

    results = []
    for tool_call in tool_calls:
        call_id = tool_call.get("id")
        func = tool_call.get("function", {})
        func_name = func.get("name")
        args = func.get("arguments", {})

        logger.info(f"Vapi Tool Call: {func_name} with args: {args}")

        # ----------------------------------------------------------------------
        # 1. CHECK AVAILABILITY
        # ----------------------------------------------------------------------
        if func_name == "check_availability":
            date_str = args.get("date", "tomorrow")
            preferred_time = args.get("preferred_time") or args.get("time")
            avail_res = check_available_slots(date_str, preferred_time)
            result_str = avail_res.get("message", f"Checked availability for {date_str}.")
            logger.info(f"check_availability result: {result_str}")
            results.append({"toolCallId": call_id, "result": result_str})

        # ----------------------------------------------------------------------
        # 2. VERIFY ADDRESS (MANDATORY HOUSE NUMBER CHECK)
        # ----------------------------------------------------------------------
        elif func_name == "verify_address":
            raw_address = args.get("address", "")
            val_res = verify_address_online(raw_address)
            if val_res.get("valid"):
                formatted = val_res.get("formatted_address")
                msg = (
                    f"Address verified successfully as: '{formatted}'. "
                    f"CRITICAL TURN-TAKING RULE: Read this exact verified address back to the caller and ask: "
                    f"'Just to make sure our estimator Riley arrives at the right home, I have your address verified as {formatted}. Is that correct?' "
                    f"DO NOT ASK FOR THE EMAIL YET. STOP TALKING AND WAIT FOR THE CALLER TO SAY YES OR NO."
                )
            else:
                msg = val_res.get("message") or (
                    f"Could not verify '{raw_address}'. A numerical house or building number is strictly required. "
                    f"Please ask the caller: 'Could you please repeat your street number and street name for me?'"
                )
            logger.info(f"verify_address result: {msg}")
            results.append({"toolCallId": call_id, "result": msg})

        # ----------------------------------------------------------------------
        # 3. BOOK INSPECTION
        # ----------------------------------------------------------------------
        elif func_name == "book_inspection":
            name = args.get("name", "Homeowner").strip()
            phone = args.get("phone", "").strip() or inbound_caller_phone
            raw_email = args.get("email", "").strip()
            email = clean_spoken_email(raw_email)
            address = args.get("address", settings.PRIMARY_CITY).strip()
            service = args.get("service", "Roof Replacement Estimate").strip()
            date_str = args.get("date", "tomorrow").strip()
            time_str = args.get("time", "1:00 PM").strip()

            norm_phone = normalize_phone(phone)

            # Ensure address has numerical house number
            val_check = verify_address_online(address)
            if val_check.get("valid"):
                address = val_check.get("formatted_address")

            # Book directly to owner's Google Calendar via gcalendar CLI
            booking = book_calendar_appointment(name, phone, address, service, date_str, time_str, customer_email=email)
            
            # Handle double-booking conflicts
            if booking.get("status") == "conflict":
                conflict_msg = booking.get("message") or (
                    f"That slot ({time_str}) on {date_str} is already booked on our calendar! "
                    f"Please apologize to the caller and offer the closest alternatives."
                )
                logger.warning(f"Double-booking prevented: {conflict_msg}")
                results.append({"toolCallId": call_id, "result": conflict_msg})
                continue

            clean_date = booking.get("date", date_str)
            clean_time = booking.get("time", time_str)
            clean_end_time = booking.get("end_time", "")
            cal_id = booking.get("event_id", "")

            timestamp_id = int(datetime.now().timestamp())
            lead_id = f"CALL-{timestamp_id}"
            booking_id = f"BK-{timestamp_id}"

            # Record in Calendar_Bookings tab
            append_booking_to_sheet({
                "booking_id": booking_id,
                "lead_id": lead_id,
                "customer_name": name,
                "phone_number": phone,
                "customer_email": email,
                "service_type": service,
                "assigned_estimator": f"{active_tenant.assigned_estimator} / {active_tenant.company_name}",
                "date": clean_date,
                "start_time": clean_time,
                "end_time": clean_end_time,
                "calendar_event_id": cal_id
            })

            # Record in Leads_Inbox tab
            from app.services.tenant_manager import TenantManager
            active_tenant = TenantManager.get_active_tenant()

            parts = name.split(" ", 1)
            first_name = parts[0]
            last_name = parts[1] if len(parts) > 1 else ""

            lead_dict = {
                "lead_id": lead_id,
                "lead_source": "Vapi Inbound Call",
                "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
                "first_name": first_name,
                "last_name": last_name,
                "phone_number": phone,
                "email": email,
                "street_address": address,
                "city": val_check.get("city", settings.PRIMARY_CITY),
                "service_requested": service,
                "urgency": "Standard",
                "status": "Inspection Booked",
                "appointment_slot": f"{clean_date} {clean_time}",
                "notes": f"Booked with {active_tenant.assigned_estimator} for {active_tenant.company_name}. Cal Event: {cal_id}",
                "call_duration_sec": 0,
                "crm_sync_status": "Scheduled"
            }
            append_lead_to_sheet(lead_dict)

            # Store in cache with event_id so updates/hangup can modify this exact lead
            if norm_phone:
                BOOKED_CALL_REGISTRY[norm_phone] = {
                    "lead_id": lead_id,
                    "event_id": cal_id,
                    "email": email,
                    "address": address
                }

            alert_business_owner(lead_dict)
            is_external_cal = booking.get("scheduling_type") == "external_link"
            booking_url = booking.get("booking_url")

            if phone:
                send_customer_sms(phone, first_name, service, booking_url=booking_url if is_external_cal else None)

            if is_external_cal and booking_url:
                confirmation_msg = (
                    f"Appointment request registered for {name} with {active_tenant.company_name}! "
                    f"I have sent an SMS to {phone} with a direct booking link to finalize your 15-minute arrival window: {booking_url}. "
                    f"One of our certified roofing specialists will meet you at {address} for the free 21-point roof inspection."
                )
            else:
                invite_note = f" A calendar invite has been sent to {email}." if email else ""
                confirmation_msg = (
                    f"Appointment successfully confirmed for {name} on {clean_date} at {clean_time}. "
                    f"One of our certified roofing specialists from our local crew will arrive at {address} for the free 21-point roof inspection.{invite_note}"
                )
            results.append({"toolCallId": call_id, "result": confirmation_msg})

        # ----------------------------------------------------------------------
        # 4. UPDATE BOOKING (IF CALLER CORRECTS EMAIL OR ADDRESS)
        # ----------------------------------------------------------------------
        elif func_name == "update_booking":
            new_email_raw = args.get("email")
            new_email = clean_spoken_email(new_email_raw) if new_email_raw else None
            new_address_raw = args.get("address")
            new_address = None
            if new_address_raw:
                val = verify_address_online(new_address_raw)
                new_address = val.get("formatted_address") if val.get("valid") else new_address_raw

            phone = args.get("phone") or inbound_caller_phone
            norm_phone = normalize_phone(phone)
            entry = BOOKED_CALL_REGISTRY.get(norm_phone, {})
            cal_id = entry.get("event_id")

            # 1. Update live Google Calendar event attendee / location
            if cal_id:
                update_calendar_event(cal_id, new_email=new_email, new_address=new_address)

            # 2. Update Google Sheet CRM tabs
            update_lead_email_and_address(norm_phone, new_email=new_email, new_address=new_address)

            updates = []
            if new_email:
                updates.append(f"email updated to {new_email} and calendar invitation resent")
                entry["email"] = new_email
            if new_address:
                updates.append(f"address updated to {new_address}")
                entry["address"] = new_address

            res_str = f"Confirmed: {' and '.join(updates)}. Reassure the caller that the update is saved and the invite is resent."
            logger.info(f"update_booking result: {res_str}")
            results.append({"toolCallId": call_id, "result": res_str})

        else:
            results.append({"toolCallId": call_id, "result": "Unknown tool function."})

    return {"results": results}


@router.post("/end-of-call")
async def handle_vapi_end_of_call(request: Request):
    """
    Post-Call Asynchronous Webhook from Vapi:
    Fires when caller hangs up.
    Only processes final 'end-of-call-report'.
    Enriches the existing booked lead row with recording URL, duration, and summary.
    """
    payload = await request.json()
    message = payload.get("message", {})
    msg_type = message.get("type") or payload.get("type", "")

    if msg_type != "end-of-call-report":
        logger.info(f"Ignoring intermediate Vapi webhook event: {msg_type}")
        return {"status": "ignored", "event_type": msg_type}

    call = message.get("call") or payload.get("call", {})
    customer = call.get("customer", {})
    phone = customer.get("number", "Unknown")
    norm_phone = normalize_phone(phone)
    
    duration = call.get("duration") or call.get("durationSeconds") or 0
    artifact = message.get("artifact") or payload.get("artifact", {})
    recording_url = artifact.get("recordingUrl") or call.get("recordingUrl", "")
    summary = message.get("summary") or payload.get("summary", "Inbound call to Ocean County Roofing Pros")
    analysis = message.get("analysis") or payload.get("analysis", {})
    structured_data = analysis.get("structuredData", {})

    # Check if this call was already booked during the live conversation
    existing_entry = BOOKED_CALL_REGISTRY.pop(norm_phone, None)
    lead_id = existing_entry.get("lead_id") if isinstance(existing_entry, dict) else existing_entry

    if lead_id or norm_phone:
        lookup_key = lead_id or norm_phone
        updated = update_lead_with_call_recording(lookup_key, recording_url, int(duration), summary)
        if updated:
            logger.info(f"Enriched existing lead {lookup_key} with recording URL and duration ({duration}s). ZERO duplicate rows.")
            return {"status": "success", "action": "updated", "lead_id": lookup_key}

    # If caller called but did NOT book an inspection
    new_lead_id = f"CALL-{int(datetime.now().timestamp())}"
    lead_dict = {
        "lead_id": new_lead_id,
        "lead_source": "Vapi Inbound Call",
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "first_name": structured_data.get("first_name", "Inbound Caller"),
        "last_name": structured_data.get("last_name", ""),
        "phone_number": phone,
        "street_address": structured_data.get("address", ""),
        "city": settings.PRIMARY_CITY,
        "service_requested": structured_data.get("service_type", "Roof Inquiry"),
        "urgency": structured_data.get("urgency", "Standard"),
        "status": "Inbound Call Completed",
        "ai_summary": summary,
        "recording_url": recording_url,
        "call_duration_sec": int(duration),
        "crm_sync_status": "Synced"
    }

    append_lead_to_sheet(lead_dict)
    alert_business_owner(lead_dict)

    logger.info(f"Processed Vapi end-of-call report for unbooked caller {new_lead_id} ({phone})")
    return {"status": "success", "lead_id": new_lead_id, "action": "created"}
