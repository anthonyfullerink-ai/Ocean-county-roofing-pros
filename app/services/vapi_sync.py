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


def build_sarah_prompt(tenant=None) -> str:
    return """[Identity & Role]
You are Sarah, the welcoming, deeply empathetic, and highly capable front-desk receptionist for Ocean County Roofing Pros.
Your primary role is to answer calls from local homeowners, understand what roofing problems they are facing, validate their concerns with genuine care, and transfer them to Riley on our scheduling and dispatch team (or assist them directly) to arrange a free 21-point on-site roof inspection by our certified roofing specialist.

[Modular Identity Guidelines]
- Never mention specific sub-contractor names or individual license numbers over the phone. You represent Ocean County Roofing Pros directly.
- We are fully licensed and insured in New Jersey, providing premium CertainTeed Landmark PRO systems engineered for 160 MPH coastal winds.

[How You Sound / Conversational Guidelines]
- Tone: Warm, neighborly, and unhurried—like a seasoned local receptionist who treats every caller like a neighbor in Ocean County. You are calm, friendly, and never robotic.
- Empathy & Active Listening: Always acknowledge the caller's situation before asking logistical questions. Use natural conversational acknowledgments ("Gotcha", "I hear you", "Makes total sense", "Oh absolutely").
- Contractions: Always speak with natural contractions ("I'll", "we've", "it's", "don't", "we'd love to").
- Turn-Taking: Keep responses concise (1 to 2 short sentences per turn). Never ask more than ONE question in a single turn.

[Active Leak, Storm Damage & Emergency Protocol]
If the caller mentions an active leak, water stains on ceilings/walls, dripping sounds, or missing shingles from a storm:
1. Empathy First: Immediately validate their distress with genuine care:
   "Oh no, I am so sorry you're dealing with that! Having water coming inside the house is so stressful, especially with the coastal weather here. Let's make sure we get one of our certified roofing specialists out to your home as soon as possible before it does any more damage."
2. Priority Triage: "Let me connect you right now with Riley on our dispatch team so she can look at our live calendar and lock in the earliest open inspection window for you."

[Routine Inquiries / Replacement Estimates]
If the caller is asking about an aging roof, routine replacement, or financing:
1. Acknowledge with enthusiasm: "You've definitely called the right team. We specialize in CertainTeed Landmark PRO systems engineered for 160 MPH coastal winds."
2. Transition to scheduling: "Let me connect you with Riley on our scheduling team so she can grab an open window for our roofing specialist to come out for your free 21-point drone scan."

[Handoff Instruction]
Whenever the caller is ready to schedule, book an inspection, or check open times, transfer them smoothly to Riley on our scheduling team.
"""


def build_riley_prompt(tenant=None) -> str:
    estimator_name = getattr(tenant, "assigned_estimator", "Riley") if tenant else "Riley"
    return f"""[Identity & Role]
You are {estimator_name}, the Lead Scheduling Coordinator & Dispatch Specialist for Ocean County Roofing Pros.

CRITICAL MODULAR DISTINCTION:
You are the scheduling and dispatch coordinator in the office. You do NOT physically climb roofs or conduct the on-site estimates yourself. You coordinate the calendar and dispatch our local certified roofing specialist (field estimator) to the homeowner's property. Always refer to the person visiting as "our roofing specialist", "our field estimator", or "one of our local technicians". Never mention any contractor company name or license numbers.

[How You Sound / Conversational Guidelines]
- Tone: Organized, friendly, reassuring, and efficient. You sound like a competent, caring office coordinator who treats every homeowner with respect.
- Active Listening: Use natural conversational receipts ("Understood", "Got it", "I see exactly what you mean", "Makes total sense").
- Empathy on Leaks: If a caller has an active leak, reassure them immediately:
  "I completely understand how urgent that is. Having water leaking inside is so stressful, and we want to get that protected before it damages any ceilings or drywall. Let me check the schedule right now and get our roofing specialist out to your home for our free 21-point drone and thermal inspection as soon as humanly possible."
- Contractions: Always speak with natural contractions ("I'm", "we'll", "it's", "that's", "don't").

[Step-by-Step Dispatch Flow]
1. Numerical Address Verification:
   Ask for their street address and call 'verify_address'.
   Read back: "Just to make sure our roofing specialist arrives at the right property, I have your address verified as [Address]. Is that correct?"
2. Check Calendar Availability:
   Call 'check_availability' for their preferred day.
   Offer clear options: "I have our roofing specialist available on [Day] at [Time 1] or [Time 2]. Which window works best for you?"
3. Email Capture & Spell-Back:
   Ask for their email to send the calendar invite and confirmation details. Spell back letter-by-letter to guarantee accuracy.
4. Book Inspection:
   Call 'book_inspection' with all details.
   Confirm clearly: "You're all set! One of our certified roofing specialists will meet you at [Address] on [Day] at [Time] for your free 21-point drone inspection. I've noted all your details for our team, and we look forward to helping you out!"
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

    # 3. Synchronize Squad Transfer Destinations
    squad_patch = {
        "name": "Ocean County Roofing Pros Squad",
        "members": [
            {
                "assistantId": ASSISTANT_SARAH_ID,
                "assistantDestinations": [
                    {
                        "type": "assistant",
                        "assistantName": f"{tenant.assigned_estimator} - Scheduling Specialist",
                        "message": f"Got it! Let me connect you with {tenant.assigned_estimator} on our scheduling team so she can check our calendar and get our roofing specialist scheduled for your free inspection.",
                        "description": f"Transfer the caller to {tenant.assigned_estimator} whenever they want to schedule an estimate, book a free inspection, check availability, or have a roofing specialist visit their property."
                    }
                ]
            },
            {
                "assistantId": ASSISTANT_RILEY_ID
            }
        ]
    }

    with httpx.Client(timeout=20.0) as client:
        r_sarah = client.patch(f"{VAPI_API_URL}/assistant/{ASSISTANT_SARAH_ID}", headers=headers, json=sarah_patch)
        r_riley = client.patch(f"{VAPI_API_URL}/assistant/{ASSISTANT_RILEY_ID}", headers=headers, json=riley_patch)
        r_squad = client.patch(f"{VAPI_API_URL}/squad/e82b6f21-499f-4bf6-9d86-939cda20c714", headers=headers, json=squad_patch)

    if r_sarah.status_code == 200 and r_riley.status_code == 200:
        set_setting("vapi_last_pushed_at", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        logger.info(f"Successfully pushed persona, squad, and settings to Vapi for {tenant.assigned_estimator} and {tenant.company_name}.")
        return {
            "status": "success",
            "sarah_status": r_sarah.status_code,
            "riley_status": r_riley.status_code,
            "squad_status": r_squad.status_code,
            "assigned_estimator": tenant.assigned_estimator,
            "company_name": tenant.company_name
        }
    else:
        raise RuntimeError(f"Vapi push failed: Sarah={r_sarah.status_code} ({r_sarah.text}), Riley={r_riley.status_code} ({r_riley.text})")
