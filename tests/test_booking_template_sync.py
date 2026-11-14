from pathlib import Path
from datetime import datetime
import json
from starlette.testclient import TestClient

from app.main import app
from app.services.db import delete_lead, get_lead, get_tenant, upsert_tenant, get_setting, set_setting


def test_built_static_pages_include_shared_booking_widget():
    """Verify build_static.py outputs shared 4-step booking widget, Step 4 calendar, Call & Email UI on home & town pages."""
    dist_dir = Path("dist")
    pages = [
        dist_dir / "index.html",
        dist_dir / "roofing-toms-river-nj" / "index.html",
        dist_dir / "roofing-brick-nj" / "index.html",
    ]
    for page in pages:
        assert page.exists(), f"Expected static build file: {page}"
        html = page.read_text(encoding="utf-8")
        assert 'id="quizSection"' in html
        assert 'id="quizStep4"' in html
        assert 'id="calendarPickerContainer"' in html
        assert 'id="step4BallparkCard"' in html
        assert 'id="emailInquiryMode"' in html
        assert 'riley@oceancountyroofingpros.com' in html
        assert 'tel:+17326609121' in html
        assert '/static/js/lead_booking.js' in html
        assert '319 Webster' not in html

    js_path = dist_dir / "static" / "js" / "lead_booking.js"
    assert js_path.exists()
    js_text = js_path.read_text(encoding="utf-8")
    assert '/api/calendar/availability' in js_text
    assert '/api/calendar/book' in js_text
    assert 'applyEstimatorSelectionToWidget' in js_text


def test_fastapi_calendar_availability_and_email_inquiry_parity():
    """Verify FastAPI parity endpoints for /api/calendar/availability, /api/calendar/book, and email-mode webform."""
    client = TestClient(app)

    # 1. Availability returns curated Mon-Sat days for google_calendar tenant
    r_avail = client.get("/api/calendar/availability?city=Toms%20River&days=4")
    assert r_avail.status_code == 200
    avail_data = r_avail.json()
    assert avail_data["status"] == "success"
    assert avail_data["scheduling_type"] == "google_calendar"
    assert len(avail_data["days"]) >= 1
    assert len(avail_data["days"][0]["slots"]) >= 1

    # 2. Email-only inquiry mode succeeds without phone
    r_email = client.post(
        "/api/leads/webform",
        json={
            "first_name": "EmailTester",
            "phone": "",
            "email": "email.tester@example.com",
            "city": "Toms River",
            "contact_preference": "email",
            "service": "Email Estimate & Inspection Inquiry",
            "notes": "Testing in-card email mode",
        },
    )
    assert r_email.status_code == 200
    email_lead_id = r_email.json()["lead_id"]

    try:
        # 3. Booking endpoint binds slot to existing lead_id
        day = avail_data["days"][0]
        slot = day["slots"][0]
        r_book = client.post(
            "/api/calendar/book",
            json={
                "lead_id": email_lead_id,
                "date": day["date"],
                "display_day": day["display_label"],
                "time": slot["time"],
                "name": "EmailTester",
                "phone": "+17325550188",
                "email": "email.tester@example.com",
                "address": "10 Main St, Toms River, NJ",
                "city": "Toms River",
            },
        )
        assert r_book.status_code == 200
        book_json = r_book.json()
        assert book_json["status"] == "success"
        assert day["date"] in book_json["appointment_slot"]

        updated = get_lead(email_lead_id)
        assert updated is not None
        assert updated["status"] == "Inspection Booked"
        assert day["date"] in updated["appointment_slot"]
    finally:
        delete_lead(email_lead_id)


def test_built_portal_and_embed_markup_present():
    """Verify partner portal self-service availability UI and inline embed iframe build cleanly."""
    dist_dir = Path("dist")
    portal_html = (dist_dir / "portal" / "index.html").read_text(encoding="utf-8")
    assert 'id="settingsIcsUrl"' in portal_html
    assert 'name="availDay"' in portal_html
    assert 'name="availWin"' in portal_html
    assert 'id="settingsMinNotice"' in portal_html
    assert 'id="settingsMaxPerDay"' in portal_html
    assert 'id="settingsBlackoutDates"' in portal_html
    assert "testPartnerIcsFeed" in portal_html
    assert "/api/portal/settings" in portal_html
    assert "/api/portal/test-ics" in portal_html

    home_html = (dist_dir / "index.html").read_text(encoding="utf-8")
    assert 'id="externalEmbedWrapper"' in home_html
    assert 'id="externalBookingIframe"' in home_html

    js_text = (dist_dir / "static" / "js" / "lead_booking.js").read_text(encoding="utf-8")
    assert "/api/calendar/webhook" in js_text
    assert "calendly.event_scheduled" in js_text


def test_fastapi_portal_settings_preservation_and_webhook_parity():
    """Verify POST /api/portal/settings preserves sensitive fields & enforces schedule rules, and POST /api/calendar/webhook updates leads."""
    client = TestClient(app)
    orig_tenant = get_tenant("client_joe_the_roofer")
    orig_sched_raw = get_setting("tenant_schedule_client_joe_the_roofer", "")

    r_create = client.post(
        "/api/leads/webform",
        json={
            "first_name": "WebhookTester",
            "phone": "",
            "email": "webhook.tester@example.com",
            "city": "Brick",
            "contact_preference": "email",
            "service": "Roof Inspection",
        },
    )
    assert r_create.status_code == 200
    lead_id = r_create.json()["lead_id"]

    try:
        # 1. Save portal schedule settings and verify portal_pin & calendar_id preserved
        r_save = client.post(
            "/api/portal/settings",
            json={
                "tenant_id": "client_joe_the_roofer",
                "company_name": orig_tenant["company_name"],
                "estimator_name": orig_tenant["estimator_name"],
                "scheduling_type": "google_calendar",
                "booking_url": orig_tenant.get("booking_url") or "",
                "dispatch_phone": orig_tenant["dispatch_phone"],
                "email": orig_tenant.get("email") or "riley@oceancountyroofingpros.com",
                "ics_feed_url": "",
                "availability": {
                    "days_of_week": ["Tue", "Thu"],
                    "windows": ["9:00 AM"],
                    "min_notice": "next_day",
                    "max_per_day": 3,
                    "blackout_dates": [],
                },
            },
        )
        assert r_save.status_code == 200
        after_tenant = get_tenant("client_joe_the_roofer")
        assert after_tenant["portal_pin"] == orig_tenant["portal_pin"]
        assert after_tenant.get("calendar_id") == orig_tenant.get("calendar_id")
        assert after_tenant["monthly_retainer"] == orig_tenant["monthly_retainer"]

        # 2. Verify GET /api/portal/data hydrates availability
        r_portal = client.get("/api/portal/data?tenant_id=client_joe_the_roofer")
        assert r_portal.status_code == 200
        portal_json = r_portal.json()
        assert portal_json["tenant"]["availability"]["windows"] == ["9:00 AM"]

        # 3. Verify GET /api/calendar/availability respects custom windows & days
        r_avail = client.get("/api/calendar/availability?city=Brick&days=7")
        assert r_avail.status_code == 200
        avail = r_avail.json()
        assert len(avail["days"]) >= 1
        assert all(datetime.strptime(d["date"], "%Y-%m-%d").strftime("%a") in ("Tue", "Thu") for d in avail["days"])
        assert all([s["time"] for s in d["slots"]] == ["9:00 AM"] for d in avail["days"])

        # 4. Verify POST /api/calendar/webhook updates lead status & slot
        r_wh = client.post(
            "/api/calendar/webhook",
            json={
                "event": "invitee.created",
                "payload": {
                    "scheduled_event": {"start_time": "2026-11-19T14:00:00Z"},
                    "tracking": {"utm_content": lead_id},
                },
            },
        )
        assert r_wh.status_code == 200
        updated = get_lead(lead_id)
        assert updated["status"] == "Inspection Booked"
        assert "2026-11-19" in updated["appointment_slot"]
    finally:
        delete_lead(lead_id)
        if orig_tenant:
            upsert_tenant(orig_tenant)
        set_setting("tenant_schedule_client_joe_the_roofer", orig_sched_raw)


def test_built_emergency_dispatch_ui_and_header_copy():
    """Verify portal/admin/lead widget emergency dispatch markup and honest 24/7 intake copy build into dist/."""
    dist_dir = Path("dist")
    portal_html = (dist_dir / "portal" / "index.html").read_text(encoding="utf-8")
    assert 'id="portalEmergencyDispatchBox"' in portal_html
    assert 'id="settingsEmergencyEnabled"' in portal_html
    assert 'id="settingsEmergencyMode"' in portal_html
    assert 'id="settingsEmergencyPhone"' in portal_html
    assert 'id="settingsEmergencyHours"' in portal_html
    assert 'id="settingsMaxResponseEta"' in portal_html
    assert 'id="settingsTarpingFeeNote"' in portal_html
    assert "onEmergencyToggleChange" in portal_html

    admin_html = (dist_dir / "admin" / "index.html").read_text(encoding="utf-8")
    assert 'id="emergencyOverflowSelect"' in admin_html
    admin_js = (dist_dir / "static" / "js" / "admin_control_plane.js").read_text(encoding="utf-8")
    assert "emergency_dispatch_policy" in admin_js

    home_html = (dist_dir / "index.html").read_text(encoding="utf-8")
    assert "24/7 Intake" in home_html
    assert "Storm Intake &amp; Triage" in home_html
    assert 'id="emergencyBannerTitle"' in home_html
    assert 'id="emergencyBannerBody"' in home_html
    assert 'id="emergencyFeeNoteText"' in home_html
    assert "319 Webster" not in home_html

    booking_js = (dist_dir / "static" / "js" / "lead_booking.js").read_text(encoding="utf-8")
    assert "updateEmergencyBannerUI" in booking_js


def test_fastapi_emergency_config_portal_admin_and_webform_parity():
    """Verify FastAPI parity for emergency portal opt-in, admin overflow policy, calendar emergency_dispatch, and webform emergency priority."""
    client = TestClient(app)
    orig_tenant = get_tenant("client_joe_the_roofer")
    orig_emerg_raw = get_setting("tenant_emergency_client_joe_the_roofer", "")
    orig_policy_raw = get_setting("emergency_dispatch_policy", "")
    orig_routing_raw = get_setting("territory_routing_json", "{}")
    created_lead_id = None

    try:
        # 1. Save portal settings with emergency_config enabled
        r_save = client.post(
            "/api/portal/settings",
            json={
                "tenant_id": "client_joe_the_roofer",
                "company_name": orig_tenant["company_name"],
                "estimator_name": orig_tenant["estimator_name"],
                "scheduling_type": orig_tenant.get("scheduling_type") or "google_calendar",
                "booking_url": orig_tenant.get("booking_url") or "",
                "dispatch_phone": orig_tenant["dispatch_phone"],
                "email": orig_tenant.get("email") or "riley@oceancountyroofingpros.com",
                "emergency_config": {
                    "emergency_enabled": True,
                    "emergency_mode": "sms_callback",
                    "emergency_phone": "+17325550177",
                    "emergency_hours": "24_7",
                    "max_response_eta_min": 15,
                    "tarping_fee_note": "Emergency tarping estimate given upfront before work starts.",
                },
            },
        )
        assert r_save.status_code == 200

        r_portal = client.get("/api/portal/data?tenant_id=client_joe_the_roofer")
        assert r_portal.status_code == 200
        portal_em = r_portal.json()["tenant"]["emergency_config"]
        assert portal_em["emergency_enabled"] is True
        assert portal_em["emergency_phone"] == "+17325550177"
        assert portal_em["max_response_eta_min"] == 15

        # 2. Save admin overflow policy
        r_route = client.post(
            "/api/admin/routing",
            json={
                "territory_routing": json.loads(orig_routing_raw or "{}"),
                "emergency_dispatch_policy": {"overflow_tenant_id": "client_joe_the_roofer"},
            },
        )
        assert r_route.status_code == 200
        r_route_get = client.get("/api/admin/routing")
        assert r_route_get.status_code == 200
        assert r_route_get.json()["emergency_dispatch_policy"]["overflow_tenant_id"] == "client_joe_the_roofer"

        # 3. Availability exposes emergency_dispatch state
        r_avail = client.get("/api/calendar/availability?city=Toms%20River&urgent=true&days=4")
        assert r_avail.status_code == 200
        avail_json = r_avail.json()
        assert "emergency_dispatch" in avail_json
        assert avail_json["emergency_dispatch"]["available_now"] is True

        # 4. Webform sets Emergency Priority on Active Water Leak
        r_web = client.post(
            "/api/leads/webform",
            json={
                "first_name": "StormCaller",
                "phone": "+17325550166",
                "email": "storm@example.com",
                "city": "Toms River",
                "urgency": "Emergency",
                "situation": "Active Water Leak",
                "service": "Emergency Leak Repair",
                "notes": "Ceiling dripping during rain",
            },
        )
        assert r_web.status_code == 200
        web_json = r_web.json()
        created_lead_id = web_json["lead_id"]
        assert web_json["emergency_dispatch"]["available_now"] is True
        lead_row = get_lead(created_lead_id)
        assert lead_row is not None
        assert lead_row["status"] == "Emergency Priority"
    finally:
        if created_lead_id:
            delete_lead(created_lead_id)
        if orig_tenant:
            upsert_tenant(orig_tenant)
        set_setting("tenant_emergency_client_joe_the_roofer", orig_emerg_raw)
        set_setting("emergency_dispatch_policy", orig_policy_raw)
        set_setting("territory_routing_json", orig_routing_raw)


def test_mandatory_email_validation_and_static_required_attribute():
    """Verify FastAPI webform and calendar booking reject missing/invalid email and static widget requires email."""
    import re as _re
    from pathlib import Path
    project_root = Path(__file__).resolve().parent.parent
    toms_river_html = (project_root / "dist" / "roofing-toms-river-nj" / "index.html").read_text(encoding="utf-8")
    assert _re.search(r'<input[^>]*id="email"[^>]*required', toms_river_html)
    client = TestClient(app)

    bad_web = client.post(
        "/api/leads/webform",
        json={
            "first_name": "NoEmail",
            "phone": "732-555-0199",
            "address": "211 Center Street, Lakehurst, nj",
            "city": "Lakehurst",
        },
    )
    assert bad_web.status_code == 400
    assert "email" in bad_web.json().get("detail", "").lower()

    bad_book = client.post(
        "/api/calendar/book",
        json={
            "lead_id": "WEB-MISSING-EMAIL",
            "date": "2026-11-16",
            "time": "09:00 AM",
            "name": "No Email",
            "phone": "732-555-0199",
            "email": "not-an-email",
            "address": "211 Center Street, Lakehurst, nj",
            "city": "Lakehurst",
        },
    )
    assert bad_book.status_code == 400
    assert "email" in bad_book.json().get("detail", "").lower()


def test_drone_section_kept_with_upon_request_copy_only():
    """Verify #inspection section & drone image stay intact while all copy states aerial drones are upon request only."""
    from pathlib import Path
    project_root = Path(__file__).resolve().parent.parent
    for rel_path in ["dist/index.html", "dist/roofing-toms-river-nj/index.html"]:
        html = (project_root / rel_path).read_text(encoding="utf-8")
        assert 'id="inspection"' in html
        assert "/static/images/drone-thermal-inspection.webp" in html
        assert "Aerial & Thermal Diagnostics (Available Upon Request)" in html
        assert "upon request" in html.lower()
        assert "Zero Foot Traffic" not in html
        assert "Free 21-point drone inspection" not in html
        assert "4K Aerial Shingle" not in html
        assert "proprietary aerial scan" not in html
        assert "High-Resolution Drone &amp; Crease Evidence" not in html
        assert "21-Point Drone &amp; Attic Audit" not in html
