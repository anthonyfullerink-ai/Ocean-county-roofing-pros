import logging
from typing import Dict, Any, Optional
from app.services.db import (
    normalize_phone,
    create_lead,
    update_lead,
    get_lead,
)

logger = logging.getLogger(__name__)


def append_lead_to_sheet(lead_data: Dict[str, Any]) -> bool:
    """
    Writes lead record directly into the unified Supabase / Local Mirror database.
    Retires Google Sheets while maintaining backward compatibility for callers.
    """
    try:
        saved = create_lead(lead_data)
        logger.info(f"Saved lead {saved.get('id')} to Unified Supabase CRM.")
        return True
    except Exception as e:
        logger.error(f"Error saving lead to Unified Supabase CRM: {e}")
        return False


def append_booking_to_sheet(booking_data: Dict[str, Any]) -> bool:
    """
    Records booking slot details onto the corresponding lead record in the unified database.
    """
    try:
        lead_id = booking_data.get("lead_id") or booking_data.get("phone_number") or ""
        slot = f"{booking_data.get('date', '')} {booking_data.get('start_time', '')}".strip()
        if lead_id and get_lead(lead_id):
            update_lead(
                lead_id,
                {
                    "status": "Booked",
                    "appointment_slot": slot,
                    "email": booking_data.get("customer_email") or booking_data.get("email"),
                },
            )
        return True
    except Exception as e:
        logger.error(f"Error recording booking in Unified Supabase CRM: {e}")
        return False


def update_lead_with_call_recording(
    lead_id_or_phone: str,
    recording_url: str,
    duration: int,
    summary: Optional[str] = None,
) -> bool:
    """
    Finds the existing lead in the unified database by lead_id or normalized phone,
    and enriches it in-place with call recording URL, duration, and AI transcript/summary.
    """
    if not lead_id_or_phone:
        return False
    updates: Dict[str, Any] = {
        "call_recording_url": recording_url or "",
        "call_duration_sec": int(duration or 0),
    }
    if summary:
        updates["call_transcript"] = summary
    updated = update_lead(lead_id_or_phone, updates)
    return updated is not None


def update_lead_email_and_address(
    lead_id_or_phone: str,
    new_email: Optional[str] = None,
    new_address: Optional[str] = None,
) -> bool:
    """
    Updates the email and/or address of an existing lead in the unified database.
    """
    if not lead_id_or_phone:
        return False
    updates: Dict[str, Any] = {}
    if new_email:
        updates["email"] = new_email.strip()
    if new_address:
        updates["street_address"] = new_address.strip()
    if not updates:
        return False
    updated = update_lead(lead_id_or_phone, updates)
    return updated is not None
