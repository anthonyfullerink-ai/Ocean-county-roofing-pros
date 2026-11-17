from datetime import datetime, timedelta, timezone
from pathlib import Path
from fastapi.testclient import TestClient

from app.main import app
from app.agents.orchestrator import run_single_agent
from app.services.db import (
    save_seo_snapshots,
    upsert_seo_experiment,
    list_seo_experiments,
    get_active_seo_overrides,
)
from build_static import build_town_page_context


def test_agent7_seo_optimizer_stages_promotes_and_reverts():
    """Verify Agent 7 stages striking-distance experiments, promotes pending_24h, and reverts regressions."""
    now = datetime.now(timezone.utc)
    save_seo_snapshots(
        [
            {
                "snapshot_date": now.strftime("%Y-%m-%d"),
                "page_url": "https://oceancountyroofingpros.com/roofing-lacey-nj",
                "page_path": "/roofing-lacey-nj",
                "query": "roof repair lacey nj",
                "clicks": 2,
                "impressions": 240,
                "ctr": 0.0083,
                "position": 13.5,
            },
            {
                "snapshot_date": now.strftime("%Y-%m-%d"),
                "page_url": "https://oceancountyroofingpros.com/roofing-howell-nj",
                "page_path": "/roofing-howell-nj",
                "query": "howell nj roofing contractor",
                "clicks": 1,
                "impressions": 190,
                "ctr": 0.005,
                "position": 17.0,
            },
        ]
    )

    exp_due = upsert_seo_experiment(
        {
            "id": "SEOEXP-PY-DUE",
            "page_path": "/roofing-brick-nj",
            "target_query": "brick nj roof replacement",
            "proposed_meta_title": "Brick NJ Roof Replacement | Free 21-Point Inspection",
            "proposed_meta_description": "Brick NJ roof replacement by licensed specialists.",
            "status": "pending_24h",
            "auto_apply_at": (now - timedelta(hours=2)).isoformat(),
        }
    )
    exp_bad = upsert_seo_experiment(
        {
            "id": "SEOEXP-PY-BAD",
            "page_path": "/roofing-howell-nj",
            "target_query": "howell nj roofing contractor",
            "proposed_meta_title": "Test Title",
            "status": "active",
            "activated_at": (now - timedelta(days=15)).isoformat(),
            "baseline_position": 11.0,
            "baseline_ctr": 0.03,
        }
    )

    res = run_single_agent("seo_optimizer")
    assert res["status"] == "success"
    assert res["metrics"]["promoted"] >= 1
    assert res["metrics"]["reverted"] >= 1
    assert res["metrics"]["staged"] >= 1

    exps = {e["id"]: e for e in list_seo_experiments(limit=50)}
    assert exps[exp_due["id"]]["status"] == "active"
    assert exps[exp_bad["id"]]["status"] == "reverted"

    # Active override merges cleanly into build_town_page_context
    overrides = get_active_seo_overrides()
    assert "/roofing-brick-nj" in overrides
    ctx = build_town_page_context(
        {"slug": "roofing-brick-nj", "town_name": "Brick Township", "meta_title": "Old", "meta_description": "Old Desc"},
        {"brand_name": "Ocean County Roofing Pros"},
        [],
        [],
        seo_overrides=overrides,
    )
    assert ctx["town"]["meta_title"] == "Brick NJ Roof Replacement | Free 21-Point Inspection"


def test_fastapi_seo_rankings_endpoints_and_ui():
    client = TestClient(app)
    r_get = client.get("/api/admin/seo-rankings")
    assert r_get.status_code == 200
    assert r_get.json()["status"] == "success"

    r_run = client.post("/api/admin/seo-rankings/run")
    assert r_run.status_code == 200
    assert r_run.json()["status"] == "success"

    admin_html = Path("app/templates/admin_dashboard.html").read_text(encoding="utf-8")
    admin_js = Path("app/static/js/admin_control_plane.js").read_text(encoding="utf-8")
    assert 'id="seoRankingsCard"' in admin_html
    assert "runSingleAgent('seo_optimizer')" in admin_html
    assert "loadSeoRankingsHub" in admin_js
