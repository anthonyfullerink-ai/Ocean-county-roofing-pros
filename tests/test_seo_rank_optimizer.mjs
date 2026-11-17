import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import seoOptimizerHandler, {
  buildOptimizedMeta,
  evaluateExperimentOutcome
} from "../netlify/functions/cron-seo-optimizer.mjs";

test("buildOptimizedMeta and evaluateExperimentOutcome handle rewrites and 14d auto-rollback", () => {
  const meta = buildOptimizedMeta({
    pagePath: "/roofing-toms-river-nj",
    targetQuery: "roof replacement toms river nj"
  });
  assert.ok(meta.proposed_meta_title.includes("Roof Replacement Toms River NJ"));
  assert.ok(meta.proposed_meta_title.length <= 62);
  assert.ok(meta.proposed_meta_description.length <= 160);

  const regressed = evaluateExperimentOutcome(
    { baseline_position: 11.2, baseline_ctr: 0.03 },
    { position: 15.8, ctr: 0.015, impressions: 180 }
  );
  assert.equal(regressed.nextStatus, "reverted");

  const winner = evaluateExperimentOutcome(
    { baseline_position: 12.0, baseline_ctr: 0.015 },
    { position: 8.5, ctr: 0.032, impressions: 220 }
  );
  assert.equal(winner.nextStatus, "kept");
});

test("cron-seo-optimizer.mjs pulls GSC rows, stages pending_24h + blog draft, promotes expired, and reverts regressions", async () => {
  const originalFetch = global.fetch;
  const { privateKey } = crypto.generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" }
  });

  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "seo-bot@ocrp-test.iam.gserviceaccount.com",
    private_key: privateKey
  });

  const past24h = new Date(Date.now() - 26 * 3600 * 1000).toISOString();
  const past15d = new Date(Date.now() - 15 * 86400 * 1000).toISOString();
  const existingExperiments = [
    {
      id: "EXP-PROMOTE",
      page_path: "/roofing-brick-nj",
      target_query: "brick nj roofer",
      status: "pending_24h",
      auto_apply_at: past24h
    },
    {
      id: "EXP-REVERT",
      page_path: "/roofing-jackson-nj",
      target_query: "jackson nj roof repair",
      status: "active",
      activated_at: past15d,
      baseline_position: 10.0,
      baseline_ctr: 0.03
    }
  ];

  const postedExperiments = [];
  const postedBlogs = [];
  const patchedExperiments = [];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u === "https://oauth2.googleapis.com/token") {
      return new Response(JSON.stringify({ access_token: "mock_gsc_tok" }), { status: 200 });
    }
    if (u.includes("googleapis.com/webmasters/v3/sites")) {
      return new Response(
        JSON.stringify({
          rows: [
            {
              keys: ["https://oceancountyroofingpros.com/roofing-toms-river-nj", "roof replacement toms river nj"],
              clicks: 4,
              impressions: 320,
              ctr: 0.0125,
              position: 11.4
            },
            {
              keys: ["https://oceancountyroofingpros.com/roofing-jackson-nj", "jackson nj roof repair"],
              clicks: 1,
              impressions: 150,
              ctr: 0.0067,
              position: 15.2
            }
          ]
        }),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([{ key: "netlify_build_hook_url", value: "https://api.netlify.com/build_hooks/test" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/seo_experiments") && method === "GET") {
      return new Response(JSON.stringify(existingExperiments), { status: 200 });
    }
    if (u.includes("/rest/v1/seo_experiments") && method === "POST") {
      postedExperiments.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (u.includes("/rest/v1/seo_experiments") && method === "PATCH") {
      patchedExperiments.push({ u, body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/blog_posts") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/blog_posts") && method === "POST") {
      postedBlogs.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (u.includes("api.netlify.com/build_hooks")) {
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  try {
    const res = await seoOptimizerHandler();
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "success");
    assert.equal(data.gsc_status, "success");
    assert.equal(data.snapshots_saved, 2);
    assert.equal(data.promoted_to_active, 1);
    assert.equal(data.auto_reverted, 1);
    assert.equal(data.staged_experiments, 1);
    assert.equal(data.blog_drafts_staged, 1);
    assert.equal(data.rebuild_triggered, true);

    assert.equal(postedExperiments[0].page_path, "/roofing-toms-river-nj");
    assert.equal(postedExperiments[0].status, "pending_24h");
    assert.equal(postedBlogs[0].status, "draft_auto_24h");
    assert.ok(patchedExperiments.some(p => p.u.includes("EXP-PROMOTE") && p.body.status === "active"));
    assert.ok(patchedExperiments.some(p => p.u.includes("EXP-REVERT") && p.body.status === "reverted"));
  } finally {
    global.fetch = originalFetch;
    delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  }
});

test("cron-seo-optimizer.mjs uses NETLIFY_BUILD_HOOK_URL env fallback and respects auto_seo_rebuild_enabled=false", async () => {
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_KEY = "test_key";
  process.env.NETLIFY_BUILD_HOOK_URL = "https://api.netlify.com/build_hooks/envhook999";

  const originalFetch = global.fetch;
  let hookCalls = 0;
  let autoRebuildFlag = "true";

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(
        JSON.stringify([{ key: "auto_seo_rebuild_enabled", value: autoRebuildFlag }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/seo_experiments") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "EXP-ENV-1",
            page_path: "/roofing-brick-nj",
            status: "pending_24h",
            auto_apply_at: new Date(Date.now() - 3600 * 1000).toISOString(),
            baseline_ctr: 0.02,
            baseline_position: 10,
            baseline_impressions: 100
          }
        ]),
        { status: 200 }
      );
    }
    if (u === "https://api.netlify.com/build_hooks/envhook999" && method === "POST") {
      hookCalls++;
      return new Response("ok", { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  try {
    const res1 = await seoOptimizerHandler();
    assert.equal(res1.status, 200);
    const data1 = await res1.json();
    assert.equal(data1.promoted_to_active, 1);
    assert.equal(data1.rebuild_triggered, true);
    assert.equal(hookCalls, 1);

    autoRebuildFlag = "false";
    const res2 = await seoOptimizerHandler();
    assert.equal(res2.status, 200);
    const data2 = await res2.json();
    assert.equal(data2.rebuild_triggered, false);
    assert.equal(hookCalls, 1);
  } finally {
    global.fetch = originalFetch;
    delete process.env.NETLIFY_BUILD_HOOK_URL;
  }
});
