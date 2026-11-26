import test from "node:test";
import assert from "node:assert/strict";
import { ChiefOfStaffService } from "../netlify/functions/services/chief-of-staff-service.mjs";
import inboundHandler from "../netlify/functions/api-email-inbound.mjs";
import vapiToolsHandler from "../netlify/functions/api-vapi-tools.mjs";
import cronBriefing from "../netlify/functions/cron-chief-briefing.mjs";
import cronWrapup from "../netlify/functions/cron-chief-wrapup.mjs";

function makeReq(url, body, method = "POST", headers = {}) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: method === "GET" ? undefined : JSON.stringify(body)
  });
}

test("ChiefOfStaffService.callGeminiBrain falls back from generativelanguage to aiplatform and parses JSON", async () => {
  const originalFetch = global.fetch;
  const hitUrls = [];

  global.fetch = async (url) => {
    const sUrl = String(url);
    hitUrls.push(sUrl);
    if (sUrl.includes("generativelanguage.googleapis.com")) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: { message: "API key not supported on AI Studio endpoint" } })
      };
    }
    if (sUrl.includes("aiplatform.googleapis.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: '```json\n{"subject":"Re: Today","reply_text":"Morning Anthony — approved SEO test and checked Riley.","actions":[{"type":"approve_seo_experiment","experiment_id":"EXP-1"}]}\n```'
                  }
                ]
              }
            }
          ]
        })
      };
    }
    throw new Error(`Unexpected URL: ${sUrl}`);
  };

  try {
    const res = await ChiefOfStaffService.callGeminiBrain({
      systemInstruction: "You are Elena.",
      userPrompt: "Approve EXP-1",
      apiKey: "mock_test_gemini_key"
    });
    assert.equal(res.ok, true);
    assert.equal(res.subject, "Re: Today");
    assert.match(res.reply_text, /Morning Anthony/);
    assert.equal(res.actions.length, 1);
    assert.equal(res.actions[0].experiment_id, "EXP-1");
    assert.equal(hitUrls.length, 2);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Inbound email from owner to elena@ routes to ChiefOfStaffService, executes actions, and replies in-thread", async () => {
  const originalFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.RESEND_API_KEY = "re_mock";
  process.env.OWNER_ALERT_EMAIL = "anthony.fuller.ink@gmail.com";
  process.env.GEMINI_API_KEY = "mock_test_key";

  const supabaseWrites = [];
  const sentEmails = [];

  global.fetch = async (url, opts = {}) => {
    const sUrl = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (sUrl.includes("generativelanguage.googleapis.com")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      subject: "Re: SEO & Lead Check",
                      reply_text: "Done! I activated SEO experiment EXP-101, turned on the storm banner, and updated Lead L-1.",
                      actions: [
                        { type: "approve_seo_experiment", experiment_id: "EXP-101" },
                        { type: "update_lead_status", lead_id: "L-1", status: "Contacted" },
                        { type: "update_system_setting", key: "storm_alert_active", value: "true" }
                      ]
                    })
                  }
                ]
              }
            }
          ]
        })
      };
    }

    if (sUrl === "https://api.resend.com/emails") {
      sentEmails.push(body);
      return { ok: true, status: 200, json: async () => ({ id: "em_elena_reply_1" }) };
    }

    if (sUrl.startsWith("https://mock.supabase.co/rest/v1/")) {
      if (method === "GET") {
        if (sUrl.includes("system_settings")) {
          return { ok: true, status: 200, json: async () => [{ key: "chief_buffer_mode", value: "true" }] };
        }
        return { ok: true, status: 200, json: async () => [] };
      }
      supabaseWrites.push({ url: sUrl, method, body });
      return { ok: true, status: 200, json: async () => [] };
    }

    throw new Error(`Unexpected fetch: ${method} ${sUrl}`);
  };

  try {
    const res = await inboundHandler(
      makeReq("https://oceancountyroofingpros.com/api/email/inbound", {
        type: "email.received",
        from: "Anthony Fuller <anthony.fuller.ink@gmail.com>",
        to: ["elena@oceancountyroofingpros.com"],
        subject: "SEO & Lead Check",
        text: "Please approve EXP-101, mark L-1 contacted, and turn on the storm alert.\n\nOn Thu, Nov 26 wrote:\n> old text",
        message_id: "<msg-123@gmail.com>"
      })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "handled_by_chief");
    assert.equal(data.chiefResult.used_gemini, true);
    assert.equal(data.chiefResult.actions_taken.length, 3);
    assert.ok(data.chiefResult.actions_taken.every(a => a.status === "executed"));

    assert.equal(sentEmails.length, 1);
    assert.match(sentEmails[0].from, /elena@oceancountyroofingpros\.com/);
    assert.equal(sentEmails[0].to[0], "anthony.fuller.ink@gmail.com");
    assert.equal(sentEmails[0].headers["In-Reply-To"], "<msg-123@gmail.com>");

    assert.ok(supabaseWrites.some(w => w.url.includes("seo_experiments?id=eq.EXP-101") && w.body.status === "active"));
    assert.ok(supabaseWrites.some(w => w.url.includes("leads?id=eq.L-1") && w.body.status === "Contacted"));
    assert.ok(supabaseWrites.some(w => w.url.includes("system_settings") && w.body.key === "storm_alert_active"));
    assert.equal(supabaseWrites.filter(w => w.url.includes("executive_messages")).length, 2);
  } finally {
    global.fetch = originalFetch;
    process.env = origEnv;
  }
});

test("cron-chief-briefing sends morning email, saves daily_reports, digests buffer; cron-chief-wrapup skips on quiet afternoon", async () => {
  const originalFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.RESEND_API_KEY = "re_mock";
  process.env.OWNER_ALERT_EMAIL = "anthony.fuller.ink@gmail.com";
  delete process.env.GEMINI_API_KEY;

  let bufferedItems = [
    { id: "BUF-1", source: "riley", severity: "important", title: "Callback requested", summary: "Toms River", digested_at: null }
  ];
  const writes = [];
  const emails = [];

  global.fetch = async (url, opts = {}) => {
    const sUrl = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (sUrl === "https://api.resend.com/emails") {
      emails.push(body);
      return { ok: true, status: 200, json: async () => ({ id: "em_brief_1" }) };
    }
    if (sUrl.includes("executive_buffer") && method === "GET") {
      return { ok: true, status: 200, json: async () => bufferedItems };
    }
    if (sUrl.includes("executive_buffer") && method === "PATCH") {
      bufferedItems = [];
      writes.push({ url: sUrl, method, body });
      return { ok: true, status: 200, json: async () => [] };
    }
    if (method === "GET") {
      return { ok: true, status: 200, json: async () => [] };
    }
    writes.push({ url: sUrl, method, body });
    return { ok: true, status: 200, json: async () => [] };
  };

  try {
    const morningRes = await cronBriefing(new Request("https://oceancountyroofingpros.com/.netlify/functions/cron-chief-briefing", { method: "POST" }));
    assert.equal(morningRes.status, 200);
    const morningData = await morningRes.json();
    assert.equal(morningData.status, "sent");
    assert.equal(morningData.buffer_digested, 1);
    assert.equal(emails.length, 1);
    assert.match(emails[0].text, /Morning Executive Briefing/);
    assert.ok(writes.some(w => w.url.includes("daily_reports")));
    assert.ok(writes.some(w => w.url.includes("executive_buffer") && w.method === "PATCH"));

    // Now wrap-up runs with 0 undigested buffer items and 0 24h leads -> skips quietly
    const wrapRes = await cronWrapup(new Request("https://oceancountyroofingpros.com/.netlify/functions/cron-chief-wrapup", { method: "POST" }));
    assert.equal(wrapRes.status, 200);
    const wrapData = await wrapRes.json();
    assert.equal(wrapData.status, "skipped");
    assert.equal(wrapData.reason, "no_afternoon_activity");
    assert.equal(emails.length, 1);
  } finally {
    global.fetch = originalFetch;
    process.env = origEnv;
  }
});

test("Riley request_human_callback buffers into executive_buffer instead of raw owner email when chief_buffer_mode=true", async () => {
  const originalFetch = global.fetch;
  const origEnv = { ...process.env };
  process.env.SUPABASE_URL = "https://mock.supabase.co";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.RESEND_API_KEY = "re_mock";
  process.env.OWNER_ALERT_EMAIL = "anthony.fuller.ink@gmail.com";
  delete process.env.VAPI_SERVER_SECRET;
  delete process.env.TWILIO_ACCOUNT_SID;

  const bufferPosts = [];
  const emails = [];

  global.fetch = async (url, opts = {}) => {
    const sUrl = String(url);
    const method = (opts.method || "GET").toUpperCase();
    const body = opts.body ? JSON.parse(opts.body) : null;

    if (sUrl === "https://api.resend.com/emails") {
      emails.push(body);
      return { ok: true, status: 200, json: async () => ({ id: "em_1" }) };
    }
    if (sUrl.includes("tenants?")) {
      return { ok: true, status: 200, json: async () => [{ tenant_id: "client_joe_the_roofer", company_name: "Joe The Roofer LLC", is_active: true }] };
    }
    if (sUrl.includes("system_settings?")) {
      return { ok: true, status: 200, json: async () => [{ key: "chief_buffer_mode", value: "true" }] };
    }
    if (sUrl.includes("executive_buffer") && method === "POST") {
      bufferPosts.push(body);
      return { ok: true, status: 200, json: async () => [] };
    }
    return { ok: true, status: 200, json: async () => [] };
  };

  try {
    const res = await vapiToolsHandler(
      makeReq("https://oceancountyroofingpros.com/api/vapi/tools", {
        message: {
          toolCalls: [
            {
              id: "tc_buf_1",
              function: {
                name: "request_human_callback",
                arguments: {
                  name: "Diane Miller",
                  phone: "732-555-8811",
                  address: "10 Bayview Ave, Toms River, NJ",
                  reason: "Has a question about metal roof financing"
                }
              }
            }
          ]
        }
      })
    );
    assert.equal(res.status, 200);
    assert.equal(bufferPosts.length, 1);
    assert.equal(bufferPosts[0].source, "riley");
    assert.equal(bufferPosts[0].severity, "important");
    assert.equal(emails.length, 0);
  } finally {
    global.fetch = originalFetch;
    process.env = origEnv;
  }
});
