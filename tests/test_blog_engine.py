"""
End-to-end tests for the Ocean County Roofing Pros Automated SEO Blog Engine:
- Public FastAPI routes (/blog, /blog/{slug}, /sitemap.xml) + JSON-LD schemas
- Admin FastAPI CRUD & bootstrap (/api/admin/blog, /api/admin/bootstrap)
- Static site builder output (dist/blog, dist/sitemap.xml) + brand/compliance guards
- scripts/generate_blog_post.py CLI & Flow preflight guard
- Live Supabase blog_posts round-trip with cleanup
"""
import json
import os
import subprocess
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.config import settings
from app.main import app
from app.services import db as db_mod


@pytest.fixture()
def isolated_blog_db(tmp_path, monkeypatch):
    """Isolate SQLite and stub out live Supabase env vars for unit/API tests."""
    temp_db = str(tmp_path / "blog_test.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    monkeypatch.setattr(settings, "SUPABASE_URL", "")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "")
    db_mod.init_db()
    return temp_db


def test_blog_public_routes_and_json_ld(isolated_blog_db):
    client = TestClient(app)

    idx = client.get("/blog")
    assert idx.status_code == 200
    assert "Coastal Wind Ratings" in idx.text
    assert "319 Webster" not in idx.text

    slug = "ocean-county-coastal-wind-ratings-110-vs-130-vs-160-mph"
    art = client.get(f"/blog/{slug}")
    assert art.status_code == 200
    body = art.text
    for expected in (
        '"@type": "Article"',
        '"@type": "BreadcrumbList"',
        '"@type": "FAQPage"',
        "GAF",
        "CertainTeed",
        "Owens Corning",
        "Standing Seam",
    ):
        assert expected in body
    assert "319 Webster" not in body

    # Create a draft post and confirm public route keeps it hidden (404)
    draft = db_mod.upsert_blog_post(
        {
            "id": "BLOG-DRAFT-ONLY",
            "slug": "draft-hidden-guide",
            "title": "Hidden 24h Draft Guide",
            "status": "draft_auto_24h",
            "excerpt": "Waiting 24h cron approval.",
        }
    )
    assert draft["status"] == "draft_auto_24h"
    assert client.get("/blog/draft-hidden-guide").status_code == 404
    assert client.get("/blog/nonexistent-post-slug").status_code == 404

    sm = client.get("/sitemap.xml")
    assert sm.status_code == 200
    assert "/blog</loc>" in sm.text
    assert f"/blog/{slug}</loc>" in sm.text
    assert "/blog/draft-hidden-guide</loc>" not in sm.text


def test_blog_admin_api_crud_and_bootstrap(isolated_blog_db):
    client = TestClient(app)

    boot = client.get("/api/admin/bootstrap")
    assert boot.status_code == 200
    boot_data = boot.json()
    assert "blog_posts" in boot_data
    assert len(boot_data["blog_posts"]) >= 3

    create_res = client.post(
        "/api/admin/blog",
        json={
            "id": "BLOG-API-TEST-1",
            "title": "Bayfront Ice Dam & Flashing Audit in Brick NJ",
            "category": "Storm & Insurance",
            "target_towns": [{"slug": "roofing-brick-nj", "label": "Brick"}, {"slug": "roofing-point-pleasant-nj", "label": "Point Pleasant"}],
            "status": "draft_auto_24h",
            "excerpt": "Contractor-agnostic guide across GAF, CertainTeed, Owens Corning, and Standing Seam.",
        },
    )
    assert create_res.status_code == 200
    created = create_res.json()["post"]
    assert created["slug"] == "bayfront-ice-dam-flashing-audit-in-brick-nj"
    assert created["status"] == "draft_auto_24h"

    list_res = client.get("/api/admin/blog")
    assert list_res.status_code == 200
    assert any(p["id"] == "BLOG-API-TEST-1" for p in list_res.json()["posts"])

    patch_res = client.patch("/api/admin/blog/BLOG-API-TEST-1", json={"reading_time_min": 9})
    assert patch_res.status_code == 200
    assert patch_res.json()["post"]["reading_time_min"] == 9

    draft_res = client.post("/api/admin/blog/BLOG-API-TEST-1/action", json={"action": "draft"})
    assert draft_res.status_code == 200
    assert draft_res.json()["post"]["status"] == "draft_auto_24h"
    assert draft_res.json()["post"]["auto_publish_at"]

    pub_res = client.post("/api/admin/blog/BLOG-API-TEST-1/action", json={"action": "publish"})
    assert pub_res.status_code == 200
    assert pub_res.json()["post"]["status"] == "published"
    assert pub_res.json()["post"]["published_at"] is not None
    assert pub_res.json()["post"]["auto_publish_at"] == ""

    del_res = client.delete("/api/admin/blog/BLOG-API-TEST-1")
    assert del_res.status_code == 200
    assert db_mod.get_blog_post("BLOG-API-TEST-1") is None


def test_generate_blog_post_cli_skip_flow(isolated_blog_db):
    from scripts import generate_blog_post as gen

    rc = gen.main(
        [
            "--topic",
            "Lacey & Barnegat Coastal Pine Needle Roof Maintenance Guide",
            "--towns",
            "Lacey, Barnegat",
            "--category",
            "Coastal Engineering",
            "--slug",
            "lacey-barnegat-pine-needle-roof-guide",
            "--skip-flow",
            "--no-build",
        ]
    )
    assert rc == 0

    post = db_mod.get_blog_post("lacey-barnegat-pine-needle-roof-guide")
    assert post is not None
    assert post["status"] == "draft_auto_24h"
    town_labels = [t.get("label") for t in post["target_towns"]]
    assert "Lacey Township" in town_labels
    assert "Barnegat" in town_labels
    assert "Standing Seam Metal" in post["sections_json"]
    assert "GAF Timberline" in post["sections_json"]
    assert "CertainTeed" in post["sections_json"]
    assert "Owens Corning" in post["sections_json"]
    assert len(post["sections"]) >= 4
    assert len(post["faqs"]) >= 4
    assert "319 Webster" not in json.dumps(post)


def test_sync_blog_posts_slug_collision_and_pruning(isolated_blog_db, monkeypatch):
    import httpx

    db_mod.upsert_blog_post(
        {
            "id": "BLOG-LOCAL-OLD",
            "slug": "shared-coastal-slug",
            "title": "Old Local Post",
            "status": "published",
        }
    )
    db_mod.upsert_blog_post(
        {
            "id": "BLOG-DELETED-IN-CLOUD",
            "slug": "deleted-cloud-slug",
            "title": "Should Be Pruned",
            "status": "published",
        }
    )

    monkeypatch.setattr(settings, "SUPABASE_URL", "https://mock.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "mock-key")

    class MockResp:
        status_code = 200
        text = "[]"

        def json(self):
            return [
                {
                    "id": "BLOG-CLOUD-NEW",
                    "slug": "shared-coastal-slug",
                    "title": "Cloud Authoritative Post",
                    "status": "published",
                    "target_towns_json": "[]",
                    "sections_json": "[]",
                    "faqs_json": "[]",
                }
            ]

    class MockClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, *a, **kw):
            return MockResp()

    monkeypatch.setattr(httpx, "Client", MockClient)
    synced = db_mod.sync_blog_posts_from_supabase()
    assert len(synced) == 1
    assert db_mod.get_blog_post("BLOG-CLOUD-NEW") is not None
    assert db_mod.get_blog_post("BLOG-LOCAL-OLD") is None
    assert db_mod.get_blog_post("BLOG-DELETED-IN-CLOUD") is None


def test_flow_json_and_clean_output(tmp_path, monkeypatch):
    from PIL import Image
    from scripts import generate_blog_post as gen

    raw_img = tmp_path / "raw_nano.png"
    Image.new("RGB", (800, 450), color=(20, 120, 110)).save(raw_img)
    test_slug = f"test-flow-mock-{uuid.uuid4().hex[:6]}"
    monkeypatch.setattr(gen, "STATIC_BLOG_DIR", tmp_path / "blog_out")
    monkeypatch.setattr(gen, "resolve_flow_auto_bin", lambda: "flow-auto")
    monkeypatch.setattr(gen, "check_flow_ready", lambda: (True, "ok"))

    seen_cmds = []

    def fake_run(cmd, **kw):
        seen_cmds.append(cmd)
        if cmd[1] == "generate":
            return SimpleNamespace(returncode=0, stdout=json.dumps({"output_path": str(raw_img)}), stderr="")
        if cmd[1] == "clean":
            out_idx = cmd.index("-o") + 1
            clean_path = Path(cmd[out_idx])
            Image.new("RGB", (800, 450), color=(30, 140, 130)).save(clean_path)
            return SimpleNamespace(returncode=0, stdout=json.dumps({"output_path": str(clean_path)}), stderr="")
        raise AssertionError(f"Unexpected cmd: {cmd}")

    monkeypatch.setattr(subprocess, "run", fake_run)
    res = gen.run_flow_image(test_slug, "Coastal shingle roof")
    assert res == (f"/static/blog/{test_slug}/hero.webp", f"/static/blog/{test_slug}/hero.jpg")
    assert (tmp_path / "blog_out" / test_slug / "hero.webp").exists()
    assert (tmp_path / "blog_out" / test_slug / "hero.jpg").exists()
    assert "--json" in seen_cmds[0]
    assert "-o" in seen_cmds[1] and "--json" in seen_cmds[1]


def test_flow_preflight_blocks_hidden_tab(monkeypatch):
    from scripts import generate_blog_post as gen

    monkeypatch.setattr(gen, "resolve_flow_auto_bin", lambda: "flow-auto")
    monkeypatch.setattr(
        subprocess,
        "run",
        lambda *a, **kw: SimpleNamespace(
            returncode=0,
            stdout=(
                "bridge: up (v1.0.15)\n"
                "extension (flow): connected\n"
                "queue: PAUSED — free plan\n"
                "flow tab: HIDDEN — bring it to the front, jobs will stall while it's hidden\n"
            ),
            stderr="",
        ),
    )

    ready, reason = gen.check_flow_ready()
    assert ready is False
    assert "HIDDEN" in reason


def test_static_build_blog_dist_and_sitemap():
    import build_static

    build_static.main()

    dist_dir = Path("dist")
    assert (dist_dir / "blog" / "index.html").exists()
    assert (dist_dir / "blog.html").exists()

    starter_slugs = (
        "ocean-county-coastal-wind-ratings-110-vs-130-vs-160-mph",
        "salt-air-noreaster-flashing-damage-ocean-county",
        "ocean-county-nj-roof-replacement-cost-guide-2026",
    )
    sitemap_xml = (dist_dir / "sitemap.xml").read_text(encoding="utf-8")
    assert "https://oceancountyroofingpros.com/blog</loc>" in sitemap_xml

    for slug in starter_slugs:
        page_file = dist_dir / "blog" / slug / "index.html"
        assert page_file.exists()
        html = page_file.read_text(encoding="utf-8")
        assert '"@type": "Article"' in html
        assert "GAF" in html
        assert "CertainTeed" in html
        assert "Owens Corning" in html
        assert "319 Webster" not in html
        assert f"https://oceancountyroofingpros.com/blog/{slug}</loc>" in sitemap_xml


def test_live_supabase_blog_posts_roundtrip(tmp_path, monkeypatch):
    if not (os.getenv("SUPABASE_URL") or settings.SUPABASE_URL) or not (os.getenv("SUPABASE_KEY") or settings.SUPABASE_KEY):
        pytest.skip("Supabase credentials not configured")

    temp_db = str(tmp_path / "live_supabase_blog_test.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    db_mod.init_db()

    uid = uuid.uuid4().hex[:8]
    test_id = f"BLOG-TEST-{uid}"
    test_slug = f"test-roundtrip-{uid}"

    try:
        created = db_mod.upsert_blog_post(
            {
                "id": test_id,
                "slug": test_slug,
                "title": f"Temporary Supabase Verification Guide {uid}",
                "category": "Coastal Materials",
                "target_towns": [{"slug": "roofing-toms-river-nj", "label": "Toms River"}],
                "excerpt": "Automated verification post.",
                "status": "draft_auto_24h",
            }
        )
        assert created["id"] == test_id

        updated = db_mod.update_blog_post(test_id, {"reading_time_min": 11, "status": "published"})
        assert updated is not None and updated["reading_time_min"] == 11
        assert updated["status"] == "published"

        synced = db_mod.sync_blog_posts_from_supabase()
        assert any(p["id"] == test_id and p["reading_time_min"] == 11 and p["status"] == "published" for p in synced)
    finally:
        db_mod.delete_blog_post(test_id)
