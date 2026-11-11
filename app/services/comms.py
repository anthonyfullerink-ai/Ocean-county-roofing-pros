import logging
from typing import Optional
from app.config import settings

logger = logging.getLogger(__name__)

def is_twilio_configured() -> bool:
    """Checks if real, valid Twilio credentials are provided."""
    sid = settings.TWILIO_ACCOUNT_SID
    token = settings.TWILIO_AUTH_TOKEN
    if not sid or not token:
        return False
    if "YOUR_" in sid or "YOUR_" in token or "placeholder" in sid.lower():
        return False
    return True

def send_customer_sms(to_phone: str, customer_name: str, service: str) -> bool:
    """
    Sends an automated, A2P 10DLC compliant confirmation SMS to the lead.
    Follows carrier guidelines: includes sender identification, purpose, and STOP/HELP keywords.
    """
    if not settings.ENABLE_SMS_CONFIRMATION:
        logger.info("SMS confirmation is disabled in settings.")
        return False

    message_body = (
        f"Hi {customer_name}, thanks for contacting {settings.BUSINESS_NAME}! "
        f"We received your request for {service} in {settings.PRIMARY_CITY}. "
        f"Our local estimator will arrive at the scheduled time for your free 21-point inspection. "
        f"Reply STOP to opt out, HELP for help. Msg & data rates may apply."
    )

    if not is_twilio_configured() or settings.MOCK_MODE:
        logger.info(f"[SMS READY] Twilio not yet connected. Queued message for {to_phone}: '{message_body}'")
        return True

    try:
        from twilio.rest import Client
        client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
        msg = client.messages.create(
            body=message_body,
            from_=settings.TWILIO_PHONE_NUMBER or settings.PRIMARY_PHONE,
            to=to_phone
        )
        logger.info(f"Sent confirmation SMS to {to_phone}, SID: {msg.sid}")
        return True
    except Exception as e:
        logger.error(f"Failed to send Twilio SMS to {to_phone}: {e}")
        return False

def alert_business_owner(lead_data: dict) -> bool:
    """
    Sends an urgent SMS alert to the active tenant roofer or on-call dispatcher.
    """
    from app.services.tenant_manager import TenantManager
    tenant = TenantManager.get_active_tenant()
    alert_phone = tenant.dispatch_phone or settings.OWNER_ALERT_PHONE
    if not alert_phone:
        return False

    slot = lead_data.get('appointment_slot')
    slot_info = f"\nAppointment: {slot}" if slot else ""

    message_body = (
        f"🚨 NEW ROOFING LEAD - {settings.BUSINESS_NAME}\n"
        f"Contractor: {tenant.company_name} ({tenant.tenant_id})\n"
        f"Name: {lead_data.get('first_name')} {lead_data.get('last_name')}\n"
        f"Phone: {lead_data.get('phone_number')}\n"
        f"Address: {lead_data.get('street_address', 'Not provided')}\n"
        f"Service: {lead_data.get('service_requested')}\n"
        f"Source: {lead_data.get('lead_source')}"
        f"{slot_info}"
    )

    if not is_twilio_configured() or settings.MOCK_MODE:
        logger.info(f"[OWNER ALERT QUEUED] Real Twilio creds pending. Lead: {lead_data.get('first_name')} {lead_data.get('last_name')} ({lead_data.get('phone_number')})")
        return True

    try:
        from twilio.rest import Client
        client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
        client.messages.create(
            body=message_body,
            from_=settings.TWILIO_PHONE_NUMBER,
            to=alert_phone
        )
        return True
    except Exception as e:
        logger.error(f"Failed to send owner alert SMS: {e}")
        return False
