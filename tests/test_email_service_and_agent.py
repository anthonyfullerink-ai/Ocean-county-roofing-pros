"""
Comprehensive Test Suite for Rank-and-Rent Autonomous Email System
Tests real Node.js execution of AIEmailAgent (entity extraction, cold lead conversion,
threaded follow-ups, multi-tenant attribution, dual alerting, and vendor spam shielding).
"""
import pytest
import subprocess
import json
import os

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
HANDLER_PATH = os.path.join(PROJECT_ROOT, "netlify", "functions", "services", "ai-email-handler.mjs").replace("\\", "/")


def run_node_analysis(payload: dict) -> dict:
    """Executes AIEmailAgent.deterministicAnalysis directly in Node.js for strict verification."""
    js_script = f"""
    import {{ AIEmailAgent }} from "file://{HANDLER_PATH}";
    const payload = {json.dumps(payload)};
    const result = AIEmailAgent.deterministicAnalysis(payload);
    console.log(JSON.stringify(result));
    """
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", js_script],
        capture_output=True,
        text=True,
        check=True
    )
    return json.loads(proc.stdout.strip())


def test_cold_lead_anthony_fuller_entity_extraction_and_reply():
    """
    Simulate the exact cold email sent by the user:
    Header: "Offgrid Media" <mediaoffgrid@gmail.com>
    Subject: Roof estimate
    Body: Hi I was looking to get a roof estimate. Anthony Fuller, Off-Grid Media, (732) 503-9880
    Verify entity extraction, non-canned response, and operator/contractor alerting.
    """
    payload = {
        "senderEmail": "mediaoffgrid@gmail.com",
        "headerName": "Offgrid Media",
        "subject": "Roof estimate",
        "textBody": "Hi I was looking to get a roof estimate.\n\nAnthony Fuller\nOff-Grid Media\n(732) 503-9880\n",
        "tenant": {
            "tenant_id": "client_joe_the_roofer",
            "company_name": "Joe The Roofer LLC",
            "estimator_name": "Riley",
            "booking_url": ""
        },
        "existingLead": None
    }

    res = run_node_analysis(payload)

    assert res["intent"] == "COLD_LEAD_ESTIMATE"
    assert res["entities"]["name"] == "Anthony Fuller"
    assert res["entities"]["phone"] == "(732) 503-9880"
    assert res["should_alert_owner"] is True
    assert res["should_alert_contractor"] is True

    # Ensure non-canned conversion copy
    reply = res["reply_body"]
    assert "Hi Anthony," in reply
    assert "(732) 503-9880" in reply
    assert "Free 21-Point Drone & Thermal Roof Inspection" in reply
    assert "street address" in reply.lower()
    assert "Morning (9:00 AM - 12:00 PM)" in reply
    assert "Our team is reviewing your inquiry" not in reply  # Old canned response removed


def test_cold_lead_with_external_contractor_booking_url():
    """Verify multi-tenant scaling when active contractor uses an external booking URL."""
    payload = {
        "senderEmail": "jane@homeowner.com",
        "headerName": "Jane Miller",
        "subject": "Shingle repair quote",
        "textBody": "We lost 5 shingles in the storm. Can someone inspect? Call 732-555-8821.",
        "tenant": {
            "tenant_id": "client_apex_roofing",
            "company_name": "Apex Shore Roofing & Restoration LLC",
            "estimator_name": "Tyler",
            "booking_url": "https://calendly.com/apex-shore-roofing/21-point-drone-inspection"
        },
        "existingLead": None
    }

    res = run_node_analysis(payload)
    assert res["intent"] == "COLD_LEAD_ESTIMATE"
    assert res["entities"]["phone"] == "732-555-8821"
    assert "https://calendly.com/apex-shore-roofing/21-point-drone-inspection" in res["reply_body"]


def test_threaded_followup_locks_in_booking():
    """Verify existing customer replying with address & time automatically books slot."""
    payload = {
        "senderEmail": "mediaoffgrid@gmail.com",
        "headerName": "Anthony Fuller",
        "subject": "Re: Roof estimate",
        "textBody": "Our address is 142 Bayview Avenue, Toms River. Tomorrow morning around 10am works great.",
        "tenant": {
            "tenant_id": "client_joe_the_roofer",
            "company_name": "Joe The Roofer LLC",
            "estimator_name": "Riley"
        },
        "existingLead": {
            "id": "EMAIL-991122",
            "first_name": "Anthony",
            "last_name": "Fuller",
            "phone": "(732) 503-9880",
            "street_address": "",
            "service_requested": "Roof Estimate & 21-Point Inspection",
            "status": "New Lead (Email)"
        }
    }

    res = run_node_analysis(payload)
    assert res["intent"] == "THREADED_FOLLOWUP"
    assert "142 Bayview Avenue" in res["entities"]["street_address"]
    assert res["entities"]["preferred_date"].lower() == "tomorrow"
    assert res["should_book_immediately"] is True
    assert "officially locked in" in res["reply_body"]
    assert res["should_alert_owner"] is True
    assert res["should_alert_contractor"] is True


def test_emergency_active_leak_escalation():
    """Verify active storm leak triggers priority escalation and emergency messaging."""
    payload = {
        "senderEmail": "urgent@shorehome.com",
        "headerName": "Bob Ross",
        "subject": "URGENT roof leak",
        "textBody": "Water is pouring through our ceiling after the storm! 88 Cedar St, Brick NJ. 732-555-0192.",
        "tenant": {
            "tenant_id": "client_joe_the_roofer",
            "company_name": "Joe The Roofer LLC"
        },
        "existingLead": None
    }

    res = run_node_analysis(payload)
    assert res["intent"] == "EMERGENCY_LEAK"
    assert res["entities"]["urgency"] == "Emergency"
    assert res["should_alert_owner"] is True
    assert res["should_alert_contractor"] is True
    assert "(732) 660-9121" in res["reply_body"]


def test_vendor_spam_is_silenced():
    """Verify B2B SEO/backlink spam is blocked from triggering owner/contractor alerts."""
    payload = {
        "senderEmail": "sales@seoagency.io",
        "headerName": "Marketing Guru",
        "subject": "Rank #1 on Google for roofing",
        "textBody": "We offer backlink building and SEO ranking services. Click here to unsubscribe.",
        "tenant": {
            "tenant_id": "client_joe_the_roofer",
            "company_name": "Joe The Roofer LLC"
        },
        "existingLead": None
    }

    res = run_node_analysis(payload)
    assert res["intent"] == "VENDOR_SPAM"
    assert res["should_alert_owner"] is False
    assert res["should_alert_contractor"] is False
    assert res["reply_body"] == ""
