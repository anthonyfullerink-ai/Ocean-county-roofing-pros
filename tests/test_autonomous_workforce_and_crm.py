import io
import os
import csv
import json
from pathlib import Path
import pytest
from PIL import Image
from fastapi.testclient import TestClient

from app.main import app
from app.config import PROJECT_ROOT, settings, load_towns_data
from app.services.db import (
    init_db,
    list_leads,
    get_lead,
    list_job_projects,
    list_reviews,
    list_gbp_posts,
    get_dashboard_kpis,
    get_all_settings,
)
from app.services.comms import SMS_DISPATCH_LOG
from app.agents.media_ingestor import stamp_exif_gps_and_save_webp, verify_exif_gps
from netlify.functions.api import handler as netlify_handler

client = TestClient(app)


@pytest.fixture(autouse=True, scope="module")
def isolated_test_db(tmp_path_factory):
    """Runs all tests against an isolated SQLite mirror and upload dir so production data stays clean."""
    import app.agents.media_ingestor as mi
    orig_db = settings.LOCAL_DB_PATH
    orig_geo = mi.GEOTAGGED_DIR
    orig_webp = mi.WEBP_DIR
    orig_proc = mi.INBOX_PROCESSED_DIR

    tmp_root = tmp_path_factory.mktemp("test_env")
    settings.LOCAL_DB_PATH = str(tmp_root / "test_supabase_mirror.db")
    mi.GEOTAGGED_DIR = tmp_root / "geotagged"
    mi.WEBP_DIR = tmp_root / "webp"
    mi.INBOX_PROCESSED_DIR = tmp_root / "processed"
    init_db()
    yield
    settings.LOCAL_DB_PATH = orig_db
    mi.GEOTAGGED_DIR = orig_geo
    mi.WEBP_DIR = orig_webp
    mi.INBOX_PROCESSED_DIR = orig_proc



def _make_test_jpeg_bytes(width: int = 640, height: int = 480) -> bytes:
    img = Image.new("RGB", (width, height), color=(15, 85, 125))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


def test_health_and_netlify_handler():
    init_db()
    r = client.get("/health")
    assert r.status_code == 200
    data = r.json()
    assert data["status"] == "online"
    assert data["local_mirror_ready"] is True
    assert callable(netlify_handler)


def test_all_10_town_silos_and_dynamic_proof():
    towns = load_towns_data()
    assert len(towns) == 10

    # Check hub page
    hub_resp = client.get("/")
    assert hub_resp.status_code == 200
    assert "Recent Verified Projects" in hub_resp.text
    assert "application/ld+json" in hub_resp.text

    # Check all 10 town silo routes
    for t in towns:
        slug = t["slug"]
        resp = client.get(f"/{slug}")
        assert resp.status_code == 200, f"Town page /{slug} failed"
        assert t["town_name"] in resp.text
        assert "application/ld+json" in resp.text

    # Check dynamic sitemap.xml has all 10 town slugs
    sm = client.get("/sitemap.xml")
    assert sm.status_code == 200
    for t in towns:
        assert t["slug"] in sm.text


def test_exif_gps_stamping_and_verification():
    # Test Ocean County (Point Pleasant, NJ: 40.0829, -74.0682)
    raw_jpg = _make_test_jpeg_bytes()
    res = stamp_exif_gps_and_save_webp(
        image_bytes=raw_jpg,
        base_filename="test_point_pleasant_roof.jpg",
        lat=40.0829,
        lon=-74.0682,
        seo_description="CertainTeed Landmark PRO 160 MPH roof in Point Pleasant, NJ",
    )
    assert os.path.exists(res["jpg_path"])
    assert os.path.exists(res["webp_path"])

    gps_info = verify_exif_gps(res["jpg_path"])
    assert gps_info["has_gps"] is True
    assert abs(gps_info["lat"] - 40.0829) < 0.001
    assert abs(gps_info["lon"] - (-74.0682)) < 0.001
    assert gps_info["lat_ref"] == "N"
    assert gps_info["lon_ref"] == "W"


def test_owner_vs_contractor_hybrid_photo_upload():
    raw_jpg = _make_test_jpeg_bytes()

    # 1. Owner upload via /api/media/upload -> goes live immediately ('approved')
    r_owner = client.post(
        "/api/media/upload",
        data={
            "town": "Brick Township",
            "neighborhood": "Herbertsville",
            "service_type": "Full Roof Replacement",
            "shingle_system": "CertainTeed Landmark PRO",
            "caption": "Owner verified tear-off in Herbertsville",
            "uploaded_by": "owner",
        },
        files={"file": ("brick_owner.jpg", raw_jpg, "image/jpeg")},
    )
    assert r_owner.status_code == 200
    proj_owner = r_owner.json()["project"]
    assert proj_owner["approval_status"] == "approved"
    assert proj_owner["town_slug"] == "roofing-brick-nj"
    assert proj_owner["verified_gps"]["has_gps"] is True

    # 2. Contractor upload via /api/media/upload -> enters 24h hybrid queue ('pending_auto_24h')
    r_contractor = client.post(
        "/api/media/upload",
        data={
            "town": "Jackson",
            "neighborhood": "Brookwood",
            "service_type": "Full Roof Replacement",
            "shingle_system": "CertainTeed Landmark",
            "caption": "Contractor field snap in Brookwood, Jackson",
            "uploaded_by": "contractor",
            "tenant_id": "client_joe_the_roofer",
        },
        files={"file": ("jackson_contractor.jpg", raw_jpg, "image/jpeg")},
    )
    assert r_contractor.status_code == 200
    proj_contractor = r_contractor.json()["project"]
    assert proj_contractor["approval_status"] == "pending_auto_24h"
    assert proj_contractor["auto_publish_at"] != ""

    # 3. Owner approves contractor photo in 1 click
    r_approve = client.post(
        f"/api/admin/projects/{proj_contractor['id']}/action",
        json={"action": "approve"},
    )
    assert r_approve.status_code == 200
    assert r_approve.json()["project"]["approval_status"] == "approved"


def test_full_5_agent_workforce_execution():
    # Ensure a sample photo & testimonial exist in content_inbox/ before running suite
    inbox_photo = PROJECT_ROOT / "content_inbox" / "photos" / "barnegat_bay_install.jpg"
    inbox_photo.parent.mkdir(parents=True, exist_ok=True)
    inbox_photo.write_bytes(_make_test_jpeg_bytes())

    resp = client.post("/api/agents/run-all")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "success"
    assert data["agents_executed"] == 5

    for key in ("media_ingestor", "gbp_seo", "reputation", "watchdog", "briefing"):
        assert key in data["results"]
        assert data["results"][key]["status"] == "success"

    # Verify daily briefing markdown file was generated in outputs/reports/
    briefing_res = data["results"]["briefing"]
    file_path = briefing_res["report"]["file_path"]
    assert file_path and os.path.exists(file_path)


def test_universal_crm_export_and_import_presets():
    # 1. Test all 5 export presets
    for fmt in ("universal_csv", "universal_json", "gohighlevel_csv", "jobnimbus_csv", "hubspot_csv"):
        r = client.get(f"/api/crm/export?format={fmt}")
        assert r.status_code == 200
        assert len(r.text) > 50

    # Verify GoHighLevel headers
    r_ghl = client.get("/api/crm/export?format=gohighlevel_csv")
    reader = csv.reader(io.StringIO(r_ghl.text))
    headers = next(reader)
    assert "Pipeline Stage" in headers
    assert "Lead Value" in headers

    # Verify JobNimbus headers
    r_jn = client.get("/api/crm/export?format=jobnimbus_csv")
    jn_headers = next(csv.reader(io.StringIO(r_jn.text)))
    assert "Display Name" in jn_headers
    assert "Status Name" in jn_headers

    # 2. Test importing external GoHighLevel CSV rows
    sample_ghl_csv = (
        "First Name,Last Name,Phone,Email,Address1,City,State,Postal Code,Pipeline Stage,Lead Value,Notes\n"
        "Anthony,TestLead,732-555-0987,anthony.test@example.com,77 Bay Ave,Manahawkin,NJ,08050,Booked,15400,Imported from GHL\n"
    )
    r_imp = client.post(
        "/api/crm/import",
        files={"file": ("ghl_import.csv", sample_ghl_csv.encode("utf-8"), "text/csv")},
    )
    assert r_imp.status_code == 200
    imp_data = r_imp.json()
    assert imp_data["status"] == "success"
    assert imp_data["total_processed"] >= 1

    # Verify imported lead is in database with mapped fields
    found = get_lead("7325550987")
    assert found is not None
    assert found["first_name"] == "Anthony"
    assert found["city"] == "Manahawkin"
    assert float(found["estimated_value"]) == 15400.0


def test_contractor_portal_1tap_completed_triggers_review_sms():
    # Create a fresh lead via /api/leads/webform
    r_web = client.post(
        "/api/leads/webform",
        json={
            "first_name": "kevin",
            "last_name": "O'Connor",
            "phone": "732-555-0444",
            "address": "19 Ocean Blvd",
            "city": "Point Pleasant",
            "service": "Full Roof Replacement",
            "diagnostic_situation": "Storm & Wind Damage",
            "home_architecture": "Coastal / Lagoon Home",
        },
    )
    assert r_web.status_code == 200
    lead_id = r_web.json()["lead_id"]

    # Contractor logs into /portal with Joe The Roofer PIN (732100)
    r_login = client.post("/api/portal/login", json={"pin": "732100"})
    assert r_login.status_code == 200
    assert r_login.json()["tenant"]["tenant_id"] == "client_joe_the_roofer"

    # Contractor taps 'Booked' -> 'Inspected' -> 'Completed'
    r_booked = client.post(f"/api/portal/leads/{lead_id}/status", json={"status": "Booked"})
    assert r_booked.status_code == 200
    assert r_booked.json()["lead"]["status"] == "Booked"

    prev_sms_count = len(SMS_DISPATCH_LOG)
    r_comp = client.post(
        f"/api/portal/leads/{lead_id}/status",
        json={"status": "Completed", "estimated_value": 16800},
    )
    assert r_comp.status_code == 200
    comp_data = r_comp.json()
    assert comp_data["lead"]["status"] == "Completed"
    assert comp_data["lead"]["review_request_sent"] is True
    assert comp_data["review_sms_result"]["sent"] is True
    assert len(SMS_DISPATCH_LOG) > prev_sms_count
    assert f"/feedback/{lead_id}" in SMS_DISPATCH_LOG[-1]["body"]


def test_portals_and_google_compliant_feedback_hub():
    # 1. Owner Command Center (/admin)
    r_admin = client.get("/admin")
    assert r_admin.status_code == 200
    assert "OWNER COMMAND CENTER" in r_admin.text
    assert "Universal CRM Export & Import Engine" in r_admin.text

    # 2. Contractor Partner Portal (/portal)
    r_portal = client.get("/portal?pin=732100")
    assert r_portal.status_code == 200
    assert "Live Partner ROI Scoreboard" in r_portal.text
    assert "1-Tap Pipeline Update" in r_portal.text

    # 3. Compliant Feedback Hub (/feedback/WEB-171001) — verify BOTH public Google CTA and direct resolution are visible
    r_fb = client.get("/feedback/WEB-171001")
    assert r_fb.status_code == 200
    assert "Post a Public Review on Google" in r_fb.text
    assert "Need Something Fixed Immediately? Message Management Directly" in r_fb.text
    assert "Toms River" in r_fb.text

    # 4. Test Direct Management Resolution submission
    r_res = client.post(
        "/api/feedback/resolution",
        json={
            "lead_id": "WEB-171001",
            "name": "Mark DeLuca",
            "phone": "732-555-0142",
            "town": "Toms River",
            "message": "Found two roofing nails near the side gate, please sweep.",
        },
    )
    assert r_res.status_code == 200
    assert r_res.json()["status"] == "success"


def test_edge_cases_and_kill_switches():
    # 1. Empty phone on webform -> 400
    r_bad = client.post("/api/leads/webform", json={"first_name": "NoPhone", "phone": "   "})
    assert r_bad.status_code == 400

    # 2. Empty & invalid import payloads on /api/crm/import
    r_empty = client.post(
        "/api/crm/import",
        files={"file": ("empty.csv", b"", "text/csv")},
    )
    assert r_empty.status_code == 200
    assert r_empty.json()["status"] == "error"

    r_bad_json = client.post(
        "/api/crm/import",
        files={"file": ("broken.json", b"{not_valid_json", "application/json")},
    )
    assert r_bad_json.status_code == 200
    assert r_bad_json.json()["status"] == "error"

    # 3. Round-trip Universal JSON export -> import
    r_json_exp = client.get("/api/crm/export?format=universal_json")
    assert r_json_exp.status_code == 200
    r_json_imp = client.post(
        "/api/crm/import",
        files={"file": ("export.json", r_json_exp.content, "application/json")},
    )
    assert r_json_imp.status_code == 200
    assert r_json_imp.json()["status"] == "success"
    assert r_json_imp.json()["updated_count"] >= 1

    # 4. Contractor quality filter rejects tiny (<100x100) image upload
    tiny_jpg = _make_test_jpeg_bytes(width=40, height=40)
    r_tiny = client.post(
        "/api/media/upload",
        data={
            "town": "Toms River",
            "caption": "Tiny thumbnail test",
            "uploaded_by": "contractor",
        },
        files={"file": ("tiny.jpg", tiny_jpg, "image/jpeg")},
    )
    assert r_tiny.status_code == 200
    assert r_tiny.json()["project"]["approval_status"] == "rejected"

    # 5. Global Kill-Switch: disable enable_review_sms, test Completed lead, then re-enable
    client.post("/api/admin/settings", json={"enable_review_sms": False})
    r_lead = client.post(
        "/api/admin/leads",
        json={"first_name": "Paused", "last_name": "SMS", "phone": "732-555-0777", "city": "Howell"},
    )
    lid = r_lead.json()["lead"]["id"]
    r_comp_paused = client.post(f"/api/portal/leads/{lid}/status", json={"status": "Completed"})
    assert r_comp_paused.status_code == 200
    assert r_comp_paused.json()["review_sms_result"]["status"] == "paused"
    assert r_comp_paused.json()["review_sms_result"]["sent"] is False

    # Restore enable_review_sms = True
    client.post("/api/admin/settings", json={"enable_review_sms": True})


def test_tenant_switching_and_vapi_webhook_db_sync():
    # 1. Switch active tenant to client_apex_roofing and back to client_joe_the_roofer
    r_sw1 = client.post("/api/admin/tenants/switch", json={"tenant_id": "client_apex_roofing"})
    assert r_sw1.status_code == 200
    assert r_sw1.json()["active_tenant"]["tenant_id"] == "client_apex_roofing"

    r_sw2 = client.post("/api/admin/tenants/switch", json={"tenant_id": "client_joe_the_roofer"})
    assert r_sw2.status_code == 200
    assert r_sw2.json()["active_tenant"]["tenant_id"] == "client_joe_the_roofer"

    # 2. Test Vapi end-of-call webhook writing directly into Unified Supabase/SQLite DB
    vapi_payload = {
        "message": {
            "type": "end-of-call-report",
            "call": {
                "customer": {"number": "+17325550888"},
                "durationSeconds": 95,
            },
            "artifact": {"recordingUrl": "https://storage.vapi.ai/test-888.mp3"},
            "summary": "Caller in Lakewood requested 21-point drone scan.",
            "analysis": {
                "structuredData": {
                    "first_name": "Brian",
                    "last_name": "Snyder",
                    "address": "42 Pine St, Lakewood, NJ",
                    "service_type": "Full Roof Replacement",
                }
            },
        }
    }
    r_vapi = client.post("/api/vapi/end-of-call", json=vapi_payload)
    assert r_vapi.status_code == 200
    vapi_lead = get_lead("7325550888")
    assert vapi_lead is not None
    assert vapi_lead["first_name"] == "Brian"
    assert vapi_lead["call_recording_url"] == "https://storage.vapi.ai/test-888.mp3"
