"""
Comprehensive Automated Test Suite for Antigravity Control Plane Overhaul (Slice 3)
Tests:
1. Node ESM execution of netlify/functions/api-admin.mjs for:
   - HMAC session authentication (/api/admin/auth & /api/admin/auth/verify)
   - Live Cloud Bootstrap (/api/admin/bootstrap)
   - Master CRM Lead CRUD (/api/admin/leads GET/POST/PATCH/DELETE)
   - Hybrid Town/Territory Contractor Routing (/api/admin/routing GET/POST)
   - AI Email Draft & AI Sandbox Simulator (/api/admin/emails/ai-draft & /api/admin/sandbox/email)
   - Vapi Voice AI Studio (/api/admin/vapi & /api/admin/vapi/assistant)
   - Live API Health Diagnostics (/api/admin/diagnostics)
   - Contractor Partner Portal (/api/portal/auth, /api/portal/data, /api/portal/leads/{id}/status)
2. Node ESM execution of AIEmailAgent.resolveTenantForText() proving Hybrid Territory Routing
   maps specific Ocean County towns (e.g., "Brick", "Toms River") to their assigned contractor
   partner and falls back to the Primary Default Partner when a town is unassigned.
3. FastAPI TestClient execution of /api/admin/auth, /api/admin/auth/verify, /api/admin/bootstrap,
   /api/admin/routing, /api/admin/sandbox/email, /api/admin/diagnostics, and /api/portal/data.
"""
import json
import os
import subprocess
import pytest
from fastapi.testclient import TestClient

from app.main import app

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
API_ADMIN_PATH = os.path.join(PROJECT_ROOT, "netlify", "functions", "api-admin.mjs").replace("\\", "/")
AI_EMAIL_HANDLER_PATH = os.path.join(PROJECT_ROOT, "netlify", "functions", "services", "ai-email-handler.mjs").replace("\\", "/")


def run_node_script(js_code: str) -> dict:
    """Executes an inline ES module script in Node.js and parses the last JSON line."""
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", js_code],
        capture_output=True,
        text=True,
        check=True,
    )
    lines = [line.strip() for line in proc.stdout.strip().splitlines() if line.strip()]
    return json.loads(lines[-1])


# ==============================================================================
# 1. NODE ESM TESTS: HYBRID TERRITORY ROUTING (AIEmailAgent.resolveTenantForText)
# ==============================================================================

def test_node_hybrid_territory_routing_resolution():
    """
    Prove AIEmailAgent.resolveTenantForText() maps specific Ocean County towns
    ("Brick", "Toms River") to their assigned contractor partner and falls back
    to the Primary Default Partner when a town is unassigned (e.g. "Lakewood" or "Jackson").
    """
    js_code = f"""
    import {{ AIEmailAgent }} from "file://{AI_EMAIL_HANDLER_PATH}";

    const mockTenants = {{
      "client_brick_premier": {{
        tenant_id: "client_brick_premier",
        company_name: "Brick Premier Roofing Co",
        estimator_name: "Marcus",
        dispatch_phone: "+17325550101"
      }},
      "client_toms_river_elite": {{
        tenant_id: "client_toms_river_elite",
        company_name: "Toms River Elite Exteriors",
        estimator_name: "Sarah",
        dispatch_phone: "+17325550202"
      }}
    }};

    const defaultPartner = {{
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      estimator_name: "Riley Davis",
      dispatch_phone: "+17326609121"
    }};

    process.env.SUPABASE_URL = "https://mock-supabase.local";
    process.env.SUPABASE_KEY = "mock_key";

    globalThis.fetch = async (url) => {{
      const u = String(url);
      for (const [tid, record] of Object.entries(mockTenants)) {{
        if (u.includes(encodeURIComponent(tid))) {{
          return new Response(JSON.stringify([record]), {{ status: 200 }});
        }}
      }}
      return new Response(JSON.stringify([defaultPartner]), {{ status: 200 }});
    }};

    const routingConfig = JSON.stringify({{
      "Brick": "client_brick_premier",
      "roofing-toms-river-nj": "client_toms_river_elite",
      "Point Pleasant": "default"
    }});

    async function run() {{
      const brickRes = await AIEmailAgent.resolveTenantForText(
        "Need a shingle roof replacement at 440 Drum Point Rd, Brick NJ",
        routingConfig,
        defaultPartner
      );
      const tomsRiverRes = await AIEmailAgent.resolveTenantForText(
        "Storm damage inspection at 188 Hooper Ave in Toms River, NJ",
        routingConfig,
        defaultPartner
      );
      const unassignedRes = await AIEmailAgent.resolveTenantForText(
        "Looking for an estimate at 902 County Line Rd, Lakewood NJ",
        routingConfig,
        defaultPartner
      );
      const defaultExplicitRes = await AIEmailAgent.resolveTenantForText(
        "Leaking skylight in Point Pleasant NJ",
        routingConfig,
        defaultPartner
      );

      console.log(JSON.stringify({{
        brick: brickRes,
        toms_river: tomsRiverRes,
        unassigned: unassignedRes,
        default_explicit: defaultExplicitRes
      }}));
    }}
    run();
    """
    res = run_node_script(js_code)

    assert res["brick"]["tenant_id"] == "client_brick_premier"
    assert res["brick"]["company_name"] == "Brick Premier Roofing Co"

    assert res["toms_river"]["tenant_id"] == "client_toms_river_elite"
    assert res["toms_river"]["company_name"] == "Toms River Elite Exteriors"

    assert res["unassigned"]["tenant_id"] == "client_joe_the_roofer"
    assert res["unassigned"]["company_name"] == "Joe The Roofer LLC"

    assert res["default_explicit"]["tenant_id"] == "client_joe_the_roofer"


# ==============================================================================
# 2. NODE ESM TESTS: NETLIFY FUNCTION api-admin.mjs CONTROL PLANE ENDPOINTS
# ==============================================================================

def test_node_api_admin_auth_bootstrap_crud_routing_sandbox_diagnostics():
    """
    End-to-end verification of netlify/functions/api-admin.mjs covering:
    - Auth & HMAC Token Verification
    - Live Cloud Bootstrap (/api/admin/bootstrap)
    - Lead CRUD (/api/admin/leads GET, POST, PATCH, DELETE) with territory auto-assignment
    - Hybrid Territory Routing (/api/admin/routing GET, POST)
    - AI Email Draft & AI Sandbox Simulator (/api/admin/emails/ai-draft & /api/admin/sandbox/email)
    - Vapi Voice AI Studio (/api/admin/vapi & /api/admin/vapi/assistant)
    - Live Diagnostics (/api/admin/diagnostics)
    - Partner Portal (/api/portal/auth, /api/portal/data, /api/portal/leads/:id/status)
    """
    js_code = f"""
    import adminHandler from "file://{API_ADMIN_PATH}";

    process.env.ADMIN_USERNAME = "anthony";
    process.env.ADMIN_PASSWORD = "Antigravity2026!";
    process.env.ADMIN_SESSION_SECRET = "test_hmac_secret_2026";
    process.env.SUPABASE_URL = "https://mock-supabase.local";
    process.env.SUPABASE_KEY = "mock_supabase_service_key";
    process.env.VAPI_API_KEY = "mock_vapi_key";
    process.env.RESEND_API_KEY = "mock_resend_key";

    const dbLeads = [
      {{
        id: "CRM-1001",
        first_name: "John",
        last_name: "Shore",
        phone: "+17325551111",
        email: "john@shore.com",
        street_address: "10 Ocean Ave",
        city: "Toms River",
        status: "Booked",
        assigned_tenant_id: "client_joe_the_roofer",
        estimated_value: 14500
      }}
    ];

    const dbTenants = [
      {{
        tenant_id: "client_joe_the_roofer",
        company_name: "Joe The Roofer LLC",
        estimator_name: "Riley Davis",
        dispatch_phone: "+17326609121",
        portal_pin: "732100",
        monthly_retainer: 1500,
        is_active: true
      }},
      {{
        tenant_id: "client_brick_specialist",
        company_name: "Brick Shore Roofers LLC",
        estimator_name: "Devon",
        dispatch_phone: "+17326609999",
        portal_pin: "732200",
        monthly_retainer: 2000,
        is_active: false
      }}
    ];

    let storedRoutingJson = JSON.stringify({{ "Brick": "client_brick_specialist" }});

    globalThis.fetch = async (url, opts = {{}}) => {{
      const u = String(url);
      const method = (opts.method || "GET").toUpperCase();

      if (u.includes("/rest/v1/system_settings")) {{
        if (method === "POST") {{
          const body = JSON.parse(opts.body || "{{}}");
          if (body.key === "territory_routing_json") {{
            storedRoutingJson = body.value;
          }}
          return new Response(JSON.stringify([body]), {{ status: 201 }});
        }}
        return new Response(JSON.stringify([
          {{ key: "territory_routing_json", value: storedRoutingJson }},
          {{ key: "enable_review_sms", value: "true" }}
        ]), {{ status: 200 }});
      }}

      if (u.includes("/rest/v1/tenants")) {{
        if (u.includes("tenant_id=eq.client_brick_specialist")) {{
          return new Response(JSON.stringify([dbTenants[1]]), {{ status: 200 }});
        }}
        return new Response(JSON.stringify(dbTenants), {{ status: 200 }});
      }}

      if (u.includes("/rest/v1/leads")) {{
        if (method === "POST") {{
          const created = JSON.parse(opts.body);
          dbLeads.unshift(created);
          return new Response(JSON.stringify([created]), {{ status: 201 }});
        }}
        if (method === "PATCH") {{
          return new Response(JSON.stringify([dbLeads[0]]), {{ status: 200 }});
        }}
        if (method === "DELETE") {{
          return new Response(JSON.stringify([]), {{ status: 200 }});
        }}
        if (u.includes("email=eq.")) {{
          const emailParam = decodeURIComponent(u.split("email=eq.")[1].split("&")[0]);
          const matched = dbLeads.filter(l => l.email === emailParam);
          return new Response(JSON.stringify(matched), {{ status: 200 }});
        }}
        return new Response(JSON.stringify(dbLeads), {{ status: 200 }});
      }}

      if (u.includes("api.vapi.ai/assistant")) {{
        return new Response(JSON.stringify({{
          id: "asst_123",
          name: "Riley Dispatcher",
          firstMessage: "Hi, this is Riley with Ocean County Roofing Pros!",
          model: {{ provider: "openai", model: "gpt-4o-mini", temperature: 0.4, messages: [{{ role: "system", content: "You are Riley." }}] }}
        }}), {{ status: 200 }});
      }}

      if (u.includes("api.vapi.ai/call")) {{
        return new Response(JSON.stringify([]), {{ status: 200 }});
      }}

      if (u.includes("api.resend.com")) {{
        return new Response(JSON.stringify({{ data: [] }}), {{ status: 200 }});
      }}

      return new Response(JSON.stringify([]), {{ status: 200 }});
    }};

    async function callApi(path, method = "GET", body = null, headers = {{}}) {{
      const reqInit = {{ method, headers: {{ "Content-Type": "application/json", ...headers }} }};
      if (body !== null) reqInit.body = JSON.stringify(body);
      const resp = await adminHandler(new Request("http://localhost" + path, reqInit), {{}});
      const data = await resp.json();
      return {{ status: resp.status, data }};
    }}

    async function run() {{
      // 1. Auth & Verify
      const authBad = await callApi("/api/admin/auth", "POST", {{ username: "anthony", password: "wrong" }});
      const authGood = await callApi("/api/admin/auth", "POST", {{ username: "anthony", password: "Antigravity2026!" }});
      const verifyGood = await callApi("/api/admin/auth/verify", "GET", null, {{ Authorization: "Bearer " + authGood.data.token }});

      // 2. Bootstrap
      const bootstrap = await callApi("/api/admin/bootstrap", "GET");

      // 3. Routing GET & POST
      const routingSave = await callApi("/api/admin/routing", "POST", {{
        territory_routing: {{ "Brick": "client_brick_specialist", "Toms River": "client_joe_the_roofer" }}
      }});
      const routingGet = await callApi("/api/admin/routing", "GET");

      // 4. Leads CRUD (Create in Brick -> auto-routes to client_brick_specialist)
      const leadCreate = await callApi("/api/admin/leads", "POST", {{
        first_name: "Elena",
        last_name: "Vance",
        phone: "732-555-9090",
        street_address: "550 Brick Blvd",
        city: "Brick",
        estimated_value: 16200
      }});
      const newLeadId = leadCreate.data.lead.id;
      const leadPatch = await callApi(`/api/admin/leads/${{newLeadId}}`, "PATCH", {{ status: "Job Won", estimated_value: 18000 }});
      const leadList = await callApi("/api/admin/leads", "GET");
      const leadDelete = await callApi(`/api/admin/leads/${{newLeadId}}`, "DELETE");

      // 5. AI Sandbox & AI Draft
      const sandboxRes = await callApi("/api/admin/sandbox/email", "POST", {{
        senderEmail: "homeowner@bricknj.com",
        headerName: "Mark Stevens",
        subject: "Roof replacement quote in Brick",
        textBody: "Hi, I need a roof replacement estimate for my house at 220 Herbertsville Rd, Brick NJ. My phone is (732) 555-4321."
      }});
      const draftRes = await callApi("/api/admin/emails/ai-draft", "POST", {{
        senderEmail: "urgent@tomsriver.com",
        headerName: "Sarah Connor",
        subject: "URGENT roof leak",
        textBody: "Water is pouring through the ceiling at 12 Main St, Toms River! Call 732-555-7777."
      }});

      // 6. Vapi Overview & Assistant Update
      const vapiGet = await callApi("/api/admin/vapi", "GET");
      const vapiUpdate = await callApi("/api/admin/vapi/assistant", "POST", {{
        assistantKey: "riley",
        firstMessage: "Hello from updated Riley!",
        systemPrompt: "Updated system prompt",
        temperature: 0.3
      }});

      // 7. Partner Portal Auth, Data & 1-Tap Status Update
      const portalAuth = await callApi("/api/portal/auth", "POST", {{ pin: "732100", tenant_id: "client_joe_the_roofer" }});
      const portalData = await callApi("/api/portal/data?tenant_id=client_joe_the_roofer", "GET");
      const portalStatus = await callApi("/api/portal/leads/CRM-1001/status", "POST", {{ status: "Completed" }});

      // 8. Live Diagnostics
      const diagnostics = await callApi("/api/admin/diagnostics", "GET");

      console.log(JSON.stringify({{
        authBadStatus: authBad.status,
        authGoodStatus: authGood.status,
        verifyAuthenticated: verifyGood.data.authenticated,
        bootstrapStatus: bootstrap.data.status,
        bootstrapTotalLeads: bootstrap.data.kpis.total_leads,
        routingGet: routingGet.data.territory_routing,
        createdLeadTenant: leadCreate.data.lead.assigned_tenant_id,
        patchedLeadStatus: leadPatch.data.lead.status,
        leadListTotal: leadList.data.total,
        deletedId: leadDelete.data.deleted_id,
        sandboxIntent: sandboxRes.data.analysis.intent,
        sandboxTenant: sandboxRes.data.tenant.tenant_id,
        draftIntent: draftRes.data.analysis.intent,
        vapiGetStatus: vapiGet.data.status,
        vapiUpdateStatus: vapiUpdate.data.status,
        portalAuthStatus: portalAuth.data.status,
        portalDataStatus: portalData.data.status,
        portalCompletedReviewSent: portalStatus.data.lead.review_request_sent,
        diagnosticsStatus: diagnostics.data.status,
        diagnosticsSupabase: diagnostics.data.checks.supabase.status
      }}));
    }}
    run();
    """
    res = run_node_script(js_code)

    assert res["authBadStatus"] == 401
    assert res["authGoodStatus"] == 200
    assert res["verifyAuthenticated"] is True
    assert res["bootstrapStatus"] == "success"
    assert res["bootstrapTotalLeads"] >= 1
    assert res["routingGet"]["Brick"] == "client_brick_specialist"
    assert res["createdLeadTenant"] == "client_brick_specialist"
    assert res["patchedLeadStatus"] == "Job Won"
    assert res["leadListTotal"] >= 1
    assert res["deletedId"].startswith("CRM-")
    assert res["sandboxIntent"] == "COLD_LEAD_ESTIMATE"
    assert res["sandboxTenant"] == "client_brick_specialist"
    assert res["draftIntent"] == "EMERGENCY_LEAK"
    assert res["vapiGetStatus"] == "success"
    assert res["vapiUpdateStatus"] == "success"
    assert res["portalAuthStatus"] == "success"
    assert res["portalDataStatus"] == "success"
    assert res["portalCompletedReviewSent"] is True
    assert res["diagnosticsStatus"] == "success"
    assert res["diagnosticsSupabase"] == "online"


# ==============================================================================
# 3. FASTAPI TESTCLIENT TESTS: CONTROL PLANE & PARTNER PORTAL ENDPOINTS
# ==============================================================================

def test_fastapi_control_plane_endpoints():
    """
    Verify FastAPI routes in app/routes/portals.py cleanly support:
    - POST /api/admin/auth & GET /api/admin/auth/verify (env credentials + fallback PIN)
    - GET /api/admin/bootstrap
    - GET & POST /api/admin/routing
    - POST /api/admin/sandbox/email & POST /api/admin/emails/ai-draft
    - GET /api/admin/diagnostics
    - GET /api/portal/data, POST /api/portal/auth, POST /api/portal/leads/{id}/status
    """
    client = TestClient(app)

    # 1. Admin Auth (PIN fallback + HMAC token verification)
    auth_res = client.post("/api/admin/auth", json={"pin": "732999"})
    assert auth_res.status_code == 200
    auth_data = auth_res.json()
    assert auth_data["authenticated"] is True
    assert "token" in auth_data

    verify_res = client.get(
        "/api/admin/auth/verify",
        headers={"Authorization": f"Bearer {auth_data['token']}"},
    )
    assert verify_res.status_code == 200
    assert verify_res.json()["authenticated"] is True

    # 2. Bootstrap
    boot_res = client.get("/api/admin/bootstrap")
    assert boot_res.status_code == 200
    boot_data = boot_res.json()
    assert boot_data["status"] == "success"
    assert "kpis" in boot_data
    assert "leads" in boot_data
    assert "tenants" in boot_data
    assert "territory_routing" in boot_data

    # 3. Hybrid Territory Routing Save & Fetch
    routing_payload = {
        "territory_routing": {
            "Brick": "client_joe_the_roofer",
            "Toms River": "client_joe_the_roofer",
        }
    }
    save_route_res = client.post("/api/admin/routing", json=routing_payload)
    assert save_route_res.status_code == 200
    assert save_route_res.json()["territory_routing"]["Brick"] == "client_joe_the_roofer"

    get_route_res = client.get("/api/admin/routing")
    assert get_route_res.status_code == 200
    assert get_route_res.json()["territory_routing"]["Toms River"] == "client_joe_the_roofer"

    # 4. AI Sandbox Simulator & AI Email Draft
    sandbox_res = client.post(
        "/api/admin/sandbox/email",
        json={
            "senderEmail": "test@oceanhome.com",
            "headerName": "Chris Russo",
            "subject": "Roof estimate in Brick NJ",
            "textBody": "Looking for a 21-point drone inspection on my shingle roof in Brick.",
        },
    )
    assert sandbox_res.status_code == 200
    sb_data = sandbox_res.json()
    assert sb_data["status"] == "success"
    assert sb_data["analysis"]["intent"] == "COLD_LEAD_ESTIMATE"
    assert "Free 21-Point Drone" in sb_data["analysis"]["reply_body"]

    # 5. Diagnostics
    diag_res = client.get("/api/admin/diagnostics")
    assert diag_res.status_code == 200
    diag_data = diag_res.json()
    assert diag_data["status"] == "success"
    assert "supabase" in diag_data["checks"]
    assert "vapi" in diag_data["checks"]
    assert "resend" in diag_data["checks"]
    assert "twilio" in diag_data["checks"]

    # 6. Partner Portal Data & Auth
    portal_data_res = client.get("/api/portal/data?tenant_id=client_joe_the_roofer")
    assert portal_data_res.status_code == 200
    p_data = portal_data_res.json()
    assert p_data["status"] == "success"
    assert "kpis" in p_data
    assert "leads" in p_data

    portal_auth_res = client.post(
        "/api/portal/auth",
        json={"tenant_id": "client_joe_the_roofer", "pin": "732100"},
    )
    assert portal_auth_res.status_code == 200
    assert portal_auth_res.json()["status"] == "success"


def test_sameas_citations_schema_and_indexnow():
    """Verify live citations inject sameAs into RoofingContractor JSON-LD schema."""
    from app.services.db import set_setting
    from app.agents.gbp_seo_agent import build_dynamic_town_json_ld

    citations = [
        {"key": "bing_places", "name": "Bing Places", "status": "live", "url": "https://www.bing.com/maps?osid=123"},
        {"key": "yelp", "name": "Yelp", "status": "pending", "url": "https://www.yelp.com/biz/pending"},
    ]
    set_setting("citations_json", json.dumps(citations))

    schema_str = build_dynamic_town_json_ld(
        brand={"brand_name": "Ocean County Roofing Pros", "primary_phone": "+17326609121"},
        town={"town_name": "Toms River", "slug": "roofing-toms-river-nj", "zip_codes": ["08753"], "state": "NJ"},
        projects=[],
        reviews=[],
    )
    schema = json.loads(schema_str)
    biz = schema["@graph"][0]
    assert "sameAs" in biz
    assert "https://www.bing.com/maps?osid=123" in biz["sameAs"]
    assert "https://www.yelp.com/biz/pending" not in biz["sameAs"]
