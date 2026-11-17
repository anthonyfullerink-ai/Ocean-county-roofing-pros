import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

import adminHandler from "../netlify/functions/api-admin.mjs";
import vapiToolsHandler from "../netlify/functions/api-vapi-tools.mjs";
import metaWebhookHandler from "../netlify/functions/api-meta-webhook.mjs";
import flywheelHandler from "../netlify/functions/cron-seo-flywheel.mjs";
import webformHandler from "../netlify/functions/api-webform.mjs";
import calendarHandler from "../netlify/functions/api-calendar.mjs";

const ADMIN_PASS = "ocroofing2026";
function adminHeaders(extra = {}) {
  return {
    "Content-Type": "application/json",
    "x-admin-password": ADMIN_PASS,
    ...extra
  };
}

function makeEnvGuard(overrides) {
  const prev = {};
  for (const [k, v] of Object.entries(overrides)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

test("api-admin.mjs: /reviews/request passes {to, body} to Twilio, /leads/:id gates review_request_sent, /sms/send logs FAILED tag, social failures not masked", async () => {
  const restoreEnv = makeEnvGuard({
    SUPABASE_URL: "https://sb.test",
    SUPABASE_KEY: "sb-key",
    ADMIN_PASSWORD: ADMIN_PASS,
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "tok123",
    TWILIO_PHONE_NUMBER: "+17326609121",
    META_ACCESS_TOKEN: "",
    META_PAGE_ID: ""
  });
  const origFetch = globalThis.fetch;
  const twilioBodies = [];
  const patchedLeads = [];
  const patchedSocialInteractions = [];
  const postedSocialQueue = [];

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("api.twilio.com")) {
      const params = new URLSearchParams(String(opts.body || ""));
      twilioBodies.push({ to: params.get("To"), body: params.get("Body") });
      if (params.get("To") === "+17325550000") {
        return new Response(JSON.stringify({ message: "Invalid To" }), { status: 400 });
      }
      return new Response(JSON.stringify({ sid: "SM123" }), { status: 200 });
    }
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([{ key: "enable_review_sms", value: "true" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/leads") && method === "GET") {
      return new Response(JSON.stringify([{ id: "L1", phone: "+17325550000", first_name: "Bob", notes: "Initial" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/leads") && method === "PATCH") {
      patchedLeads.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "GET") {
      return new Response(JSON.stringify([{ id: "SI-1", platform: "facebook", interaction_type: "comment", external_id: "c1", ai_reply_draft: "Thanks!", reply_status: "pending_approval" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "PATCH") {
      patchedSocialInteractions.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/social_queue") && method === "POST") {
      postedSocialQueue.push(JSON.parse(opts.body));
      return new Response("", { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };

  try {
    // 1. /reviews/request
    const revReq = await adminHandler(new Request("https://site.test/api/admin/reviews/request", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ lead_id: "L1", first_name: "Bob", phone: "+17325551111" })
    }));
    const revJson = await revReq.json();
    assert.equal(revJson.sms.sent, true);
    assert.equal(twilioBodies[0].to, "+17325551111");
    assert.ok(twilioBodies[0].body.includes("Bob"));

    // 2. PATCH /leads/L1 Completed with failing Twilio (+17325550000) -> review_request_sent NOT set
    const leadPatchRes = await adminHandler(new Request("https://site.test/api/admin/leads/L1", {
      method: "PATCH",
      headers: adminHeaders(),
      body: JSON.stringify({ status: "Completed" })
    }));
    const leadPatchJson = await leadPatchRes.json();
    assert.equal(leadPatchJson.review_sms_result.sent, false);
    assert.equal(patchedLeads[0].review_request_sent, undefined);

    // 3. POST /sms/send with failing Twilio -> note prefixed [Outbound SMS FAILED]
    const smsFailRes = await adminHandler(new Request("https://site.test/api/admin/sms/send", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ to: "+17325550000", body: "Hello", lead_id: "L1" })
    }));
    const smsFailJson = await smsFailRes.json();
    assert.equal(smsFailJson.sms.sent, false);
    assert.ok(patchedLeads[1].notes.includes("Outbound SMS FAILED"));

    // 4. social interaction approve_and_publish when Meta skipped -> reply_status = "failed"
    const socIntRes = await adminHandler(new Request("https://site.test/api/admin/social/interaction/SI-1/action", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ action: "approve_and_publish" })
    }));
    const socIntJson = await socIntRes.json();
    assert.equal(socIntJson.reply_status, "failed");
    assert.equal(patchedSocialInteractions[0].reply_status, "failed");

    // 5. POST /api/admin/social with publish_now=true when Meta skipped -> status = "failed" (not "scheduled")
    const socPostRes = await adminHandler(new Request("https://site.test/api/admin/social", {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ caption: "Test post", publish_now: true })
    }));
    const socPostJson = await socPostRes.json();
    assert.equal(socPostJson.post.status, "failed");
    assert.equal(postedSocialQueue[0].status, "failed");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv();
  }
});

test("api-vapi-tools.mjs: external_link sends Twilio SMS, and Meta failures are marked failed", async () => {
  const restoreEnv = makeEnvGuard({
    SUPABASE_URL: "https://sb.test",
    SUPABASE_KEY: "sb-key",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "tok123",
    TWILIO_PHONE_NUMBER: "+18669001221",
    META_ACCESS_TOKEN: "",
    META_PAGE_ID: ""
  });
  const origFetch = globalThis.fetch;
  const twilioCalls = [];
  const postedQueue = [];
  const patchedInteractions = [];

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("api.twilio.com")) {
      const params = new URLSearchParams(String(opts.body || ""));
      twilioCalls.push({ to: params.get("To"), body: params.get("Body") });
      return new Response(JSON.stringify({ sid: "SM_EXT" }), { status: 200 });
    }
    if (u.includes("/rest/v1/tenants")) {
      return new Response(JSON.stringify([{
        tenant_id: "t_ext",
        company_name: "External Roofers",
        scheduling_type: "external_link",
        booking_url: "https://cal.com/ext-roofers",
        is_active_default: true
      }]), { status: 200 });
    }
    if (u.includes("/rest/v1/system_settings")) return new Response("[]", { status: 200 });
    if (u.includes("/rest/v1/social_queue") && method === "POST") {
      postedQueue.push(JSON.parse(opts.body));
      return new Response("", { status: 201 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "GET") {
      return new Response(JSON.stringify([{ id: "SI-V1", platform: "facebook", interaction_type: "comment", external_id: "c99", ai_reply_draft: "Hi!", reply_status: "pending_approval" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "PATCH") {
      patchedInteractions.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    return new Response("[]", { status: 200 });
  };

  try {
    const res = await vapiToolsHandler(new Request("https://site.test/api/vapi/tools", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          type: "tool-calls",
          toolCalls: [
            {
              id: "tc1",
              function: {
                name: "book_inspection",
                arguments: { name: "Jane Doe", phone: "(732) 555-9876", address: "10 Main St, Toms River", date: "2026-11-20", time: "10:00 AM" }
              }
            },
            {
              id: "tc2",
              function: {
                name: "create_social_post",
                arguments: { caption: "Storm check", publish_now: true }
              }
            },
            {
              id: "tc3",
              function: {
                name: "approve_social_reply",
                arguments: { interaction_id: "SI-V1", action: "approve_and_publish" }
              }
            }
          ]
        }
      })
    }));
    const data = await res.json();
    assert.equal(twilioCalls.length, 1);
    assert.equal(twilioCalls[0].to, "+17325559876");
    assert.ok(twilioCalls[0].body.includes("https://cal.com/ext-roofers"));
    assert.ok(data.results[0].result.includes("I have sent an SMS"));
    assert.equal(postedQueue[0].status, "failed");
    assert.ok(data.results[1].result.includes("failed"));
    assert.equal(patchedInteractions[0].reply_status, "failed");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv();
  }
});

test("api-meta-webhook.mjs: EmailService.sendEmail includes from and html (not htmlBody)", async () => {
  const restoreEnv = makeEnvGuard({
    RESEND_API_KEY: "re_test_123",
    META_APP_SECRET: "",
    SUPABASE_URL: "",
    SUPABASE_KEY: ""
  });
  const origFetch = globalThis.fetch;
  const resendPayloads = [];
  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("api.resend.com")) {
      resendPayloads.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "em_1" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const res = await metaWebhookHandler(new Request("https://site.test/api/meta/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        object: "page",
        entry: [{
          changes: [{
            field: "ratings",
            value: { rating: 1, review_text: "Terrible leak", reviewer: { name: "Angry Owner", id: "u1" } }
          }]
        }]
      })
    }));
    assert.equal(res.status, 200);
    assert.equal(resendPayloads.length, 1);
    assert.ok(resendPayloads[0].from);
    assert.ok(resendPayloads[0].html);
    assert.equal(resendPayloads[0].htmlBody, undefined);
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv();
  }
});

test("cron-seo-flywheel.mjs: uses job_projects schema columns and records failed Meta dispatches", async () => {
  const restoreEnv = makeEnvGuard({
    SUPABASE_URL: "https://sb.test",
    SUPABASE_KEY: "sb-key",
    META_ACCESS_TOKEN: "",
    META_PAGE_ID: ""
  });
  const origFetch = globalThis.fetch;
  const urlsSeen = [];
  const patchedProjects = [];
  const patchedQueue = [];
  const patchedInteractions = [];
  const metaPayloads = [];

  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    urlsSeen.push(`${method} ${u}`);
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([{ key: "auto_publish_24h", value: "true" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/job_projects") && method === "GET") {
      return new Response(JSON.stringify([{
        id: "JP1",
        approval_status: "pending_auto_24h",
        town_name: "Brick, NJ",
        ai_seo_summary: "New Timberline HDZ roof in Brick",
        image_geotagged_jpg_url: "https://cdn.test/brick.jpg"
      }]), { status: 200 });
    }
    if (u.includes("/rest/v1/job_projects") && method === "PATCH") {
      patchedProjects.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/social_queue") && method === "GET") {
      return new Response(JSON.stringify([{ id: "SQ1", caption: "Due post", status: "scheduled" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/social_queue") && method === "PATCH") {
      patchedQueue.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "GET") {
      return new Response(JSON.stringify([{ id: "SI1", external_id: "c1", ai_reply_draft: "Thank you!", reply_status: "auto_24h", rating: 5 }]), { status: 200 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "PATCH") {
      patchedInteractions.push(JSON.parse(opts.body));
      return new Response(null, { status: 204 });
    }
    if (u.includes("graph.facebook.com")) {
      metaPayloads.push(u);
      return new Response(JSON.stringify({ error: { message: "bad" } }), { status: 400 });
    }
    return new Response("[]", { status: 200 });
  };

  try {
    const res = await flywheelHandler(new Request("https://site.test/api/cron/seo-flywheel"));
    assert.equal(res.status, 200);
    assert.ok(urlsSeen.some(x => x.includes("job_projects?approval_status=eq.pending_auto_24h")));
    assert.equal(patchedProjects[0].approval_status, "approved");
    assert.equal(patchedQueue[0].status, "failed");
    assert.equal(patchedInteractions[0].reply_status, "failed");
  } finally {
    globalThis.fetch = origFetch;
    restoreEnv();
  }
});

test("api-webform.mjs & api-calendar.mjs: normalize To phone to E.164 and log !res.ok on Twilio", async () => {
  const restoreEnv = makeEnvGuard({
    SUPABASE_URL: "",
    SUPABASE_KEY: "",
    TWILIO_ACCOUNT_SID: "AC123",
    TWILIO_AUTH_TOKEN: "tok123",
    TWILIO_PHONE_NUMBER: "+17326609121",
    RESEND_API_KEY: ""
  });
  const origFetch = globalThis.fetch;
  const origErr = console.error;
  const twilioTos = [];
  const loggedErrors = [];
  console.error = (...args) => loggedErrors.push(args.join(" "));

  globalThis.fetch = async (url, opts = {}) => {
    if (String(url).includes("api.twilio.com")) {
      const p = new URLSearchParams(String(opts.body || ""));
      twilioTos.push(p.get("To"));
      return new Response("Twilio Bad", { status: 400 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const wfRes = await webformHandler(new Request("https://site.test/api/leads/webform", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", phone: "(732) 555-1234", first_name: "Sam", city: "Brick" })
    }));
    assert.equal(wfRes.status, 200);

    const calRes = await calendarHandler(new Request("https://site.test/api/calendar/book", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.com", phone: "732-555-4321", name: "Sam", date: "2026-11-25", time: "10:00 AM", city: "Brick" })
    }));
    assert.equal(calRes.status, 200);

    assert.deepEqual(twilioTos, ["+17325551234", "+17325554321"]);
    assert.ok(loggedErrors.some(e => e.includes("[api-webform] Twilio SMS failed (400)")));
    assert.ok(loggedErrors.some(e => e.includes("[api-calendar] Twilio booking SMS failed (400)")));
  } finally {
    console.error = origErr;
    globalThis.fetch = origFetch;
    restoreEnv();
  }
});

test("admin_control_plane.js: SMS/review functions show error toast when data.sms.sent is false", async () => {
  const code = fs.readFileSync(new URL("../app/static/js/admin_control_plane.js", import.meta.url), "utf-8");
  const toasts = [];
  const sandbox = {
    STATE: { leads: [{ id: "L1", first_name: "Bob", phone: "+17325551234", email: "" }] },
    showToast: (msg, isErr = false) => toasts.push({ msg, isErr }),
    hydrateAdminBootstrap: () => {},
    document: {
      addEventListener: () => {},
      getElementById: (id) => {
        if (id === "inspQuickSms") return { value: "Hello" };
        if (id === "sms_to_phone") return { value: "+17325551234" };
        if (id === "sms_body_text") return { value: "Hello" };
        return null;
      }
    },
    window: { addEventListener: () => {}, location: { search: "", pathname: "/admin" } },
    localStorage: { getItem: () => null, setItem: () => {} },
    console,
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ status: "error", sms: { sent: false, status: "error", error: "Unverified number" } })
    })
  };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  vm.runInContext(`STATE.leads = [{ id: "L1", first_name: "Bob", phone: "+17325551234", email: "" }]; showToast = __captureToast;`, Object.assign(sandbox, { __captureToast: (msg, isErr = false) => toasts.push({ msg, isErr }) }));

  await sandbox.sendQuickLeadSms("L1", "+17325551234");
  await sandbox.sendManualSms({ preventDefault: () => {}, target: { reset: () => {} } });
  await sandbox.sendReviewRequestForLead("L1");

  const errorToasts = toasts.filter(t => t.isErr === true);
  assert.equal(errorToasts.length, 3);
  assert.ok(errorToasts[0].msg.includes("Unverified number"));
  assert.ok(errorToasts[1].msg.includes("Unverified number"));
  assert.ok(errorToasts[2].msg.includes("Unverified number"));
});
