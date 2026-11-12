import os
import json
import logging
import httpx
from typing import Dict, Any, Optional
from datetime import datetime

from app.config import settings
from app.services.tenant_manager import TenantManager
from app.services.db import (
    get_setting,
    set_setting,
    get_active_tenant_record,
    list_tenants
)

logger = logging.getLogger(__name__)

VAPI_API_URL = "https://api.vapi.ai"

# Core Vapi Assistant IDs
ASSISTANT_SARAH_ID = "dbc59b3f-85a6-4fad-9dab-b5a36b16125b"
ASSISTANT_RILEY_ID = "e86a1d27-c226-4018-96f0-e434eb53b895"


def _get_headers() -> Dict[str, str]:
    if not settings.VAPI_API_KEY:
        raise ValueError("VAPI_API_KEY is not configured in environment.")
    return {
        "Authorization": f"Bearer {settings.VAPI_API_KEY}",
        "Content-Type": "application/json"
    }


def fetch_vapi_assistant(assistant_id: str) -> Dict[str, Any]:
    """
    Retrieves the raw assistant configuration directly from Vapi API.
    """
    url = f"{VAPI_API_URL}/assistant/{assistant_id}"
    with httpx.Client(timeout=15.0) as client:
        r = client.get(url, headers=_get_headers())
        if r.status_code == 200:
            return r.json()
        raise RuntimeError(f"Vapi API returned {r.status_code}: {r.text}")


def pull_vapi_state_to_db() -> Dict[str, Any]:
    """
    Pulls live assistant configurations from Vapi into local settings & Supabase.
    Tracks voice IDs, model parameters, assistant names, and last sync timestamp.
    """
    sarah = fetch_vapi_assistant(ASSISTANT_SARAH_ID)
    riley = fetch_vapi_assistant(ASSISTANT_RILEY_ID)

    sync_snapshot = {
        "last_sync": datetime.now().isoformat(),
        "sarah": {
            "name": sarah.get("name"),
            "voice": sarah.get("voice"),
            "model": sarah.get("model", {}).get("model"),
            "first_message": sarah.get("firstMessage"),
            "server_url": sarah.get("serverUrl")
        },
        "riley": {
            "name": riley.get("name"),
            "voice": riley.get("voice"),
            "model": riley.get("model", {}).get("model"),
            "server_url": riley.get("serverUrl")
        }
    }

    set_setting("vapi_sync_snapshot", json.dumps(sync_snapshot))
    set_setting("vapi_last_synced_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    logger.info("Successfully pulled Vapi state into database.")
    return sync_snapshot


def build_sarah_prompt(tenant) -> str:
    return f"""[Identity & Role]
You are Sarah, the welcoming, deeply empathetic, and highly capable front-desk receptionist for Ocean County Roofing Pros, partnered with {tenant.company_name} (NJ Home Improvement Contractor License #{tenant.service_license}).
Your primary role is to answer calls from local homeowners, understand what roofing problems they are facing, validate their concerns with genuine care, and book a free 21-point on-site roof inspection with our senior estimator {tenant.assigned_estimator}.

[How You Sound / Conversational Guidelines]
- Tone: Warm, neighborly, and unhurried—like a seasoned local receptionist who treats every caller like a neighbor in Ocean County. You are calm, friendly, and never robotic.
- Empathy & Active Listening: Always acknowledge the caller's situation before asking logistical questions. Use natural conversational acknowledgments ("Gotcha", "I hear you", "Makes total sense", "Oh absolutely").
- Contractions: Always speak with natural contractions ("I'll", "we've", "it's", "don't", "we'd love to").
- Turn-Taking: Keep responses concise (1 to 2 short sentences per turn). Never ask more than ONE question in a single turn.

[Active Leak, Storm Damage & Emergency Protocol]
If the caller mentions an active leak, water stains on ceilings/walls, dripping sounds, or missing shingles from a storm:
1. Empathy First: Immediately validate their distress with genuine care:
   "Oh no, I am so sorry you're dealing with that! Having water coming inside the house is so stressful, especially with the coastal weather here. Let's make sure we get {tenant.assigned_estimator} out to your home as soon as possible before it does any more damage."
2. Priority Triage: Politely ask for their address to verify they are in Ocean County, and find the EARLIEST available arrival window for {tenant.assigned_estimator}.
3. Reassurance: Let them know {tenant.assigned_estimator} brings a high-definition 4K drone and FLIR thermal imaging scanner to inspect hard-to-see areas and pinpoint the leak without walking all over delicate shingles.

[Routine Inquiries / Replacement Estimates]
If the caller is asking about an aging roof, routine replacement, or financing:
1. Acknowledge with enthusiasm: "You've definitely called the right team. We specialize in CertainTeed Landmark PRO systems engineered for 160 MPH coastal winds."
2. Transition to booking a free 21-point drone roof scan with {tenant.assigned_estimator}.

[Step-by-Step Conversation Flow]
1. Greeting: "Thanks for calling Ocean County Roofing Pros! This is Sarah. How can I help you with your roof today?"
2. Problem Discovery & Empathy: Listen to their issue. Express empathy. Capture their name.
3. Address Verification: Call 'verify_address' as soon as they provide an address. A numerical street number is strictly mandatory. Read back: "Just to make sure our estimator {tenant.assigned_estimator} arrives at the right home, I have your address verified as [Address]. Is that correct?"
4. Scheduling: Call 'check_availability' for their preferred day. Offer 2 clear slots with {tenant.assigned_estimator}.
5. Email Capture: Ask for email to deliver the confirmation and calendar invite. Spell back letter-by-letter.
6. Booking: Call 'book_inspection' with all verified fields. Reassure them that {tenant.assigned_estimator} will arrive at the scheduled time.
"""


def build_riley_prompt(tenant) -> str:
    return f"""[Identity & Role]
You are {tenant.assigned_estimator}, the dedicated Senior Estimator & Scheduling Specialist for Ocean County Roofing Pros, working alongside {tenant.company_name} (NJ Home Improvement Contractor License #{tenant.service_license}).
You are an expert on Ocean County coastal roofs—from Seaside salt-air exposure to Lakewood and Toms River architectural shingle replacements.

[How You Sound / Conversational Guidelines]
- Tone: Confident, reassuring, personable, and technically savvy. You sound like a master estimator who is patient, transparent, and easy to talk to.
- Active Listening: Use natural conversational receipts ("Understood", "Got it", "I see exactly what you mean").
- Empathy on Leaks: If a caller has an active leak, reassure them immediately: "Water leaks can be nerve-wracking, but don't worry—I've seen every type of valley, chimney, and flashing leak in Ocean County. We'll pinpoint the exact entry point with our drone and thermal scan and get you taken care of."
- Contractions: Always speak with natural contractions ("I'm", "we'll", "it's", "that's", "don't").

[Tool Instructions]
- Use 'verify_address' to validate numerical house numbers.
- Use 'check_availability' to check open inspection windows.
- Use 'book_inspection' to secure the appointment.
- Use 'update_booking' if the caller needs to update their email or arrival details.
"""


def push_prompts_and_settings_to_vapi() -> Dict[str, Any]:
    """
    Pushes active contractor information, empathetic prompts, backchanneling,
    and snappy turn-taking parameters to both Sarah and Riley in Vapi.
    """
    tenant = TenantManager.get_active_tenant()
    headers = _get_headers()

    sarah_prompt = build_sarah_prompt(tenant)
    riley_prompt = build_riley_prompt(tenant)

    # 1. Update Sarah
    sarah_patch = {
        "name": "Sarah - Ocean County Roofing Pros",
        "firstMessage": "Thanks for calling Ocean County Roofing Pros! This is Sarah. How can I help you with your roof today?",
        "model": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "messages": [{"role": "system", "content": sarah_prompt}]
        },
        "serverUrl": "https://ocean-county-roofing-pros.netlify.app/api/vapi/webhook",
        "backchannelingEnabled": True,
        "startSpeakingPlan": {
            "waitSeconds": 0.25,
            "smartEndpointingEnabled": True
        },
        "stopSpeakingPlan": {
            "numWords": 1,
            "voiceSeconds": 0.2,
            "backoffSeconds": 1.0
        }
    }

    # 2. Update Riley
    riley_raw = fetch_vapi_assistant(ASSISTANT_RILEY_ID)
    riley_tools = riley_raw.get("model", {}).get("tools", [])
    for t in riley_tools:
        if "server" in t:
            t["server"]["url"] = "https://ocean-county-roofing-pros.netlify.app/api/vapi/tools"

    riley_patch = {
        "name": f"{tenant.assigned_estimator} - Scheduling Specialist",
        "model": {
            "provider": "openai",
            "model": "gpt-4o-mini",
            "messages": [{"role": "system", "content": riley_prompt}],
            "tools": riley_tools
        },
        "serverUrl": "https://ocean-county-roofing-pros.netlify.app/api/vapi/webhook",
        "backchannelingEnabled": True,
        "startSpeakingPlan": {
            "waitSeconds": 0.25,
            "smartEndpointingEnabled": True
        },
        "stopSpeakingPlan": {
            "numWords": 1,
            "voiceSeconds": 0.2,
            "backoffSeconds": 1.0
        }
    }

    with httpx.Client(timeout=20.0) as client:
        r_sarah = client.patch(f"{VAPI_API_URL}/assistant/{ASSISTANT_SARAH_ID}", headers=headers, json=sarah_patch)
        r_riley = client.patch(f"{VAPI_API_URL}/assistant/{ASSISTANT_RILEY_ID}", headers=headers, json=riley_patch)

    if r_sarah.status_code == 200 and r_riley.status_code == 200:
        set_setting("vapi_last_pushed_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        logger.info(f"Successfully pushed persona and settings to Vapi for {tenant.assigned_estimator} and {tenant.company_name}.")
        return {
            "status": "success",
            "sarah_status": r_sarah.status_code,
            "riley_status": r_riley.status_code,
            "assigned_estimator": tenant.assigned_estimator,
            "company_name": tenant.company_name
        }
    else:
        raise RuntimeError(f"Vapi push failed: Sarah={r_sarah.status_code} ({r_sarah.text}), Riley={r_riley.status_code} ({r_riley.text})")
