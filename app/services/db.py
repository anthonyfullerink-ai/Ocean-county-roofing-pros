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
_CLOUD_NULLABLE_TIMESTAMPTZ_COLS = {"review_request_sent_at", "auto_publish_at", "published_at"}


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

    # 2. Seed tenants
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
            ),
        ]
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

    # 3. Seed realistic Ocean County leads
    cur.execute("SELECT COUNT(*) FROM leads")
    if cur.fetchone()[0] == 0:
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

    # 4. Seed verified job_projects across Ocean County towns
    cur.execute("SELECT COUNT(*) FROM job_projects")
    if cur.fetchone()[0] == 0:
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

    # 5. Seed verified customer reviews
    cur.execute("SELECT COUNT(*) FROM reviews")
    if cur.fetchone()[0] == 0:
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

    # 6. Seed GBP Posts
    cur.execute("SELECT COUNT(*) FROM gbp_posts")
    if cur.fetchone()[0] == 0:
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
