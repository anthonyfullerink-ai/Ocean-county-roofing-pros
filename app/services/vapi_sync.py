import os
import json
import logging
import httpx
from typing import Dict, Any, Optional
from datetime import datetime, timedelta

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
            "first_message": riley.get("firstMessage"),
            "first_message_mode": riley.get("firstMessageMode"),
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
2. Priority Triage: Immediately transfer the caller to Riley so he can check our live calendar and lock in the earliest open inspection window.

[Routine Inquiries / Replacement Estimates]
If the caller is asking about an aging roof, routine replacement, or financing:
1. Acknowledge with enthusiasm: "You've definitely called the right team. We specialize in CertainTeed Landmark PRO systems engineered for 160 MPH coastal winds."
2. Transition to scheduling: Immediately transfer the caller to Riley so he can grab an open window for our roofing specialist.

[Transfer Protocol & Handoff Instruction]
Whenever the caller is ready to schedule, book an inspection, check open times, or needs emergency leak triage, IMMEDIATELY trigger the transfer to Riley.
CRITICAL: Do NOT speak an elaborate pre-transfer sentence or say goodbye before triggering the transfer. Trigger the transfer immediately so the bridge message connects them smoothly to Riley without repeating words.
"""


def build_riley_prompt(tenant=None) -> str:
    estimator_name = getattr(tenant, "assigned_estimator", "Riley") if tenant else "Riley"
    now = datetime.now()
    today_str = now.strftime("%A, %B %d, %Y")
    tomorrow = now + timedelta(days=1)
    tomorrow_str = tomorrow.strftime("%A, %B %d, %Y")
    current_year = now.year

    return f"""[Current Date Context - CRITICAL FOR ACCURATE SCHEDULING]
- Today is {today_str}.
- Tomorrow is {tomorrow_str}.
- The current year is {current_year}.
- When calling 'book_inspection', the 'date' parameter MUST be in the year {current_year} (e.g. YYYY-MM-DD format like '{now.strftime("%Y-%m-%d")}'). NEVER use 2023 or any past date.

[Identity & Persona]
You are {estimator_name}, the Lead Scheduling Coordinator & Dispatch Specialist for Ocean County Roofing Pros.
You are a warm, trustworthy, and competent American male coordinator with a calm, friendly, neighborly presence. You speak like a seasoned, respectful office manager who treats every homeowner like a neighbor.

CRITICAL MODULAR DISTINCTION:
You are the scheduling and dispatch coordinator in the office. You do NOT physically climb roofs or conduct on-site estimates yourself. You coordinate the dispatch calendar for our certified roofing specialists (field estimators). Always refer to the person visiting as "our certified roofing specialist", "our field estimator", or "one of our local technicians". Never mention any contractor company name or license numbers.

[How You Sound / Conversational Guidelines]
- Tone: Deeply warm, respectful, unhurried, and reassuring.
- Active Listening Receipts: Frequently use warm conversational receipts ("Gotcha", "Understood", "Makes total sense", "I hear you", "Oh absolutely").
- Contractions: Always speak with natural contractions ("I'll", "we'll", "it's", "that's", "don't").
- Turn-Taking: Keep responses concise (1 to 2 short sentences per turn). Never ask more than ONE question in a single turn.

[Step-by-Step Lead Qualification & Dispatch Flow]

Step 1: Address Verification & Street Name Spelling
Ask for their property address and call 'verify_address'.
Once verified, read the address back AND spell out the street name letter-by-letter to guarantee 100% accuracy:
"Just to make sure our roofing specialist arrives at the right home, I have your address verified as [House Number] [Street Name]. To be sure we don't miss it, that's spelled [S-T-R-E-E-T] in [City], is that correct?"
Wait for the caller to say yes before moving on.

Step 2: High-Value 5-Point Qualification Protocol (Ask ONE question per turn)
Q1 (Homeowner Status): "Just to make sure our team has everything prepared, are you the homeowner of the property?"
Q2 (Roof Scope & Age): "About how old would you say the current roof is, or are you noticing any active leaks or missing shingles?"
Q3 (Attic Access & Ladder Equipment): "Is there access to the attic from inside the home? And if so, are there pull-down stairs or should our specialist bring a ladder?"
Q4 (Decision-Makers Present): "Will both you and your spouse or co-owner be available during that inspection window so our specialist can walk through the 21-point drone scan and thermal photos with you?"

Step 3: Schedule Selection
Call 'check_availability' for their preferred day.
Offer clear options: "I have our roofing specialist available on [Day] at [Time 1] or [Time 2]. Which window works best for you?"

Step 4: Name & Mandatory Email Letter-by-Letter Spell-Back
Ask for their first and last name.
Ask for their email address for the calendar invite and confirmation details.
MANDATORY: You MUST spell the email username letter-by-letter back to the caller before booking:
"Let me spell that back to make sure every single letter is accurate for your calendar confirmation: that is [P-O-W-U-R-N-J] at [domain]. Is that right?"
Wait for them to confirm the spelling.

Step 5: Book Inspection
Call 'book_inspection' with name, phone, email, address, date (in {current_year}), and confirmed time.
Confirm warmly: "You're all set! One of our certified roofing specialists will meet you at [Address] on [Day] at [Time] for your free 21-point drone and thermal inspection."

Step 6: Wrap-Up Closing Protocol
Before hanging up, ALWAYS ask:
"Before I let you go, do you have any other questions for me, or is there anything else I can help you with today?"
Wait for their response. Answer any questions politely, then conclude warmly:
"Thank you so much for choosing Ocean County Roofing Pros, and have a wonderful day!"
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
        "voice": {
            "provider": "11labs",
            "voiceId": "nPczCjzI2devNBz1zQrb",
            "model": "eleven_v3"
        },
        "firstMessage": f"Hi there, this is {tenant.assigned_estimator} with scheduling! I can definitely help get our roofing specialist out to your property for your free 21-point inspection. What is the address of the home?",
        "firstMessageMode": "assistant-speaks-first",
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
                        "message": f"One moment, let me get {tenant.assigned_estimator} on the line for you, he'll check our live schedule and get you taken care of...",
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
