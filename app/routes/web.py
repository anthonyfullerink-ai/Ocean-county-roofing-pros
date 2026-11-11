import logging
from fastapi import APIRouter, Request, HTTPException, Response
from fastapi.responses import HTMLResponse, PlainTextResponse, JSONResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
import os
from datetime import datetime

from app.config import (
    settings,
    load_brand_config,
    load_services_data,
    load_towns_data,
    get_town_by_slug
)
from app.services.tenant_manager import TenantManager

router = APIRouter(tags=["Website, SEO & Tenant Management"])
logger = logging.getLogger(__name__)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEMPLATES_DIR = os.path.join(BASE_DIR, "templates")
templates = Jinja2Templates(directory=TEMPLATES_DIR)

class TenantSwitchRequest(BaseModel):
    tenant_id: str
    switched_by: str = "admin"

@router.get("/", response_class=HTMLResponse)
async def render_hub_page(request: Request):
    """
    Renders the Master County Hub Landing Page.
    Defaults to the primary base city (Toms River, NJ) with county-wide silo links.
    """
    brand = load_brand_config()
    services = load_services_data()
    all_towns = load_towns_data()
    primary_town = get_town_by_slug("roofing-toms-river-nj") or (all_towns[0] if all_towns else {})

    return templates.TemplateResponse(
        request,
        "location_page.html",
        {
            "brand": brand,
            "services": services,
            "town": primary_town,
            "all_towns": all_towns,
            "current_town": primary_town
        }
    )

@router.get("/privacy-policy", response_class=HTMLResponse)
async def render_privacy_policy(request: Request):
    brand = load_brand_config()
    return templates.TemplateResponse(
        request,
        "privacy-policy.html",
        {
            "brand": brand,
            "business_name": brand.get("brand_name", settings.BUSINESS_NAME),
            "phone_number": brand.get("primary_phone", settings.PRIMARY_PHONE)
        }
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
            "phone_number": brand.get("primary_phone", settings.PRIMARY_PHONE)
        }
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
        "Disallow: /api/\n\n"
        "Sitemap: https://oceancountyroofingpros.com/sitemap.xml\n"
    )
    return PlainTextResponse(content=content, media_type="text/plain")

@router.get("/sitemap.xml")
async def get_sitemap_xml():
    """
    Generates dynamic XML sitemap indexing all county town silos for Googlebot.
    Enables ranking in organic search results below the Google Map Pack.
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
            urls.append(f"""  <url>
    <loc>{base_url}/{slug}</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>""")

    urls.append(f"""  <url>
    <loc>{base_url}/privacy-policy</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>""")

    urls.append(f"""  <url>
    <loc>{base_url}/terms</loc>
    <lastmod>{today_iso}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>""")

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
        "active_tenant": active_tenant.dict(),
        "total_tenants": len(all_tenants),
        "tenants": [t.dict() for t in all_tenants]
    }

@router.post("/api/admin/tenants/switch")
async def switch_tenant_admin(body: TenantSwitchRequest):
    """
    Switches active contractor tenant in 1 second without server rebuild or downtime.
    Redirects calendar appointments, SMS lead alerts, and estimator assignments.
    """
    success = TenantManager.switch_tenant(body.tenant_id, switched_by=body.switched_by)
    if not success:
        raise HTTPException(status_code=400, detail=f"Failed to switch to tenant '{body.tenant_id}'. Verify tenant file exists.")
    
    new_active = TenantManager.get_active_tenant()
    return {
        "status": "success",
        "message": f"Successfully switched active contractor to: {new_active.company_name}",
        "active_tenant": new_active.dict()
    }

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

    brand = load_brand_config()
    services = load_services_data()
    all_towns = load_towns_data()

    return templates.TemplateResponse(
        request,
        "location_page.html",
        {
            "brand": brand,
            "services": services,
            "town": town,
            "all_towns": all_towns,
            "current_town": town
        }
    )
