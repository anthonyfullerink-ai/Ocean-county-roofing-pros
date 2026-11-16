import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import metaWebhookHandler, { verifyMetaWebhookSignature } from "../netlify/functions/api-meta-webhook.mjs";
import vapiToolsHandler from "../netlify/functions/api-vapi-tools.mjs";
import { MetaSocialService } from "../netlify/functions/services/meta-social-service.mjs";

test("MetaSocialService UTM helper and message classifier enforce negative-review guardrails", () => {
  const tracked = MetaSocialService.appendSocialUtm("https://oceancountyroofingpros.com/#quizSection", {
    source: "facebook",
    campaign: "silverton_job"
  });
  assert.ok(tracked.includes("utm_source=facebook"));
  assert.ok(tracked.includes("utm_medium=social"));
  assert.ok(tracked.includes("utm_campaign=silverton_job"));

  const neg = MetaSocialService.classifySocialMessage({
    text: "Never got a call back",
    interactionType: "review",
    rating: 2,
    authorName: "Bob"
  });
  assert.equal(neg.intent, "NEGATIVE_REVIEW");
  assert.equal(neg.reply_status, "pending_approval");
  assert.equal(neg.requires_owner_alert, true);

  const pos = MetaSocialService.classifySocialMessage({
    text: "Great job on our roof!",
    interactionType: "review",
    rating: 5,
    authorName: "Alice"
  });
  assert.equal(pos.intent, "POSITIVE_REVIEW");
  assert.equal(pos.reply_status, "auto_24h");

  const spam = MetaSocialService.classifySocialMessage({
    text: "Check my telegram for free crypto forex signals",
    interactionType: "comment"
  });
  assert.equal(spam.intent, "SPAM_OR_TROLL");
  assert.equal(spam.reply_status, "ignored");
});

test("api-meta-webhook.mjs handles GET verification, HMAC signature, DM lead->Vapi callback, and holds negative reviews", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.META_WEBHOOK_VERIFY_TOKEN = "test_verify_tok";
  process.env.META_APP_SECRET = "test_app_secret";
  process.env.META_PAGE_ID = "1466735946524886";
  process.env.META_ACCESS_TOKEN = "mock_page_tok";
  process.env.VAPI_API_KEY = "mock_vapi_key";
  process.env.VAPI_PHONE_NUMBER_ID = "mock_phone_id";

  // 1. GET verification
  const getOk = await metaWebhookHandler(
    new Request("https://oceancountyroofingpros.com/api/meta/webhook?hub.mode=subscribe&hub.verify_token=test_verify_tok&hub.challenge=987654", {
      method: "GET"
    })
  );
  assert.equal(getOk.status, 200);
  assert.equal(await getOk.text(), "987654");

  const getBad = await metaWebhookHandler(
    new Request("https://oceancountyroofingpros.com/api/meta/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=123", {
      method: "GET"
    })
  );
  assert.equal(getBad.status, 403);

  // 2. Signature helper
  const payload = JSON.stringify({
    object: "page",
    entry: [
      {
        messaging: [
          {
            sender: { id: "user_dm_1" },
            message: { mid: "mid.1", text: "Hi how much for a roof quote? My number is 732-555-8811" }
          }
        ],
        changes: [
          {
            field: "ratings",
            value: {
              rating: 1,
              recommendation_type: "negative",
              review_text: "Unhappy with delay",
              reviewer: { id: "rev_1", name: "Grumpy Homeowner" },
              open_graph_story_id: "og_1"
            }
          }
        ]
      }
    ]
  });
  const badSig = await metaWebhookHandler(
    new Request("https://oceancountyroofingpros.com/api/meta/webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-hub-signature-256": "sha256=deadbeef" },
      body: payload
    })
  );
  assert.equal(badSig.status, 401);

  const validSig = "sha256=" + crypto.createHmac("sha256", "test_app_secret").update(payload).digest("hex");
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const bodyObj = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ u, method: opts.method || "GET", body: bodyObj });
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([{ key: "social_auto_reply_enabled", value: "true" }]), { status: 200 });
    }
    if (u.includes("api.vapi.ai/call/phone")) {
      return new Response(JSON.stringify({ id: "vapi_call_dm_1" }), { status: 201 });
    }
    if (u.includes("graph.facebook.com")) {
      return new Response(JSON.stringify({ message_id: "fb_msg_1", id: "fb_rep_1" }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 201 });
  };

  try {
    const postRes = await metaWebhookHandler(
      new Request("https://oceancountyroofingpros.com/api/meta/webhook", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-hub-signature-256": validSig },
        body: payload
      })
    );
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.processed_count, 2);

    // DM created CRM lead and triggered Vapi callback
    assert.ok(calls.some(c => c.u.includes("/rest/v1/leads") && c.body?.phone === "+17325558811"));
    assert.ok(calls.some(c => c.u.includes("api.vapi.ai/call/phone")));

    // 1-star rating was NEVER auto-replied and held as pending_approval
    const negRow = postJson.processed.find(p => p.interaction_type === "review");
    assert.equal(negRow.reply_status, "pending_approval");
    assert.equal(verifyMetaWebhookSignature(payload, validSig, "test_app_secret"), true);
  } finally {
    global.fetch = originalFetch;
  }
});

test("api-vapi-tools.mjs supports Maya social tools (create_social_post, get_social_digest, approve_social_reply)", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.VAPI_SERVER_SECRET = "";

  const dbSocialQueue = [];
  const dbInteractions = [
    {
      id: "SOC-REV-99",
      platform: "facebook",
      interaction_type: "review",
      external_id: "og_99",
      author_name: "Tom",
      rating: 5,
      message_text: "Awesome roof!",
      intent: "POSITIVE_REVIEW",
      ai_reply_draft: "Thank you Tom!",
      reply_status: "pending_approval"
    }
  ];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/tenants")) {
      return new Response(JSON.stringify([{ tenant_id: "client_joe_the_roofer", company_name: "Joe The Roofer LLC", is_active: true }]), { status: 200 });
    }
    if (u.includes("/rest/v1/social_queue") && method === "POST") {
      dbSocialQueue.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (u.includes("/rest/v1/social_queue") && method === "GET") {
      return new Response(JSON.stringify(dbSocialQueue), { status: 200 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "GET") {
      return new Response(JSON.stringify(dbInteractions), { status: 200 });
    }
    if (u.includes("/rest/v1/social_interactions") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (u.includes("graph.facebook.com")) {
      return new Response(JSON.stringify({ id: "fb_comment_reply_99" }), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  try {
    const res = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: {
            toolCalls: [
              {
                id: "tc_1",
                function: {
                  name: "create_social_post",
                  arguments: { caption: "Silverton job wrapped!", town_name: "Toms River", publish_now: false }
                }
              },
              {
                id: "tc_2",
                function: {
                  name: "get_social_digest",
                  arguments: {}
                }
              },
              {
                id: "tc_3",
                function: {
                  name: "approve_social_reply",
                  arguments: { interaction_id: "SOC-REV-99", action: "approve_and_publish" }
                }
              }
            ]
          }
        })
      })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.results.length, 3);
    assert.ok(data.results[0].result.includes("Queued social post"));
    assert.ok(data.results[1].result.includes("SOC-REV-99"));
    assert.ok(data.results[2].result.includes("published"));
    assert.equal(dbSocialQueue.length, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
