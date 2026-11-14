import pytest
from app.services.tenant_manager import TenantManager
from app.services.db import get_active_tenant_record, list_tenants
from app.services.vapi_sync import (
    fetch_vapi_assistant,
    build_sarah_prompt,
    build_riley_prompt,
    ASSISTANT_SARAH_ID,
    ASSISTANT_RILEY_ID,
)


def test_tenant_estimator_updated_to_riley():
    """Verifies that the assigned estimator across configurations is Riley."""
    tenant = TenantManager.get_active_tenant()
    assert tenant.assigned_estimator == "Riley"
    assert tenant.tenant_id == "client_joe_the_roofer"

    db_rec = get_active_tenant_record()
    assert db_rec is not None
    assert db_rec.get("estimator_name") == "Riley"


def test_vapi_assistant_state_and_empathy_prompts():
    """Verifies Vapi assistants exist, and prompts include the active leak empathy protocol."""
    tenant = TenantManager.get_active_tenant()
    sarah_prompt = build_sarah_prompt(tenant)
    riley_prompt = build_riley_prompt(tenant)

    # 1. Verify Riley name in prompts
    assert "Riley" in sarah_prompt
    assert "Riley" in riley_prompt

    # 2. Verify active leak empathy protocol
    assert "Active Leak, Storm Damage & Emergency Protocol" in sarah_prompt
    assert "Having water coming inside the house is so stressful" in sarah_prompt
    assert "21-point roof and attic inspection" in riley_prompt
    assert "roofing specialist" in sarah_prompt
    assert "roofing specialist" in riley_prompt
    assert "CertainTeed" in sarah_prompt

    # 3. Verify zero references to contractor or license numbers (Modular & Contractor-Agnostic)
    assert "Joe The Roofer" not in sarah_prompt
    assert "Joe The Roofer" not in riley_prompt
    assert "13VH" not in sarah_prompt
    assert "13VH" not in riley_prompt
    assert "License #" not in sarah_prompt
    assert "License #" not in riley_prompt


    # 4. Verify Sarah's industry knowledge base and low-friction qualification
    assert "Roofing Industry Knowledge Base" in sarah_prompt
    assert "Sun Exposure & Facing" in sarah_prompt
    assert "Low-Friction Conversational Qualification Flow" in sarah_prompt

    # 5. Verify 5-Point Lead Qualification Protocol & Attic Access in Riley
    assert "homeowner of the property" in riley_prompt
    assert "access to the attic" in riley_prompt
    assert "stairs or should our specialist bring a ladder" in riley_prompt
    assert "spouse or co-owner be available" in riley_prompt

    # 6. Verify Human Representative Request Protocol on BOTH Sarah and Riley
    assert "Human Representative Request Protocol" in sarah_prompt
    assert "request_human_callback" in sarah_prompt
    assert "Human Representative Request Protocol" in riley_prompt
    assert "request_human_callback" in riley_prompt

    # 7. Verify Drone Inspection Policy is strictly "upon request only" on BOTH Sarah and Riley
    assert "upon request only" in sarah_prompt.lower()
    assert "upon request only" in riley_prompt.lower()
    assert "drone roof scan" not in sarah_prompt.lower()
    assert "free 21-point roof & drone" not in sarah_prompt.lower()

    # 6. Verify wrap-up closing inquiry & dynamic date
    assert "anything else I can help you with today" in riley_prompt
    assert "Current Date Context" in riley_prompt


def test_vapi_cloud_assistant_properties():
    """Queries live Vapi Cloud to verify assistant configuration."""
    riley = fetch_vapi_assistant(ASSISTANT_RILEY_ID)
    sarah = fetch_vapi_assistant(ASSISTANT_SARAH_ID)

    assert "Riley" in riley.get("name", "")
    assert riley.get("backchannelingEnabled") is True
    assert riley.get("backgroundDenoisingEnabled") is True
    assert riley.get("startSpeakingPlan", {}).get("waitSeconds") == 0.25
    assert riley.get("transcriber", {}).get("model") == "nova-2"
    assert "Hello, thanks for holding! This is Riley over in scheduling" in riley.get("firstMessage", "")
    assert riley.get("firstMessageMode") == "assistant-speaks-first"
    assert riley.get("voice", {}).get("voiceId") == "nPczCjzI2devNBz1zQrb"
    assert riley.get("voice", {}).get("model") == "eleven_flash_v2_5"
    assert riley.get("voice", {}).get("stability") == 0.55
    assert riley.get("voice", {}).get("speed") == 1.0

    assert "Sarah" in sarah.get("name", "")
    assert sarah.get("backchannelingEnabled") is True
    assert sarah.get("voice", {}).get("model") == "eleven_v3"
