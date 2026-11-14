import json
import logging
import os
from datetime import datetime
from typing import Dict, Any
from fastapi import APIRouter, Request, HTTPException, Response
from fastapi.responses import HTMLResponse, PlainTextResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel

from app.config import (
    settings,
    load_brand_config,
    load_services_data,
    load_towns_data,
    get_town_by_slug,
)
from app.services.tenant_manager import TenantManager
from app.services.db import (
    list_job_projects,
    list_reviews,
    get_setting,
    get_bool_setting,
    list_blog_posts,
    get_blog_post,
)
from app.agents.gbp_seo_agent import build_dynamic_town_json_ld

router = APIRouter(tags=["Website, SEO & Tenant Management"])
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
templates = Jinja2Templates(directory=TEMPLATES_DIR)


class TenantSwitchRequest(BaseModel):
    tenant_id: str
    switched_by: str = "admin"


def _build_town_page_context(town: Dict[str, Any]) -> Dict[str, Any]:
    brand = load_brand_config()
    services = load_services_data()
    all_towns = load_towns_data()
    town_slug = town.get("slug", "roofing-toms-river-nj")

    approved_all = list_job_projects(approval_status="approved")
    town_projects = [p for p in approved_all if p.get("town_slug") == town_slug]
    # Supplement with nearby Ocean County approved projects so every town silo displays rich visual proof
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


@router.get("/", response_class=HTMLResponse)
async def render_hub_page(request: Request):
    """
    Renders the Master County Hub Landing Page.
    Defaults to the primary base city (Toms River, NJ) with county-wide silo links.
    """
    all_towns = load_towns_data()
    primary_town = get_town_by_slug("roofing-toms-river-nj") or (all_towns[0] if all_towns else {})
    ctx = _build_town_page_context(primary_town)
    return templates.TemplateResponse(request, "location_page.html", ctx)


@router.get("/privacy-policy", response_class=HTMLResponse)
async def render_privacy_policy(request: Request):
    brand = load_brand_config()
    return templates.TemplateResponse(
        request,
        "privacy-policy.html",
        {
            "brand": brand,
            "business_name": brand.get("brand_name", settings.BUSINESS_NAME),
            "phone_number": brand.get("primary_phone", settings.PRIMARY_PHONE),
        },
    )


@router.get("/terms", response_class=HTMLResponse)
async def render_terms(request: Request):
    brand = load_brand_config()
    return templates.TemplateResponse(
        request,
        "terms.html",
        {
            "brand": brand,
            "business_name": brand.get("brand_name", settings.BUSINESS_NAME),
            "phone_number": brand.get("primary_phone", settings.PRIMARY_PHONE),
        },
    )


# ------------------------------------------------------------------------------
# SEO MOAT: DYNAMIC XML SITEMAP & ROBOTS.TXT
# ------------------------------------------------------------------------------

@router.get("/robots.txt", response_class=PlainTextResponse)
async def get_robots_txt():
    """Generates search engine crawling instructions."""
    content = (
        "User-agent: *\n"
        "Allow: /\n"
        "Disallow: /api/\n"
        "Disallow: /admin\n"
        "Disallow: /portal\n\n"
        "Sitemap: https://oceancountyroofingpros.com/sitemap.xml\n"
    )
    return PlainTextResponse(content=content, media_type="text/plain")


@router.get("/sitemap.xml")
async def get_sitemap_xml():
    """
    Generates dynamic XML sitemap indexing all 10 county town silos for Googlebot.
    """
    base_url = "https://oceancountyroofingpros.com"
    today_iso = datetime.now().strftime("%Y-%m-%d")
    all_towns = load_towns_data()

    urls = [
        f"""  <url>
    <loc>{base_url}/</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
  </url>"""
    ]

    for town in all_towns:
        slug = town.get("slug")
        if slug:
            urls.append(
                f"""  <url>
    <loc>{base_url}/{slug}</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>"""
            )

    urls.append(
        f"""  <url>
    <loc>{base_url}/blog</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.85</priority>
  </url>"""
    )
    for post in list_blog_posts(status="published"):
        pslug = post.get("slug")
        if pslug:
            lastmod = (post.get("updated_at") or post.get("published_at") or today_iso)[:10]
            urls.append(
                f"""  <url>
    <loc>{base_url}/blog/{pslug}</loc>
    <lastmod>{lastmod}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.8</priority>
  </url>"""
            )

    urls.append(
        f"""  <url>
    <loc>{base_url}/privacy-policy</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>"""
    )

    urls.append(
        f"""  <url>
    <loc>{base_url}/terms</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>"""
    )

    sitemap_xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
{chr(10).join(urls)}
</urlset>"""

    return Response(content=sitemap_xml, media_type="application/xml")


# ------------------------------------------------------------------------------
# MULTI-TENANT ADMIN ENDPOINTS (RANK AND RENT ENGINE)
# ------------------------------------------------------------------------------

@router.get("/api/admin/tenants")
async def list_tenants_admin():
    """Lists all configured tenants and highlights the active contractor."""
    active_tenant = TenantManager.get_active_tenant()
    all_tenants = TenantManager.list_all_tenants()
    return {
        "active_tenant_id": active_tenant.tenant_id,
        "active_tenant": active_tenant.model_dump(),
        "total_tenants": len(all_tenants),
        "tenants": [t.model_dump() for t in all_tenants],
    }


@router.post("/api/admin/tenants/switch")
async def switch_tenant_admin(body: TenantSwitchRequest):
    """
    Switches active contractor tenant in 1 second without server rebuild or downtime.
    """
    success = TenantManager.switch_tenant(body.tenant_id, switched_by=body.switched_by)
    if not success:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to switch to tenant '{body.tenant_id}'. Verify tenant exists.",
        )

    new_active = TenantManager.get_active_tenant()
    return {
        "status": "success",
        "message": f"Successfully switched active contractor to: {new_active.company_name}",
        "active_tenant": new_active.model_dump(),
    }


# ------------------------------------------------------------------------------
# SEO BLOG HUB & ARTICLE ROUTES (/blog & /blog/{post_slug})
# ------------------------------------------------------------------------------

def _build_blog_shared_context() -> Dict[str, Any]:
    brand = load_brand_config()
    all_towns = load_towns_data()
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
        "all_towns": all_towns,
        "is_blog_page": True,
        "storm_alert_active": storm_alert_active,
        "storm_alert_headline": storm_alert_headline,
        "dispatch_ticker_messages": ticker_list,
    }


@router.get("/blog", response_class=HTMLResponse)
async def render_blog_index(request: Request):
    posts = list_blog_posts(status="published")
    categories = []
    for p in posts:
        cat = p.get("category")
        if cat and cat not in categories:
            categories.append(cat)
    ctx = {
        **_build_blog_shared_context(),
        "posts": posts,
        "categories": categories,
    }
    return templates.TemplateResponse(request, "blog_index.html", ctx)


@router.get("/blog/{post_slug}", response_class=HTMLResponse)
async def render_blog_post(request: Request, post_slug: str):
    post = get_blog_post(post_slug)
    if not post or post.get("status") != "published":
        raise HTTPException(status_code=404, detail=f"Guide '{post_slug}' not found.")
    related = [p for p in list_blog_posts(status="published") if p.get("slug") != post.get("slug")][:2]
    ctx = {
        **_build_blog_shared_context(),
        "post": post,
        "related_posts": related,
    }
    return templates.TemplateResponse(request, "blog_post.html", ctx)


# ------------------------------------------------------------------------------
# DYNAMIC GEO-SILO TOWN PAGES (Catch-all for town slugs)
# ------------------------------------------------------------------------------

@router.get("/{town_slug}", response_class=HTMLResponse)
async def render_dynamic_location_page(request: Request, town_slug: str):
    """
    Dynamic Geo-Silo Route:
    Renders hyper-targeted landing pages for any town defined in config/towns.json.
    """
    if town_slug.startswith("api") or town_slug.startswith("static"):
        raise HTTPException(status_code=404, detail="Page not found")

    town = get_town_by_slug(town_slug)
    if not town:
        raise HTTPException(status_code=404, detail=f"Location page '{town_slug}' not found.")

    ctx = _build_town_page_context(town)
    return templates.TemplateResponse(request, "location_page.html", ctx)
