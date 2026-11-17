import os
import re
import json
import sqlite3
import logging
from pathlib import Path
from datetime import datetime, timedelta, timezone
from typing import Dict, Any, List, Optional

import httpx
from app.config import settings, PROJECT_ROOT, get_town_by_name_or_slug

logger = logging.getLogger(__name__)


def normalize_phone(raw_phone: str) -> str:
    """Normalizes any phone string to the standard 10-digit number."""
    if not raw_phone:
        return ""
    digits = re.sub(r"\D", "", str(raw_phone))
    return digits[-10:] if len(digits) >= 10 else digits


def format_e164_phone(raw_phone: str) -> str:
    norm = normalize_phone(raw_phone)
    if len(norm) == 10:
        return f"+1{norm}"
    return raw_phone or ""


def is_supabase_configured() -> bool:
    """Returns True if live cloud Supabase URL and Key are configured."""
    url = (settings.SUPABASE_URL or "").strip()
    key = (settings.SUPABASE_KEY or "").strip()
    if not url or not key:
        return False
    if "YOUR_" in url.upper() or "YOUR_" in key.upper() or "placeholder" in url.lower():
        return False
    return url.startswith("http")


def get_sqlite_path() -> str:
    """
    Resolves the SQLite database path (`data/local_supabase_mirror.db`),
    falling back to `/tmp/local_supabase_mirror.db` on read-only serverless containers.
    """
    rel_path = settings.LOCAL_DB_PATH or "data/local_supabase_mirror.db"
    candidate = Path(rel_path) if os.path.isabs(rel_path) else (PROJECT_ROOT / rel_path)
    try:
        candidate.parent.mkdir(parents=True, exist_ok=True)
        # Test write access on parent directory
        test_conn = sqlite3.connect(str(candidate))
        test_conn.close()
        return str(candidate)
    except Exception as e:
        logger.warning(f"Primary DB path {candidate} not writable ({e}), using /tmp fallback.")
        fallback = Path("/tmp/local_supabase_mirror.db")
        fallback.parent.mkdir(parents=True, exist_ok=True)
        return str(fallback)


def _get_conn() -> sqlite3.Connection:
    db_path = get_sqlite_path()
    conn = sqlite3.connect(db_path, timeout=15.0)
    conn.row_factory = sqlite3.Row
    return conn


_CLOUD_BOOL_COLS = {"is_active", "review_request_sent", "is_public", "webhook_dispatched", "meta_shared"}
_CLOUD_NULLABLE_TIMESTAMPTZ_COLS = {"review_request_sent_at", "auto_publish_at", "published_at", "auto_apply_at", "activated_at", "evaluated_at"}


def _prepare_cloud_payload(payload: Any) -> Any:
    """
    Normalizes SQLite-flavored record dicts into PostgreSQL/PostgREST-compliant JSON payloads:
    - Converts 0/1 integer boolean flags into JSON true/false booleans.
    - Converts empty string '' on nullable TIMESTAMPTZ columns into None (null).
    """
    if not isinstance(payload, dict):
        return payload
    cleaned: Dict[str, Any] = {}
    for k, v in payload.items():
        if k in _CLOUD_BOOL_COLS:
            cleaned[k] = bool(v)
        elif k in _CLOUD_NULLABLE_TIMESTAMPTZ_COLS and (v == "" or v is None):
            cleaned[k] = None
        else:
            cleaned[k] = v
    return cleaned


def _sync_to_supabase_cloud(table: str, method: str, payload: Any = None, match_col: str = "id", match_val: str = ""):
    """
    Optional non-blocking cloud sync when SUPABASE_URL and SUPABASE_KEY are present in .env.
    """
    if not is_supabase_configured():
        return
    base_url = settings.SUPABASE_URL.rstrip("/")
    headers = {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
        "Content-Type": "application/json",
        "Prefer": "return=minimal,resolution=merge-duplicates",
    }
    norm_payload = _prepare_cloud_payload(payload)
    try:
        with httpx.Client(timeout=5.0) as client:
            if method == "UPSERT":
                conflict_q = f"?on_conflict={match_col}" if match_col else ""
                client.post(f"{base_url}/rest/v1/{table}{conflict_q}", headers=headers, json=norm_payload)
            elif method == "PATCH" and match_val:
                client.patch(f"{base_url}/rest/v1/{table}?{match_col}=eq.{match_val}", headers=headers, json=norm_payload)
            elif method == "DELETE" and match_val:
                client.delete(f"{base_url}/rest/v1/{table}?{match_col}=eq.{match_val}", headers=headers)
    except Exception as e:
        logger.warning(f"Cloud Supabase sync warning ({table} {method}): {e}")


def init_db() -> None:
    """
    Initializes all 8 core tables in the local Supabase SQLite mirror and seeds
    realistic Ocean County data on first run so the system runs 100% out-of-the-box.
    """
    conn = _get_conn()
    cur = conn.cursor()

    cur.executescript(
        """
        CREATE TABLE IF NOT EXISTS tenants (
            tenant_id TEXT PRIMARY KEY,
            company_name TEXT NOT NULL,
            contact_name TEXT DEFAULT '',
            estimator_name TEXT DEFAULT 'Riley',
            dispatch_phone TEXT DEFAULT '',
            email TEXT DEFAULT '',
            portal_pin TEXT DEFAULT '732100',
            scheduling_type TEXT DEFAULT 'google_calendar',
            booking_url TEXT DEFAULT '',
            calendar_id TEXT DEFAULT 'primary',
            ics_feed_url TEXT DEFAULT '',
            availability_json TEXT DEFAULT '{}',
            emergency_config_json TEXT DEFAULT '{}',
            service_license TEXT DEFAULT 'Fully Licensed & Insured NJ HIC',
            monthly_retainer REAL DEFAULT 1500.00,
            is_active INTEGER DEFAULT 0,
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS leads (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            lead_source TEXT DEFAULT 'Website Form',
            first_name TEXT DEFAULT '',
            last_name TEXT DEFAULT '',
            phone TEXT NOT NULL,
            email TEXT DEFAULT '',
            street_address TEXT DEFAULT '',
            city TEXT DEFAULT 'Toms River',
            state TEXT DEFAULT 'NJ',
            zip_code TEXT DEFAULT '08753',
            service_requested TEXT DEFAULT 'Full Roof Replacement',
            urgency TEXT DEFAULT 'Standard',
            diagnostic_situation TEXT DEFAULT '',
            home_architecture TEXT DEFAULT '',
            appointment_slot TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            assigned_tenant_id TEXT DEFAULT 'client_joe_the_roofer',
            status TEXT DEFAULT 'New Lead',
            estimated_value REAL DEFAULT 12500.00,
            call_recording_url TEXT DEFAULT '',
            call_transcript TEXT DEFAULT '',
            call_duration_sec INTEGER DEFAULT 0,
            review_request_sent INTEGER DEFAULT 0,
            review_request_sent_at TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS job_projects (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            town_slug TEXT NOT NULL,
            town_name TEXT NOT NULL,
            neighborhood TEXT DEFAULT '',
            service_type TEXT DEFAULT 'Full Roof Replacement',
            shingle_system TEXT DEFAULT 'CertainTeed Landmark PRO',
            caption TEXT DEFAULT '',
            ai_seo_summary TEXT DEFAULT '',
            image_webp_url TEXT DEFAULT '',
            image_geotagged_jpg_url TEXT DEFAULT '',
            lat REAL DEFAULT 39.9537,
            lon REAL DEFAULT -74.1979,
            uploaded_by TEXT DEFAULT 'owner',
            tenant_id TEXT DEFAULT 'client_joe_the_roofer',
            approval_status TEXT DEFAULT 'approved',
            auto_publish_at TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS reviews (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            lead_id TEXT DEFAULT '',
            reviewer_name TEXT NOT NULL,
            town_name TEXT DEFAULT 'Toms River',
            town_slug TEXT DEFAULT 'roofing-toms-river-nj',
            service_performed TEXT DEFAULT 'Full Roof Replacement',
            rating INTEGER DEFAULT 5,
            review_text TEXT NOT NULL,
            source TEXT DEFAULT 'Google',
            ai_reply_draft TEXT DEFAULT '',
            reply_status TEXT DEFAULT 'pending',
            is_public INTEGER DEFAULT 1,
            resolution_status TEXT DEFAULT 'resolved'
        );

        CREATE TABLE IF NOT EXISTS gbp_posts (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            scheduled_for TEXT DEFAULT '',
            post_type TEXT DEFAULT 'Project Highlight',
            town_name TEXT DEFAULT 'Toms River',
            town_slug TEXT DEFAULT 'roofing-toms-river-nj',
            title TEXT NOT NULL,
            content TEXT NOT NULL,
            image_url TEXT DEFAULT '',
            cta_type TEXT DEFAULT 'LEARN_MORE',
            cta_url TEXT DEFAULT 'https://oceancountyroofingpros.com',
            status TEXT DEFAULT 'draft_auto_24h',
            auto_publish_at TEXT DEFAULT '',
            webhook_dispatched INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS agent_runs (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            agent_name TEXT NOT NULL,
            status TEXT DEFAULT 'success',
            summary TEXT DEFAULT '',
            metrics_json TEXT DEFAULT '{}',
            duration_ms INTEGER DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS daily_reports (
            id TEXT PRIMARY KEY,
            report_date TEXT NOT NULL,
            created_at TEXT NOT NULL,
            headline TEXT DEFAULT '',
            markdown_content TEXT NOT NULL,
            metrics_json TEXT DEFAULT '{}',
            file_path TEXT DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS system_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS blog_posts (
            id TEXT PRIMARY KEY,
            slug TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            meta_title TEXT DEFAULT '',
            meta_description TEXT DEFAULT '',
            category TEXT DEFAULT 'Coastal Materials',
            excerpt TEXT DEFAULT '',
            target_towns_json TEXT DEFAULT '[]',
            sections_json TEXT DEFAULT '[]',
            faqs_json TEXT DEFAULT '[]',
            hero_image_url TEXT DEFAULT '',
            hero_image_alt TEXT DEFAULT '',
            veo_video_url TEXT DEFAULT '',
            veo_video_poster_url TEXT DEFAULT '',
            reading_time_min INTEGER DEFAULT 6,
            cta_service TEXT DEFAULT 'Free 21-Point Roof & Attic Inspection',
            author_name TEXT DEFAULT 'Ocean County Roofing Pros Editorial Team',
            status TEXT DEFAULT 'draft_auto_24h',
            auto_publish_at TEXT DEFAULT '',
            published_at TEXT DEFAULT '',
            meta_shared INTEGER DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS site_analytics_events (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            event_name TEXT NOT NULL DEFAULT 'page_view',
            session_id TEXT DEFAULT '',
            visitor_id TEXT DEFAULT '',
            page_path TEXT NOT NULL DEFAULT '/',
            page_title TEXT DEFAULT '',
            page_type TEXT DEFAULT 'landing',
            town_slug TEXT DEFAULT '',
            town_name TEXT DEFAULT '',
            device_type TEXT DEFAULT 'desktop',
            referrer_host TEXT DEFAULT 'direct',
            source_channel TEXT DEFAULT 'Direct',
            utm_source TEXT DEFAULT '',
            utm_medium TEXT DEFAULT '',
            utm_campaign TEXT DEFAULT '',
            viewport_width INTEGER DEFAULT 0,
            meta_json TEXT DEFAULT '{}'
        );
        CREATE INDEX IF NOT EXISTS idx_sqlite_analytics_created_at ON site_analytics_events(created_at DESC);
        CREATE INDEX IF NOT EXISTS idx_sqlite_analytics_event_name ON site_analytics_events(event_name);
        CREATE INDEX IF NOT EXISTS idx_sqlite_analytics_page_path ON site_analytics_events(page_path);

        CREATE TABLE IF NOT EXISTS social_interactions (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            platform TEXT NOT NULL DEFAULT 'facebook',
            interaction_type TEXT NOT NULL DEFAULT 'comment',
            external_id TEXT DEFAULT '',
            post_id TEXT DEFAULT '',
            author_name TEXT DEFAULT '',
            author_id TEXT DEFAULT '',
            rating INTEGER DEFAULT 0,
            message_text TEXT DEFAULT '',
            intent TEXT DEFAULT 'GENERAL',
            ai_reply_draft TEXT DEFAULT '',
            reply_status TEXT DEFAULT 'pending_approval',
            auto_publish_at TEXT DEFAULT '',
            published_reply_id TEXT DEFAULT '',
            lead_id TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sqlite_social_int_status ON social_interactions(reply_status);
        CREATE INDEX IF NOT EXISTS idx_sqlite_social_int_created ON social_interactions(created_at DESC);

        CREATE TABLE IF NOT EXISTS social_queue (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            caption TEXT NOT NULL,
            image_url TEXT DEFAULT '',
            link_url TEXT DEFAULT 'https://oceancountyroofingpros.com',
            platforms TEXT DEFAULT 'facebook,instagram',
            utm_campaign TEXT DEFAULT 'social_agent',
            town_name TEXT DEFAULT 'Ocean County',
            status TEXT DEFAULT 'scheduled',
            scheduled_for TEXT NOT NULL,
            published_at TEXT DEFAULT '',
            external_post_ids_json TEXT DEFAULT '{}',
            created_by TEXT DEFAULT 'vapi_voice'
        );
        CREATE INDEX IF NOT EXISTS idx_sqlite_social_q_status ON social_queue(status);
        CREATE INDEX IF NOT EXISTS idx_sqlite_social_q_sched ON social_queue(scheduled_for ASC);

        CREATE TABLE IF NOT EXISTS seo_ranking_snapshots (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            snapshot_date TEXT NOT NULL,
            page_url TEXT NOT NULL,
            page_path TEXT NOT NULL DEFAULT '/',
            query TEXT NOT NULL,
            clicks INTEGER DEFAULT 0,
            impressions INTEGER DEFAULT 0,
            ctr REAL DEFAULT 0.0,
            position REAL DEFAULT 0.0
        );
        CREATE INDEX IF NOT EXISTS idx_sqlite_seo_snap_date ON seo_ranking_snapshots(snapshot_date DESC);
        CREATE INDEX IF NOT EXISTS idx_sqlite_seo_snap_path ON seo_ranking_snapshots(page_path);

        CREATE TABLE IF NOT EXISTS seo_experiments (
            id TEXT PRIMARY KEY,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            page_path TEXT NOT NULL,
            target_query TEXT NOT NULL,
            original_meta_title TEXT DEFAULT '',
            original_meta_description TEXT DEFAULT '',
            proposed_meta_title TEXT DEFAULT '',
            proposed_meta_description TEXT DEFAULT '',
            baseline_position REAL DEFAULT 0.0,
            baseline_ctr REAL DEFAULT 0.0,
            baseline_impressions INTEGER DEFAULT 0,
            latest_position REAL DEFAULT 0.0,
            latest_ctr REAL DEFAULT 0.0,
            status TEXT DEFAULT 'pending_24h',
            auto_apply_at TEXT DEFAULT '',
            activated_at TEXT DEFAULT '',
            evaluated_at TEXT DEFAULT '',
            reason TEXT DEFAULT ''
        );
        CREATE INDEX IF NOT EXISTS idx_sqlite_seo_exp_status ON seo_experiments(status);
        CREATE INDEX IF NOT EXISTS idx_sqlite_seo_exp_path ON seo_experiments(page_path);
        """
    )

    # Automatic migration: ensure newer columns exist on existing databases
    existing_tenant_cols = [c[1] for c in cur.execute("PRAGMA table_info(tenants)").fetchall()]
    if "scheduling_type" not in existing_tenant_cols:
        cur.execute("ALTER TABLE tenants ADD COLUMN scheduling_type TEXT DEFAULT 'google_calendar'")
    if "booking_url" not in existing_tenant_cols:
        cur.execute("ALTER TABLE tenants ADD COLUMN booking_url TEXT DEFAULT ''")
    if "ics_feed_url" not in existing_tenant_cols:
        cur.execute("ALTER TABLE tenants ADD COLUMN ics_feed_url TEXT DEFAULT ''")
    if "availability_json" not in existing_tenant_cols:
        cur.execute("ALTER TABLE tenants ADD COLUMN availability_json TEXT DEFAULT '{}'")
    if "emergency_config_json" not in existing_tenant_cols:
        cur.execute("ALTER TABLE tenants ADD COLUMN emergency_config_json TEXT DEFAULT '{}'")

    # Sync tenant YAML presets to DB for any existing seeded rows
    cur.execute(
        """
        UPDATE tenants SET
            scheduling_type = 'external_link',
            booking_url = 'https://calendly.com/apex-shore-roofing/21-point-drone-inspection'
        WHERE tenant_id = 'client_apex_roofing' AND (booking_url IS NULL OR booking_url = '')
        """
    )

    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    tomorrow_iso = (datetime.now() + timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")

    # 1. Seed system_settings
    default_ticker = [
        "🟢 Dispatched 12m ago: Free 21-Point Roof & Attic Inspection in Silverton, Toms River",
        "🟢 Dispatched 26m ago: CertainTeed Landmark PRO Replacement in Brick Township",
        "🟢 Dispatched 39m ago: 160 MPH Coastal Roof Upgrade in Point Pleasant Beach",
        "🟢 Dispatched 54m ago: Emergency Flashing & Leak Triage in Forked River, Lacey",
        "🟢 Dispatched 1h 15m ago: 21-Point Roof & Attic Moisture Check in Brookwood, Jackson",
    ]
    default_settings = {
        "auto_publish_24h": "true",
        "enable_review_sms": "true",
        "enable_weather_storm_banner": "true",
        "enable_vapi_callback": "true" if settings.ENABLE_OUTBOUND_CALLBACK else "false",
        "gbp_review_url": settings.GBP_REVIEW_URL or "https://g.page/r/OceanCountyRoofingPros/review",
        "gbp_webhook_url": settings.GBP_WEBHOOK_URL or "",
        "admin_pin": settings.ADMIN_PIN or "732999",
        "storm_alert_active": "false",
        "storm_alert_headline": "🟢 Active in Ocean County Today — 21-Point Roof & Attic Inspections Dispatched Daily (Drone Upon Request)",
        "dispatch_ticker_json": json.dumps(default_ticker),
    }
    for k, v in default_settings.items():
        cur.execute(
            "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)",
            (k, v, now_iso),
        )

    seed_demo_data = bool(os.getenv("PYTEST_CURRENT_TEST") or os.getenv("OCRP_SEED_DEMO_DATA") == "1")

    # 2. Seed tenants (primary active tenant always; sample standby tenant only in tests/demo mode)
    cur.execute("SELECT COUNT(*) FROM tenants")
    if cur.fetchone()[0] == 0:
        tenants_seed = [
            (
                "client_joe_the_roofer",
                "Joe The Roofer LLC",
                "Joe",
                "Riley",
                "+17326609121",
                "powurnj@gmail.com",
                "732100",
                "google_calendar",
                "",
                "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com",
                "Fully Licensed & Insured NJ HIC",
                1500.00,
                1,
                "Primary launch partner for Ocean County, NJ. Full 21-point roof & attic inspections (drone upon request).",
                now_iso,
            ),
        ]
        if seed_demo_data:
            tenants_seed.append(
                (
                    "client_apex_roofing",
                    "Apex Shore Roofing & Restoration LLC",
                    "Mike Sullivan",
                    "Tyler",
                    "+17325550199",
                    "dispatch@apexshoreroofing.com",
                    "732200",
                    "external_link",
                    "https://calendly.com/apex-shore-roofing/21-point-drone-inspection",
                    "apex_shore_calendar@group.calendar.google.com",
                    "Fully Licensed & Insured NJ HIC",
                    2000.00,
                    0,
                    "Backup / prospective tenant covering northern Ocean and Monmouth counties.",
                    now_iso,
                )
            )
        cur.executemany(
            """
            INSERT INTO tenants (
                tenant_id, company_name, contact_name, estimator_name, dispatch_phone,
                email, portal_pin, scheduling_type, booking_url, calendar_id, service_license, monthly_retainer,
                is_active, notes, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            tenants_seed,
        )

    # 3. Seed realistic Ocean County leads (only in test/demo mode; production starts with live data only)
    cur.execute("SELECT COUNT(*) FROM leads")
    if seed_demo_data and cur.fetchone()[0] == 0:
        leads_seed = [
            (
                "WEB-171001",
                now_iso,
                now_iso,
                "Website Form",
                "Mark",
                "DeLuca",
                "+17325550142",
                "mark.deluca@example.com",
                "48 Kettle Creek Rd",
                "Toms River",
                "NJ",
                "08753",
                "Full Roof Replacement",
                "High",
                "Storm & Wind Damage",
                "2-Story Colonial",
                "2026-11-09 10:00 AM",
                "CertainTeed Landmark PRO Pewter Gray installation completed in Silverton.",
                "client_joe_the_roofer",
                "Completed",
                14200.00,
                "https://storage.vapi.ai/demo-call-171001.mp3",
                "Caller requested 21-point roof & attic inspection (plus requested drone views) after bayfront wind gusts lifted ridge tabs.",
                142,
                1,
                now_iso,
            ),
            (
                "CALL-171002",
                now_iso,
                now_iso,
                "Vapi Inbound Call",
                "David",
                "Miller",
                "+17325550188",
                "dmiller.brick@example.com",
                "214 Drum Point Rd",
                "Brick Township",
                "NJ",
                "08723",
                "Full Roof Replacement",
                "Standard",
                "Aging Roof (15+ Years)",
                "1-Story Ranch",
                "2026-11-10 01:00 PM",
                "Signed contract for CertainTeed Landmark Charcoal 50-Yr package.",
                "client_joe_the_roofer",
                "Job Won",
                12800.00,
                "https://storage.vapi.ai/demo-call-171002.mp3",
                "Booked 21-point roof & attic inspection with estimator Riley.",
                168,
                0,
                "",
            ),
            (
                "WEB-171003",
                now_iso,
                now_iso,
                "Website Form",
                "Elena",
                "Rossi",
                "+17325550164",
                "elena.rossi@example.com",
                "112 Ocean Ave",
                "Point Pleasant",
                "NJ",
                "08742",
                "Coastal 160-MPH Roof Upgrade",
                "High",
                "Full Replacement & Architectural Upgrade",
                "Coastal / Lagoon Home",
                "2026-11-11 09:00 AM",
                "21-point roof & attic inspection completed; homeowner reviewing written proposal.",
                "client_joe_the_roofer",
                "Inspected",
                16500.00,
                "",
                "",
                0,
                0,
                "",
            ),
            (
                "CALL-171004",
                now_iso,
                now_iso,
                "Vapi Inbound Call",
                "Robert",
                "Kowalski",
                "+17325550191",
                "rkowalski@example.com",
                "85 Whitesville Rd",
                "Jackson",
                "NJ",
                "08527",
                "Emergency Leak Repair",
                "Emergency",
                "Active Water Leak",
                "Split-Level / Cape Cod",
                "2026-11-12 11:00 AM",
                "Chimney counter-flashing and valley leak inspection scheduled with Riley.",
                "client_joe_the_roofer",
                "Booked",
                1850.00,
                "https://storage.vapi.ai/demo-call-171004.mp3",
                "Caller reported attic moisture near chimney flashing after heavy rain.",
                115,
                0,
                "",
            ),
            (
                "WEB-171005",
                now_iso,
                now_iso,
                "Website Form",
                "Patricia",
                "Gallagher",
                "+17325550129",
                "pgallagher@example.com",
                "309 Lakeside Dr N",
                "Lacey Township",
                "NJ",
                "08731",
                "Full Roof Replacement",
                "Standard",
                "Aging Roof (15+ Years)",
                "1-Story Ranch",
                "2026-11-12 03:00 PM",
                "Forked River lagoon home requesting 21-point roof inspection (plus aerial drone inquiry) and 50-year shingle quote.",
                "client_joe_the_roofer",
                "Booked",
                12500.00,
                "",
                "",
                0,
                0,
                "",
            ),
        ]
        cur.executemany(
            """
            INSERT INTO leads (
                id, created_at, updated_at, lead_source, first_name, last_name, phone, email,
                street_address, city, state, zip_code, service_requested, urgency,
                diagnostic_situation, home_architecture, appointment_slot, notes,
                assigned_tenant_id, status, estimated_value, call_recording_url,
                call_transcript, call_duration_sec, review_request_sent, review_request_sent_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            leads_seed,
        )

    # 4. Seed verified job_projects across Ocean County towns (only in test/demo mode)
    cur.execute("SELECT COUNT(*) FROM job_projects")
    if seed_demo_data and cur.fetchone()[0] == 0:
        projects_seed = [
            (
                "PROJ-TR-001",
                now_iso,
                "roofing-toms-river-nj",
                "Toms River",
                "Silverton",
                "Full Roof Replacement",
                "CertainTeed Landmark PRO (Pewter)",
                "1-day tear-off and 160 MPH coastal shingle installation near Silver Bay.",
                "Completed a full tear-off down to the plywood deck in Silverton, Toms River, NJ (08753), installing a CertainTeed Landmark PRO architectural roof system rated for 160 MPH Barnegat Bay wind gusts with DiamondDeck synthetic underlayment and ice-and-water shield.",
                "/static/images/shingle-restored-after.webp",
                "/static/images/shingle-restored-after.jpg",
                39.9612,
                -74.1425,
                "owner",
                "client_joe_the_roofer",
                "approved",
                "",
            ),
            (
                "PROJ-BRK-002",
                now_iso,
                "roofing-brick-nj",
                "Brick Township",
                "Midstreams",
                "Full Roof Replacement",
                "CertainTeed Landmark (Moire Black)",
                "Complete 28-square colonial roof replacement and ridge vent upgrade in Midstreams.",
                "Installed a 50-year CertainTeed Integrity Roof System in the Midstreams neighborhood of Brick Township, NJ (08724), including Cobra snow-country ridge ventilation, custom step flashing, and a full magnetic yard sweep.",
                "/static/images/roofer-crew-action.webp",
                "/static/images/roofer-crew-action.jpg",
                40.0642,
                -74.1288,
                "owner",
                "client_joe_the_roofer",
                "approved",
                "",
            ),
            (
                "PROJ-PP-003",
                now_iso,
                "roofing-point-pleasant-nj",
                "Point Pleasant",
                "Point Pleasant Beach",
                "Coastal Storm Restoration",
                "CertainTeed Landmark PRO (Weathered Wood)",
                "Hurricane-rated 6-nail oceanfront shingle installation two blocks from the boardwalk.",
                "Engineered for salt-air corrosion and Atlantic nor'easter wind shear in Point Pleasant Beach, NJ (08742). Upgraded aged 3-tab shingles to 160-MPH wind-warranted CertainTeed Landmark PRO with StreakFighter copper-infused algae protection.",
                "/static/images/drone-thermal-inspection.webp",
                "/static/images/drone-thermal-inspection.jpg",
                40.0851,
                -74.0598,
                "owner",
                "client_joe_the_roofer",
                "approved",
                "",
            ),
            (
                "PROJ-LCY-004",
                now_iso,
                "roofing-lacey-nj",
                "Lacey Township",
                "Forked River",
                "Full Roof Replacement",
                "CertainTeed Landmark (Georgetown Gray)",
                "Lagoon-front ranch tear-off and skylight flashing rebuild on Kettle Creek.",
                "Pending 24h hybrid auto-publish: Contractor field upload from Forked River in Lacey Township, NJ (08731) featuring custom Velux skylight flashing and 130+ MPH wind-resistant shingles.",
                "/static/images/shingle-damaged-before.webp",
                "/static/images/shingle-damaged-before.jpg",
                39.8594,
                -74.1842,
                "contractor",
                "client_joe_the_roofer",
                "pending_auto_24h",
                tomorrow_iso,
            ),
        ]
        cur.executemany(
            """
            INSERT INTO job_projects (
                id, created_at, town_slug, town_name, neighborhood, service_type,
                shingle_system, caption, ai_seo_summary, image_webp_url,
                image_geotagged_jpg_url, lat, lon, uploaded_by, tenant_id,
                approval_status, auto_publish_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            projects_seed,
        )

    # 5. Seed verified customer reviews (only in test/demo mode)
    cur.execute("SELECT COUNT(*) FROM reviews")
    if seed_demo_data and cur.fetchone()[0] == 0:
        reviews_seed = [
            (
                "REV-101",
                now_iso,
                "WEB-171001",
                "Mark & Sarah D.",
                "Toms River",
                "roofing-toms-river-nj",
                "Full Roof Replacement",
                5,
                "After the nor'easter in March, two shingles ripped off our bayfront roof in Silverton, Toms River. Their 21-point inspection caught hidden water seepage around the chimney before it ruined our drywall. The crew finished the whole CertainTeed Landmark PRO replacement in a single day and left zero nails in the driveway!",
                "Google",
                "Thank you so much, Mark and Sarah! Protecting bayfront homes in Silverton and across Toms River from nor'easter wind damage is exactly why we start every job with a thorough 21-point roof & attic inspection. Enjoy your new 50-year CertainTeed Landmark PRO roof!",
                "published",
                1,
                "resolved",
            ),
            (
                "REV-102",
                now_iso,
                "CALL-171002",
                "David M.",
                "Brick Township",
                "roofing-brick-nj",
                "Full Roof Replacement",
                5,
                "We got 4 estimates for our ranch in Brick Township. Ocean County Roofing Pros sent a 21-point inspection photo report within 2 hours with crystal-clear pictures of the rotted valley flashing. Totally transparent pricing, zero sales pressure, and 1-day installation.",
                "Google",
                "We appreciate the 5-star review, David! Our Brick Township crew takes pride in delivering zero-pressure 21-point inspection photo reports and clean 1-day CertainTeed installations. Thank you for trusting us with your home!",
                "published",
                1,
                "resolved",
            ),
            (
                "REV-103",
                now_iso,
                "WEB-171003",
                "Elena R.",
                "Point Pleasant",
                "roofing-point-pleasant-nj",
                "Coastal 160-MPH Roof Upgrade",
                5,
                "Living two blocks from the beach in Point Pleasant means brutal salt air and gale-force gusts. Upgrading to the CertainTeed Landmark PRO 160 MPH system transformed our curb appeal and even lowered our homeowners insurance premium.",
                "Google",
                "Thank you, Elena! Coastal homes in Point Pleasant Beach demand true 160 MPH hurricane-grade fastening and StreakFighter algae protection. We're thrilled the new CertainTeed Landmark PRO system earned you an insurance discount!",
                "pending",
                1,
                "resolved",
            ),
        ]
        cur.executemany(
            """
            INSERT INTO reviews (
                id, created_at, lead_id, reviewer_name, town_name, town_slug,
                service_performed, rating, review_text, source, ai_reply_draft,
                reply_status, is_public, resolution_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            reviews_seed,
        )

    # 6. Seed GBP Posts (only in test/demo mode)
    cur.execute("SELECT COUNT(*) FROM gbp_posts")
    if seed_demo_data and cur.fetchone()[0] == 0:
        gbp_seed = [
            (
                "GBP-201",
                now_iso,
                now_iso[:10],
                "Project Highlight",
                "Toms River",
                "roofing-toms-river-nj",
                "1-Day CertainTeed Landmark PRO Roof Replacement in Silverton, Toms River",
                "Just wrapped up a 26-square coastal roof upgrade in Silverton, Toms River, NJ (08753)! Our certified crew performed a full tear-off to the plywood deck, installed ice-and-water barrier in all valleys, and fastened 160 MPH wind-rated CertainTeed Landmark PRO shingles. Book your free 21-point roof & attic inspection in Ocean County today (aerial drone diagnostics available upon request)!",
                "/static/images/shingle-restored-after.jpg",
                "BOOK",
                "https://oceancountyroofingpros.com/roofing-toms-river-nj#quizSection",
                "approved",
                "",
                0,
            ),
            (
                "GBP-202",
                now_iso,
                now_iso[:10],
                "Seasonal Tip",
                "Brick Township",
                "roofing-brick-nj",
                "Jersey Shore Coastal Wind & Flashing Check Before the Next Nor'easter",
                "Homeowners in Brick Township and Point Pleasant: 82% of roof leaks start at chimney counter-flashing and plumbing vent boots 12 months before water spots appear on your ceiling. Our free 21-point roof & attic inspection spots hidden moisture early—with aerial drone diagnostics available upon request for steep or complex roofs.",
                "/static/images/drone-thermal-inspection.jpg",
                "LEARN_MORE",
                "https://oceancountyroofingpros.com/roofing-brick-nj#quizSection",
                "draft_auto_24h",
                tomorrow_iso,
                0,
            ),
        ]
        cur.executemany(
            """
            INSERT INTO gbp_posts (
                id, created_at, scheduled_for, post_type, town_name, town_slug,
                title, content, image_url, cta_type, cta_url, status,
                auto_publish_at, webhook_dispatched
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            gbp_seed,
        )

    # 7. Seed Starter Ocean County SEO Blog Articles
    cur.execute("SELECT COUNT(*) FROM blog_posts")
    if cur.fetchone()[0] == 0:
        from app.services.blog_seed import get_starter_blog_posts
        for post in get_starter_blog_posts(now_iso):
            cur.execute(
                """
                INSERT INTO blog_posts (
                    id, slug, title, meta_title, meta_description, category, excerpt,
                    target_towns_json, sections_json, faqs_json, hero_image_url,
                    hero_image_alt, veo_video_url, veo_video_poster_url,
                    reading_time_min, cta_service, author_name, status,
                    auto_publish_at, published_at, meta_shared, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    post["id"],
                    post["slug"],
                    post["title"],
                    post.get("meta_title", ""),
                    post.get("meta_description", ""),
                    post.get("category", "Coastal Materials"),
                    post.get("excerpt", ""),
                    json.dumps(post.get("target_towns", [])),
                    json.dumps(post.get("sections", [])),
                    json.dumps(post.get("faqs", [])),
                    post.get("hero_image_url", ""),
                    post.get("hero_image_alt", ""),
                    post.get("veo_video_url", ""),
                    post.get("veo_video_poster_url", ""),
                    int(post.get("reading_time_min") or 6),
                    post.get("cta_service", "Free 21-Point Roof & Attic Inspection"),
                    post.get("author_name", "Ocean County Roofing Pros Editorial Team"),
                    post.get("status", "published"),
                    post.get("auto_publish_at", ""),
                    post.get("published_at", now_iso),
                    1 if post.get("meta_shared") else 0,
                    post.get("created_at", now_iso),
                    post.get("updated_at", now_iso),
                ),
            )

    conn.commit()
    conn.close()


# Ensure DB is initialized on import
init_db()


# ==============================================================================
# SYSTEM SETTINGS CRUD
# ==============================================================================

def get_all_settings() -> Dict[str, str]:
    conn = _get_conn()
    rows = conn.execute("SELECT key, value FROM system_settings").fetchall()
    conn.close()
    return {r["key"]: r["value"] for r in rows}


def get_setting(key: str, default: str = "") -> str:
    conn = _get_conn()
    row = conn.execute("SELECT value FROM system_settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row else default


def get_bool_setting(key: str, default: bool = True) -> bool:
    val = get_setting(key, "true" if default else "false").strip().lower()
    return val in ("true", "1", "yes", "on")


def set_setting(key: str, value: Any) -> None:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    str_val = str(value)
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO system_settings (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (key, str_val, now_iso),
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("system_settings", "UPSERT", {"key": key, "value": str_val, "updated_at": now_iso}, match_col="key", match_val=key)


def update_settings_bulk(updates: Dict[str, Any]) -> Dict[str, str]:
    for k, v in updates.items():
        if isinstance(v, bool):
            set_setting(k, "true" if v else "false")
        else:
            set_setting(k, v)
    return get_all_settings()


# ==============================================================================
# TENANTS CRUD
# ==============================================================================

def list_tenants() -> List[Dict[str, Any]]:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM tenants ORDER BY is_active DESC, company_name ASC").fetchall()
    conn.close()
    res = []
    for r in rows:
        d = dict(r)
        d["is_active"] = bool(d.get("is_active"))
        res.append(d)
    return res


def get_tenant(tenant_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM tenants WHERE tenant_id = ?", (tenant_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["is_active"] = bool(d.get("is_active"))
    return d


def get_active_tenant_record() -> Dict[str, Any]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM tenants WHERE is_active = 1 LIMIT 1").fetchone()
    if not row:
        row = conn.execute("SELECT * FROM tenants LIMIT 1").fetchone()
    conn.close()
    if row:
        d = dict(row)
        d["is_active"] = bool(d.get("is_active"))
        return d
    return {
        "tenant_id": "client_joe_the_roofer",
        "company_name": "Joe The Roofer LLC",
        "contact_name": "Joe",
        "estimator_name": "Riley",
        "dispatch_phone": "+17326609121",
        "email": "powurnj@gmail.com",
        "portal_pin": "732100",
        "calendar_id": "primary",
        "service_license": "Fully Licensed & Insured NJ HIC",
        "monthly_retainer": 1500.0,
        "is_active": True,
        "notes": "",
    }


def switch_active_tenant_db(tenant_id: str) -> bool:
    conn = _get_conn()
    target = conn.execute("SELECT tenant_id FROM tenants WHERE tenant_id = ?", (tenant_id,)).fetchone()
    if not target:
        conn.close()
        return False
    all_rows = conn.execute("SELECT tenant_id FROM tenants").fetchall()
    conn.execute("UPDATE tenants SET is_active = 0")
    conn.execute("UPDATE tenants SET is_active = 1 WHERE tenant_id = ?", (tenant_id,))
    conn.commit()
    conn.close()
    for r in all_rows:
        tid = r["tenant_id"]
        _sync_to_supabase_cloud("tenants", "PATCH", {"is_active": tid == tenant_id}, match_col="tenant_id", match_val=tid)
    return True


def upsert_tenant(data: Dict[str, Any]) -> Dict[str, Any]:
    tenant_id = (data.get("tenant_id") or "").strip()
    if not tenant_id:
        slug = re.sub(r"[^a-z0-9]+", "_", (data.get("company_name") or "partner").lower()).strip("_")
        tenant_id = f"client_{slug}"
    existing = get_tenant(tenant_id) or {}
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    raw_avail = data.get("availability_json", data.get("availability", existing.get("availability_json", "{}")))
    avail_str = json.dumps(raw_avail) if isinstance(raw_avail, (dict, list)) else str(raw_avail or "{}")
    ics_url = str(data.get("ics_feed_url", existing.get("ics_feed_url", "")) or "").strip()
    raw_emerg = data.get("emergency_config_json", data.get("emergency_config", existing.get("emergency_config_json", "{}")))
    emerg_str = json.dumps(raw_emerg) if isinstance(raw_emerg, dict) else str(raw_emerg or "{}")

    record = {
        "tenant_id": tenant_id,
        "company_name": data.get("company_name", existing.get("company_name", "Roofing Partner LLC")),
        "contact_name": data.get("contact_name", data.get("contact_person", existing.get("contact_name", ""))),
        "estimator_name": data.get("estimator_name", data.get("assigned_estimator", existing.get("estimator_name", "Riley"))),
        "dispatch_phone": data.get("dispatch_phone", existing.get("dispatch_phone", "+17326609121")),
        "email": data.get("email", data.get("notification_email", existing.get("email", ""))),
        "portal_pin": str(data.get("portal_pin", existing.get("portal_pin", "732100"))).strip(),
        "scheduling_type": data.get("scheduling_type", existing.get("scheduling_type", "google_calendar")),
        "booking_url": data.get("booking_url", existing.get("booking_url", "")),
        "calendar_id": data.get("calendar_id", data.get("google_calendar_id", existing.get("calendar_id", "primary"))),
        "ics_feed_url": ics_url,
        "availability_json": avail_str,
        "emergency_config_json": emerg_str,
        "service_license": data.get("service_license", existing.get("service_license", "Fully Licensed & Insured NJ HIC")),
        "monthly_retainer": float(data.get("monthly_retainer", data.get("monthly_rate", existing.get("monthly_retainer", 1500.0)))),
        "is_active": 1 if data.get("is_active", existing.get("is_active", False)) else 0,
        "notes": data.get("notes", existing.get("notes", "")),
        "created_at": existing.get("created_at", now_iso),
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO tenants (
            tenant_id, company_name, contact_name, estimator_name, dispatch_phone,
            email, portal_pin, scheduling_type, booking_url, calendar_id, ics_feed_url, availability_json, emergency_config_json,
            service_license, monthly_retainer, is_active, notes, created_at
        ) VALUES (
            :tenant_id, :company_name, :contact_name, :estimator_name, :dispatch_phone,
            :email, :portal_pin, :scheduling_type, :booking_url, :calendar_id, :ics_feed_url, :availability_json, :emergency_config_json,
            :service_license, :monthly_retainer, :is_active, :notes, :created_at
        )
        ON CONFLICT(tenant_id) DO UPDATE SET
            company_name = excluded.company_name,
            contact_name = excluded.contact_name,
            estimator_name = excluded.estimator_name,
            dispatch_phone = excluded.dispatch_phone,
            email = excluded.email,
            portal_pin = excluded.portal_pin,
            scheduling_type = excluded.scheduling_type,
            booking_url = excluded.booking_url,
            calendar_id = excluded.calendar_id,
            ics_feed_url = excluded.ics_feed_url,
            availability_json = excluded.availability_json,
            emergency_config_json = excluded.emergency_config_json,
            service_license = excluded.service_license,
            monthly_retainer = excluded.monthly_retainer,
            is_active = excluded.is_active,
            notes = excluded.notes
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("tenants", "UPSERT", record, match_col="tenant_id", match_val=tenant_id)
    if ics_url or avail_str != "{}":
        try:
            avail_obj = json.loads(avail_str)
        except Exception:
            avail_obj = {}
        set_setting(f"tenant_schedule_{tenant_id}", json.dumps({"ics_feed_url": ics_url, "availability": avail_obj}))
    if emerg_str and emerg_str != "{}":
        set_setting(f"tenant_emergency_{tenant_id}", emerg_str)
    return get_tenant(tenant_id)


def authenticate_tenant_portal(identifier: str = "", pin: str = "") -> Optional[Dict[str, Any]]:
    """
    Authenticates a contractor by 6-digit PIN and optional email or tenant_id.
    """
    pin_clean = (pin or "").strip()
    id_clean = (identifier or "").strip().lower()
    tenants = list_tenants()
    for t in tenants:
        if pin_clean and str(t.get("portal_pin", "")).strip() == pin_clean:
            if not id_clean or id_clean in (
                t.get("tenant_id", "").lower(),
                t.get("email", "").lower(),
                t.get("company_name", "").lower(),
            ):
                return t
    # If only PIN was provided and matched a tenant, return that tenant
    if pin_clean:
        for t in tenants:
            if str(t.get("portal_pin", "")).strip() == pin_clean:
                return t
    return None


# ==============================================================================
# LEADS CRUD
# ==============================================================================

def default_estimated_value_for_service(service_requested: str) -> float:
    s = (service_requested or "").lower()
    if any(k in s for k in ("repair", "leak", "flashing", "tarp", "patch")):
        return 1200.00
    return 12500.00


def list_leads(
    status: Optional[str] = None,
    tenant_id: Optional[str] = None,
    search: Optional[str] = None,
) -> List[Dict[str, Any]]:
    conn = _get_conn()
    query = "SELECT * FROM leads WHERE 1=1"
    params: List[Any] = []
    if status and status != "All":
        query += " AND status = ?"
        params.append(status)
    if tenant_id and tenant_id != "All":
        query += " AND assigned_tenant_id = ?"
        params.append(tenant_id)
    if search:
        q = f"%{search.strip()}%"
        query += " AND (first_name LIKE ? OR last_name LIKE ? OR phone LIKE ? OR email LIKE ? OR street_address LIKE ? OR city LIKE ? OR id LIKE ?)"
        params.extend([q, q, q, q, q, q, q])
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    res = []
    for r in rows:
        d = dict(r)
        d["review_request_sent"] = bool(d.get("review_request_sent"))
        res.append(d)
    return res


def get_lead(lead_id_or_phone: str) -> Optional[Dict[str, Any]]:
    if not lead_id_or_phone:
        return None
    key = lead_id_or_phone.strip()
    conn = _get_conn()
    row = conn.execute("SELECT * FROM leads WHERE id = ?", (key,)).fetchone()
    if not row:
        norm = normalize_phone(key)
        if norm:
            rows = conn.execute("SELECT * FROM leads ORDER BY created_at DESC").fetchall()
            for candidate in rows:
                if normalize_phone(candidate["phone"]) == norm:
                    row = candidate
                    break
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["review_request_sent"] = bool(d.get("review_request_sent"))
    return d


def create_lead(lead_data: Dict[str, Any]) -> Dict[str, Any]:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    lead_id = (
        lead_data.get("id")
        or lead_data.get("lead_id")
        or f"WEB-{int(datetime.now().timestamp() * 1000) % 100000000}"
    )
    service_req = lead_data.get("service_requested") or lead_data.get("service") or "Full Roof Replacement"
    raw_val = lead_data.get("estimated_value")
    if raw_val is None or raw_val == "":
        est_value = default_estimated_value_for_service(service_req)
    else:
        try:
            est_value = float(str(raw_val).replace("$", "").replace(",", "").strip())
        except ValueError:
            est_value = default_estimated_value_for_service(service_req)

    active_tenant = get_active_tenant_record()
    assigned_tenant = lead_data.get("assigned_tenant_id") or active_tenant.get("tenant_id", "client_joe_the_roofer")

    raw_city = lead_data.get("city") or ""
    raw_address = lead_data.get("street_address") or lead_data.get("address") or ""
    if not raw_city and raw_address:
        town_match = get_town_by_name_or_slug(raw_address)
        raw_city = town_match.get("town_name", settings.PRIMARY_CITY)
    elif not raw_city:
        raw_city = settings.PRIMARY_CITY

    town_info = get_town_by_name_or_slug(raw_city)
    zip_code = lead_data.get("zip_code") or (town_info.get("zip_codes", ["08753"])[0])

    # Normalize status names
    raw_status = (lead_data.get("status") or "New Lead").strip()
    if raw_status == "Inspection Booked":
        raw_status = "Booked"

    phone_raw = lead_data.get("phone") or lead_data.get("phone_number") or ""
    phone_e164 = format_e164_phone(phone_raw) if phone_raw else ""

    record = {
        "id": str(lead_id),
        "created_at": lead_data.get("created_at") or lead_data.get("timestamp") or now_iso,
        "updated_at": now_iso,
        "lead_source": lead_data.get("lead_source") or "Website Form",
        "first_name": (lead_data.get("first_name") or "").strip(),
        "last_name": (lead_data.get("last_name") or "").strip(),
        "phone": phone_e164 or phone_raw,
        "email": (lead_data.get("email") or "").strip(),
        "street_address": raw_address.strip(),
        "city": raw_city.strip(),
        "state": (lead_data.get("state") or settings.PRIMARY_STATE).strip(),
        "zip_code": str(zip_code).strip(),
        "service_requested": service_req,
        "urgency": lead_data.get("urgency") or "Standard",
        "diagnostic_situation": lead_data.get("diagnostic_situation") or "",
        "home_architecture": lead_data.get("home_architecture") or "",
        "appointment_slot": lead_data.get("appointment_slot") or "",
        "notes": lead_data.get("notes") or lead_data.get("ai_summary") or "",
        "assigned_tenant_id": assigned_tenant,
        "status": raw_status,
        "estimated_value": est_value,
        "call_recording_url": lead_data.get("call_recording_url") or lead_data.get("recording_url") or "",
        "call_transcript": lead_data.get("call_transcript") or lead_data.get("ai_summary") or "",
        "call_duration_sec": int(lead_data.get("call_duration_sec") or 0),
        "review_request_sent": 1 if lead_data.get("review_request_sent") else 0,
        "review_request_sent_at": lead_data.get("review_request_sent_at") or "",
    }

    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO leads (
            id, created_at, updated_at, lead_source, first_name, last_name, phone, email,
            street_address, city, state, zip_code, service_requested, urgency,
            diagnostic_situation, home_architecture, appointment_slot, notes,
            assigned_tenant_id, status, estimated_value, call_recording_url,
            call_transcript, call_duration_sec, review_request_sent, review_request_sent_at
        ) VALUES (
            :id, :created_at, :updated_at, :lead_source, :first_name, :last_name, :phone, :email,
            :street_address, :city, :state, :zip_code, :service_requested, :urgency,
            :diagnostic_situation, :home_architecture, :appointment_slot, :notes,
            :assigned_tenant_id, :status, :estimated_value, :call_recording_url,
            :call_transcript, :call_duration_sec, :review_request_sent, :review_request_sent_at
        )
        ON CONFLICT(id) DO UPDATE SET
            updated_at = excluded.updated_at,
            first_name = excluded.first_name,
            last_name = excluded.last_name,
            phone = excluded.phone,
            email = excluded.email,
            street_address = excluded.street_address,
            city = excluded.city,
            state = excluded.state,
            zip_code = excluded.zip_code,
            service_requested = excluded.service_requested,
            urgency = excluded.urgency,
            diagnostic_situation = excluded.diagnostic_situation,
            home_architecture = excluded.home_architecture,
            appointment_slot = excluded.appointment_slot,
            notes = excluded.notes,
            assigned_tenant_id = excluded.assigned_tenant_id,
            status = excluded.status,
            estimated_value = excluded.estimated_value,
            call_recording_url = excluded.call_recording_url,
            call_transcript = excluded.call_transcript,
            call_duration_sec = excluded.call_duration_sec,
            review_request_sent = excluded.review_request_sent,
            review_request_sent_at = excluded.review_request_sent_at
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("leads", "UPSERT", record, match_col="id", match_val=record["id"])
    return get_lead(record["id"])


def update_lead(lead_id_or_phone: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    existing = get_lead(lead_id_or_phone)
    if not existing:
        return None
    lead_id = existing["id"]
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    allowed_cols = {
        "first_name",
        "last_name",
        "phone",
        "email",
        "street_address",
        "city",
        "state",
        "zip_code",
        "service_requested",
        "urgency",
        "diagnostic_situation",
        "home_architecture",
        "appointment_slot",
        "notes",
        "assigned_tenant_id",
        "status",
        "estimated_value",
        "call_recording_url",
        "call_transcript",
        "call_duration_sec",
        "review_request_sent",
        "review_request_sent_at",
    }

    clean_updates: Dict[str, Any] = {"updated_at": now_iso}
    for k, v in updates.items():
        if k in allowed_cols and v is not None:
            if k == "estimated_value":
                try:
                    clean_updates[k] = float(str(v).replace("$", "").replace(",", "").strip())
                except ValueError:
                    pass
            elif k == "review_request_sent":
                clean_updates[k] = 1 if v else 0
            else:
                clean_updates[k] = v

    set_clause = ", ".join(f"{col} = ?" for col in clean_updates.keys())
    values = list(clean_updates.values()) + [lead_id]

    conn = _get_conn()
    conn.execute(f"UPDATE leads SET {set_clause} WHERE id = ?", values)
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("leads", "PATCH", clean_updates, match_col="id", match_val=lead_id)
    return get_lead(lead_id)


def delete_lead(lead_id: str) -> bool:
    conn = _get_conn()
    cur = conn.execute("DELETE FROM leads WHERE id = ?", (lead_id,))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    if deleted:
        _sync_to_supabase_cloud("leads", "DELETE", match_col="id", match_val=lead_id)
    return deleted


# ==============================================================================
# JOB PROJECTS CRUD (Geo-Tagged Job Photos & Town Case Studies)
# ==============================================================================

def list_job_projects(
    town_slug: Optional[str] = None,
    approval_status: Optional[str] = None,
) -> List[Dict[str, Any]]:
    conn = _get_conn()
    query = "SELECT * FROM job_projects WHERE 1=1"
    params: List[Any] = []
    if town_slug:
        query += " AND town_slug = ?"
        params.append(town_slug)
    if approval_status:
        query += " AND approval_status = ?"
        params.append(approval_status)
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_job_project(project_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM job_projects WHERE id = ?", (project_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def create_job_project(data: Dict[str, Any]) -> Dict[str, Any]:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    proj_id = data.get("id") or f"PROJ-{int(datetime.now().timestamp() * 1000) % 10000000}"
    town_info = get_town_by_name_or_slug(data.get("town_slug") or data.get("town_name") or "Toms River")
    uploaded_by = (data.get("uploaded_by") or "owner").lower()
    default_status = "approved" if uploaded_by == "owner" else "pending_auto_24h"
    approval_status = data.get("approval_status") or default_status
    auto_publish_at = data.get("auto_publish_at") or (
        (datetime.now() + timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        if approval_status == "pending_auto_24h"
        else ""
    )

    record = {
        "id": proj_id,
        "created_at": data.get("created_at") or now_iso,
        "town_slug": data.get("town_slug") or town_info.get("slug", "roofing-toms-river-nj"),
        "town_name": data.get("town_name") or town_info.get("town_name", "Toms River"),
        "neighborhood": data.get("neighborhood") or (town_info.get("neighborhoods", ["Central"])[0]),
        "service_type": data.get("service_type") or "Full Roof Replacement",
        "shingle_system": data.get("shingle_system") or "CertainTeed Landmark PRO",
        "caption": data.get("caption") or "",
        "ai_seo_summary": data.get("ai_seo_summary") or "",
        "image_webp_url": data.get("image_webp_url") or "/static/images/shingle-restored-after.webp",
        "image_geotagged_jpg_url": data.get("image_geotagged_jpg_url") or "/static/images/shingle-restored-after.jpg",
        "lat": float(data.get("lat") if data.get("lat") is not None else town_info.get("lat", 39.9537)),
        "lon": float(data.get("lon") if data.get("lon") is not None else town_info.get("lon", -74.1979)),
        "uploaded_by": uploaded_by,
        "tenant_id": data.get("tenant_id") or get_active_tenant_record().get("tenant_id", "client_joe_the_roofer"),
        "approval_status": approval_status,
        "auto_publish_at": auto_publish_at,
    }

    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO job_projects (
            id, created_at, town_slug, town_name, neighborhood, service_type,
            shingle_system, caption, ai_seo_summary, image_webp_url,
            image_geotagged_jpg_url, lat, lon, uploaded_by, tenant_id,
            approval_status, auto_publish_at
        ) VALUES (
            :id, :created_at, :town_slug, :town_name, :neighborhood, :service_type,
            :shingle_system, :caption, :ai_seo_summary, :image_webp_url,
            :image_geotagged_jpg_url, :lat, :lon, :uploaded_by, :tenant_id,
            :approval_status, :auto_publish_at
        )
        ON CONFLICT(id) DO UPDATE SET
            town_slug = excluded.town_slug,
            town_name = excluded.town_name,
            neighborhood = excluded.neighborhood,
            service_type = excluded.service_type,
            shingle_system = excluded.shingle_system,
            caption = excluded.caption,
            ai_seo_summary = excluded.ai_seo_summary,
            image_webp_url = excluded.image_webp_url,
            image_geotagged_jpg_url = excluded.image_geotagged_jpg_url,
            lat = excluded.lat,
            lon = excluded.lon,
            approval_status = excluded.approval_status,
            auto_publish_at = excluded.auto_publish_at
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("job_projects", "UPSERT", record, match_col="id", match_val=proj_id)
    return get_job_project(proj_id)


def update_job_project(project_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    existing = get_job_project(project_id)
    if not existing:
        return None
    allowed = {
        "town_slug",
        "town_name",
        "neighborhood",
        "service_type",
        "shingle_system",
        "caption",
        "ai_seo_summary",
        "image_webp_url",
        "image_geotagged_jpg_url",
        "lat",
        "lon",
        "approval_status",
        "auto_publish_at",
    }
    clean = {k: v for k, v in updates.items() if k in allowed and v is not None}
    if not clean:
        return existing
    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    vals = list(clean.values()) + [project_id]
    conn = _get_conn()
    conn.execute(f"UPDATE job_projects SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("job_projects", "PATCH", clean, match_col="id", match_val=project_id)
    return get_job_project(project_id)


# ==============================================================================
# REVIEWS CRUD
# ==============================================================================

def list_reviews(
    town_slug: Optional[str] = None,
    public_only: bool = False,
    reply_status: Optional[str] = None,
) -> List[Dict[str, Any]]:
    conn = _get_conn()
    query = "SELECT * FROM reviews WHERE 1=1"
    params: List[Any] = []
    if town_slug:
        query += " AND town_slug = ?"
        params.append(town_slug)
    if public_only:
        query += " AND is_public = 1"
    if reply_status:
        query += " AND reply_status = ?"
        params.append(reply_status)
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    res = []
    for r in rows:
        d = dict(r)
        d["is_public"] = bool(d.get("is_public"))
        res.append(d)
    return res


def get_review(review_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM reviews WHERE id = ?", (review_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["is_public"] = bool(d.get("is_public"))
    return d


def create_review(data: Dict[str, Any]) -> Dict[str, Any]:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rev_id = data.get("id") or f"REV-{int(datetime.now().timestamp() * 1000) % 10000000}"
    town_info = get_town_by_name_or_slug(data.get("town_slug") or data.get("town_name") or "Toms River")
    record = {
        "id": rev_id,
        "created_at": data.get("created_at") or now_iso,
        "lead_id": data.get("lead_id") or "",
        "reviewer_name": data.get("reviewer_name") or "Verified Homeowner",
        "town_name": data.get("town_name") or town_info.get("town_name", "Toms River"),
        "town_slug": data.get("town_slug") or town_info.get("slug", "roofing-toms-river-nj"),
        "service_performed": data.get("service_performed") or "Full Roof Replacement",
        "rating": int(data.get("rating") if data.get("rating") is not None else 5),
        "review_text": data.get("review_text") or "",
        "source": data.get("source") or "Website",
        "ai_reply_draft": data.get("ai_reply_draft") or "",
        "reply_status": data.get("reply_status") or "pending",
        "is_public": 1 if data.get("is_public", True) else 0,
        "resolution_status": data.get("resolution_status") or "resolved",
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO reviews (
            id, created_at, lead_id, reviewer_name, town_name, town_slug,
            service_performed, rating, review_text, source, ai_reply_draft,
            reply_status, is_public, resolution_status
        ) VALUES (
            :id, :created_at, :lead_id, :reviewer_name, :town_name, :town_slug,
            :service_performed, :rating, :review_text, :source, :ai_reply_draft,
            :reply_status, :is_public, :resolution_status
        )
        ON CONFLICT(id) DO UPDATE SET
            ai_reply_draft = excluded.ai_reply_draft,
            reply_status = excluded.reply_status,
            is_public = excluded.is_public,
            resolution_status = excluded.resolution_status
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("reviews", "UPSERT", record, match_col="id", match_val=rev_id)
    return get_review(rev_id)


def update_review(review_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    existing = get_review(review_id)
    if not existing:
        return None
    allowed = {"ai_reply_draft", "reply_status", "is_public", "resolution_status", "review_text", "rating"}
    clean: Dict[str, Any] = {}
    for k, v in updates.items():
        if k in allowed and v is not None:
            clean[k] = (1 if v else 0) if k == "is_public" else v
    if not clean:
        return existing
    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    vals = list(clean.values()) + [review_id]
    conn = _get_conn()
    conn.execute(f"UPDATE reviews SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("reviews", "PATCH", clean, match_col="id", match_val=review_id)
    return get_review(review_id)


# ==============================================================================
# GBP POSTS CRUD
# ==============================================================================

def list_gbp_posts(status: Optional[str] = None) -> List[Dict[str, Any]]:
    conn = _get_conn()
    query = "SELECT * FROM gbp_posts WHERE 1=1"
    params: List[Any] = []
    if status:
        query += " AND status = ?"
        params.append(status)
    query += " ORDER BY created_at DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    res = []
    for r in rows:
        d = dict(r)
        d["webhook_dispatched"] = bool(d.get("webhook_dispatched"))
        res.append(d)
    return res


def get_gbp_post(post_id: str) -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM gbp_posts WHERE id = ?", (post_id,)).fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    d["webhook_dispatched"] = bool(d.get("webhook_dispatched"))
    return d


def create_gbp_post(data: Dict[str, Any]) -> Dict[str, Any]:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    post_id = data.get("id") or f"GBP-{int(datetime.now().timestamp() * 1000) % 10000000}"
    town_info = get_town_by_name_or_slug(data.get("town_slug") or data.get("town_name") or "Toms River")
    status = data.get("status") or "draft_auto_24h"
    auto_publish_at = data.get("auto_publish_at") or (
        (datetime.now() + timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        if status == "draft_auto_24h"
        else ""
    )
    record = {
        "id": post_id,
        "created_at": data.get("created_at") or now_iso,
        "scheduled_for": data.get("scheduled_for") or now_iso[:10],
        "post_type": data.get("post_type") or "Project Highlight",
        "town_name": data.get("town_name") or town_info.get("town_name", "Toms River"),
        "town_slug": data.get("town_slug") or town_info.get("slug", "roofing-toms-river-nj"),
        "title": data.get("title") or "Ocean County Roofing Update",
        "content": data.get("content") or "",
        "image_url": data.get("image_url") or "/static/images/shingle-restored-after.jpg",
        "cta_type": data.get("cta_type") or "LEARN_MORE",
        "cta_url": data.get("cta_url") or f"https://oceancountyroofingpros.com/{town_info.get('slug', 'roofing-toms-river-nj')}",
        "status": status,
        "auto_publish_at": auto_publish_at,
        "webhook_dispatched": 1 if data.get("webhook_dispatched") else 0,
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO gbp_posts (
            id, created_at, scheduled_for, post_type, town_name, town_slug,
            title, content, image_url, cta_type, cta_url, status,
            auto_publish_at, webhook_dispatched
        ) VALUES (
            :id, :created_at, :scheduled_for, :post_type, :town_name, :town_slug,
            :title, :content, :image_url, :cta_type, :cta_url, :status,
            :auto_publish_at, :webhook_dispatched
        )
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            content = excluded.content,
            status = excluded.status,
            webhook_dispatched = excluded.webhook_dispatched
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("gbp_posts", "UPSERT", record, match_col="id", match_val=post_id)
    return get_gbp_post(post_id)


def update_gbp_post(post_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    existing = get_gbp_post(post_id)
    if not existing:
        return None
    allowed = {"title", "content", "status", "image_url", "cta_type", "cta_url", "webhook_dispatched", "auto_publish_at"}
    clean: Dict[str, Any] = {}
    for k, v in updates.items():
        if k in allowed and v is not None:
            clean[k] = (1 if v else 0) if k == "webhook_dispatched" else v
    if not clean:
        return existing
    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    vals = list(clean.values()) + [post_id]
    conn = _get_conn()
    conn.execute(f"UPDATE gbp_posts SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("gbp_posts", "PATCH", clean, match_col="id", match_val=post_id)
    return get_gbp_post(post_id)


# ==============================================================================
# AGENT RUNS & DAILY REPORTS
# ==============================================================================

def log_agent_run(
    agent_name: str,
    status: str,
    summary: str,
    metrics: Optional[Dict[str, Any]] = None,
    duration_ms: int = 0,
) -> Dict[str, Any]:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    run_id = f"RUN-{int(datetime.now().timestamp() * 1000) % 100000000}"
    record = {
        "id": run_id,
        "created_at": now_iso,
        "agent_name": agent_name,
        "status": status,
        "summary": summary,
        "metrics_json": json.dumps(metrics or {}),
        "duration_ms": int(duration_ms),
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO agent_runs (id, created_at, agent_name, status, summary, metrics_json, duration_ms)
        VALUES (:id, :created_at, :agent_name, :status, :summary, :metrics_json, :duration_ms)
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("agent_runs", "UPSERT", record, match_col="id", match_val=run_id)
    return record


def list_agent_runs(limit: int = 40) -> List[Dict[str, Any]]:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM agent_runs ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    res = []
    for r in rows:
        d = dict(r)
        try:
            d["metrics"] = json.loads(d.get("metrics_json") or "{}")
        except Exception:
            d["metrics"] = {}
        res.append(d)
    return res


def save_daily_report(
    report_date: str,
    headline: str,
    markdown_content: str,
    metrics: Optional[Dict[str, Any]] = None,
    file_path: str = "",
) -> Dict[str, Any]:
    now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rep_id = f"REP-{report_date}-{int(datetime.now().timestamp()) % 10000}"
    record = {
        "id": rep_id,
        "report_date": report_date,
        "created_at": now_iso,
        "headline": headline,
        "markdown_content": markdown_content,
        "metrics_json": json.dumps(metrics or {}),
        "file_path": file_path,
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT INTO daily_reports (id, report_date, created_at, headline, markdown_content, metrics_json, file_path)
        VALUES (:id, :report_date, :created_at, :headline, :markdown_content, :metrics_json, :file_path)
        """,
        record,
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("daily_reports", "UPSERT", record, match_col="id", match_val=rep_id)
    return record


def get_latest_daily_report() -> Optional[Dict[str, Any]]:
    conn = _get_conn()
    row = conn.execute("SELECT * FROM daily_reports ORDER BY created_at DESC LIMIT 1").fetchone()
    conn.close()
    if not row:
        return None
    d = dict(row)
    try:
        d["metrics"] = json.loads(d.get("metrics_json") or "{}")
    except Exception:
        d["metrics"] = {}
    return d


def list_daily_reports(limit: int = 15) -> List[Dict[str, Any]]:
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM daily_reports ORDER BY created_at DESC LIMIT ?", (limit,)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


# ==============================================================================
# KPI & ROI SCOREBOARD ENGINE
# ==============================================================================

def get_dashboard_kpis(tenant_id: Optional[str] = None) -> Dict[str, Any]:
    leads = list_leads(tenant_id=tenant_id)
    active_tenant = get_tenant(tenant_id) if tenant_id else get_active_tenant_record()
    if not active_tenant:
        active_tenant = get_active_tenant_record()

    total_leads = len(leads)
    booked_count = sum(1 for l in leads if l.get("status") in ("Booked", "Inspection Booked", "Inspected", "Job Won", "Completed"))
    inspected_count = sum(1 for l in leads if l.get("status") in ("Inspected", "Job Won", "Completed"))
    jobs_won_count = sum(1 for l in leads if l.get("status") in ("Job Won", "Completed"))
    completed_count = sum(1 for l in leads if l.get("status") == "Completed")

    active_pipeline_value = sum(
        float(l.get("estimated_value") or 0)
        for l in leads
        if l.get("status") != "Lost"
    )
    won_revenue_value = sum(
        float(l.get("estimated_value") or 0)
        for l in leads
        if l.get("status") in ("Job Won", "Completed")
    )

    retainer = float(active_tenant.get("monthly_retainer") or 1500.0)
    roi_base = active_pipeline_value if active_pipeline_value > 0 else won_revenue_value
    roi_multiple = round(roi_base / retainer, 1) if retainer > 0 else 0.0
    won_roi_multiple = round(won_revenue_value / retainer, 1) if retainer > 0 else 0.0

    projects = list_job_projects()
    approved_projects = [p for p in projects if p.get("approval_status") == "approved"]
    pending_projects = [p for p in projects if p.get("approval_status") == "pending_auto_24h"]

    all_reviews = list_reviews()
    public_reviews = [r for r in all_reviews if r.get("is_public")]
    avg_rating = (
        round(sum(int(r.get("rating") or 5) for r in public_reviews) / len(public_reviews), 2)
        if public_reviews
        else 5.0
    )
    pending_replies = [r for r in all_reviews if r.get("reply_status") == "pending"]
    open_resolutions = [r for r in all_reviews if r.get("resolution_status") == "open"]

    gbp_posts = list_gbp_posts()
    pending_gbp = [g for g in gbp_posts if g.get("status") == "draft_auto_24h"]

    blog_posts = list_blog_posts()
    published_blog_posts = [b for b in blog_posts if b.get("status") == "published"]
    pending_blog_posts = [b for b in blog_posts if b.get("status") == "draft_auto_24h"]

    return {
        "total_leads": total_leads,
        "booked_count": booked_count,
        "inspected_count": inspected_count,
        "jobs_won_count": jobs_won_count,
        "completed_count": completed_count,
        "active_pipeline_value": active_pipeline_value,
        "won_revenue_value": won_revenue_value,
        "monthly_retainer": retainer,
        "roi_multiple": roi_multiple,
        "won_roi_multiple": won_roi_multiple,
        "active_tenant": active_tenant,
        "approved_projects_count": len(approved_projects),
        "pending_projects_count": len(pending_projects),
        "total_reviews_count": len(public_reviews),
        "avg_rating": avg_rating,
        "pending_replies_count": len(pending_replies),
        "open_resolutions_count": len(open_resolutions),
        "pending_gbp_count": len(pending_gbp),
        "published_blog_count": len(published_blog_posts),
        "pending_blog_count": len(pending_blog_posts),
        "pending_approval_total": len(pending_projects) + len(pending_replies) + len(pending_gbp) + len(pending_blog_posts),
        "supabase_cloud_connected": is_supabase_configured(),
        "local_mirror_path": get_sqlite_path(),
    }


# ==============================================================================
# BLOG POSTS CRUD & SUPABASE CLOUD SYNC
# ==============================================================================

def _parse_json_list(raw: Any) -> List[Any]:
    if isinstance(raw, list):
        return raw
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, list) else []
        except Exception:
            return []
    return []


def _normalize_blog_row(row: Dict[str, Any]) -> Dict[str, Any]:
    d = dict(row)
    d["meta_shared"] = bool(d.get("meta_shared"))
    d["target_towns"] = _parse_json_list(d.get("target_towns") if "target_towns" in d else d.get("target_towns_json"))
    d["sections"] = _parse_json_list(d.get("sections") if "sections" in d else d.get("sections_json"))
    d["faqs"] = _parse_json_list(d.get("faqs") if "faqs" in d else d.get("faqs_json"))
    d["target_towns_json"] = d.get("target_towns_json") or json.dumps(d["target_towns"])
    d["sections_json"] = d.get("sections_json") or json.dumps(d["sections"])
    d["faqs_json"] = d.get("faqs_json") or json.dumps(d["faqs"])
    d["reading_time_min"] = int(d.get("reading_time_min") or 6)
    pub_raw = str(d.get("published_at") or d.get("created_at") or "")
    d["published_date_iso"] = pub_raw[:10] if len(pub_raw) >= 10 else datetime.now().strftime("%Y-%m-%d")
    return d


def _slugify_blog_title(text: str) -> str:
    cleaned = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return cleaned or f"ocean-county-roofing-guide-{int(datetime.now().timestamp())}"


def _save_blog_record_sqlite(record: Dict[str, Any]) -> None:
    conn = _get_conn()
    conn.execute(
        "DELETE FROM blog_posts WHERE slug = ? AND id != ?",
        (record["slug"], record["id"]),
    )
    conn.execute(
        """
        INSERT INTO blog_posts (
            id, slug, title, meta_title, meta_description, category, excerpt,
            target_towns_json, sections_json, faqs_json, hero_image_url,
            hero_image_alt, veo_video_url, veo_video_poster_url,
            reading_time_min, cta_service, author_name, status,
            auto_publish_at, published_at, meta_shared, created_at, updated_at
        ) VALUES (
            :id, :slug, :title, :meta_title, :meta_description, :category, :excerpt,
            :target_towns_json, :sections_json, :faqs_json, :hero_image_url,
            :hero_image_alt, :veo_video_url, :veo_video_poster_url,
            :reading_time_min, :cta_service, :author_name, :status,
            :auto_publish_at, :published_at, :meta_shared, :created_at, :updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            slug = excluded.slug,
            title = excluded.title,
            meta_title = excluded.meta_title,
            meta_description = excluded.meta_description,
            category = excluded.category,
            excerpt = excluded.excerpt,
            target_towns_json = excluded.target_towns_json,
            sections_json = excluded.sections_json,
            faqs_json = excluded.faqs_json,
            hero_image_url = excluded.hero_image_url,
            hero_image_alt = excluded.hero_image_alt,
            veo_video_url = excluded.veo_video_url,
            veo_video_poster_url = excluded.veo_video_poster_url,
            reading_time_min = excluded.reading_time_min,
            cta_service = excluded.cta_service,
            author_name = excluded.author_name,
            status = excluded.status,
            auto_publish_at = excluded.auto_publish_at,
            published_at = excluded.published_at,
            meta_shared = excluded.meta_shared,
            updated_at = excluded.updated_at
        """,
        record,
    )
    conn.commit()
    conn.close()


def sync_blog_posts_from_supabase() -> List[Dict[str, Any]]:
    """
    Pulls blog_posts from live Supabase PostgREST (if configured) and mirrors them
    into local SQLite so static builds (`build_static.py`) and local renders stay in sync
    with cloud edits from `/admin` or `cron-seo-flywheel.mjs`.
    Falls back gracefully to local SQLite on offline/error.
    """
    if not is_supabase_configured():
        return []
    base_url = settings.SUPABASE_URL.rstrip("/")
    headers = {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
    }
    try:
        with httpx.Client(timeout=6.0) as client:
            r = client.get(
                f"{base_url}/rest/v1/blog_posts?order=published_at.desc.nullslast,created_at.desc",
                headers=headers,
            )
            if r.status_code != 200:
                logger.warning(f"Supabase blog_posts pull returned {r.status_code}: {r.text[:200]}")
                return []
            cloud_rows = r.json()
            if not isinstance(cloud_rows, list):
                return []
            cloud_ids = []
            now_utc = datetime.now(timezone.utc).isoformat()
            for row in cloud_rows:
                norm_rec = {
                    "id": str(row.get("id") or ""),
                    "slug": str(row.get("slug") or ""),
                    "title": str(row.get("title") or ""),
                    "meta_title": row.get("meta_title") or "",
                    "meta_description": row.get("meta_description") or "",
                    "category": row.get("category") or "Coastal Materials",
                    "excerpt": row.get("excerpt") or "",
                    "target_towns_json": row.get("target_towns_json") or "[]",
                    "sections_json": row.get("sections_json") or "[]",
                    "faqs_json": row.get("faqs_json") or "[]",
                    "hero_image_url": row.get("hero_image_url") or "",
                    "hero_image_alt": row.get("hero_image_alt") or "",
                    "veo_video_url": row.get("veo_video_url") or "",
                    "veo_video_poster_url": row.get("veo_video_poster_url") or "",
                    "reading_time_min": int(row.get("reading_time_min") or 6),
                    "cta_service": row.get("cta_service") or "Free 21-Point Roof & Attic Inspection",
                    "author_name": row.get("author_name") or "Ocean County Roofing Pros Editorial Team",
                    "status": row.get("status") or "draft_auto_24h",
                    "auto_publish_at": row.get("auto_publish_at") or "",
                    "published_at": row.get("published_at") or "",
                    "meta_shared": 1 if row.get("meta_shared") else 0,
                    "created_at": row.get("created_at") or now_utc,
                    "updated_at": row.get("updated_at") or now_utc,
                }
                if norm_rec["id"] and norm_rec["slug"]:
                    cloud_ids.append(norm_rec["id"])
                    _save_blog_record_sqlite(norm_rec)
            if cloud_ids:
                placeholders = ",".join("?" for _ in cloud_ids)
                conn = _get_conn()
                conn.execute(f"DELETE FROM blog_posts WHERE id NOT IN ({placeholders})", cloud_ids)
                conn.commit()
                conn.close()
            return [_normalize_blog_row(r) for r in cloud_rows]
    except Exception as e:
        logger.warning(f"Supabase blog_posts pull warning: {e}")
        return []


def _safe_float(val: Any, default: float) -> float:
    if val is None or val == "":
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _safe_int(val: Any, default: int) -> int:
    if val is None or val == "":
        return default
    try:
        return int(float(val))
    except (TypeError, ValueError):
        return default


def sync_job_projects_from_supabase() -> List[Dict[str, Any]]:
    """
    Pulls job_projects from live Supabase PostgREST (if configured) and mirrors them
    into local SQLite so static builds (`build_static.py`) include newly approved
    job photos from `/admin`, `/portal`, or `cron-seo-flywheel.mjs`.
    Falls back gracefully to local SQLite on offline/error.
    """
    init_db()
    if not is_supabase_configured():
        return []
    base_url = settings.SUPABASE_URL.rstrip("/")
    headers = {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
    }
    conn: Optional[sqlite3.Connection] = None
    try:
        with httpx.Client(timeout=6.0) as client:
            r = client.get(
                f"{base_url}/rest/v1/job_projects?order=created_at.desc",
                headers=headers,
            )
            if r.status_code != 200:
                logger.warning(f"Supabase job_projects pull returned {r.status_code}: {r.text[:200]}")
                return []
            cloud_rows = r.json()
            if not isinstance(cloud_rows, list):
                return []
            cloud_ids: List[str] = []
            now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            conn = _get_conn()
            for row in cloud_rows:
                proj_id = str(row.get("id") or "").strip()
                if not proj_id:
                    continue
                town_slug = str(row.get("town_slug") or "roofing-toms-river-nj")
                town_name = str(row.get("town_name") or "Toms River")
                record = {
                    "id": proj_id,
                    "created_at": str(row.get("created_at") or now_iso),
                    "town_slug": town_slug,
                    "town_name": town_name,
                    "neighborhood": str(row.get("neighborhood") or ""),
                    "service_type": str(row.get("service_type") or "Full Roof Replacement"),
                    "shingle_system": str(row.get("shingle_system") or "CertainTeed Landmark PRO"),
                    "caption": str(row.get("caption") or ""),
                    "ai_seo_summary": str(row.get("ai_seo_summary") or ""),
                    "image_webp_url": str(row.get("image_webp_url") or "/static/images/shingle-restored-after.webp"),
                    "image_geotagged_jpg_url": str(row.get("image_geotagged_jpg_url") or "/static/images/shingle-restored-after.jpg"),
                    "lat": _safe_float(row.get("lat"), 39.9537),
                    "lon": _safe_float(row.get("lon"), -74.1979),
                    "uploaded_by": str(row.get("uploaded_by") or "owner"),
                    "tenant_id": str(row.get("tenant_id") or "client_joe_the_roofer"),
                    "approval_status": str(row.get("approval_status") or "approved"),
                    "auto_publish_at": str(row.get("auto_publish_at") or ""),
                }
                conn.execute(
                    """
                    INSERT INTO job_projects (
                        id, created_at, town_slug, town_name, neighborhood, service_type,
                        shingle_system, caption, ai_seo_summary, image_webp_url,
                        image_geotagged_jpg_url, lat, lon, uploaded_by, tenant_id,
                        approval_status, auto_publish_at
                    ) VALUES (
                        :id, :created_at, :town_slug, :town_name, :neighborhood, :service_type,
                        :shingle_system, :caption, :ai_seo_summary, :image_webp_url,
                        :image_geotagged_jpg_url, :lat, :lon, :uploaded_by, :tenant_id,
                        :approval_status, :auto_publish_at
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        created_at = excluded.created_at,
                        town_slug = excluded.town_slug,
                        town_name = excluded.town_name,
                        neighborhood = excluded.neighborhood,
                        service_type = excluded.service_type,
                        shingle_system = excluded.shingle_system,
                        caption = excluded.caption,
                        ai_seo_summary = excluded.ai_seo_summary,
                        image_webp_url = excluded.image_webp_url,
                        image_geotagged_jpg_url = excluded.image_geotagged_jpg_url,
                        lat = excluded.lat,
                        lon = excluded.lon,
                        uploaded_by = excluded.uploaded_by,
                        tenant_id = excluded.tenant_id,
                        approval_status = excluded.approval_status,
                        auto_publish_at = excluded.auto_publish_at
                    """,
                    record,
                )
                cloud_ids.append(proj_id)
            if cloud_ids:
                placeholders = ",".join("?" for _ in cloud_ids)
                conn.execute(f"DELETE FROM job_projects WHERE id NOT IN ({placeholders})", cloud_ids)
            conn.commit()
            return list_job_projects()
    except Exception as e:
        logger.warning(f"Supabase job_projects pull warning: {e}")
        return []
    finally:
        if conn is not None:
            conn.close()


def sync_reviews_from_supabase() -> List[Dict[str, Any]]:
    """
    Pulls reviews from live Supabase PostgREST (if configured) and mirrors them
    into local SQLite so static builds (`build_static.py`) include newly published
    or approved reviews from `/feedback`, `/admin`, or `cron-seo-flywheel.mjs`.
    Falls back gracefully to local SQLite on offline/error.
    """
    init_db()
    if not is_supabase_configured():
        return []
    base_url = settings.SUPABASE_URL.rstrip("/")
    headers = {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
    }
    conn: Optional[sqlite3.Connection] = None
    try:
        with httpx.Client(timeout=6.0) as client:
            r = client.get(
                f"{base_url}/rest/v1/reviews?order=created_at.desc",
                headers=headers,
            )
            if r.status_code != 200:
                logger.warning(f"Supabase reviews pull returned {r.status_code}: {r.text[:200]}")
                return []
            cloud_rows = r.json()
            if not isinstance(cloud_rows, list):
                return []
            cloud_ids: List[str] = []
            now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            conn = _get_conn()
            for row in cloud_rows:
                rev_id = str(row.get("id") or "").strip()
                if not rev_id:
                    continue
                is_pub_raw = row.get("is_public")
                is_pub_int = 0 if (is_pub_raw is False or str(is_pub_raw).lower() in ("false", "0")) else 1
                record = {
                    "id": rev_id,
                    "created_at": str(row.get("created_at") or now_iso),
                    "lead_id": str(row.get("lead_id") or ""),
                    "reviewer_name": str(row.get("reviewer_name") or "Verified Homeowner"),
                    "town_name": str(row.get("town_name") or "Toms River"),
                    "town_slug": str(row.get("town_slug") or "roofing-toms-river-nj"),
                    "service_performed": str(row.get("service_performed") or "Full Roof Replacement"),
                    "rating": _safe_int(row.get("rating"), 5),
                    "review_text": str(row.get("review_text") or ""),
                    "source": str(row.get("source") or "Google"),
                    "ai_reply_draft": str(row.get("ai_reply_draft") or ""),
                    "reply_status": str(row.get("reply_status") or "pending"),
                    "is_public": is_pub_int,
                    "resolution_status": str(row.get("resolution_status") or "resolved"),
                }
                conn.execute(
                    """
                    INSERT INTO reviews (
                        id, created_at, lead_id, reviewer_name, town_name, town_slug,
                        service_performed, rating, review_text, source, ai_reply_draft,
                        reply_status, is_public, resolution_status
                    ) VALUES (
                        :id, :created_at, :lead_id, :reviewer_name, :town_name, :town_slug,
                        :service_performed, :rating, :review_text, :source, :ai_reply_draft,
                        :reply_status, :is_public, :resolution_status
                    )
                    ON CONFLICT(id) DO UPDATE SET
                        created_at = excluded.created_at,
                        lead_id = excluded.lead_id,
                        reviewer_name = excluded.reviewer_name,
                        town_name = excluded.town_name,
                        town_slug = excluded.town_slug,
                        service_performed = excluded.service_performed,
                        rating = excluded.rating,
                        review_text = excluded.review_text,
                        source = excluded.source,
                        ai_reply_draft = excluded.ai_reply_draft,
                        reply_status = excluded.reply_status,
                        is_public = excluded.is_public,
                        resolution_status = excluded.resolution_status
                    """,
                    record,
                )
                cloud_ids.append(rev_id)
            if cloud_ids:
                placeholders = ",".join("?" for _ in cloud_ids)
                conn.execute(f"DELETE FROM reviews WHERE id NOT IN ({placeholders})", cloud_ids)
            conn.commit()
            return list_reviews()
    except Exception as e:
        logger.warning(f"Supabase reviews pull warning: {e}")
        return []
    finally:
        if conn is not None:
            conn.close()


def sync_citations_from_supabase() -> Optional[str]:
    """
    Pulls `citations_json` from live Supabase `system_settings` (if configured) and
    mirrors it into local SQLite without writing back to Supabase.
    Falls back gracefully to local SQLite on offline/error.
    """
    init_db()
    if not is_supabase_configured():
        return None
    base_url = settings.SUPABASE_URL.rstrip("/")
    headers = {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
    }
    conn: Optional[sqlite3.Connection] = None
    try:
        with httpx.Client(timeout=6.0) as client:
            r = client.get(
                f"{base_url}/rest/v1/system_settings?key=eq.citations_json&select=key,value,updated_at",
                headers=headers,
            )
            if r.status_code != 200:
                logger.warning(f"Supabase citations_json pull returned {r.status_code}: {r.text[:200]}")
                return None
            rows = r.json()
            if not isinstance(rows, list) or not rows:
                return None
            raw_val = rows[0].get("value")
            if raw_val is None:
                return None
            str_val = json.dumps(raw_val) if isinstance(raw_val, (list, dict)) else str(raw_val)
            if not str_val.strip():
                return None
            now_iso = str(rows[0].get("updated_at") or datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
            conn = _get_conn()
            conn.execute(
                """
                INSERT INTO system_settings (key, value, updated_at)
                VALUES ('citations_json', ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (str_val, now_iso),
            )
            conn.commit()
            return str_val
    except Exception as e:
        logger.warning(f"Supabase citations_json pull warning: {e}")
        return None
    finally:
        if conn is not None:
            conn.close()


def list_blog_posts(
    status: Optional[str] = None,
    category: Optional[str] = None,
    sync_from_cloud: bool = False,
) -> List[Dict[str, Any]]:
    if sync_from_cloud:
        sync_blog_posts_from_supabase()
    conn = _get_conn()
    query = "SELECT * FROM blog_posts WHERE 1=1"
    params: List[Any] = []
    if status and status != "All":
        query += " AND status = ?"
        params.append(status)
    if category and category != "All":
        query += " AND category = ?"
        params.append(category)
    query += " ORDER BY CASE WHEN published_at != '' THEN published_at ELSE created_at END DESC"
    rows = conn.execute(query, params).fetchall()
    conn.close()
    return [_normalize_blog_row(dict(r)) for r in rows]


def get_blog_post(slug_or_id: str, sync_from_cloud: bool = False) -> Optional[Dict[str, Any]]:
    if not slug_or_id:
        return None
    if sync_from_cloud:
        sync_blog_posts_from_supabase()
    key = slug_or_id.strip()
    conn = _get_conn()
    row = conn.execute("SELECT * FROM blog_posts WHERE slug = ? OR id = ?", (key, key)).fetchone()
    conn.close()
    return _normalize_blog_row(dict(row)) if row else None


def upsert_blog_post(data: Dict[str, Any]) -> Dict[str, Any]:
    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.isoformat()
    slug = (data.get("slug") or _slugify_blog_title(data.get("title") or "")).strip().lower()
    existing = (get_blog_post(str(data["id"])) if data.get("id") else None) or get_blog_post(slug) or {}
    post_id = str(data.get("id") or existing.get("id") or f"BLOG-{int(now_dt.timestamp() * 1000) % 100000000}")
    status = (data.get("status") or existing.get("status") or "draft_auto_24h").strip()
    auto_publish_at = data.get("auto_publish_at")
    if auto_publish_at is None:
        auto_publish_at = (
            (now_dt + timedelta(hours=24)).isoformat()
            if status == "draft_auto_24h"
            else ""
        )
    published_at = data.get("published_at")
    if published_at is None:
        if status == "published":
            published_at = existing.get("published_at") or now_iso
        else:
            published_at = existing.get("published_at") or ""

    target_towns = data.get("target_towns")
    if target_towns is None:
        target_towns = _parse_json_list(data.get("target_towns_json")) or existing.get("target_towns", [])
    sections = data.get("sections")
    if sections is None:
        sections = _parse_json_list(data.get("sections_json")) or existing.get("sections", [])
    faqs = data.get("faqs")
    if faqs is None:
        faqs = _parse_json_list(data.get("faqs_json")) or existing.get("faqs", [])

    record = {
        "id": post_id,
        "slug": slug,
        "title": (data.get("title") or existing.get("title") or "Ocean County Roofing Guide").strip(),
        "meta_title": (data.get("meta_title") or existing.get("meta_title") or data.get("title") or "").strip(),
        "meta_description": (data.get("meta_description") or existing.get("meta_description") or data.get("excerpt") or "").strip(),
        "category": (data.get("category") or existing.get("category") or "Coastal Materials").strip(),
        "excerpt": (data.get("excerpt") or existing.get("excerpt") or "").strip(),
        "target_towns_json": json.dumps(target_towns),
        "sections_json": json.dumps(sections),
        "faqs_json": json.dumps(faqs),
        "hero_image_url": (data.get("hero_image_url") if data.get("hero_image_url") is not None else existing.get("hero_image_url", "/static/images/shingle-restored-after.webp")).strip(),
        "hero_image_alt": (data.get("hero_image_alt") if data.get("hero_image_alt") is not None else existing.get("hero_image_alt", "")).strip(),
        "veo_video_url": (data.get("veo_video_url") if data.get("veo_video_url") is not None else existing.get("veo_video_url", "")).strip(),
        "veo_video_poster_url": (data.get("veo_video_poster_url") if data.get("veo_video_poster_url") is not None else existing.get("veo_video_poster_url", "")).strip(),
        "reading_time_min": int(data.get("reading_time_min") or existing.get("reading_time_min") or 6),
        "cta_service": (data.get("cta_service") or existing.get("cta_service") or "Free 21-Point Roof & Attic Inspection").strip(),
        "author_name": (data.get("author_name") or existing.get("author_name") or "Ocean County Roofing Pros Editorial Team").strip(),
        "status": status,
        "auto_publish_at": auto_publish_at or "",
        "published_at": published_at or "",
        "meta_shared": 1 if data.get("meta_shared", existing.get("meta_shared", False)) else 0,
        "created_at": existing.get("created_at") or data.get("created_at") or now_iso,
        "updated_at": now_iso,
    }

    _save_blog_record_sqlite(record)
    _sync_to_supabase_cloud("blog_posts", "UPSERT", record, match_col="id", match_val=post_id)
    return get_blog_post(post_id)


def update_blog_post(slug_or_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    existing = get_blog_post(slug_or_id)
    if not existing:
        return None
    post_id = existing["id"]
    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.isoformat()
    allowed = {
        "slug",
        "title",
        "meta_title",
        "meta_description",
        "category",
        "excerpt",
        "target_towns_json",
        "sections_json",
        "faqs_json",
        "hero_image_url",
        "hero_image_alt",
        "veo_video_url",
        "veo_video_poster_url",
        "reading_time_min",
        "cta_service",
        "author_name",
        "status",
        "auto_publish_at",
        "published_at",
        "meta_shared",
    }
    clean: Dict[str, Any] = {"updated_at": now_iso}
    if "target_towns" in updates and updates["target_towns"] is not None:
        clean["target_towns_json"] = json.dumps(updates["target_towns"])
    if "sections" in updates and updates["sections"] is not None:
        clean["sections_json"] = json.dumps(updates["sections"])
    if "faqs" in updates and updates["faqs"] is not None:
        clean["faqs_json"] = json.dumps(updates["faqs"])
    for k, v in updates.items():
        if k in allowed and v is not None:
            if k == "meta_shared":
                clean[k] = 1 if v else 0
            elif k == "reading_time_min":
                clean[k] = int(v)
            else:
                clean[k] = v
    if clean.get("status") == "published":
        if not clean.get("published_at") and not existing.get("published_at"):
            clean["published_at"] = now_iso
        if "auto_publish_at" not in clean:
            clean["auto_publish_at"] = ""
    if clean.get("status") == "draft_auto_24h" and not clean.get("auto_publish_at") and not existing.get("auto_publish_at"):
        clean["auto_publish_at"] = (now_dt + timedelta(hours=24)).isoformat()

    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    vals = list(clean.values()) + [post_id]
    conn = _get_conn()
    conn.execute(f"UPDATE blog_posts SET {set_clause} WHERE id = ?", vals)
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("blog_posts", "PATCH", clean, match_col="id", match_val=post_id)
    return get_blog_post(post_id)


def delete_blog_post(slug_or_id: str) -> bool:
    existing = get_blog_post(slug_or_id)
    if not existing:
        return False
    post_id = existing["id"]
    conn = _get_conn()
    cur = conn.execute("DELETE FROM blog_posts WHERE id = ?", (post_id,))
    conn.commit()
    deleted = cur.rowcount > 0
    conn.close()
    if deleted:
        _sync_to_supabase_cloud("blog_posts", "DELETE", match_col="id", match_val=post_id)
    return deleted


# ==============================================================================
# 10. FIRST-PARTY WEBSITE ANALYTICS EVENTS & AGGREGATION
# ==============================================================================

_ANALYTICS_BOT_RE = re.compile(
    r"(bot|crawl|spider|slurp|lighthouse|headlesschrome|pingdom|uptimerobot|pagespeed|curl/|wget/)",
    re.IGNORECASE,
)


def is_ignored_analytics_hit(page_path: str, user_agent: str = "") -> bool:
    """Returns True for crawlers/monitors or internal control-plane paths (/admin, /portal, /api)."""
    p = (page_path or "/").strip().lower()
    if p.startswith("/admin") or p.startswith("/portal") or p.startswith("/api/") or p.startswith("/.netlify"):
        return True
    if user_agent and _ANALYTICS_BOT_RE.search(user_agent):
        return True
    return False


def classify_analytics_source(
    referrer_host: str = "",
    utm_source: str = "",
    utm_medium: str = "",
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, str]:
    """Derives clean referrer host and attribution channel without external credentials."""
    host = (referrer_host or "").strip().lower()
    if host.startswith("www."):
        host = host[4:]
    if not host or "oceancountyroofingpros.com" in host or host in ("localhost", "127.0.0.1"):
        host = "direct"

    usrc = (utm_source or "").strip().lower()
    umed = (utm_medium or "").strip().lower()
    meta_dict = meta if isinstance(meta, dict) else {}

    if usrc or meta_dict.get("gclid") or meta_dict.get("fbclid") or umed in ("cpc", "ppc", "paid", "paid_social", "email"):
        channel = "Campaign"
    elif any(k in host for k in ("google.", "bing.com", "duckduckgo.com", "search.yahoo.com", "yahoo.com")):
        channel = "Organic Search"
    elif any(k in host for k in ("facebook.com", "instagram.com", "nextdoor.com", "yelp.com", "linkedin.com", "t.co", "x.com", "youtube.com")):
        channel = "Social"
    elif host == "direct":
        channel = "Direct"
    else:
        channel = "Referral"

    return {"referrer_host": host, "source_channel": channel}


def _normalize_device_type(raw_device: str = "", viewport_width: int = 0, user_agent: str = "") -> str:
    val = (raw_device or "").strip().lower()
    if val in ("mobile", "tablet", "desktop"):
        return val
    if viewport_width and viewport_width > 0:
        if viewport_width < 768:
            return "mobile"
        if viewport_width < 1024:
            return "tablet"
        return "desktop"
    ua = (user_agent or "").lower()
    if any(k in ua for k in ("ipad", "tablet")):
        return "tablet"
    if any(k in ua for k in ("iphone", "android", "mobile")):
        return "mobile"
    return "desktop"


def record_analytics_event(data: Dict[str, Any], user_agent: str = "") -> Dict[str, Any]:
    """Persists an anonymous first-party pageview or funnel event locally and syncs to Supabase."""
    page_path = (str(data.get("page_path") or "/").split("?")[0] or "/")[:240]
    if is_ignored_analytics_hit(page_path, user_agent):
        return {"ok": True, "ignored": True}

    now_iso = datetime.now(timezone.utc).isoformat()
    vw = 0
    try:
        vw = int(data.get("viewport_width") or 0)
    except Exception:
        vw = 0

    meta_obj = data.get("meta") if isinstance(data.get("meta"), dict) else {}
    raw_ref = str(data.get("referrer_host") or data.get("referrer") or "")
    if "://" in raw_ref:
        try:
            raw_ref = raw_ref.split("://", 1)[1].split("/", 1)[0].split(":", 1)[0]
        except Exception:
            raw_ref = ""

    utm_source = str(data.get("utm_source") or "")[:80]
    utm_medium = str(data.get("utm_medium") or "")[:80]
    utm_campaign = str(data.get("utm_campaign") or "")[:120]
    attributed = classify_analytics_source(raw_ref, utm_source, utm_medium, meta_obj)

    import secrets
    event_id = str(data.get("id") or f"EVT-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{secrets.token_hex(3)}")
    record = {
        "id": event_id,
        "created_at": str(data.get("created_at") or now_iso),
        "event_name": str(data.get("event_name") or "page_view")[:64],
        "session_id": str(data.get("session_id") or "")[:80],
        "visitor_id": str(data.get("visitor_id") or "")[:80],
        "page_path": page_path,
        "page_title": str(data.get("page_title") or "")[:160],
        "page_type": str(data.get("page_type") or "landing")[:32],
        "town_slug": str(data.get("town_slug") or "")[:80],
        "town_name": str(data.get("town_name") or "")[:80],
        "device_type": _normalize_device_type(str(data.get("device_type") or ""), vw, user_agent),
        "referrer_host": attributed["referrer_host"],
        "source_channel": attributed["source_channel"],
        "utm_source": utm_source,
        "utm_medium": utm_medium,
        "utm_campaign": utm_campaign,
        "viewport_width": vw,
        "meta_json": json.dumps(meta_obj),
    }

    conn = _get_conn()
    conn.execute(
        """
        INSERT OR REPLACE INTO site_analytics_events (
            id, created_at, event_name, session_id, visitor_id, page_path, page_title,
            page_type, town_slug, town_name, device_type, referrer_host, source_channel,
            utm_source, utm_medium, utm_campaign, viewport_width, meta_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            record["id"],
            record["created_at"],
            record["event_name"],
            record["session_id"],
            record["visitor_id"],
            record["page_path"],
            record["page_title"],
            record["page_type"],
            record["town_slug"],
            record["town_name"],
            record["device_type"],
            record["referrer_host"],
            record["source_channel"],
            record["utm_source"],
            record["utm_medium"],
            record["utm_campaign"],
            record["viewport_width"],
            record["meta_json"],
        ),
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("site_analytics_events", "UPSERT", record, match_col="id", match_val=event_id)
    return {"ok": True, "event": record}


def _parse_iso_dt(raw: str) -> Optional[datetime]:
    if not raw:
        return None
    try:
        s = str(raw).strip().replace("Z", "+00:00")
        dt = datetime.fromisoformat(s)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except Exception:
        try:
            dt = datetime.strptime(str(raw)[:19], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            return dt
        except Exception:
            return None


def summarize_analytics_events(
    events: List[Dict[str, Any]],
    range_key: str = "30d",
    now_utc: Optional[datetime] = None,
) -> Dict[str, Any]:
    """Aggregates raw site_analytics_events rows into KPIs, daily charts (America/New_York), funnel, sources, and top pages."""
    from zoneinfo import ZoneInfo

    et_tz = ZoneInfo("America/New_York")
    range_days_map = {"24h": 1, "today": 1, "7d": 7, "30d": 30, "90d": 90}
    days = range_days_map.get((range_key or "30d").lower(), 30)
    ref_utc = now_utc or datetime.now(timezone.utc)
    cutoff = ref_utc - timedelta(days=days)

    filtered: List[Dict[str, Any]] = []
    for ev in events or []:
        dt = _parse_iso_dt(ev.get("created_at", ""))
        if dt and dt >= cutoff:
            filtered.append({**ev, "_dt": dt})

    visitors_set = set()
    sessions_set = set()
    visitor_device_map: Dict[str, str] = {}
    visitor_source_map: Dict[str, str] = {}

    quiz_start_visitors = set()
    lead_visitors = set()
    booking_visitors = set()

    pageviews = 0
    call_clicks = 0
    sms_clicks = 0
    estimator_clicks = 0
    email_inquiries = 0
    leads_submitted = 0
    bookings_confirmed = 0
    blog_reads = 0

    today_et_date = ref_utc.astimezone(et_tz).date()
    day_buckets: Dict[str, Dict[str, Any]] = {}
    for offset in range(days - 1, -1, -1):
        d_obj = today_et_date - timedelta(days=offset)
        d = d_obj.strftime("%Y-%m-%d")
        day_buckets[d] = {
            "date": d,
            "label": d_obj.strftime("%b %d"),
            "_visitors": set(),
            "visitors": 0,
            "pageviews": 0,
            "conversions": 0,
            "intent_clicks": 0,
        }

    page_stats: Dict[str, Dict[str, Any]] = {}
    town_stats: Dict[str, Dict[str, Any]] = {}
    source_stats: Dict[str, int] = {}

    for ev in filtered:
        ename = ev.get("event_name") or "page_view"
        vid = ev.get("visitor_id") or ev.get("session_id") or ev.get("id")
        sid = ev.get("session_id") or vid
        path = (ev.get("page_path") or "/").strip() or "/"
        town = (ev.get("town_name") or "").strip() or "General / Countywide"
        device = (ev.get("device_type") or "desktop").lower()
        source = (ev.get("source_channel") or "Direct").strip() or "Direct"
        day_key = ev["_dt"].astimezone(et_tz).strftime("%Y-%m-%d")

        visitors_set.add(vid)
        sessions_set.add(sid)
        visitor_device_map.setdefault(vid, device)
        visitor_source_map.setdefault(vid, source)

        if day_key in day_buckets:
            day_buckets[day_key]["_visitors"].add(vid)

        p_entry = page_stats.setdefault(path, {"page_path": path, "pageviews": 0, "_visitors": set(), "conversions": 0, "town_name": town})
        t_entry = town_stats.setdefault(town, {"town_name": town, "pageviews": 0, "_visitors": set(), "conversions": 0})

        if ename == "page_view":
            pageviews += 1
            p_entry["pageviews"] += 1
            p_entry["_visitors"].add(vid)
            t_entry["pageviews"] += 1
            t_entry["_visitors"].add(vid)
            if day_key in day_buckets:
                day_buckets[day_key]["pageviews"] += 1
            source_stats[source] = source_stats.get(source, 0) + 1
        elif ename in ("quiz_step_complete", "estimator_quote_click"):
            quiz_start_visitors.add(vid)
            if ename == "estimator_quote_click":
                estimator_clicks += 1
                if day_key in day_buckets:
                    day_buckets[day_key]["intent_clicks"] += 1
        elif ename == "phone_call_click":
            call_clicks += 1
            p_entry["conversions"] += 1
            t_entry["conversions"] += 1
            if day_key in day_buckets:
                day_buckets[day_key]["intent_clicks"] += 1
                day_buckets[day_key]["conversions"] += 1
        elif ename == "sms_click":
            sms_clicks += 1
            p_entry["conversions"] += 1
            t_entry["conversions"] += 1
            if day_key in day_buckets:
                day_buckets[day_key]["intent_clicks"] += 1
                day_buckets[day_key]["conversions"] += 1
        elif ename == "email_inquiry_sent":
            email_inquiries += 1
            leads_submitted += 1
            lead_visitors.add(vid)
            p_entry["conversions"] += 1
            t_entry["conversions"] += 1
            if day_key in day_buckets:
                day_buckets[day_key]["conversions"] += 1
        elif ename == "generate_lead":
            leads_submitted += 1
            lead_visitors.add(vid)
            p_entry["conversions"] += 1
            t_entry["conversions"] += 1
            if day_key in day_buckets:
                day_buckets[day_key]["conversions"] += 1
        elif ename == "booking_confirmed":
            bookings_confirmed += 1
            booking_visitors.add(vid)
            p_entry["conversions"] += 1
            t_entry["conversions"] += 1
        elif ename == "blog_read_complete":
            blog_reads += 1

    unique_visitors = len(visitors_set)
    device_counts = {"mobile": 0, "desktop": 0, "tablet": 0}
    for dev in visitor_device_map.values():
        key = dev if dev in device_counts else "desktop"
        device_counts[key] += 1

    mobile_pct = round((device_counts["mobile"] / unique_visitors) * 100, 1) if unique_visitors else 0.0
    total_conversions = leads_submitted + call_clicks + sms_clicks
    conv_rate = round((leads_submitted / unique_visitors) * 100, 1) if unique_visitors else 0.0

    daily_series = []
    for item in day_buckets.values():
        daily_series.append(
            {
                "date": item["date"],
                "label": item["label"],
                "visitors": len(item["_visitors"]),
                "pageviews": item["pageviews"],
                "conversions": item["conversions"],
                "intent_clicks": item["intent_clicks"],
            }
        )

    top_pages = sorted(
        [
            {
                "page_path": p["page_path"],
                "pageviews": p["pageviews"],
                "visitors": len(p["_visitors"]),
                "conversions": p["conversions"],
                "town_name": p["town_name"],
            }
            for p in page_stats.values()
        ],
        key=lambda x: (x["pageviews"], x["visitors"]),
        reverse=True,
    )[:12]

    top_towns = sorted(
        [
            {
                "town_name": t["town_name"],
                "pageviews": t["pageviews"],
                "visitors": len(t["_visitors"]),
                "conversions": t["conversions"],
            }
            for t in town_stats.values()
        ],
        key=lambda x: (x["pageviews"], x["visitors"]),
        reverse=True,
    )[:10]

    sources = sorted(
        [{"source": k, "count": v} for k, v in (source_stats or {"Direct": 0}).items()],
        key=lambda x: x["count"],
        reverse=True,
    )

    recent_sorted = sorted(filtered, key=lambda x: x["_dt"], reverse=True)[:25]
    recent_events = [
        {
            "created_at": r.get("created_at"),
            "event_name": r.get("event_name"),
            "page_path": r.get("page_path"),
            "town_name": r.get("town_name") or "",
            "device_type": r.get("device_type") or "desktop",
            "source_channel": r.get("source_channel") or "Direct",
            "referrer_host": r.get("referrer_host") or "direct",
        }
        for r in recent_sorted
    ]

    return {
        "status": "success",
        "range": (range_key or "30d").lower(),
        "days": days,
        "kpis": {
            "unique_visitors": unique_visitors,
            "sessions": len(sessions_set),
            "pageviews": pageviews,
            "leads_submitted": leads_submitted,
            "bookings_confirmed": bookings_confirmed,
            "call_clicks": call_clicks,
            "sms_clicks": sms_clicks,
            "estimator_clicks": estimator_clicks,
            "email_inquiries": email_inquiries,
            "intent_actions_total": total_conversions,
            "conversion_rate_pct": conv_rate,
            "mobile_pct": mobile_pct,
            "blog_reads": blog_reads,
        },
        "funnel": [
            {"stage": "Site Visitors", "count": unique_visitors},
            {"stage": "Quiz / Cost Guide Started", "count": len(quiz_start_visitors)},
            {"stage": "Lead Submitted", "count": len(lead_visitors)},
            {"stage": "Inspection Booked", "count": len(booking_visitors)},
        ],
        "devices": device_counts,
        "sources": sources,
        "top_pages": top_pages,
        "top_towns": top_towns,
        "daily_series": daily_series,
        "recent_events": recent_events,
    }


def get_analytics_summary(range_key: str = "30d") -> Dict[str, Any]:
    """Reads site_analytics_events from SQLite mirror and computes dashboard summary."""
    init_db()
    conn = _get_conn()
    rows = conn.execute("SELECT * FROM site_analytics_events ORDER BY created_at DESC LIMIT 10000").fetchall()
    conn.close()
    events = [dict(r) for r in rows]
    return summarize_analytics_events(events, range_key=range_key)


# ==============================================================================
# 11. SOCIAL INTERACTIONS & SOCIAL POST QUEUE (VAPI MAYA + AGENT 6)
# ==============================================================================

def record_social_interaction(data: Dict[str, Any]) -> Dict[str, Any]:
    """Persists a Facebook/Instagram/GBP comment, DM, or social review to SQLite & Supabase."""
    init_db()
    import secrets
    now_iso = datetime.now(timezone.utc).isoformat()
    row_id = str(data.get("id") or f"SOC-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{secrets.token_hex(2)}")
    record = {
        "id": row_id,
        "created_at": str(data.get("created_at") or now_iso),
        "updated_at": str(data.get("updated_at") or now_iso),
        "platform": str(data.get("platform") or "facebook"),
        "interaction_type": str(data.get("interaction_type") or "comment"),
        "external_id": str(data.get("external_id") or ""),
        "post_id": str(data.get("post_id") or ""),
        "author_name": str(data.get("author_name") or "Neighbor"),
        "author_id": str(data.get("author_id") or ""),
        "rating": int(data.get("rating") or 0),
        "message_text": str(data.get("message_text") or ""),
        "intent": str(data.get("intent") or "GENERAL"),
        "ai_reply_draft": str(data.get("ai_reply_draft") or ""),
        "reply_status": str(data.get("reply_status") or "pending_approval"),
        "auto_publish_at": str(data.get("auto_publish_at") or ""),
        "published_reply_id": str(data.get("published_reply_id") or ""),
        "lead_id": str(data.get("lead_id") or ""),
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT OR REPLACE INTO social_interactions (
            id, created_at, updated_at, platform, interaction_type, external_id, post_id,
            author_name, author_id, rating, message_text, intent, ai_reply_draft,
            reply_status, auto_publish_at, published_reply_id, lead_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        tuple(record.values()),
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("social_interactions", "UPSERT", record, match_col="id", match_val=row_id)
    return record


def list_social_interactions(
    reply_status: Optional[str] = None,
    platform: Optional[str] = None,
    limit: int = 100,
) -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    clauses = []
    params: List[Any] = []
    if reply_status:
        clauses.append("reply_status = ?")
        params.append(reply_status)
    if platform:
        clauses.append("platform = ?")
        params.append(platform)
    where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(int(limit))
    rows = conn.execute(
        f"SELECT * FROM social_interactions {where_sql} ORDER BY created_at DESC LIMIT ?",
        params,
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_social_interaction(interaction_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    init_db()
    allowed = {
        "intent", "ai_reply_draft", "reply_status", "auto_publish_at",
        "published_reply_id", "lead_id", "rating",
    }
    clean = {k: v for k, v in (updates or {}).items() if k in allowed and v is not None}
    clean["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    conn = _get_conn()
    conn.execute(f"UPDATE social_interactions SET {set_clause} WHERE id = ?", list(clean.values()) + [interaction_id])
    conn.commit()
    row = conn.execute("SELECT * FROM social_interactions WHERE id = ?", (interaction_id,)).fetchone()
    conn.close()
    if not row:
        return None
    _sync_to_supabase_cloud("social_interactions", "PATCH", clean, match_col="id", match_val=interaction_id)
    return dict(row)


def enqueue_social_post(data: Dict[str, Any]) -> Dict[str, Any]:
    """Adds a scheduled or voice-dictated social media post to social_queue."""
    init_db()
    import secrets
    now_iso = datetime.now(timezone.utc).isoformat()
    post_id = str(data.get("id") or f"SQ-{int(datetime.now(timezone.utc).timestamp() * 1000)}-{secrets.token_hex(2)}")
    record = {
        "id": post_id,
        "created_at": str(data.get("created_at") or now_iso),
        "updated_at": str(data.get("updated_at") or now_iso),
        "caption": str(data.get("caption") or "").strip(),
        "image_url": str(data.get("image_url") or "").strip(),
        "link_url": str(data.get("link_url") or "https://oceancountyroofingpros.com").strip(),
        "platforms": str(data.get("platforms") or "facebook,instagram"),
        "utm_campaign": str(data.get("utm_campaign") or "social_agent"),
        "town_name": str(data.get("town_name") or "Ocean County"),
        "status": str(data.get("status") or "scheduled"),
        "scheduled_for": str(data.get("scheduled_for") or now_iso),
        "published_at": str(data.get("published_at") or ""),
        "external_post_ids_json": str(data.get("external_post_ids_json") or "{}"),
        "created_by": str(data.get("created_by") or "vapi_voice"),
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT OR REPLACE INTO social_queue (
            id, created_at, updated_at, caption, image_url, link_url, platforms,
            utm_campaign, town_name, status, scheduled_for, published_at,
            external_post_ids_json, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        tuple(record.values()),
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("social_queue", "UPSERT", record, match_col="id", match_val=post_id)
    return record


def list_social_queue(status: Optional[str] = None, limit: int = 100) -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    if status:
        rows = conn.execute(
            "SELECT * FROM social_queue WHERE status = ? ORDER BY scheduled_for DESC LIMIT ?",
            (status, int(limit)),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM social_queue ORDER BY created_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_social_queue_item(post_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    init_db()
    allowed = {
        "caption", "image_url", "link_url", "platforms", "utm_campaign",
        "town_name", "status", "scheduled_for", "published_at", "external_post_ids_json",
    }
    clean = {k: v for k, v in (updates or {}).items() if k in allowed and v is not None}
    clean["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    conn = _get_conn()
    conn.execute(f"UPDATE social_queue SET {set_clause} WHERE id = ?", list(clean.values()) + [post_id])
    conn.commit()
    row = conn.execute("SELECT * FROM social_queue WHERE id = ?", (post_id,)).fetchone()
    conn.close()
    if not row:
        return None
    _sync_to_supabase_cloud("social_queue", "PATCH", clean, match_col="id", match_val=post_id)
    return dict(row)


# ==============================================================================
# 12. CLOSED-LOOP SEO RANKING SNAPSHOTS & EXPERIMENTS (AGENT 7)
# ==============================================================================

def save_seo_snapshots(rows: List[Dict[str, Any]]) -> int:
    """Stores GSC ranking snapshot rows locally and syncs to Supabase."""
    init_db()
    if not rows:
        return 0
    now_iso = datetime.now(timezone.utc).isoformat()
    conn = _get_conn()
    saved = 0
    for r in rows:
        snap_date = str(r.get("snapshot_date") or now_iso[:10])
        page_url = str(r.get("page_url") or "https://oceancountyroofingpros.com/")
        page_path = str(r.get("page_path") or "/").strip() or "/"
        query = str(r.get("query") or "").strip()
        if not query:
            continue
        import hashlib
        row_id = str(
            r.get("id")
            or f"GSC-{hashlib.sha1(f'{snap_date}|{page_path}|{query}'.encode()).hexdigest()[:12]}"
        )
        rec = {
            "id": row_id,
            "created_at": str(r.get("created_at") or now_iso),
            "snapshot_date": snap_date,
            "page_url": page_url,
            "page_path": page_path,
            "query": query,
            "clicks": int(r.get("clicks") or 0),
            "impressions": int(r.get("impressions") or 0),
            "ctr": float(r.get("ctr") or 0.0),
            "position": float(r.get("position") or 0.0),
        }
        conn.execute(
            """
            INSERT OR REPLACE INTO seo_ranking_snapshots (
                id, created_at, snapshot_date, page_url, page_path, query,
                clicks, impressions, ctr, position
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            tuple(rec.values()),
        )
        _sync_to_supabase_cloud("seo_ranking_snapshots", "UPSERT", rec, match_col="id", match_val=row_id)
        saved += 1
    conn.commit()
    conn.close()
    return saved


def list_seo_snapshots(limit: int = 100) -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    rows = conn.execute(
        "SELECT * FROM seo_ranking_snapshots ORDER BY snapshot_date DESC, impressions DESC LIMIT ?",
        (int(limit),),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def upsert_seo_experiment(data: Dict[str, Any]) -> Dict[str, Any]:
    init_db()
    import secrets
    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.isoformat()
    exp_id = str(data.get("id") or f"SEOEXP-{int(now_dt.timestamp() * 1000)}-{secrets.token_hex(2)}")
    status = str(data.get("status") or "pending_24h")
    auto_apply_at = str(
        data.get("auto_apply_at")
        if data.get("auto_apply_at") is not None
        else ((now_dt + timedelta(hours=24)).isoformat() if status == "pending_24h" else "")
    )
    rec = {
        "id": exp_id,
        "created_at": str(data.get("created_at") or now_iso),
        "updated_at": str(data.get("updated_at") or now_iso),
        "page_path": str(data.get("page_path") or "/"),
        "target_query": str(data.get("target_query") or ""),
        "original_meta_title": str(data.get("original_meta_title") or ""),
        "original_meta_description": str(data.get("original_meta_description") or ""),
        "proposed_meta_title": str(data.get("proposed_meta_title") or ""),
        "proposed_meta_description": str(data.get("proposed_meta_description") or ""),
        "baseline_position": float(data.get("baseline_position") or 0.0),
        "baseline_ctr": float(data.get("baseline_ctr") or 0.0),
        "baseline_impressions": int(data.get("baseline_impressions") or 0),
        "latest_position": float(data.get("latest_position") or data.get("baseline_position") or 0.0),
        "latest_ctr": float(data.get("latest_ctr") or data.get("baseline_ctr") or 0.0),
        "status": status,
        "auto_apply_at": auto_apply_at,
        "activated_at": str(data.get("activated_at") or (now_iso if status == "active" else "")),
        "evaluated_at": str(data.get("evaluated_at") or ""),
        "reason": str(data.get("reason") or ""),
    }
    conn = _get_conn()
    conn.execute(
        """
        INSERT OR REPLACE INTO seo_experiments (
            id, created_at, updated_at, page_path, target_query,
            original_meta_title, original_meta_description,
            proposed_meta_title, proposed_meta_description,
            baseline_position, baseline_ctr, baseline_impressions,
            latest_position, latest_ctr, status, auto_apply_at,
            activated_at, evaluated_at, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        tuple(rec.values()),
    )
    conn.commit()
    conn.close()
    _sync_to_supabase_cloud("seo_experiments", "UPSERT", rec, match_col="id", match_val=exp_id)
    return rec


def list_seo_experiments(status: Optional[str] = None, limit: int = 50) -> List[Dict[str, Any]]:
    init_db()
    conn = _get_conn()
    if status:
        rows = conn.execute(
            "SELECT * FROM seo_experiments WHERE status = ? ORDER BY created_at DESC LIMIT ?",
            (status, int(limit)),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM seo_experiments ORDER BY created_at DESC LIMIT ?",
            (int(limit),),
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def update_seo_experiment(exp_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    init_db()
    allowed = {
        "proposed_meta_title", "proposed_meta_description", "latest_position",
        "latest_ctr", "status", "auto_apply_at", "activated_at", "evaluated_at", "reason",
    }
    clean = {k: v for k, v in (updates or {}).items() if k in allowed and v is not None}
    clean["updated_at"] = datetime.now(timezone.utc).isoformat()
    set_clause = ", ".join(f"{k} = ?" for k in clean.keys())
    conn = _get_conn()
    conn.execute(f"UPDATE seo_experiments SET {set_clause} WHERE id = ?", list(clean.values()) + [exp_id])
    conn.commit()
    row = conn.execute("SELECT * FROM seo_experiments WHERE id = ?", (exp_id,)).fetchone()
    conn.close()
    if not row:
        return None
    _sync_to_supabase_cloud("seo_experiments", "PATCH", clean, match_col="id", match_val=exp_id)
    return dict(row)


def get_active_seo_overrides() -> Dict[str, Dict[str, str]]:
    """Returns active/kept title & meta description overrides keyed by page_path (e.g. '/roofing-toms-river-nj')."""
    init_db()
    conn = _get_conn()
    rows = conn.execute(
        "SELECT page_path, proposed_meta_title, proposed_meta_description FROM seo_experiments WHERE status IN ('active', 'kept') ORDER BY updated_at DESC"
    ).fetchall()
    conn.close()
    overrides: Dict[str, Dict[str, str]] = {}
    for r in rows:
        p = str(r["page_path"] or "/").strip()
        if p not in overrides:
            overrides[p] = {
                "meta_title": r["proposed_meta_title"] or "",
                "meta_description": r["proposed_meta_description"] or "",
            }
    return overrides
