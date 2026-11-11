import logging
import httpx
from typing import Dict, Any, Optional
from app.config import settings

logger = logging.getLogger(__name__)

VAPI_BASE_URL = "https://api.vapi.ai"

async def trigger_outbound_speed_to_lead_call(customer_phone: str, customer_name: str, service_requested: str, address: str) -> bool:
    """
    Triggers an instant outbound phone call via Vapi within 30 seconds of web form submission.
    Can be dynamically toggled ON or OFF in settings (or via client config).
    """
    if not settings.ENABLE_OUTBOUND_CALLBACK:
        logger.info("Outbound callback is disabled by configuration.")
        return False

    if settings.MOCK_MODE or not settings.VAPI_API_KEY or not settings.VAPI_PHONE_NUMBER_ID:
        logger.info(
            f"[MOCK VAPI OUTBOUND] Triggering 30-sec callback to {customer_phone} ({customer_name}) "
            f"for '{service_requested}' at '{address}'"
        )
        return True

    headers = {
        "Authorization": f"Bearer {settings.VAPI_API_KEY}",
        "Content-Type": "application/json"
    }

    # Pass dynamic context to Vapi so the assistant greets the caller with their actual request!
    payload = {
        "phoneNumberId": settings.VAPI_PHONE_NUMBER_ID,
        "customer": {
            "number": customer_phone,
            "name": customer_name
        },
        "assistantId": settings.VAPI_OUTBOUND_ASSISTANT_ID,
        "assistantOverrides": {
            "variableValues": {
                "customerName": customer_name,
                "serviceRequested": service_requested,
                "propertyAddress": address,
                "businessName": settings.BUSINESS_NAME
            }
        }
    }

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(f"{VAPI_BASE_URL}/call/phone", json=payload, headers=headers)
            if response.status_code in [200, 201]:
                logger.info(f"Successfully initiated Vapi outbound speed-to-lead call to {customer_phone}")
                return True
            else:
                logger.error(f"Vapi call dispatch failed ({response.status_code}): {response.text}")
                return False
    except Exception as e:
        logger.error(f"Exception triggering Vapi outbound call: {e}")
        return False
