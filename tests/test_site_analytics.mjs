import test from "node:test";
import assert from "node:assert/strict";
import analyticsHandler, {
  classifyAnalyticsSource,
  isIgnoredAnalyticsHit,
  summarizeAnalyticsEvents
} from "../netlify/functions/api-analytics.mjs";
import adminHandler from "../netlify/functions/api-admin.mjs";

test("classifyAnalyticsSource & isIgnoredAnalyticsHit classify channels and filter bots/internal routes", () => {
  assert.equal(isIgnoredAnalyticsHit("/admin"), true);
  assert.equal(isIgnoredAnalyticsHit("/portal"), true);
  assert.equal(isIgnoredAnalyticsHit("/api/admin/bootstrap"), true);
  assert.equal(isIgnoredAnalyticsHit("/", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"), true);
  assert.equal(isIgnoredAnalyticsHit("/roofing-toms-river-nj", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), false);

  assert.equal(
    classifyAnalyticsSource({ referrerHost: "https://www.google.com/search?q=roof+brick" }).source_channel,
    "Organic Search"
  );
  assert.equal(
    classifyAnalyticsSource({ referrerHost: "https://l.facebook.com/" }).source_channel,
    "Social"
  );
  assert.equal(
    classifyAnalyticsSource({ referrerHost: "https://oceancountyroofingpros.com/" }).source_channel,
    "Direct"
  );
  assert.equal(
    classifyAnalyticsSource({ referrerHost: "", utmSource: "meta_ads", utmMedium: "paid_social" }).source_channel,
    "Campaign"
  );
});

test("Netlify api-analytics.mjs records collect beacons and enforces admin auth on summary", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_supabase_key";
  process.env.ADMIN_USERNAME = "owner";
  process.env.ADMIN_PASSWORD = "secret_password";

  const storedEvents = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/rest/v1/site_analytics_events") && method === "POST") {
      storedEvents.push(JSON.parse(opts.body));
      return new Response(null, { status: 201 });
    }
    if (u.includes("/rest/v1/site_analytics_events") && method === "GET") {
      return new Response(JSON.stringify(storedEvents), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  };

  try {
    // 1. Collect public page_view + funnel events
    const pvRes = await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/collect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"
        },
        body: JSON.stringify({
          event_name: "page_view",
          session_id: "sid-1",
          visitor_id: "vid-1",
          page_path: "/roofing-brick-nj",
          town_name: "Brick",
          device_type: "mobile",
          referrer_host: "https://www.google.com/",
          viewport_width: 390
        })
      })
    );
    assert.equal(pvRes.status, 200);
    const pvJson = await pvRes.json();
    assert.equal(pvJson.ok, true);

    await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: "quiz_step_complete",
          session_id: "sid-1",
          visitor_id: "vid-1",
          page_path: "/roofing-brick-nj",
          town_name: "Brick",
          device_type: "mobile"
        })
      })
    );

    await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: "generate_lead",
          session_id: "sid-1",
          visitor_id: "vid-1",
          page_path: "/roofing-brick-nj",
          town_name: "Brick",
          device_type: "mobile"
        })
      })
    );

    await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event_name: "phone_call_click",
          session_id: "sid-2",
          visitor_id: "vid-2",
          page_path: "/",
          town_name: "Toms River",
          device_type: "desktop"
        })
      })
    );

    // Ignored admin hit
    const adminHit = await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/collect", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_name: "page_view", page_path: "/admin", visitor_id: "vid-admin" })
      })
    );
    const adminHitJson = await adminHit.json();
    assert.equal(adminHitJson.ignored, true);
    assert.equal(storedEvents.length, 4);

    // 2. Unauthorized summary returns 401
    const unauthRes = await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/summary?range=30d", { method: "GET" })
    );
    assert.equal(unauthRes.status, 401);

    // 3. Authenticate and retrieve summary
    const authRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "owner", password: "secret_password" })
      })
    );
    const { token } = await authRes.json();
    assert.ok(token);

    const sumRes = await analyticsHandler(
      new Request("https://oceancountyroofingpros.com/api/analytics/summary?range=30d", {
        method: "GET",
        headers: { Authorization: `Bearer ${token}` }
      })
    );
    assert.equal(sumRes.status, 200);
    const sum = await sumRes.json();
    assert.equal(sum.status, "success");
    assert.equal(sum.kpis.unique_visitors, 2);
    assert.equal(sum.kpis.pageviews, 1);
    assert.equal(sum.kpis.leads_submitted, 1);
    assert.equal(sum.kpis.call_clicks, 1);
    assert.equal(sum.sources[0].source, "Organic Search");
    assert.equal(sum.top_pages[0].page_path, "/roofing-brick-nj");
    assert.equal(sum.daily_series.length, 30);
    assert.equal(sum.funnel[0].count, 2);
    assert.equal(sum.funnel[1].count, 1);
    assert.equal(sum.funnel[2].count, 1);

    // Quick pure helper check
    const emptySum = summarizeAnalyticsEvents([], "7d");
    assert.equal(emptySum.daily_series.length, 7);
    assert.equal(emptySum.kpis.unique_visitors, 0);
  } finally {
    global.fetch = originalFetch;
  }
});
