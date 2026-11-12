/**
 * Netlify Serverless Function: Admin & Tenant Operations
 * Routes: /api/admin/*
 */
import crypto from "crypto";

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "ocrp_admin_secret_key_2026_offgrid_media";

function createSessionToken(username) {
  const payload = {
    u: username,
    exp: Date.now() + 24 * 60 * 60 * 1000 // 24-hour expiration
  };
  const str = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(str).digest("hex");
  return `${str}.${sig}`;
}

function verifySessionToken(token) {
  if (!token || !token.includes(".")) return null;
  const [str, sig] = token.split(".");
  const expectedSig = crypto.createHmac("sha256", SESSION_SECRET).update(str).digest("hex");
  if (sig !== expectedSig) return null;
  try {
    const payload = JSON.parse(Buffer.from(str, "base64url").toString());
    if (Date.now() > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_KEY || "";

  const headers = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    // 0. OWNER ADMIN AUTHENTICATION (/api/admin/auth)
    if (path.endsWith("/auth") && req.method === "POST") {
      const body = await req.json();
      const inputUser = (body.username || "").trim();
      const inputPass = (body.password || "").trim();

      const expectedUser = (process.env.ADMIN_USERNAME || "").trim();
      const expectedPass = (process.env.ADMIN_PASSWORD || "").trim();

      if (!expectedPass) {
        return new Response(JSON.stringify({ error: "ADMIN_PASSWORD not set in environment" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }

      if (inputUser === expectedUser && inputPass === expectedPass) {
        const token = createSessionToken(inputUser);
        return new Response(JSON.stringify({
          status: "success",
          token,
          user: inputUser,
          message: "Owner authenticated"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } else {
        return new Response(JSON.stringify({ error: "Invalid admin username or password" }), {
          status: 401,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 0b. VERIFY SESSION (/api/admin/auth/verify)
    if (path.includes("/auth/verify")) {
      const authHeader = req.headers.get("authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const session = verifySessionToken(token);
      if (session) {
        return new Response(JSON.stringify({ authenticated: true, user: session.u }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ authenticated: false }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 1. SWITCH ACTIVE TENANT (/api/admin/tenants/switch)
    if (path.includes("/switch") && req.method === "POST") {
      const body = await req.json();
      const tenantId = body.tenant_id;
      if (!tenantId) {
        return new Response(JSON.stringify({ error: "tenant_id required" }), { status: 400 });
      }

      if (supabaseUrl && supabaseKey) {
        // Set all other tenants to false, then target to true
        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants?tenant_id=neq.${tenantId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ is_active: false })
        });
        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants?tenant_id=eq.${tenantId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ is_active: true })
        });
      }

      return new Response(JSON.stringify({
        status: "success",
        active_tenant_id: tenantId,
        message: `Switched active tenant to ${tenantId}`
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 2. LIST OR UPSERT TENANTS (/api/admin/tenants)
    if (path.includes("/tenants")) {
      if (req.method === "GET") {
        if (supabaseUrl && supabaseKey) {
          const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants?order=is_active.desc,company_name.asc`, { headers });
          const tenants = await res.json();
          const active = tenants.find(t => t.is_active) || tenants[0] || {};
          return new Response(JSON.stringify({
            active_tenant_id: active.tenant_id,
            active_tenant: active,
            total_tenants: tenants.length,
            tenants
          }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }
      } else if (req.method === "POST") {
        const body = await req.json();
        const tenantId = body.tenant_id || `client_${(body.company_name || "partner").toLowerCase().replace(/[^a-z0-9]/g, "_")}`;
        const record = {
          tenant_id: tenantId,
          company_name: body.company_name,
          contact_name: body.contact_name || body.estimator_name || "Manager",
          estimator_name: body.estimator_name || "Riley",
          dispatch_phone: body.dispatch_phone || "+17326609121",
          email: body.email || "",
          portal_pin: body.portal_pin || "732100",
          scheduling_type: body.scheduling_type || "google_calendar",
          booking_url: body.booking_url || "",
          monthly_retainer: parseFloat(body.monthly_retainer || 1500.0)
        };

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants`, {
            method: "POST",
            headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify(record)
          });
        }

        return new Response(JSON.stringify({ status: "success", tenant: record }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // 3. GET / UPDATE SETTINGS (/api/admin/settings)
    if (path.includes("/settings") && req.method === "POST") {
      const body = await req.json();
      if (supabaseUrl && supabaseKey) {
        for (const [k, v] of Object.entries(body)) {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/system_settings`, {
            method: "POST",
            headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({ key: k, value: String(v), updated_at: new Date().toISOString() })
          });
        }
      }
      return new Response(JSON.stringify({ status: "success", settings: body }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // 4. VAPI VOICE AI 2-WAY SYNC (/api/admin/vapi/sync)
    if (path.includes("/vapi/sync")) {
      const vapiKey = process.env.VAPI_API_KEY || "";
      if (!vapiKey) {
        return new Response(JSON.stringify({ error: "VAPI_API_KEY not configured" }), { status: 500 });
      }

      const vapiHeaders = {
        "Authorization": `Bearer ${vapiKey}`,
        "Content-Type": "application/json"
      };

      if (req.method === "GET" || (req.method === "POST" && path.includes("/pull"))) {
        const sarahRes = await fetch("https://api.vapi.ai/assistant/dbc59b3f-85a6-4fad-9dab-b5a36b16125b", { headers: vapiHeaders });
        const rileyRes = await fetch("https://api.vapi.ai/assistant/e86a1d27-c226-4018-96f0-e434eb53b895", { headers: vapiHeaders });
        const sarah = await sarahRes.json();
        const riley = await rileyRes.json();

        return new Response(JSON.stringify({
          status: "success",
          last_sync: new Date().toISOString(),
          sarah: { name: sarah.name, voice: sarah.voice, model: sarah.model?.model },
          riley: { name: riley.name, voice: riley.voice, model: riley.model?.model }
        }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response(JSON.stringify({ error: "Not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
