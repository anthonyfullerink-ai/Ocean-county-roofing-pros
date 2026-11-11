import os
import pytest
import httpx
from app.config import settings
from app.services.tenant_manager import TenantManager
from app.services.calendar_service import check_available_slots
from app.services.db import (
    is_supabase_configured,
    create_lead,
    delete_lead,
    get_lead,
)

SECONDARY_CALENDAR_ID = "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com"


def test_google_calendar_secondary_dispatch_routing():
    """Verifies default tenant and settings route to the secondary dispatch calendar."""
    # 1. Verify environment setting
    assert settings.GOOGLE_CALENDAR_ID == SECONDARY_CALENDAR_ID

    # 2. Verify active tenant configuration
    tenant = TenantManager.get_active_tenant()
    assert tenant.tenant_id == "client_joe_the_roofer"
    assert tenant.google_calendar_id == SECONDARY_CALENDAR_ID

    # 3. Verify calendar availability check resolves against the dispatch calendar
    slot_info = check_available_slots("tomorrow", preferred_time="10:00 AM")
    assert slot_info is not None
    assert "date" in slot_info
    assert "available" in slot_info

    # 4. Verify tenant switching correctly updates calendar ID in active_tenant.yaml
    TenantManager.switch_tenant("client_apex_roofing")
    apex_tenant = TenantManager.get_active_tenant()
    assert apex_tenant.tenant_id == "client_apex_roofing"
    assert apex_tenant.google_calendar_id == "apex_shore_calendar@group.calendar.google.com"

    # Switch back to primary partner Joe The Roofer
    TenantManager.switch_tenant("client_joe_the_roofer")
    joe_tenant = TenantManager.get_active_tenant()
    assert joe_tenant.tenant_id == "client_joe_the_roofer"
    assert joe_tenant.google_calendar_id == SECONDARY_CALENDAR_ID


def test_live_supabase_cloud_postgrest_sync():
    """Verifies live PostgreSQL / PostgREST cloud sync with Supabase project in us-east-1."""
    assert is_supabase_configured() is True
    assert "supabase.co" in settings.SUPABASE_URL

    test_lead_id = "TEST-PYTEST-LIVE-SYNC"
    lead_payload = {
        "id": test_lead_id,
        "first_name": "PytestLive",
        "last_name": "CloudVerification",
        "phone": "+17325557766",
        "city": "Toms River",
        "service_requested": "21-Point Drone Roof Inspection",
        "urgency": "High",
    }

    # 1. Create lead locally (triggers non-blocking _sync_to_supabase_cloud)
    created = create_lead(lead_payload)
    assert created["id"] == test_lead_id

    # 2. Query live Supabase cloud PostgREST API directly
    headers = {
        "apikey": settings.SUPABASE_KEY,
        "Authorization": f"Bearer {settings.SUPABASE_KEY}",
    }
    with httpx.Client(timeout=10.0) as client:
        r = client.get(
            f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/leads?id=eq.{test_lead_id}",
            headers=headers,
        )
        assert r.status_code == 200
        records = r.json()
        assert len(records) == 1
        cloud_rec = records[0]
        assert cloud_rec["id"] == test_lead_id
        assert cloud_rec["first_name"] == "PytestLive"
        assert cloud_rec["city"] == "Toms River"

        # 3. Delete lead and verify cloud deletion
        delete_lead(test_lead_id)
        r_del = client.get(
            f"{settings.SUPABASE_URL.rstrip('/')}/rest/v1/leads?id=eq.{test_lead_id}",
            headers=headers,
        )
        assert r_del.status_code == 200
        assert len(r_del.json()) == 0
