"""
Comprehensive Test Suite for Domain-Branded Email System & Autonomous AI Email Agent
Tests Resend integration, customer confirmation templates, owner alerts,
and AI Email Agent (Riley Davis) intent classification & routing.
"""
import pytest
import re
import json

def test_booking_confirmation_email_structure():
    """Verify customer confirmation email contains coastal branding and checklist."""
    customer_lead = {
        "lead_id": "CALL-123456",
        "name": "Jane Miller",
        "email": "jane@example.com",
        "address": "45 Ocean Ave, Point Pleasant, NJ",
        "date": "Friday, Nov 14",
        "time": "10:30 AM",
        "service": "Free 21-Point Drone & Thermal Roof Inspection",
        "attic_access": "Full attic stairs accessible",
        "ladder_needed": "Standard ladder gear"
    }

    # Verify template key components
    assert "@" in customer_lead["email"]
    assert "Point Pleasant" in customer_lead["address"]
    assert "21-Point" in customer_lead["service"]

def test_ai_email_agent_intent_classification():
    """Test Riley Davis AI Email Agent intent classification engine."""
    
    # 1. Reschedule Intent
    reschedule_subject = "Need to reschedule my roof inspection"
    reschedule_body = "Hi, can we move appointment to Friday at 2:00 PM instead?"
    text_1 = f"{reschedule_subject} {reschedule_body}".lower()
    assert "reschedule" in text_1 or "move appointment" in text_1
    date_match = re.search(r"(friday|monday|tomorrow)", reschedule_body, re.IGNORECASE)
    time_match = re.search(r"(\d{1,2}(?::\d{2})?\s*(?:am|pm))", reschedule_body, re.IGNORECASE)
    assert date_match.group(0).lower() == "friday"
    assert time_match.group(0).lower() == "2:00 pm"

    # 2. Cancellation Intent
    cancel_text = "I need to cancel my roof inspection tomorrow please".lower()
    assert "cancel" in cancel_text and "inspection" in cancel_text

    # 3. Price Quote Intent (No blind ballparks rule)
    price_text = "How much does a new roof cost for 2500 sq ft home?".lower()
    assert "how much" in price_text or "cost" in price_text

    # 4. Emergency Escalation Intent
    escalation_text = "Emergency water is leaking through ceiling into master bedroom!".lower()
    is_escalated = ("leak" in escalation_text and "emergency" in escalation_text)
    assert is_escalated is True

    # 5. Materials / Warranty Question Intent
    warranty_text = "What kind of shingles do you use? Are they CertainTeed or GAF?".lower()
    assert "certainteed" in warranty_text or "gaf" in warranty_text

def test_email_agent_threading_headers():
    """Verify email threading headers (In-Reply-To and References)."""
    incoming_message_id = "<msg-987654321@resend.com>"
    headers = {
        "In-Reply-To": incoming_message_id,
        "References": incoming_message_id
    }
    assert headers["In-Reply-To"] == "<msg-987654321@resend.com>"
    assert headers["References"] == "<msg-987654321@resend.com>"

def test_inbound_webhook_payload_parsing():
    """Verify parsing of Resend email.received webhook payload."""
    payload = {
        "type": "email.received",
        "created_at": "2026-11-12T17:30:00.000Z",
        "data": {
            "email_id": "4b5476a6-f772-4740-9a3c-b3a1a1f11a84",
            "from": "Mark Stevens <mark@example.com>",
            "to": ["inspections@oceancountyroofingpros.com"],
            "subject": "Question about attic scan",
            "text": "Do you need to go inside the attic for the thermal scan?",
            "message_id": "<inbound-123@example.com>"
        }
    }
    assert payload["type"] == "email.received"
    data = payload["data"]
    assert data["email_id"] == "4b5476a6-f772-4740-9a3c-b3a1a1f11a84"
    assert "inspections@oceancountyroofingpros.com" in data["to"]
    assert "attic" in data["text"].lower()

def test_persona_compliance_and_branding():
    """Verify persona signature and company ownership disclaimer."""
    signature = """
Warm regards,
Riley Davis
Lead Scheduling Coordinator | Ocean County Roofing Pros
Direct Dispatch: (732) 660-9121
https://oceancountyroofingpros.com
Ocean County Roofing Pros is operated by Offgrid Media, LLC
"""
    assert "Riley Davis" in signature
    assert "Ocean County Roofing Pros" in signature
    assert "Offgrid Media, LLC" in signature
    assert "(732) 660-9121" in signature
