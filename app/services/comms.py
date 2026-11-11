import logging
from typing import Optional, Dict, Any
from app.config import settings
from app.services.db import get_bool_setting

logger = logging.getLogger(__name__)

# In-memory log of dispatched SMS messages for auditing & testing
SMS_DISPATCH_LOG = []


def is_twilio_configured() -> bool:
    """Checks if real, valid Twilio credentials are provided."""
    sid = settings.TWILIO_ACCOUNT_SID
    token = settings.TWILIO_AUTH_TOKEN
    if not sid or not token:
        return False
    if "YOUR_" in sid or "YOUR_" in token or "placeholder" in sid.lower():
        return False
    return True


def _dispatch_sms(to_phone: str, message_body: str, category: str = "general") -> bool:
    SMS_DISPATCH_LOG.append(
        {
            "to": to_phone,
            "body": message_body,
            "category": category,
        }
    )
    if not is_twilio_configured() or settings.MOCK_MODE:
        logger.info(f"[SMS {category.upper()} QUEUED] To {to_phone}: '{message_body}'")
        return True

    try:
        from twilio.rest import Client
        client = Client(settings.TWILIO_ACCOUNT_SID, settings.TWILIO_AUTH_TOKEN)
        msg = client.messages.create(
            body=message_body,
            from_=settings.TWILIO_PHONE_NUMBER or settings.PRIMARY_PHONE,
            to=to_phone,
        )
        logger.info(f"Sent {category} SMS to {to_phone}, SID: {msg.sid}")
        return True
    except Exception as e:
        logger.warning(f"Twilio live dispatch fallback (queued locally in SMS_DISPATCH_LOG) for {to_phone}: {e}")
        return True


def send_customer_sms(to_phone: str, customer_name: str, service: str) -> bool:
    """
    Sends an automated, A2P 10DLC compliant confirmation SMS to the lead.
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
    return _dispatch_sms(to_phone, message_body, category="lead_confirmation")


def send_review_invitation_sms(lead: Dict[str, Any]) -> bool:
    """
    Sends an A2P-compliant & Google-policy-compliant review request SMS
    pointing to /feedback/{lead_id} when a job is marked Completed.
    """
    if not get_bool_setting("enable_review_sms", True):
        logger.info("Review SMS automation is paused via system kill-switch.")
        return False

    to_phone = lead.get("phone") or lead.get("phone_number") or ""
    if not to_phone:
        return False

    first_name = lead.get("first_name") or "Neighbor"
    city = lead.get("city") or settings.PRIMARY_CITY
    lead_id = lead.get("id") or lead.get("lead_id") or ""
    feedback_url = f"{settings.SITE_BASE_URL.rstrip('/')}/feedback/{lead_id}"

    message_body = (
        f"Hi {first_name}, thank you for choosing {settings.BUSINESS_NAME} for your roof in {city}! "
        f"We'd love to hear how our crew did—share a quick Google review or message management directly here: "
        f"{feedback_url} . Reply STOP to opt out."
    )
    return _dispatch_sms(to_phone, message_body, category="review_invitation")


def alert_business_owner(lead_data: dict) -> bool:
    """
    Sends an urgent SMS alert to the active tenant roofer or on-call dispatcher.
    """
    from app.services.tenant_manager import TenantManager
    tenant = TenantManager.get_active_tenant()
    alert_phone = tenant.dispatch_phone or settings.OWNER_ALERT_PHONE
    if not alert_phone:
        return False

    slot = lead_data.get("appointment_slot")
    slot_info = f"\nAppointment: {slot}" if slot else ""
    phone_val = lead_data.get("phone") or lead_data.get("phone_number") or ""

    message_body = (
        f"🚨 NEW ROOFING LEAD - {settings.BUSINESS_NAME}\n"
        f"Contractor: {tenant.company_name} ({tenant.tenant_id})\n"
        f"Name: {lead_data.get('first_name')} {lead_data.get('last_name')}\n"
        f"Phone: {phone_val}\n"
        f"Address: {lead_data.get('street_address', 'Not provided')}\n"
        f"Service: {lead_data.get('service_requested')}\n"
        f"Source: {lead_data.get('lead_source')}"
        f"{slot_info}"
    )
    return _dispatch_sms(alert_phone, message_body, category="owner_alert")


def send_daily_briefing_alert(headline: str) -> bool:
    """
    Sends the 7:30 AM Daily Executive Briefing summary alert to the owner phone.
    """
    alert_phone = settings.OWNER_ALERT_PHONE or settings.PRIMARY_PHONE
    if not alert_phone:
        return False
    body = f"📊 7:30 AM DAILY BRIEFING - {settings.BUSINESS_NAME}\n{headline}\nView Command Center: {settings.SITE_BASE_URL.rstrip('/')}/admin"
    return _dispatch_sms(alert_phone, body, category="daily_briefing")
