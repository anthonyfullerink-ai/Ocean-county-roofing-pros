/**
 * Netlify Serverless Function: Antigravity Control Plane for Owner Command Center (/admin) & Partner Portal (/portal)
 * Routes: /api/admin/*, /api/portal/*, /api/vapi/sync/*
 */
import crypto from "crypto";
import { EmailService } from "./services/email-service.mjs";
import { AIEmailAgent } from "./services/ai-email-handler.mjs";

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "ocrp_admin_secret_key_2026_offgrid_media";
const SARAH_ASSISTANT_ID = process.env.VAPI_RECEPTIONIST_ID || "dbc59b3f-85a6-4fad-9dab-b5a36b16125b";
const RILEY_ASSISTANT_ID = process.env.VAPI_ESTIMATOR_ID || "e86a1d27-c226-4018-96f0-e434eb53b895";

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

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function computeKpis({ leads = [], tenants = [], projects = [], reviews = [], supabaseConnected = false, filterTenantId = null }) {
  const activeTenant =
    (filterTenantId && tenants.find(t => t.tenant_id === filterTenantId)) ||
    tenants.find(t => t.is_active) ||
    tenants[0] || {
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      estimator_name: "Riley Davis",
      dispatch_phone: "+17326609121",
      monthly_retainer: 1500
    };

  const scopedLeads = filterTenantId
    ? leads.filter(l => l.assigned_tenant_id === filterTenantId)
    : leads;

  const totalLeads = scopedLeads.length;
  const bookedStatuses = new Set(["Booked", "Inspection Booked", "Inspected", "Job Won", "Completed"]);
  const wonStatuses = new Set(["Job Won", "Completed"]);

  const bookedCount = scopedLeads.filter(l => bookedStatuses.has(l.status)).length;
  const jobsWonCount = scopedLeads.filter(l => wonStatuses.has(l.status)).length;

  const activePipelineValue = scopedLeads
    .filter(l => l.status !== "Lost" && l.status !== "Inspection Cancelled")
    .reduce((acc, l) => acc + (parseFloat(l.estimated_value) || 12500), 0);

  const wonRevenueValue = scopedLeads
    .filter(l => wonStatuses.has(l.status))
    .reduce((acc, l) => acc + (parseFloat(l.estimated_value) || 12500), 0);

  const retainer = parseFloat(activeTenant.monthly_retainer) || 1500;
  const basisValue = wonRevenueValue > 0 ? wonRevenueValue : activePipelineValue;
  const roiMultiple = retainer > 0 ? Math.round((basisValue / retainer) * 10) / 10 : 0;

  const approvedProjectsCount = projects.filter(p => p.approval_status === "approved").length;
  const pendingProjectsCount = projects.filter(p => p.approval_status === "pending_auto_24h").length;

  const publicReviews = reviews.filter(r => r.is_public !== false && r.source !== "Direct Resolution");
  const avgRating =
    publicReviews.length > 0
      ? Math.round((publicReviews.reduce((a, r) => a + (parseFloat(r.rating) || 5), 0) / publicReviews.length) * 10) / 10
      : 5.0;

  return {
    total_leads: totalLeads,
    booked_count: bookedCount,
    jobs_won_count: jobsWonCount,
    active_pipeline_value: activePipelineValue,
    won_revenue_value: wonRevenueValue,
    monthly_retainer: retainer,
    roi_multiple: roiMultiple,
    approved_projects_count: approvedProjectsCount,
    pending_projects_count: pendingProjectsCount,
    pending_approval_total: pendingProjectsCount,
    avg_rating: avgRating,
    total_reviews_count: publicReviews.length,
    active_tenant: activeTenant,
    supabase_cloud_connected: supabaseConnected
  };
}

async function sendTwilioSms({ to, body }) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";

  if (!twilioSid || !twilioToken) {
    return { sent: false, status: "mock_logged", reason: "Twilio credentials not set in environment", to, from: twilioPhone, body };
  }

  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      To: to,
      From: twilioPhone,
      Body: body
    })
  });
  const data = await res.json();
  if (!res.ok) {
    return { sent: false, status: "error", error: data.message || "Twilio error", code: res.status };
  }
  return { sent: true, status: "dispatched", sid: data.sid, to, from: twilioPhone, body };
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";

  const headers = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    // =========================================================================
    // 0. OWNER ADMIN AUTHENTICATION (/api/admin/auth & /api/admin/auth/verify)
    // =========================================================================
    if (path.endsWith("/admin/auth") && req.method === "POST") {
      const body = await req.json();
      const inputUser = (body.username || "").trim();
      const inputPass = (body.password || body.pin || "").trim();

      const expectedUser = (process.env.ADMIN_USERNAME || "").trim();
      const expectedPass = (process.env.ADMIN_PASSWORD || "").trim();

      if (!expectedPass) {
        return jsonResponse({ error: "ADMIN_PASSWORD not set in environment" }, 500);
      }

      if (inputUser === expectedUser && inputPass === expectedPass) {
        const token = createSessionToken(inputUser);
        return jsonResponse({
          status: "success",
          token,
          user: inputUser,
          authenticated: true,
          message: "Owner authenticated"
        });
      } else {
        return jsonResponse({ error: "Invalid admin username or password" }, 401);
      }
    }

    if (path.includes("/auth/verify")) {
      const authHeader = req.headers.get("authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "");
      const session = verifySessionToken(token);
      if (session) {
        return jsonResponse({ authenticated: true, user: session.u });
      }
      return jsonResponse({ authenticated: false }, 401);
    }

    // =========================================================================
    // 1. LIVE CLOUD BOOTSTRAP (/api/admin/bootstrap)
    // =========================================================================
    if (path.includes("/bootstrap") && req.method === "GET") {
      if (!supabaseUrl || !supabaseKey) {
        return jsonResponse({
          status: "local_only",
          supabase_connected: false,
          message: "Supabase environment variables not configured"
        });
      }

      const [leadsRes, tenantsRes, settingsRes, projectsRes, reviewsRes, gbpRes, runsRes, reportsRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/leads?order=created_at.desc&limit=250`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/tenants?order=is_active.desc,company_name.asc`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/system_settings`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/job_projects?order=created_at.desc&limit=100`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/reviews?order=created_at.desc&limit=100`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/gbp_posts?order=created_at.desc&limit=50`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/agent_runs?order=created_at.desc&limit=40`, { headers }).catch(() => null),
        fetch(`${supabaseUrl}/rest/v1/daily_reports?order=created_at.desc&limit=1`, { headers }).catch(() => null)
      ]);

      const leads = leadsRes && leadsRes.ok ? await leadsRes.json() : [];
      const tenants = tenantsRes && tenantsRes.ok ? await tenantsRes.json() : [];
      const settingsRows = settingsRes && settingsRes.ok ? await settingsRes.json() : [];
      const projects = projectsRes && projectsRes.ok ? await projectsRes.json() : [];
      const reviews = reviewsRes && reviewsRes.ok ? await reviewsRes.json() : [];
      const gbp_posts = gbpRes && gbpRes.ok ? await gbpRes.json() : [];
      const agent_runs = runsRes && runsRes.ok ? await runsRes.json() : [];
      const reports = reportsRes && reportsRes.ok ? await reportsRes.json() : [];

      const sys_settings = {};
      for (const r of settingsRows) {
        if (r && r.key) sys_settings[r.key] = r.value;
      }

      let territory_routing = {};
      if (sys_settings.territory_routing_json) {
        try {
          territory_routing = JSON.parse(sys_settings.territory_routing_json);
        } catch (e) {
          territory_routing = {};
        }
      }

      const kpis = computeKpis({
        leads,
        tenants,
        projects,
        reviews,
        supabaseConnected: true
      });

      return jsonResponse({
        status: "success",
        supabase_connected: true,
        kpis,
        leads,
        tenants,
        sys_settings,
        territory_routing,
        projects,
        reviews,
        gbp_posts,
        agent_runs,
        latest_report: reports[0] || null
      });
    }

    // =========================================================================
    // 2. MASTER CRM LEADS CRUD (/api/admin/leads & /api/admin/leads/:id)
    // =========================================================================
    if (path.includes("/leads")) {
      const parts = path.split("/").filter(Boolean);
      const leadsIdx = parts.indexOf("leads");
      const rawLeadId = leadsIdx >= 0 && parts.length > leadsIdx + 1 ? decodeURIComponent(parts[leadsIdx + 1]) : null;
      const leadId = rawLeadId && rawLeadId !== "update" && rawLeadId !== "status" ? rawLeadId : null;

      // GET /api/admin/leads
      if (req.method === "GET" && !leadId) {
        if (!supabaseUrl || !supabaseKey) return jsonResponse({ status: "success", total: 0, leads: [] });
        const statusFilter = url.searchParams.get("status");
        const tenantFilter = url.searchParams.get("tenant_id");
        let query = `${supabaseUrl}/rest/v1/leads?order=created_at.desc&limit=250`;
        if (statusFilter) query += `&status=eq.${encodeURIComponent(statusFilter)}`;
        if (tenantFilter) query += `&assigned_tenant_id=eq.${encodeURIComponent(tenantFilter)}`;
        const res = await fetch(query, { headers });
        const leads = res.ok ? await res.json() : [];
        return jsonResponse({ status: "success", total: leads.length, leads });
      }

      // POST /api/admin/leads (Create Manual Lead)
      if (req.method === "POST" && !leadId) {
        const body = await req.json();
        const phone = (body.phone || "").trim();
        if (!phone) {
          return jsonResponse({ detail: "Phone number is required." }, 400);
        }
        const newId = body.id || `CRM-${Date.now() % 100000000}`;
        const nowIso = new Date().toISOString();
        const city = body.city || "Toms River";
        const address = body.street_address || body.address || "";

        let assignedTenantId = body.assigned_tenant_id || "";
        if (!assignedTenantId && supabaseUrl && supabaseKey) {
          const sysSettings = await AIEmailAgent.loadSystemSettings();
          const resolved = await AIEmailAgent.resolveTenantForText(
            `${address} ${city}`,
            sysSettings.territory_routing_json
          );
          assignedTenantId = resolved?.tenant_id || "client_joe_the_roofer";
        }

        const record = {
          id: newId,
          created_at: nowIso,
          updated_at: nowIso,
          lead_source: body.lead_source || "Owner Manual Entry",
          first_name: (body.first_name || "Homeowner").trim(),
          last_name: (body.last_name || "").trim(),
          phone,
          email: (body.email || "").trim(),
          street_address: address,
          city,
          state: body.state || "NJ",
          zip_code: body.zip_code || "",
          service_requested: body.service_requested || "Full Roof Replacement",
          urgency: body.urgency || "Standard",
          status: body.status || "New Lead",
          appointment_slot: body.appointment_slot || "",
          assigned_tenant_id: assignedTenantId || "client_joe_the_roofer",
          estimated_value: parseFloat(body.estimated_value) || 12500.0,
          notes: body.notes || ""
        };

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/leads`, {
            method: "POST",
            headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify(record)
          });
        }
        return jsonResponse({ status: "success", lead: record });
      }

      // PATCH or POST /api/admin/leads/:id or /api/portal/leads/:id/status
      if ((req.method === "PATCH" || req.method === "POST") && leadId) {
        const body = await req.json();
        const updates = { updated_at: new Date().toISOString() };
        const allowedFields = [
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
          "status",
          "appointment_slot",
          "assigned_tenant_id",
          "estimated_value",
          "notes",
          "call_recording_url"
        ];
        for (const k of allowedFields) {
          if (body[k] !== undefined) {
            updates[k] = k === "estimated_value" ? parseFloat(body[k]) || 0 : body[k];
          }
        }

        let existingLead = null;
        if (supabaseUrl && supabaseKey) {
          const getRes = await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}&limit=1`, { headers });
          if (getRes.ok) {
            const arr = await getRes.json();
            existingLead = arr[0] || null;
          }
        }

        let reviewSmsResult = null;
        if (updates.status === "Completed") {
          const sysSettings = await AIEmailAgent.loadSystemSettings();
          const reviewSmsEnabled = sysSettings.enable_review_sms !== "false";
          const targetPhone = updates.phone || existingLead?.phone || "";
          const firstName = updates.first_name || existingLead?.first_name || "Neighbor";
          if (!reviewSmsEnabled) {
            reviewSmsResult = { sent: false, status: "paused" };
          } else if (targetPhone) {
            const feedbackUrl = `https://oceancountyroofingpros.com/feedback/${encodeURIComponent(leadId)}`;
            const smsBody = `Hi ${firstName}, thank you for choosing Ocean County Roofing Pros! Your roofing project is marked complete. We'd love your feedback or a quick Google review here: ${feedbackUrl}`;
            reviewSmsResult = await sendTwilioSms({ to: targetPhone, body: smsBody });
            updates.review_request_sent = true;
            updates.review_request_sent_at = new Date().toISOString();
          }
        }

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify(updates)
          });
        }

        const mergedLead = { ...(existingLead || { id: leadId }), ...updates };
        return jsonResponse({
          status: "success",
          lead: mergedLead,
          review_sms_result: reviewSmsResult
        });
      }

      // DELETE /api/admin/leads/:id
      if (req.method === "DELETE" && leadId) {
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
            method: "DELETE",
            headers
          });
        }
        return jsonResponse({ status: "success", deleted_id: leadId });
      }
    }

    // =========================================================================
    // 3. CONTRACTOR PARTNER PORTAL (/api/portal/login, /api/portal/auth & /api/portal/data)
    // =========================================================================
    if ((path.includes("/portal/login") || path.includes("/portal/auth")) && req.method === "POST") {
      const body = await req.json();
      const pin = String(body.pin || "").trim();
      const identifier = String(body.identifier || body.tenant_id || body.email || "").trim().toLowerCase();

      if (!pin) return jsonResponse({ error: "Partner PIN is required" }, 400);

      let matchedTenant = null;
      if (supabaseUrl && supabaseKey) {
        const res = await fetch(`${supabaseUrl}/rest/v1/tenants?order=is_active.desc`, { headers });
        if (res.ok) {
          const tenants = await res.json();
          matchedTenant = tenants.find(t => {
            const pinMatch = String(t.portal_pin || "").trim() === pin;
            if (!pinMatch) return false;
            if (!identifier) return true;
            return (
              String(t.tenant_id || "").toLowerCase() === identifier ||
              String(t.email || "").toLowerCase() === identifier ||
              String(t.company_name || "").toLowerCase().includes(identifier)
            );
          });
        }
      }

      if (!matchedTenant && pin === "732100") {
        matchedTenant = {
          tenant_id: "client_joe_the_roofer",
          company_name: "Joe The Roofer LLC",
          estimator_name: "Riley Davis",
          dispatch_phone: "+17326609121",
          portal_pin: "732100",
          monthly_retainer: 1500
        };
      }

      if (!matchedTenant) {
        return jsonResponse({ error: "Invalid Partner PIN or Identifier" }, 401);
      }

      return jsonResponse({ status: "success", tenant: matchedTenant });
    }

    if (path.includes("/portal/data") && req.method === "GET") {
      const tenantId = url.searchParams.get("tenant_id") || "client_joe_the_roofer";
      if (!supabaseUrl || !supabaseKey) {
        return jsonResponse({ status: "local_only", leads: [], projects: [] });
      }

      const [leadsRes, tenantsRes, projectsRes, reviewsRes] = await Promise.all([
        fetch(`${supabaseUrl}/rest/v1/leads?assigned_tenant_id=eq.${encodeURIComponent(tenantId)}&order=created_at.desc`, { headers }),
        fetch(`${supabaseUrl}/rest/v1/tenants`, { headers }),
        fetch(`${supabaseUrl}/rest/v1/job_projects?tenant_id=eq.${encodeURIComponent(tenantId)}&order=created_at.desc`, { headers }),
        fetch(`${supabaseUrl}/rest/v1/reviews?order=created_at.desc`, { headers })
      ]);

      const leads = leadsRes.ok ? await leadsRes.json() : [];
      const tenants = tenantsRes.ok ? await tenantsRes.json() : [];
      const projects = projectsRes.ok ? await projectsRes.json() : [];
      const reviews = reviewsRes.ok ? await reviewsRes.json() : [];

      const tenant = tenants.find(t => t.tenant_id === tenantId) || tenants.find(t => t.is_active) || tenants[0] || {};
      const kpis = computeKpis({
        leads,
        tenants,
        projects,
        reviews,
        supabaseConnected: true,
        filterTenantId: tenantId
      });

      return jsonResponse({
        status: "success",
        tenant,
        all_tenants: tenants,
        kpis,
        leads,
        projects
      });
    }

    // =========================================================================
    // 4. SWITCH ACTIVE TENANT & HYBRID TERRITORY ROUTING (/api/admin/tenants & /api/admin/routing)
    // =========================================================================
    if (path.includes("/switch") && req.method === "POST") {
      const body = await req.json();
      const tenantId = body.tenant_id;
      if (!tenantId) {
        return jsonResponse({ error: "tenant_id required" }, 400);
      }

      let activeTenant = { tenant_id: tenantId };
      if (supabaseUrl && supabaseKey) {
        await fetch(`${supabaseUrl}/rest/v1/tenants?tenant_id=neq.${encodeURIComponent(tenantId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ is_active: false })
        });
        const patchRes = await fetch(`${supabaseUrl}/rest/v1/tenants?tenant_id=eq.${encodeURIComponent(tenantId)}`, {
          method: "PATCH",
          headers: { ...headers, "Prefer": "return=representation" },
          body: JSON.stringify({ is_active: true })
        });
        if (patchRes.ok) {
          const rows = await patchRes.json();
          if (rows.length > 0) activeTenant = rows[0];
        }
      }

      return jsonResponse({
        status: "success",
        active_tenant_id: tenantId,
        active_tenant: activeTenant,
        message: `Switched primary active partner to ${tenantId}`
      });
    }

    if (path.includes("/routing")) {
      if (req.method === "GET") {
        const sysSettings = await AIEmailAgent.loadSystemSettings();
        let routing = {};
        try {
          routing = JSON.parse(sysSettings.territory_routing_json || "{}");
        } catch (e) {
          routing = {};
        }
        return jsonResponse({ status: "success", territory_routing: routing });
      }

      if (req.method === "POST") {
        const body = await req.json();
        const routingMap = body.territory_routing || body;
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/system_settings`, {
            method: "POST",
            headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify({
              key: "territory_routing_json",
              value: JSON.stringify(routingMap),
              updated_at: new Date().toISOString()
            })
          });
        }
        return jsonResponse({
          status: "success",
          territory_routing: routingMap,
          message: "Hybrid town territory routing rules saved to Supabase Cloud"
        });
      }
    }

    if (path.includes("/tenants")) {
      if (req.method === "GET") {
        if (supabaseUrl && supabaseKey) {
          const res = await fetch(`${supabaseUrl}/rest/v1/tenants?order=is_active.desc,company_name.asc`, { headers });
          const tenants = await res.json();
          const active = tenants.find(t => t.is_active) || tenants[0] || {};
          return jsonResponse({
            active_tenant_id: active.tenant_id,
            active_tenant: active,
            total_tenants: tenants.length,
            tenants
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
          calendar_id: body.calendar_id || "",
          monthly_retainer: parseFloat(body.monthly_retainer || 1500.0)
        };
        if (body.is_active !== undefined) {
          record.is_active = Boolean(body.is_active);
        }

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/tenants`, {
            method: "POST",
            headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
            body: JSON.stringify(record)
          });
        }

        return jsonResponse({ status: "success", tenant: record });
      }
    }

    // =========================================================================
    // 5. SYSTEM SETTINGS & LIVE CRO CONTROLS (/api/admin/settings)
    // =========================================================================
    if (path.includes("/settings")) {
      if (req.method === "GET") {
        const sysSettings = await AIEmailAgent.loadSystemSettings();
        return new Response(JSON.stringify({ status: "success", settings: sysSettings }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"
          }
        });
      }
      if (req.method === "POST") {
        const body = await req.json();
        const syncedBody = { ...body };
        if ("emergency_banner_enabled" in body) {
          syncedBody.storm_alert_active = String(body.emergency_banner_enabled) === "true" ? "true" : "false";
        }
        if ("emergency_banner_text" in body) {
          syncedBody.storm_alert_headline = body.emergency_banner_text;
        }
        if ("ticker_messages_json" in body) {
          syncedBody.dispatch_ticker_json = typeof body.ticker_messages_json === "string"
            ? body.ticker_messages_json
            : JSON.stringify(body.ticker_messages_json);
        }
        if (supabaseUrl && supabaseKey) {
          const rows = Object.entries(syncedBody).map(([k, v]) => ({
            key: k,
            value: typeof v === "object" ? JSON.stringify(v) : String(v),
            updated_at: new Date().toISOString()
          }));
          for (const row of rows) {
            await fetch(`${supabaseUrl}/rest/v1/system_settings`, {
              method: "POST",
              headers: { ...headers, "Prefer": "resolution=merge-duplicates" },
              body: JSON.stringify(row)
            });
          }
        }
        return jsonResponse({ status: "success", settings: syncedBody });
      }
    }

    // =========================================================================
    // 6. VAPI VOICE AI STUDIO (/api/admin/vapi, /api/admin/vapi/overview, /api/admin/vapi/assistant, /api/vapi/sync)
    // =========================================================================
    if ((path.endsWith("/vapi") || path.includes("/vapi/overview") || path.includes("/vapi/sync")) && req.method === "GET") {
      const vapiKey = process.env.VAPI_API_KEY || "";
      if (!vapiKey) {
        return jsonResponse({ error: "VAPI_API_KEY not configured" }, 500);
      }

      const vapiHeaders = {
        "Authorization": `Bearer ${vapiKey}`,
        "Content-Type": "application/json"
      };

      const [sarahRes, rileyRes, callsRes] = await Promise.all([
        fetch(`https://api.vapi.ai/assistant/${SARAH_ASSISTANT_ID}`, { headers: vapiHeaders }),
        fetch(`https://api.vapi.ai/assistant/${RILEY_ASSISTANT_ID}`, { headers: vapiHeaders }),
        fetch("https://api.vapi.ai/call?limit=25", { headers: vapiHeaders }).catch(() => null)
      ]);

      const sarahRaw = sarahRes.ok ? await sarahRes.json() : {};
      const rileyRaw = rileyRes.ok ? await rileyRes.json() : {};
      const callsRaw = callsRes && callsRes.ok ? await callsRes.json() : [];

      const formatAssistant = (raw, roleLabel) => {
        const sysMsg = (raw.model?.messages || []).find(m => m.role === "system")?.content || raw.model?.systemPrompt || "";
        return {
          id: raw.id,
          role: roleLabel,
          name: raw.name || roleLabel,
          firstMessage: raw.firstMessage || "",
          systemPrompt: sysMsg,
          model: raw.model?.model || "gpt-4o-mini",
          provider: raw.model?.provider || "openai",
          temperature: raw.model?.temperature ?? 0.4,
          voice: raw.voice || {},
          waitSeconds: raw.startSpeakingPlan?.waitSeconds ?? 0.6,
          serverUrl: raw.serverUrl || ""
        };
      };

      const calls = Array.isArray(callsRaw)
        ? callsRaw.map(c => {
            const started = c.startedAt ? new Date(c.startedAt).getTime() : 0;
            const ended = c.endedAt ? new Date(c.endedAt).getTime() : 0;
            const durSec = c.durationSeconds || (started && ended && ended > started ? Math.round((ended - started) / 1000) : 0);
            return {
              id: c.id,
              assistantId: c.assistantId,
              assistantName: c.assistantId === SARAH_ASSISTANT_ID ? "Sarah (Receptionist)" : c.assistantId === RILEY_ASSISTANT_ID ? "Riley (Dispatcher)" : "Voice AI",
              customerNumber: c.customer?.number || "Web / Unknown",
              customerName: c.customer?.name || "",
              status: c.status,
              endedReason: c.endedReason || "",
              createdAt: c.createdAt || c.startedAt || "",
              durationSeconds: durSec,
              cost: c.cost || 0,
              summary: c.analysis?.summary || c.summary || "",
              recordingUrl: c.artifact?.recordingUrl || c.recordingUrl || "",
              transcript: c.artifact?.transcript || c.transcript || ""
            };
          })
        : [];

      return jsonResponse({
        status: "success",
        last_sync: new Date().toISOString(),
        sarah: formatAssistant(sarahRaw, "Sarah (Front Desk Receptionist)"),
        riley: formatAssistant(rileyRaw, "Riley (Roofing Dispatch Specialist)"),
        calls
      });
    }

    if (path.includes("/vapi/assistant") && (req.method === "PATCH" || req.method === "POST")) {
      const vapiKey = process.env.VAPI_API_KEY || "";
      if (!vapiKey) {
        return jsonResponse({ error: "VAPI_API_KEY not configured" }, 500);
      }

      const body = await req.json();
      const targetKey = (body.assistantKey || "riley").toLowerCase();
      const assistantId = body.assistantId || (targetKey === "sarah" ? SARAH_ASSISTANT_ID : RILEY_ASSISTANT_ID);

      const vapiHeaders = {
        "Authorization": `Bearer ${vapiKey}`,
        "Content-Type": "application/json"
      };

      // Fetch current assistant first so we preserve tools / toolIds / provider settings
      const curRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, { headers: vapiHeaders });
      if (!curRes.ok) {
        return jsonResponse({ error: `Failed to fetch assistant ${assistantId}` }, 500);
      }
      const cur = await curRes.json();

      const patchPayload = {};
      if (body.name !== undefined) patchPayload.name = body.name;
      if (body.firstMessage !== undefined) patchPayload.firstMessage = body.firstMessage;

      if (body.systemPrompt !== undefined || body.model !== undefined || body.temperature !== undefined) {
        const curModel = cur.model || { provider: "openai", model: "gpt-4o-mini" };
        const existingMessages = Array.isArray(curModel.messages) ? [...curModel.messages] : [];
        let updatedMessages = existingMessages;

        if (body.systemPrompt !== undefined) {
          const sysIdx = updatedMessages.findIndex(m => m.role === "system");
          if (sysIdx >= 0) {
            updatedMessages[sysIdx] = { ...updatedMessages[sysIdx], content: body.systemPrompt };
          } else {
            updatedMessages.unshift({ role: "system", content: body.systemPrompt });
          }
        }

        patchPayload.model = {
          ...curModel,
          model: body.model || curModel.model || "gpt-4o-mini",
          messages: updatedMessages
        };
        if (body.temperature !== undefined) {
          patchPayload.model.temperature = parseFloat(body.temperature);
        }
      }

      if (body.waitSeconds !== undefined) {
        patchPayload.startSpeakingPlan = {
          ...(cur.startSpeakingPlan || {}),
          waitSeconds: parseFloat(body.waitSeconds) || 0.6
        };
      }

      const updateRes = await fetch(`https://api.vapi.ai/assistant/${assistantId}`, {
        method: "PATCH",
        headers: vapiHeaders,
        body: JSON.stringify(patchPayload)
      });

      const updatedData = await updateRes.json();
      if (!updateRes.ok) {
        return jsonResponse({ error: updatedData.message || "Vapi PATCH error", details: updatedData }, updateRes.status);
      }

      return jsonResponse({
        status: "success",
        message: `Live Vapi assistant (${updatedData.name || targetKey}) updated on Vapi Cloud!`,
        assistant: updatedData
      });
    }

    // =========================================================================
    // 7. RESEND LIVE EMAIL CENTER (/api/admin/emails, /api/admin/emails/send, /api/admin/emails/ai-draft)
    // =========================================================================
    if (path.includes("/emails/send") && req.method === "POST") {
      const body = await req.json();
      const toEmail = (body.to || "").trim();
      const subject = (body.subject || "Ocean County Roofing Pros — Inspection Desk").trim();
      const textBody = (body.body || body.text || "").trim();
      const fromPersona = body.from_persona || "riley";

      if (!toEmail || !textBody) {
        return jsonResponse({ error: "Recipient email and message body are required" }, 400);
      }

      const activeTenant = await AIEmailAgent.loadActiveTenant();
      let sendRes;
      if (fromPersona === "riley") {
        sendRes = await EmailService.sendAgentReply(
          toEmail,
          subject,
          textBody,
          body.in_reply_to || null,
          activeTenant
        );
      } else {
        sendRes = await EmailService.sendEmail({
          from: EmailService.getFromAddress(),
          to: [toEmail],
          reply_to: EmailService.getReplyToAddress(),
          subject,
          html: `<div style="font-family: sans-serif; font-size: 15px; color: #1e293b; line-height: 1.6;">${textBody.replace(/\n/g, "<br>")}</div>`,
          text: textBody
        });
      }

      // Optionally log to CRM lead notes if lead_id provided
      if (body.lead_id && supabaseUrl && supabaseKey) {
        try {
          const getRes = await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(body.lead_id)}&limit=1`, { headers });
          if (getRes.ok) {
            const arr = await getRes.json();
            if (arr[0]) {
              const stamp = new Date().toISOString().split("T")[0];
              const newNote = `${arr[0].notes ? arr[0].notes + "\n" : ""}[${stamp} Outbound Email -> ${toEmail}]: "${subject}"`;
              await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(body.lead_id)}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ notes: newNote, updated_at: new Date().toISOString() })
              });
            }
          }
        } catch (e) {
          console.error("Failed logging email note to lead:", e);
        }
      }

      return jsonResponse({
        status: sendRes?.status === "error" ? "error" : "success",
        result: sendRes
      });
    }

    if ((path.includes("/emails/ai-draft") || path.includes("/sandbox/email")) && req.method === "POST") {
      const body = await req.json();
      const senderEmail = (body.senderEmail || body.from || "homeowner@example.com").trim();
      const headerName = (body.headerName || body.name || "Homeowner").trim();
      const subject = (body.subject || "Roof estimate inquiry").trim();
      const textBody = (body.textBody || body.body || "").trim();

      const sysSettings = await AIEmailAgent.loadSystemSettings();
      const tenant = await AIEmailAgent.resolveTenantForText(
        `${subject} ${textBody}`,
        sysSettings.territory_routing_json
      );
      const existingLead = await AIEmailAgent.lookupLeadByEmail(senderEmail);

      const analysis = await AIEmailAgent.analyzeEmailWithAI({
        senderEmail,
        headerName,
        subject,
        textBody,
        tenant,
        existingLead,
        customRules: sysSettings.email_agent_custom_rules || ""
      });

      return jsonResponse({
        status: "success",
        tenant,
        existingLead,
        analysis
      });
    }

    if (path.includes("/emails")) {
      const resendKey = process.env.RESEND_API_KEY || "";
      if (!resendKey) {
        return jsonResponse({ status: "skipped", received: [], sent: [], error: "RESEND_API_KEY not configured" });
      }

      const resendHeaders = {
        "Authorization": `Bearer ${resendKey}`,
        "Content-Type": "application/json"
      };

      const parts = path.split("/").filter(Boolean);
      const emailsIdx = parts.indexOf("emails");
      const emailId = emailsIdx >= 0 && parts.length > emailsIdx + 1 ? parts[emailsIdx + 1] : null;

      // GET /api/admin/emails/:id?direction=received|sent
      if (emailId && req.method === "GET") {
        const direction = url.searchParams.get("direction") || "received";
        const endpoint =
          direction === "received"
            ? `https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`
            : `https://api.resend.com/emails/${encodeURIComponent(emailId)}`;

        let detailRes = await fetch(endpoint, { headers: resendHeaders });
        if (!detailRes.ok && direction === "received") {
          detailRes = await fetch(`https://api.resend.com/emails/${encodeURIComponent(emailId)}`, { headers: resendHeaders });
        }
        const detail = detailRes.ok ? await detailRes.json() : { error: "Could not load email detail" };
        return jsonResponse({ status: "success", direction, email: detail });
      }

      // GET /api/admin/emails (List both Inbound Receiving & Sent Outbound)
      if (req.method === "GET") {
        const [recRes, sentRes] = await Promise.all([
          fetch("https://api.resend.com/emails/receiving", { headers: resendHeaders }).catch(() => null),
          fetch("https://api.resend.com/emails", { headers: resendHeaders }).catch(() => null)
        ]);

        const recJson = recRes && recRes.ok ? await recRes.json() : { data: [] };
        const sentJson = sentRes && sentRes.ok ? await sentRes.json() : { data: [] };

        return jsonResponse({
          status: "success",
          received: recJson.data || [],
          sent: sentJson.data || []
        });
      }
    }

    // =========================================================================
    // 8. TWILIO SMS DISPATCHER (/api/admin/sms/send)
    // =========================================================================
    if (path.includes("/sms/send") && req.method === "POST") {
      const body = await req.json();
      const to = (body.to || body.phone || "").trim();
      const msg = (body.body || body.message || "").trim();

      if (!to || !msg) {
        return jsonResponse({ error: "Destination phone number and SMS body are required" }, 400);
      }

      const smsResult = await sendTwilioSms({ to, body: msg });

      if (body.lead_id && supabaseUrl && supabaseKey) {
        try {
          const getRes = await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(body.lead_id)}&limit=1`, { headers });
          if (getRes.ok) {
            const arr = await getRes.json();
            if (arr[0]) {
              const stamp = new Date().toISOString().split("T")[0];
              const newNote = `${arr[0].notes ? arr[0].notes + "\n" : ""}[${stamp} Outbound SMS -> ${to}]: "${msg}"`;
              await fetch(`${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(body.lead_id)}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ notes: newNote, updated_at: new Date().toISOString() })
              });
            }
          }
        } catch (e) {
          console.error("Failed logging SMS note to lead:", e);
        }
      }

      return jsonResponse({
        status: smsResult.sent ? "success" : smsResult.status,
        sms: smsResult
      });
    }

    // =========================================================================
    // 9. SEO, GBP & PHOTO QUEUE ACTIONS (/api/admin/projects, /api/admin/gbp, /api/admin/reviews)
    // =========================================================================
    if (path.includes("/projects/") && path.endsWith("/action") && req.method === "POST") {
      const parts = path.split("/").filter(Boolean);
      const projId = parts[parts.indexOf("projects") + 1];
      const body = await req.json();
      const action = (body.action || "approve").toLowerCase();
      const updates = {
        approval_status: action === "approve" ? "approved" : action === "reject" ? "rejected" : action
      };
      if (supabaseUrl && supabaseKey) {
        await fetch(`${supabaseUrl}/rest/v1/job_projects?id=eq.${encodeURIComponent(projId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(updates)
        });
      }
      return jsonResponse({ status: "success", project: { id: projId, ...updates } });
    }

    if (path.includes("/gbp/") && path.endsWith("/action") && req.method === "POST") {
      const parts = path.split("/").filter(Boolean);
      const postId = parts[parts.indexOf("gbp") + 1];
      const body = await req.json();
      const action = (body.action || "publish").toLowerCase();
      const updates = {
        status: action === "publish" ? "published" : action === "approve" ? "approved" : "rejected"
      };
      if (supabaseUrl && supabaseKey) {
        await fetch(`${supabaseUrl}/rest/v1/gbp_posts?id=eq.${encodeURIComponent(postId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(updates)
        });
      }
      return jsonResponse({ status: "success", post: { id: postId, ...updates } });
    }

    if (path.includes("/reviews/") && path.endsWith("/action") && req.method === "POST") {
      const parts = path.split("/").filter(Boolean);
      const revId = parts[parts.indexOf("reviews") + 1];
      const body = await req.json();
      const updates = { reply_status: "published" };
      if (body.ai_reply_draft !== undefined) updates.ai_reply_draft = body.ai_reply_draft;
      if (supabaseUrl && supabaseKey) {
        await fetch(`${supabaseUrl}/rest/v1/reviews?id=eq.${encodeURIComponent(revId)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify(updates)
        });
      }
      return jsonResponse({ status: "success", review: { id: revId, ...updates } });
    }

    if (path.endsWith("/reviews/request") && req.method === "POST") {
      const body = await req.json();
      const leadId = (body.lead_id || "").trim();
      const firstName = (body.first_name || "Homeowner").trim();
      const phone = (body.phone || "").trim();
      const email = (body.email || "").trim();
      const feedbackUrl = `https://oceancountyroofingpros.com/feedback/${encodeURIComponent(leadId || "verified")}`;

      let smsRes = { status: "skipped" };
      if (phone) {
        const smsText = `Hi ${firstName}, thanks for choosing Ocean County Roofing Pros! How did our team do? Takes 20 seconds: ${feedbackUrl} (Reply STOP to opt out)`;
        smsRes = await sendTwilioSms(phone, smsText);
      }

      let emailRes = { status: "skipped" };
      if (email && email.includes("@")) {
        emailRes = await EmailService.sendEmail({
          from: EmailService.getFromAddress("riley@oceancountyroofingpros.com"),
          to: [email],
          reply_to: EmailService.getReplyToAddress("riley@oceancountyroofingpros.com"),
          subject: `Quick 20-second feedback on your Ocean County roof service`,
          html: `<p>Hi ${firstName},</p><p>Thank you for trusting <strong>Ocean County Roofing Pros</strong> with your home! Your feedback helps local Ocean County homeowners find reliable roofing care.</p><p><a href="${feedbackUrl}" style="display:inline-block;background:#0A486D;color:#ffffff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold;">Share Your 20-Second Feedback →</a></p><p>Warm regards,<br>Riley Davis • Ocean County Roofing Pros</p>`
        });
      }

      return jsonResponse({
        status: "success",
        feedback_url: feedbackUrl,
        sms: smsRes,
        email: emailRes
      });
    }

    // =========================================================================
    // 10. LIVE API HEALTH DIAGNOSTICS (/api/admin/diagnostics)
    // =========================================================================
    if (path.includes("/diagnostics") && req.method === "GET") {
      const checks = {
        supabase: { configured: Boolean(supabaseUrl && supabaseKey), status: "offline" },
        vapi: { configured: Boolean(process.env.VAPI_API_KEY), status: "offline" },
        resend: { configured: Boolean(process.env.RESEND_API_KEY), status: "offline" },
        twilio: { configured: Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN), status: "offline" }
      };

      await Promise.all([
        (async () => {
          if (!checks.supabase.configured) return;
          const r = await fetch(`${supabaseUrl}/rest/v1/tenants?select=tenant_id&limit=1`, { headers }).catch(() => null);
          checks.supabase.status = r && r.ok ? "online" : "error";
        })(),
        (async () => {
          if (!checks.vapi.configured) return;
          const r = await fetch(`https://api.vapi.ai/assistant/${RILEY_ASSISTANT_ID}`, {
            headers: { "Authorization": `Bearer ${process.env.VAPI_API_KEY}` }
          }).catch(() => null);
          checks.vapi.status = r && r.ok ? "online" : "error";
        })(),
        (async () => {
          if (!checks.resend.configured) return;
          const r = await fetch("https://api.resend.com/domains", {
            headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}` }
          }).catch(() => null);
          checks.resend.status = r && r.ok ? "online" : "error";
        })(),
        (async () => {
          if (!checks.twilio.configured) return;
          const sid = process.env.TWILIO_ACCOUNT_SID;
          const tok = process.env.TWILIO_AUTH_TOKEN;
          const auth = Buffer.from(`${sid}:${tok}`).toString("base64");
          const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}.json`, {
            headers: { "Authorization": `Basic ${auth}` }
          }).catch(() => null);
          checks.twilio.status = r && r.ok ? "online" : "error";
        })()
      ]);

      return jsonResponse({
        status: "success",
        timestamp: new Date().toISOString(),
        checks
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message }, 500);
  }
};
