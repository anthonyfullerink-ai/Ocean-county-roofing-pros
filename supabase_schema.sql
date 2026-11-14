-- =============================================================================
-- OCEAN COUNTY ROOFING PROS — SUPABASE MASTER POSTGRESQL SCHEMA
-- Asset: oceancountyroofingpros.com
-- Usage: Paste directly into Supabase SQL Editor to provision all tables & indexes
-- =============================================================================

-- 1. TENANTS (Roofing Contractor Partners)
CREATE TABLE IF NOT EXISTS public.tenants (
    tenant_id TEXT PRIMARY KEY,
    company_name TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    estimator_name TEXT DEFAULT 'Hannah',
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
    monthly_retainer NUMERIC(12, 2) DEFAULT 1500.00,
    is_active BOOLEAN DEFAULT FALSE,
    notes TEXT DEFAULT '',
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. LEADS (Master CRM & Voice AI Dispatch Pipeline)
CREATE TABLE IF NOT EXISTS public.leads (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
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
    status TEXT DEFAULT 'New Lead', -- New Lead | Booked | Inspected | Job Won | Completed | Lost
    estimated_value NUMERIC(12, 2) DEFAULT 12500.00,
    call_recording_url TEXT DEFAULT '',
    call_transcript TEXT DEFAULT '',
    call_duration_sec INTEGER DEFAULT 0,
    review_request_sent BOOLEAN DEFAULT FALSE,
    review_request_sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON public.leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_tenant ON public.leads(assigned_tenant_id);
CREATE INDEX IF NOT EXISTS idx_leads_phone ON public.leads(phone);

-- 3. JOB PROJECTS (Geo-Tagged Job-Site Photos & Town Silo Proof)
CREATE TABLE IF NOT EXISTS public.job_projects (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    town_slug TEXT NOT NULL,
    town_name TEXT NOT NULL,
    neighborhood TEXT DEFAULT '',
    service_type TEXT DEFAULT 'Full Roof Replacement',
    shingle_system TEXT DEFAULT 'CertainTeed Landmark PRO',
    caption TEXT DEFAULT '',
    ai_seo_summary TEXT DEFAULT '',
    image_webp_url TEXT DEFAULT '',
    image_geotagged_jpg_url TEXT DEFAULT '',
    lat DOUBLE PRECISION DEFAULT 39.9537,
    lon DOUBLE PRECISION DEFAULT -74.1979,
    uploaded_by TEXT DEFAULT 'owner', -- owner | contractor
    tenant_id TEXT DEFAULT 'client_joe_the_roofer',
    approval_status TEXT DEFAULT 'approved', -- approved | pending_auto_24h | rejected
    auto_publish_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_projects_town_slug ON public.job_projects(town_slug);
CREATE INDEX IF NOT EXISTS idx_projects_approval ON public.job_projects(approval_status);

-- 4. REVIEWS (Verified Customer Reviews & Direct Management Resolutions)
CREATE TABLE IF NOT EXISTS public.reviews (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    lead_id TEXT DEFAULT '',
    reviewer_name TEXT NOT NULL,
    town_name TEXT DEFAULT 'Toms River',
    town_slug TEXT DEFAULT 'roofing-toms-river-nj',
    service_performed TEXT DEFAULT 'Full Roof Replacement',
    rating INTEGER DEFAULT 5,
    review_text TEXT NOT NULL,
    source TEXT DEFAULT 'Google', -- Google | Website | Direct Resolution
    ai_reply_draft TEXT DEFAULT '',
    reply_status TEXT DEFAULT 'pending', -- pending | approved | published
    is_public BOOLEAN DEFAULT TRUE,
    resolution_status TEXT DEFAULT 'resolved' -- open | resolved
);

CREATE INDEX IF NOT EXISTS idx_reviews_town_slug ON public.reviews(town_slug);
CREATE INDEX IF NOT EXISTS idx_reviews_public ON public.reviews(is_public);

-- 5. GBP POSTS (Google Business Profile Updates, Offers & Storm Alerts)
CREATE TABLE IF NOT EXISTS public.gbp_posts (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    scheduled_for TEXT DEFAULT '',
    post_type TEXT DEFAULT 'Project Highlight', -- Project Highlight | Storm Alert | Seasonal Tip | Offer
    town_name TEXT DEFAULT 'Toms River',
    town_slug TEXT DEFAULT 'roofing-toms-river-nj',
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    image_url TEXT DEFAULT '',
    cta_type TEXT DEFAULT 'LEARN_MORE',
    cta_url TEXT DEFAULT 'https://oceancountyroofingpros.com',
    status TEXT DEFAULT 'draft_auto_24h', -- draft_auto_24h | approved | published | rejected
    auto_publish_at TIMESTAMPTZ,
    webhook_dispatched BOOLEAN DEFAULT FALSE
);

-- 6. AGENT RUNS (5-Agent Workforce Execution Audit Log)
CREATE TABLE IF NOT EXISTS public.agent_runs (
    id TEXT PRIMARY KEY,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    agent_name TEXT NOT NULL,
    status TEXT DEFAULT 'success',
    summary TEXT DEFAULT '',
    metrics_json TEXT DEFAULT '{}',
    duration_ms INTEGER DEFAULT 0
);

-- 7. DAILY REPORTS (7:30 AM Executive Briefings & Contractor ROI Reports)
CREATE TABLE IF NOT EXISTS public.daily_reports (
    id TEXT PRIMARY KEY,
    report_date TEXT NOT NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    headline TEXT DEFAULT '',
    markdown_content TEXT NOT NULL,
    metrics_json TEXT DEFAULT '{}',
    file_path TEXT DEFAULT ''
);

-- 8. SYSTEM SETTINGS (Global Automation Kill-Switches & Config)
CREATE TABLE IF NOT EXISTS public.system_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Default System Settings Seed
INSERT INTO public.system_settings (key, value) VALUES
    ('auto_publish_24h', 'true'),
    ('enable_review_sms', 'true'),
    ('enable_weather_storm_banner', 'true'),
    ('enable_vapi_callback', 'true'),
    ('gbp_review_url', 'https://g.page/r/OceanCountyRoofingPros/review'),
    ('gbp_webhook_url', ''),
    ('admin_pin', '732999'),
    ('storm_alert_active', 'false'),
    ('storm_alert_headline', '🟢 Active in Ocean County Today — 21-Point Drone Roof Inspections Dispatched Daily')
ON CONFLICT (key) DO NOTHING;

-- Default Tenants Seed
INSERT INTO public.tenants (tenant_id, company_name, contact_name, estimator_name, dispatch_phone, email, portal_pin, calendar_id, monthly_retainer, is_active, notes)
VALUES
    ('client_joe_the_roofer', 'Joe The Roofer LLC', 'Joe', 'Hannah', '+17326609121', 'powurnj@gmail.com', '732100', '7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com', 1500.00, TRUE, 'Primary launch partner for Ocean County, NJ. Full 21-point drone inspections.'),
    ('client_apex_roofing', 'Apex Shore Roofing & Restoration LLC', 'Mike Sullivan', 'Tyler', '+17325550199', 'dispatch@apexshoreroofing.com', '732200', 'apex_shore_calendar@group.calendar.google.com', 2000.00, FALSE, 'Backup / prospective tenant covering northern Ocean and Monmouth counties.')
ON CONFLICT (tenant_id) DO NOTHING;

-- 9. BLOG POSTS (Automated Ocean County SEO Guides + Flow Nano Banana / Veo Media)
CREATE TABLE IF NOT EXISTS public.blog_posts (
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
    status TEXT DEFAULT 'draft_auto_24h', -- draft_auto_24h | published | archived
    auto_publish_at TIMESTAMPTZ,
    published_at TIMESTAMPTZ,
    meta_shared BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_blog_posts_status ON public.blog_posts(status);
CREATE INDEX IF NOT EXISTS idx_blog_posts_slug ON public.blog_posts(slug);
CREATE INDEX IF NOT EXISTS idx_blog_posts_published_at ON public.blog_posts(published_at DESC);
