from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi.testclient import TestClient

from app.main import app
from app.agents.orchestrator import run_single_agent
from app.services.db import record_social_interaction, list_social_interactions


def test_agent6_social_promotes_positive_24h_and_holds_negative_reviews():
    """Agent 6 promotes expired 4-5 star replies but never auto-publishes 1-3 star reviews."""
    past_iso = (datetime.now(timezone.utc) - timedelta(hours=2)).isoformat()
    pos = record_social_interaction(
        {
            "id": "SOC-TEST-POS",
            "platform": "facebook",
            "interaction_type": "review",
            "author_name": "Happy Homeowner",
            "rating": 5,
            "message_text": "Clean 1-day install!",
            "intent": "POSITIVE_REVIEW",
            "ai_reply_draft": "Thank you!",
            "reply_status": "auto_24h",
            "auto_publish_at": past_iso,
        }
    )
    neg = record_social_interaction(
        {
            "id": "SOC-TEST-NEG",
            "platform": "facebook",
            "interaction_type": "review",
            "author_name": "Concerned Neighbor",
            "rating": 2,
            "message_text": "Need follow-up call.",
            "intent": "NEGATIVE_REVIEW",
            "ai_reply_draft": "Management is calling you today.",
            "reply_status": "pending_approval",
        }
    )

    res = run_single_agent("social")
    assert res["status"] == "success"
    assert res["metrics"]["promoted_replies"] >= 1
    assert res["metrics"]["held_negative"] >= 1

    all_items = {item["id"]: item for item in list_social_interactions(limit=50)}
    assert all_items[pos["id"]]["reply_status"] == "published"
    assert all_items[neg["id"]]["reply_status"] == "pending_approval"


def test_fastapi_social_endpoints_and_admin_ui():
    """Verify /api/admin/social routes and OC Roofing Pros HQ Social & Reviews UI."""
    client = TestClient(app)

    post_res = client.post(
        "/api/admin/social",
        json={"caption": "Toms River coastal roof upgrade!", "town_name": "Toms River", "utm_campaign": "tr_promo"},
    )
    assert post_res.status_code == 200
    assert post_res.json()["post"]["status"] == "scheduled"

    get_res = client.get("/api/admin/social")
    assert get_res.status_code == 200
    data = get_res.json()
    assert data["status"] == "success"
    assert any(q["utm_campaign"] == "tr_promo" for q in data["queue"])

    admin_html = Path("app/templates/admin_dashboard.html").read_text(encoding="utf-8")
    admin_js = Path("app/static/js/admin_control_plane.js").read_text(encoding="utf-8")
    assert 'id="tabBtn-social"' in admin_html
    assert 'id="tab-social"' in admin_html
    assert "triggerMayaVoiceBriefing" in admin_html
    assert "runSingleAgent('social')" in admin_html
    assert "loadSocialHub" in admin_js
