from pathlib import Path
from fastapi.testclient import TestClient

from app.main import app


def test_fastapi_analytics_collect_auth_and_summary():
    """Verify /api/analytics/collect and /api/analytics/summary work end-to-end with SQLite mirror."""
    client = TestClient(app)

    # 1. Record pageview, call click, and lead event
    r1 = client.post(
        "/api/analytics/collect",
        json={
            "event_name": "page_view",
            "session_id": "py-sid-1",
            "visitor_id": "py-vid-1",
            "page_path": "/roofing-toms-river-nj",
            "town_name": "Toms River",
            "device_type": "mobile",
            "referrer_host": "https://www.google.com/",
            "viewport_width": 390,
        },
    )
    assert r1.status_code == 200
    assert r1.json()["ok"] is True

    r2 = client.post(
        "/api/analytics/collect",
        json={
            "event_name": "sms_click",
            "session_id": "py-sid-1",
            "visitor_id": "py-vid-1",
            "page_path": "/roofing-toms-river-nj",
            "town_name": "Toms River",
            "device_type": "mobile",
        },
    )
    assert r2.status_code == 200

    # Ignored /admin hit should not inflate stats
    r_ign = client.post(
        "/api/analytics/collect",
        json={"event_name": "page_view", "page_path": "/admin", "visitor_id": "py-admin"},
    )
    assert r_ign.status_code == 200
    assert r_ign.json().get("ignored") is True

    # 2. Unauthorized GET /api/analytics/summary rejected
    unauth = client.get("/api/analytics/summary?range=30d")
    assert unauth.status_code == 401

    # 3. Authenticated summary returns aggregated metrics
    auth = client.post("/api/admin/auth", json={"pin": "732999"})
    assert auth.status_code == 200
    token = auth.json()["token"]

    summary = client.get(
        "/api/analytics/summary?range=30d",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert summary.status_code == 200
    data = summary.json()
    assert data["status"] == "success"
    assert data["kpis"]["unique_visitors"] >= 1
    assert data["kpis"]["pageviews"] >= 1
    assert data["kpis"]["sms_clicks"] >= 1
    assert len(data["daily_series"]) == 30
    assert any(p["page_path"] == "/roofing-toms-river-nj" for p in data["top_pages"])


def test_admin_dashboard_and_base_include_zero_login_analytics():
    """Verify compiled templates render built-in analytics UI and first-party beacon hook."""
    base_html = Path("app/templates/base.html").read_text(encoding="utf-8")
    admin_html = Path("app/templates/admin_dashboard.html").read_text(encoding="utf-8")
    admin_js = Path("app/static/js/admin_control_plane.js").read_text(encoding="utf-8")

    assert "/api/analytics/collect" in base_html
    assert "sendBeacon" in base_html
    assert "blog_read_complete" in base_html

    assert 'id="tabBtn-analytics"' in admin_html
    assert 'id="tab-analytics"' in admin_html
    assert 'id="overviewTrafficPulseStrip"' in admin_html
    assert 'id="analyticsDailyChartWrap"' in admin_html
    assert 'id="analyticsFunnelBody"' in admin_html
    assert "Zero Login Required" in admin_html

    assert "loadSiteAnalytics" in admin_js
    assert "/api/analytics/summary" in admin_js
    assert "formatEtTimestamp" in admin_js
    assert "America/New_York" in admin_js

    from datetime import datetime, timezone
    from app.services.db import summarize_analytics_events

    et_sum = summarize_analytics_events(
        [
            {
                "id": "py-et-1",
                "created_at": "2026-11-15T03:30:00Z",
                "event_name": "page_view",
                "visitor_id": "py-et-v1",
                "session_id": "py-et-s1",
                "page_path": "/",
            }
        ],
        range_key="7d",
        now_utc=datetime(2026, 11, 15, 6, 0, tzinfo=timezone.utc),
    )
    by_day = {d["date"]: d["pageviews"] for d in et_sum["daily_series"]}
    assert by_day["2026-11-14"] == 1
    assert by_day["2026-11-15"] == 0
