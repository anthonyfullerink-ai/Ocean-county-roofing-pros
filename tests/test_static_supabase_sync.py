import json
from pathlib import Path
import httpx

from app.config import settings
from app.services import db as db_mod


def test_sync_job_projects_from_supabase_and_fallback(tmp_path, monkeypatch):
    temp_db = str(tmp_path / "sync_proj_test.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    db_mod.init_db()

    # Seed a stale local project that is no longer in Supabase
    db_mod.create_job_project(
        {
            "id": "PROJ-STALE-LOCAL",
            "town_slug": "roofing-toms-river-nj",
            "town_name": "Toms River",
            "caption": "Stale local project",
            "approval_status": "approved",
        }
    )
    assert db_mod.get_job_project("PROJ-STALE-LOCAL") is not None

    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "test-service-key")

    class MockResp:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

    # 1. Error response falls back safely without wiping local SQLite
    class ErrorClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, *a, **kw):
            return MockResp(500, {"error": "db down"})

    monkeypatch.setattr(httpx, "Client", ErrorClient)
    res_err = db_mod.sync_job_projects_from_supabase()
    assert res_err == []
    assert db_mod.get_job_project("PROJ-STALE-LOCAL") is not None

    # 2. Valid Supabase response mirrors cloud rows and removes stale local rows
    class OkClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, *a, **kw):
            assert "/rest/v1/job_projects" in url
            return MockResp(
                200,
                [
                    {
                        "id": "PROJ-CLOUD-1",
                        "created_at": "2026-11-17T12:00:00Z",
                        "town_slug": "roofing-toms-river-nj",
                        "town_name": "Toms River",
                        "neighborhood": "Silverton",
                        "service_type": "Full Roof Replacement",
                        "shingle_system": "GAF Timberline HDZ",
                        "caption": "Freshly approved Supabase job photo",
                        "ai_seo_summary": "Cloud synced Silverton roof replacement.",
                        "image_webp_url": "https://cdn.example.com/silverton-roof.webp",
                        "image_geotagged_jpg_url": "https://cdn.example.com/silverton-roof.jpg",
                        "lat": 39.99,
                        "lon": -74.13,
                        "uploaded_by": "contractor",
                        "tenant_id": "client_joe_the_roofer",
                        "approval_status": "approved",
                        "auto_publish_at": "",
                    }
                ],
            )

    monkeypatch.setattr(httpx, "Client", OkClient)
    synced = db_mod.sync_job_projects_from_supabase()
    assert len(synced) == 1
    assert synced[0]["id"] == "PROJ-CLOUD-1"
    assert db_mod.get_job_project("PROJ-CLOUD-1") is not None
    assert db_mod.get_job_project("PROJ-STALE-LOCAL") is None


def test_sync_reviews_from_supabase_and_fallback(tmp_path, monkeypatch):
    temp_db = str(tmp_path / "sync_rev_test.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    db_mod.init_db()

    db_mod.create_review(
        {
            "id": "REV-STALE-LOCAL",
            "reviewer_name": "Old Local Reviewer",
            "town_slug": "roofing-toms-river-nj",
            "review_text": "Stale local review",
            "is_public": True,
        }
    )

    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "test-service-key")

    class MockResp:
        def __init__(self, status_code, payload):
            self.status_code = status_code
            self._payload = payload
            self.text = json.dumps(payload)

        def json(self):
            return self._payload

    class ExcClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, *a, **kw):
            raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx, "Client", ExcClient)
    assert db_mod.sync_reviews_from_supabase() == []
    assert db_mod.get_review("REV-STALE-LOCAL") is not None

    class OkClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, *a, **kw):
            assert "/rest/v1/reviews" in url
            return MockResp(
                200,
                [
                    {
                        "id": "REV-CLOUD-PUB",
                        "created_at": "2026-11-17T14:00:00Z",
                        "lead_id": "LEAD-1",
                        "reviewer_name": "Sarah Jenkins",
                        "town_name": "Toms River",
                        "town_slug": "roofing-toms-river-nj",
                        "service_performed": "Full Roof Replacement",
                        "rating": 5,
                        "review_text": "Cloud synced 5-star review from Silverton.",
                        "source": "Google",
                        "ai_reply_draft": "Thank you Sarah!",
                        "reply_status": "published",
                        "is_public": True,
                        "resolution_status": "resolved",
                    },
                    {
                        "id": "REV-CLOUD-PRIV",
                        "created_at": "2026-11-17T13:00:00Z",
                        "lead_id": "LEAD-2",
                        "reviewer_name": "Private Feedback",
                        "town_name": "Brick",
                        "town_slug": "roofing-brick-nj",
                        "service_performed": "Roof Repair",
                        "rating": 2,
                        "review_text": "Private resolution item.",
                        "source": "Direct Resolution",
                        "ai_reply_draft": "",
                        "reply_status": "pending",
                        "is_public": False,
                        "resolution_status": "open",
                    },
                ],
            )

    monkeypatch.setattr(httpx, "Client", OkClient)
    synced = db_mod.sync_reviews_from_supabase()
    assert len(synced) == 2
    pub = db_mod.list_reviews(public_only=True)
    assert [r["id"] for r in pub] == ["REV-CLOUD-PUB"]
    assert db_mod.get_review("REV-STALE-LOCAL") is None


def test_sync_citations_from_supabase(tmp_path, monkeypatch):
    temp_db = str(tmp_path / "sync_cit_test.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    db_mod.init_db()

    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "test-service-key")

    # Ensure syncing from Supabase does not write back to Supabase
    write_backs = []
    monkeypatch.setattr(db_mod, "_sync_to_supabase_cloud", lambda *a, **kw: write_backs.append(a))

    citations_payload = [
        {"key": "bbb", "name": "BBB", "status": "live", "url": "https://www.bbb.org/us/nj/toms-river/ocrp"},
        {"key": "yelp", "name": "Yelp", "status": "pending", "url": "https://www.yelp.com/biz/pending"},
    ]

    class MockResp:
        status_code = 200
        text = "ok"

        def json(self):
            return [{"key": "citations_json", "value": json.dumps(citations_payload), "updated_at": "2026-11-17T15:00:00Z"}]

    class OkClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, *a, **kw):
            assert "system_settings?key=eq.citations_json" in url
            return MockResp()

    monkeypatch.setattr(httpx, "Client", OkClient)
    val = db_mod.sync_citations_from_supabase()
    assert val is not None
    assert "https://www.bbb.org/us/nj/toms-river/ocrp" in db_mod.get_setting("citations_json")
    assert write_backs == []


def test_build_static_pulls_supabase_projects_reviews_citations(tmp_path, monkeypatch):
    temp_db = str(tmp_path / "build_static_supa.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    db_mod.init_db()

    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "test-service-key")

    citations_payload = [
        {"key": "bing", "name": "Bing Places", "status": "live", "url": "https://www.bing.com/maps?osid=cloud-999"}
    ]

    class MockResp:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload
            self.text = "ok"

        def json(self):
            return self._payload

    class MultiClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, *a, **kw):
            if "/rest/v1/job_projects" in url:
                return MockResp(
                    [
                        {
                            "id": "PROJ-E2E-CLOUD",
                            "created_at": "2026-11-17T16:00:00Z",
                            "town_slug": "roofing-toms-river-nj",
                            "town_name": "Toms River",
                            "neighborhood": "North Dover",
                            "service_type": "Full Roof Replacement",
                            "shingle_system": "CertainTeed Landmark PRO",
                            "caption": "E2E Cloud Approved Job Photo",
                            "ai_seo_summary": "Cloud approved North Dover roof.",
                            "image_webp_url": "https://cdn.example.com/e2e-roof.webp",
                            "image_geotagged_jpg_url": "https://cdn.example.com/e2e-roof.jpg",
                            "lat": 40.01,
                            "lon": -74.21,
                            "uploaded_by": "owner",
                            "tenant_id": "client_joe_the_roofer",
                            "approval_status": "approved",
                            "auto_publish_at": "",
                        }
                    ]
                )
            if "/rest/v1/reviews" in url:
                return MockResp(
                    [
                        {
                            "id": "REV-E2E-CLOUD",
                            "created_at": "2026-11-17T16:05:00Z",
                            "lead_id": "LEAD-E2E",
                            "reviewer_name": "Marcus Vance",
                            "town_name": "Toms River",
                            "town_slug": "roofing-toms-river-nj",
                            "service_performed": "Roof Replacement",
                            "rating": 5,
                            "review_text": "E2E Cloud Synced Review Text!",
                            "source": "Google",
                            "ai_reply_draft": "",
                            "reply_status": "published",
                            "is_public": True,
                            "resolution_status": "resolved",
                        }
                    ]
                )
            if "system_settings?key=eq.citations_json" in url:
                return MockResp([{"key": "citations_json", "value": json.dumps(citations_payload)}])
            if "/rest/v1/seo_experiments" in url:
                return MockResp([])
            if "/rest/v1/blog_posts" in url:
                return MockResp([])
            return MockResp([])

    monkeypatch.setattr(httpx, "Client", MultiClient)
    monkeypatch.setattr(httpx, "get", lambda url, *a, **kw: MultiClient().get(url, *a, **kw))

    import build_static

    build_static.main()

    toms_river_html = Path("dist/roofing-toms-river-nj/index.html").read_text(encoding="utf-8")
    assert "Marcus Vance" in toms_river_html
    assert "E2E Cloud Synced Review Text!" in toms_river_html
    assert "https://www.bing.com/maps?osid=cloud-999" in toms_river_html
    assert "https://cdn.example.com/e2e-roof.webp" in toms_river_html
    assert "https://oceancountyroofingpros.comhttps://" not in toms_river_html


def test_sync_handles_uninitialized_db_and_malformed_numbers(tmp_path, monkeypatch):
    temp_db = str(tmp_path / "uninit_sync.db")
    monkeypatch.setattr(settings, "LOCAL_DB_PATH", temp_db)
    # Intentionally DO NOT call db_mod.init_db() first

    monkeypatch.setattr(settings, "SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setattr(settings, "SUPABASE_KEY", "test-service-key")

    class MockResp:
        def __init__(self, payload):
            self.status_code = 200
            self._payload = payload
            self.text = "ok"

        def json(self):
            return self._payload

    class EdgeClient:
        def __init__(self, *a, **kw):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, *a, **kw):
            if "/rest/v1/job_projects" in url:
                return MockResp(
                    [
                        {
                            "id": "PROJ-BAD-COORDS",
                            "town_slug": "roofing-brick-nj",
                            "town_name": "Brick",
                            "lat": "",
                            "lon": "not-a-float",
                            "approval_status": "approved",
                        }
                    ]
                )
            if "/rest/v1/reviews" in url:
                return MockResp(
                    [
                        {
                            "id": "REV-FLOAT-RATING",
                            "reviewer_name": "Alex M.",
                            "town_slug": "roofing-brick-nj",
                            "rating": "5.0",
                            "review_text": "Great roof!",
                            "is_public": True,
                        }
                    ]
                )
            if "system_settings?key=eq.citations_json" in url:
                return MockResp([{"key": "citations_json", "value": "[]"}])
            return MockResp([])

    monkeypatch.setattr(httpx, "Client", EdgeClient)

    projs = db_mod.sync_job_projects_from_supabase()
    assert any(p["id"] == "PROJ-BAD-COORDS" for p in projs)
    bad_p = db_mod.get_job_project("PROJ-BAD-COORDS")
    assert bad_p["lat"] == 39.9537
    assert bad_p["lon"] == -74.1979

    revs = db_mod.sync_reviews_from_supabase()
    assert any(r["id"] == "REV-FLOAT-RATING" for r in revs)
    assert db_mod.get_review("REV-FLOAT-RATING")["rating"] == 5

    assert db_mod.sync_citations_from_supabase() == "[]"
