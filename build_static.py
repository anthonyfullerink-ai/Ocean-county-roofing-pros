import os
import shutil
import json
from pathlib import Path
from datetime import datetime
from jinja2 import Environment, FileSystemLoader

# Load configuration and helper utilities from app
from app.config import (
    settings,
    load_brand_config,
    load_services_data,
    load_towns_data,
    get_town_by_slug,
)
from app.services.db import (
    list_job_projects,
    list_reviews,
    get_setting,
    get_bool_setting,
    list_tenants,
    get_dashboard_kpis,
    list_blog_posts,
    sync_blog_posts_from_supabase,
    get_active_seo_overrides,
    is_supabase_configured,
)
from app.services.tenant_manager import TenantManager
from app.agents.gbp_seo_agent import build_dynamic_town_json_ld

PROJECT_ROOT = Path(__file__).resolve().parent
DIST_DIR = PROJECT_ROOT / "dist"
TEMPLATES_DIR = PROJECT_ROOT / "app" / "templates"
STATIC_DIR = PROJECT_ROOT / "app" / "static"


def fetch_live_seo_overrides():
    overrides = dict(get_active_seo_overrides())
    if is_supabase_configured():
        try:
            import httpx
            base = settings.SUPABASE_URL.rstrip("/")
            h = {"apikey": settings.SUPABASE_KEY, "Authorization": f"Bearer {settings.SUPABASE_KEY}"}
            r = httpx.get(
                f"{base}/rest/v1/seo_experiments?status=in.(active,kept)&order=updated_at.desc",
                headers=h,
                timeout=6.0,
            )
            if r.status_code == 200:
                for row in r.json():
                    p = str(row.get("page_path") or "/").strip()
                    if p not in overrides:
                        overrides[p] = {
                            "meta_title": row.get("proposed_meta_title") or "",
                            "meta_description": row.get("proposed_meta_description") or "",
                        }
        except Exception:
            pass
    return overrides


def build_town_page_context(town, brand, services, all_towns, seo_overrides=None, override_path=None):
    town = dict(town or {})
    town_slug = town.get("slug", "roofing-toms-river-nj")
    target_path = override_path or f"/{town_slug}"
    if seo_overrides and target_path in seo_overrides:
        ov = seo_overrides[target_path]
        if ov.get("meta_title"):
            town["meta_title"] = ov["meta_title"]
        if ov.get("meta_description"):
            town["meta_description"] = ov["meta_description"]
    approved_all = list_job_projects(approval_status="approved")
    town_projects = [p for p in approved_all if p.get("town_slug") == town_slug]
    other_projects = [p for p in approved_all if p.get("town_slug") != town_slug]
    display_projects = (town_projects + other_projects)[:6]

    public_reviews = list_reviews(public_only=True)
    town_reviews = [r for r in public_reviews if r.get("town_slug") == town_slug]
    other_reviews = [r for r in public_reviews if r.get("town_slug") != town_slug]
    display_reviews = (town_reviews + other_reviews)[:6]

    dynamic_json_ld = build_dynamic_town_json_ld(
        town=town,
        brand=brand,
        projects=display_projects,
        reviews=display_reviews,
    )

    storm_alert_active = get_bool_setting("storm_alert_active", False) and get_bool_setting(
        "enable_weather_storm_banner", True
    )
    storm_alert_headline = get_setting(
        "storm_alert_headline",
        "🟢 Active in Ocean County Today — 21-Point Roof & Attic Inspections Dispatched Daily (Drone Upon Request)",
    )
    raw_ticker = get_setting("dispatch_ticker_json", "[]")
    try:
        ticker_list = json.loads(raw_ticker)
    except Exception:
        ticker_list = []

    return {
        "brand": brand,
        "services": services,
        "town": town,
        "all_towns": all_towns,
        "current_town": town,
        "town_projects": display_projects,
        "exact_town_project_count": len(town_projects),
        "town_reviews": display_reviews,
        "dynamic_json_ld": dynamic_json_ld,
        "storm_alert_active": storm_alert_active,
        "storm_alert_headline": storm_alert_headline,
        "dispatch_ticker_messages": ticker_list,
    }


def main():
    print("Building static site for Ocean County Roofing Pros...")
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)
    DIST_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Copy static assets
    print("Copying static assets...")
    shutil.copytree(STATIC_DIR, DIST_DIR / "static")

    # 2. Setup Jinja2 Environment
    env = Environment(loader=FileSystemLoader(str(TEMPLATES_DIR)))

    brand = load_brand_config()
    services = load_services_data()
    all_towns = load_towns_data()
    seo_overrides = fetch_live_seo_overrides()

    # 3. Master Landing Page (index.html)
    print("Generating index.html...")
    index_template = env.get_template("index.html")
    primary_town = get_town_by_slug("roofing-toms-river-nj") or (all_towns[0] if all_towns else {})
    ctx_index = build_town_page_context(primary_town, brand, services, all_towns, seo_overrides=seo_overrides, override_path="/")
    (DIST_DIR / "index.html").write_text(index_template.render(ctx_index), encoding="utf-8")

    # 4. Town Location Silo Pages
    loc_template = env.get_template("location_page.html")
    for town in all_towns:
        slug = town.get("slug")
        if slug:
            print(f"Generating silo: /{slug}...")
            town_ctx = build_town_page_context(town, brand, services, all_towns, seo_overrides=seo_overrides)
            rendered = loc_template.render(town_ctx)
            
            # Write both /slug/index.html and /slug.html for zero-redirect edge routing
            town_dir = DIST_DIR / slug
            town_dir.mkdir(parents=True, exist_ok=True)
            (town_dir / "index.html").write_text(rendered, encoding="utf-8")
            (DIST_DIR / f"{slug}.html").write_text(rendered, encoding="utf-8")

    # 5. Policy Pages
    print("Generating privacy-policy and terms...")
    privacy_template = env.get_template("privacy-policy.html")
    (DIST_DIR / "privacy-policy").mkdir(parents=True, exist_ok=True)
    (DIST_DIR / "privacy-policy" / "index.html").write_text(
        privacy_template.render({"brand": brand, "business_name": brand.get("brand_name", settings.BUSINESS_NAME), "phone_number": brand.get("primary_phone", settings.PRIMARY_PHONE)}),
        encoding="utf-8"
    )

    terms_template = env.get_template("terms.html")
    (DIST_DIR / "terms").mkdir(parents=True, exist_ok=True)
    (DIST_DIR / "terms" / "index.html").write_text(
        terms_template.render({"brand": brand, "business_name": brand.get("brand_name", settings.BUSINESS_NAME), "phone_number": brand.get("primary_phone", settings.PRIMARY_PHONE)}),
        encoding="utf-8"
    )

    # 5B. SEO Blog Hub (/blog) & Article Pages (/blog/<slug>) from Supabase blog_posts
    print("Syncing and generating /blog SEO hub & articles...")
    sync_blog_posts_from_supabase()
    published_posts = list_blog_posts(status="published")
    blog_categories = []
    for p in published_posts:
        cat = p.get("category")
        if cat and cat not in blog_categories:
            blog_categories.append(cat)

    storm_alert_active = get_bool_setting("storm_alert_active", False) and get_bool_setting(
        "enable_weather_storm_banner", True
    )
    storm_alert_headline = get_setting(
        "storm_alert_headline",
        "🟢 Active in Ocean County Today — 21-Point Roof & Attic Inspections Dispatched Daily (Drone Upon Request)",
    )
    raw_ticker = get_setting("dispatch_ticker_json", "[]")
    try:
        ticker_list = json.loads(raw_ticker)
    except Exception:
        ticker_list = []

    blog_shared_ctx = {
        "brand": brand,
        "all_towns": all_towns,
        "is_blog_page": True,
        "storm_alert_active": storm_alert_active,
        "storm_alert_headline": storm_alert_headline,
        "dispatch_ticker_messages": ticker_list,
    }

    blog_index_template = env.get_template("blog_index.html")
    blog_index_html = blog_index_template.render({
        **blog_shared_ctx,
        "posts": published_posts,
        "categories": blog_categories,
    })
    (DIST_DIR / "blog").mkdir(parents=True, exist_ok=True)
    (DIST_DIR / "blog" / "index.html").write_text(blog_index_html, encoding="utf-8")
    (DIST_DIR / "blog.html").write_text(blog_index_html, encoding="utf-8")

    blog_post_template = env.get_template("blog_post.html")
    for post in published_posts:
        pslug = post.get("slug")
        if not pslug:
            continue
        print(f"Generating blog article: /blog/{pslug}...")
        related = [p for p in published_posts if p.get("slug") != pslug][:2]
        rendered_post = blog_post_template.render({
            **blog_shared_ctx,
            "post": post,
            "related_posts": related,
        })
        post_dir = DIST_DIR / "blog" / pslug
        post_dir.mkdir(parents=True, exist_ok=True)
        (post_dir / "index.html").write_text(rendered_post, encoding="utf-8")
        (DIST_DIR / "blog" / f"{pslug}.html").write_text(rendered_post, encoding="utf-8")

    # 6. Admin, Partner Portal, and Feedback Hub Shells
    print("Generating admin dashboard and partner portal shells...")
    from app.services.db import (
        get_all_settings,
        list_leads,
        list_gbp_posts,
        list_agent_runs,
        get_latest_daily_report,
    )

    sys_settings = get_all_settings()
    kpis = get_dashboard_kpis()
    all_leads = list_leads()
    all_projects = list_job_projects()
    all_reviews = list_reviews()
    all_tenants = list_tenants()
    all_gbp = list_gbp_posts()
    all_blog = list_blog_posts(sync_from_cloud=False)
    all_runs = list_agent_runs(limit=30)
    latest_rep = get_latest_daily_report()

    admin_template = env.get_template("admin_dashboard.html")
    (DIST_DIR / "admin").mkdir(parents=True, exist_ok=True)
    (DIST_DIR / "admin" / "index.html").write_text(
        admin_template.render({
            "brand": brand,
            "towns": all_towns,
            "kpis": kpis,
            "leads": all_leads,
            "tenants": all_tenants,
            "projects": all_projects,
            "reviews": all_reviews,
            "gbp_posts": all_gbp,
            "blog_posts": all_blog,
            "agent_runs": all_runs,
            "latest_report": latest_rep,
            "sys_settings": sys_settings,
            "is_admin_authenticated": False,
        }),
        encoding="utf-8"
    )

    active_tenant_rec = TenantManager.get_active_tenant().model_dump()
    portal_kpis = get_dashboard_kpis(tenant_id=active_tenant_rec["tenant_id"])

    portal_template = env.get_template("partner_portal.html")
    (DIST_DIR / "portal").mkdir(parents=True, exist_ok=True)
    (DIST_DIR / "portal" / "index.html").write_text(
        portal_template.render({
            "brand": brand,
            "towns": all_towns,
            "tenant": active_tenant_rec,
            "all_tenants": all_tenants,
            "is_authenticated": False,
            "kpis": portal_kpis,
            "leads": [l for l in all_leads if l.get("assigned_tenant_id") == active_tenant_rec["tenant_id"]],
            "projects": [p for p in all_projects if p.get("tenant_id") == active_tenant_rec["tenant_id"]],
        }),
        encoding="utf-8"
    )

    feedback_template = env.get_template("feedback_hub.html")
    (DIST_DIR / "feedback").mkdir(parents=True, exist_ok=True)
    (DIST_DIR / "feedback" / "index.html").write_text(
        feedback_template.render({
            "brand": brand,
            "lead": {},
            "gbp_review_url": settings.GBP_REVIEW_URL or "https://g.page/r/OceanCountyRoofingPros/review",
        }),
        encoding="utf-8"
    )

    # 7. Robots.txt and Sitemap.xml
    print("Generating sitemap.xml and robots.txt...")
    robots_content = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /admin\n"
        "Disallow: /portal\n\n"
        "Sitemap: https://oceancountyroofingpros.com/sitemap.xml\n"
    )
    (DIST_DIR / "robots.txt").write_text(robots_content, encoding="utf-8")

    today_iso = datetime.now().strftime("%Y-%m-%d")
    base_url = "https://oceancountyroofingpros.com"
    urls = [
        f"""  <url>\n    <loc>{base_url}/</loc>\n    <lastmod>{today_iso}</lastmod>\n    <changefreq>daily</changefreq>\n    <priority>1.0</priority>\n  </url>"""
    ]
    for town in all_towns:
        slug = town.get("slug")
        if slug:
            urls.append(
                f"""  <url>\n    <loc>{base_url}/{slug}</loc>\n    <lastmod>{today_iso}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>"""
            )
    urls.append(
        f"""  <url>\n    <loc>{base_url}/blog</loc>\n    <lastmod>{today_iso}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.85</priority>\n  </url>"""
    )
    for post in published_posts:
        pslug = post.get("slug")
        if pslug:
            lastmod = (post.get("updated_at") or post.get("published_at") or today_iso)[:10]
            urls.append(
                f"""  <url>\n    <loc>{base_url}/blog/{pslug}</loc>\n    <lastmod>{lastmod}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.8</priority>\n  </url>"""
            )
    urls.append(f"""  <url>\n    <loc>{base_url}/privacy-policy</loc>\n    <lastmod>{today_iso}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.3</priority>\n  </url>""")
    urls.append(f"""  <url>\n    <loc>{base_url}/terms</loc>\n    <lastmod>{today_iso}</lastmod>\n    <changefreq>monthly</changefreq>\n    <priority>0.3</priority>\n  </url>""")
    sitemap_xml = f"""<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.w3.org/schemas/sitemap/0.9">\n{chr(10).join(urls)}\n</urlset>"""
    (DIST_DIR / "sitemap.xml").write_text(sitemap_xml, encoding="utf-8")

    # 8. IndexNow Instant Indexing Verification Key File
    indexnow_key = "ocrp2026indexnow84eb54d7"
    (DIST_DIR / f"{indexnow_key}.txt").write_text(indexnow_key, encoding="utf-8")

    print(f"Static site successfully built in {DIST_DIR}!")


if __name__ == "__main__":
    main()
