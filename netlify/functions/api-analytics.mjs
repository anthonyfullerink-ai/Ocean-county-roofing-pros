/**
 * Netlify Serverless Function: First-Party Website Analytics Engine
 * Routes:
 *   - POST /api/analytics/collect  (Public, non-blocking beacon ingestion)
 *   - GET  /api/analytics/summary  (Protected by Owner Admin Bearer Token)
 */
import crypto from "crypto";

const SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || "ocrp_admin_secret_key_2026_offgrid_media";
const BOT_UA_RE = /(bot|crawl|spider|slurp|lighthouse|headlesschrome|pingdom|uptimerobot|pagespeed|curl\/|wget\/)/i;

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

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      ...extraHeaders
    }
  });
}

export function isIgnoredAnalyticsHit(pagePath = "/", userAgent = "") {
  const p = String(pagePath || "/").trim().toLowerCase();
  if (p.startsWith("/admin") || p.startsWith("/portal") || p.startsWith("/api/") || p.startsWith("/.netlify")) {
    return true;
  }
  if (userAgent && BOT_UA_RE.test(userAgent)) {
    return true;
  }
  return false;
}

export function classifyAnalyticsSource({ referrerHost = "", utmSource = "", utmMedium = "", meta = {} } = {}) {
  let host = String(referrerHost || "").trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname.toLowerCase();
    } catch (e) {
      host = "";
    }
  }
  host = host.replace(/^www\./, "");
  if (!host || host.includes("oceancountyroofingpros.com") || host === "localhost" || host === "127.0.0.1") {
    host = "direct";
  }

  const usrc = String(utmSource || "").trim().toLowerCase();
  const umed = String(utmMedium || "").trim().toLowerCase();
  const m = meta && typeof meta === "object" ? meta : {};

  let sourceChannel = "Referral";
  if (usrc || m.gclid || m.fbclid || ["cpc", "ppc", "paid", "paid_social", "email"].includes(umed)) {
    sourceChannel = "Campaign";
  } else if (/google\.|bing\.com|duckduckgo\.com|yahoo\.com/.test(host)) {
    sourceChannel = "Organic Search";
  } else if (/facebook\.com|instagram\.com|nextdoor\.com|yelp\.com|linkedin\.com|t\.co|x\.com|youtube\.com/.test(host)) {
    sourceChannel = "Social";
  } else if (host === "direct") {
    sourceChannel = "Direct";
  }

  return { referrer_host: host, source_channel: sourceChannel };
}

function normalizeDeviceType(rawDevice = "", viewportWidth = 0, userAgent = "") {
  const val = String(rawDevice || "").trim().toLowerCase();
  if (val === "mobile" || val === "tablet" || val === "desktop") return val;
  const vw = Number(viewportWidth) || 0;
  if (vw > 0) {
    if (vw < 768) return "mobile";
    if (vw < 1024) return "tablet";
    return "desktop";
  }
  const ua = String(userAgent || "").toLowerCase();
  if (/ipad|tablet/.test(ua)) return "tablet";
  if (/iphone|android|mobile/.test(ua)) return "mobile";
  return "desktop";
}

function formatUtcDay(dt) {
  return dt.toISOString().slice(0, 10);
}

function formatDayLabel(isoDateStr) {
  const [y, m, d] = isoDateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, (m || 1) - 1, d || 1));
  return dt.toLocaleDateString("en-US", { month: "short", day: "2-digit", timeZone: "UTC" });
}

export function summarizeAnalyticsEvents(events = [], rangeKey = "30d", nowMs = Date.now()) {
  const rangeMap = { "24h": 1, today: 1, "7d": 7, "30d": 30, "90d": 90 };
  const normalizedRange = String(rangeKey || "30d").toLowerCase();
  const days = rangeMap[normalizedRange] || 30;
  const cutoffMs = nowMs - days * 24 * 60 * 60 * 1000;

  const filtered = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const t = Date.parse(ev.created_at || "");
    if (!Number.isNaN(t) && t >= cutoffMs) {
      filtered.push({ ...ev, _ts: t });
    }
  }

  const visitorsSet = new Set();
  const sessionsSet = new Set();
  const visitorDeviceMap = new Map();

  const quizStartVisitors = new Set();
  const leadVisitors = new Set();
  const bookingVisitors = new Set();

  let pageviews = 0;
  let callClicks = 0;
  let smsClicks = 0;
  let estimatorClicks = 0;
  let emailInquiries = 0;
  let leadsSubmitted = 0;
  let bookingsConfirmed = 0;
  let blogReads = 0;

  const dayBuckets = new Map();
  for (let offset = days - 1; offset >= 0; offset--) {
    const dt = new Date(nowMs - offset * 24 * 60 * 60 * 1000);
    const key = formatUtcDay(dt);
    dayBuckets.set(key, {
      date: key,
      label: formatDayLabel(key),
      _visitors: new Set(),
      pageviews: 0,
      conversions: 0,
      intent_clicks: 0
    });
  }

  const pageStats = new Map();
  const townStats = new Map();
  const sourceStats = new Map();

  for (const ev of filtered) {
    const ename = ev.event_name || "page_view";
    const vid = ev.visitor_id || ev.session_id || ev.id;
    const sid = ev.session_id || vid;
    const path = String(ev.page_path || "/").trim() || "/";
    const town = String(ev.town_name || "").trim() || "General / Countywide";
    const device = String(ev.device_type || "desktop").toLowerCase();
    const source = String(ev.source_channel || "Direct").trim() || "Direct";
    const dayKey = new Date(ev._ts).toISOString().slice(0, 10);

    visitorsSet.add(vid);
    sessionsSet.add(sid);
    if (!visitorDeviceMap.has(vid)) visitorDeviceMap.set(vid, device);

    const bucket = dayBuckets.get(dayKey);
    if (bucket) bucket._visitors.add(vid);

    if (!pageStats.has(path)) {
      pageStats.set(path, { page_path: path, pageviews: 0, _visitors: new Set(), conversions: 0, town_name: town });
    }
    const pEntry = pageStats.get(path);

    if (!townStats.has(town)) {
      townStats.set(town, { town_name: town, pageviews: 0, _visitors: new Set(), conversions: 0 });
    }
    const tEntry = townStats.get(town);

    if (ename === "page_view") {
      pageviews += 1;
      pEntry.pageviews += 1;
      pEntry._visitors.add(vid);
      tEntry.pageviews += 1;
      tEntry._visitors.add(vid);
      if (bucket) bucket.pageviews += 1;
      sourceStats.set(source, (sourceStats.get(source) || 0) + 1);
    } else if (ename === "quiz_step_complete" || ename === "estimator_quote_click") {
      quizStartVisitors.add(vid);
      if (ename === "estimator_quote_click") {
        estimatorClicks += 1;
        if (bucket) bucket.intent_clicks += 1;
      }
    } else if (ename === "phone_call_click") {
      callClicks += 1;
      pEntry.conversions += 1;
      tEntry.conversions += 1;
      if (bucket) {
        bucket.intent_clicks += 1;
        bucket.conversions += 1;
      }
    } else if (ename === "sms_click") {
      smsClicks += 1;
      pEntry.conversions += 1;
      tEntry.conversions += 1;
      if (bucket) {
        bucket.intent_clicks += 1;
        bucket.conversions += 1;
      }
    } else if (ename === "email_inquiry_sent") {
      emailInquiries += 1;
      leadsSubmitted += 1;
      leadVisitors.add(vid);
      pEntry.conversions += 1;
      tEntry.conversions += 1;
      if (bucket) bucket.conversions += 1;
    } else if (ename === "generate_lead") {
      leadsSubmitted += 1;
      leadVisitors.add(vid);
      pEntry.conversions += 1;
      tEntry.conversions += 1;
      if (bucket) bucket.conversions += 1;
    } else if (ename === "booking_confirmed") {
      bookingsConfirmed += 1;
      bookingVisitors.add(vid);
      pEntry.conversions += 1;
      tEntry.conversions += 1;
    } else if (ename === "blog_read_complete") {
      blogReads += 1;
    }
  }

  const uniqueVisitors = visitorsSet.size;
  const deviceCounts = { mobile: 0, desktop: 0, tablet: 0 };
  for (const dev of visitorDeviceMap.values()) {
    const key = dev in deviceCounts ? dev : "desktop";
    deviceCounts[key] += 1;
  }

  const mobilePct = uniqueVisitors > 0 ? Math.round((deviceCounts.mobile / uniqueVisitors) * 1000) / 10 : 0.0;
  const convRatePct = uniqueVisitors > 0 ? Math.round((leadsSubmitted / uniqueVisitors) * 1000) / 10 : 0.0;

  const dailySeries = Array.from(dayBuckets.values()).map(b => ({
    date: b.date,
    label: b.label,
    visitors: b._visitors.size,
    pageviews: b.pageviews,
    conversions: b.conversions,
    intent_clicks: b.intent_clicks
  }));

  const topPages = Array.from(pageStats.values())
    .map(p => ({
      page_path: p.page_path,
      pageviews: p.pageviews,
      visitors: p._visitors.size,
      conversions: p.conversions,
      town_name: p.town_name
    }))
    .sort((a, b) => (b.pageviews - a.pageviews) || (b.visitors - a.visitors))
    .slice(0, 12);

  const topTowns = Array.from(townStats.values())
    .map(t => ({
      town_name: t.town_name,
      pageviews: t.pageviews,
      visitors: t._visitors.size,
      conversions: t.conversions
    }))
    .sort((a, b) => (b.pageviews - a.pageviews) || (b.visitors - a.visitors))
    .slice(0, 10);

  const sources = (sourceStats.size > 0
    ? Array.from(sourceStats.entries()).map(([source, count]) => ({ source, count }))
    : [{ source: "Direct", count: 0 }]
  ).sort((a, b) => b.count - a.count);

  const recentEvents = filtered
    .slice()
    .sort((a, b) => b._ts - a._ts)
    .slice(0, 25)
    .map(r => ({
      created_at: r.created_at,
      event_name: r.event_name,
      page_path: r.page_path,
      town_name: r.town_name || "",
      device_type: r.device_type || "desktop",
      source_channel: r.source_channel || "Direct",
      referrer_host: r.referrer_host || "direct"
    }));

  return {
    status: "success",
    range: normalizedRange,
    days,
    kpis: {
      unique_visitors: uniqueVisitors,
      sessions: sessionsSet.size,
      pageviews,
      leads_submitted: leadsSubmitted,
      bookings_confirmed: bookingsConfirmed,
      call_clicks: callClicks,
      sms_clicks: smsClicks,
      estimator_clicks: estimatorClicks,
      email_inquiries: emailInquiries,
      intent_actions_total: leadsSubmitted + callClicks + smsClicks,
      conversion_rate_pct: convRatePct,
      mobile_pct: mobilePct,
      blog_reads: blogReads
    },
    funnel: [
      { stage: "Site Visitors", count: uniqueVisitors },
      { stage: "Quiz / Cost Guide Started", count: quizStartVisitors.size },
      { stage: "Lead Submitted", count: leadVisitors.size },
      { stage: "Inspection Booked", count: bookingVisitors.size }
    ],
    devices: deviceCounts,
    sources,
    top_pages: topPages,
    top_towns: topTowns,
    daily_series: dailySeries,
    recent_events: recentEvents
  };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. PUBLIC NON-BLOCKING TELEMETRY COLLECTION (/api/analytics/collect)
    if (path.endsWith("/collect") && req.method === "POST") {
      let body = {};
      try {
        const text = await req.text();
        body = text ? JSON.parse(text) : {};
      } catch (e) {
        return jsonResponse({ ok: false, error: "Invalid payload" }, 400);
      }

      const rawPath = String(body.page_path || "/").split("?")[0].slice(0, 240) || "/";
      const ua = req.headers.get("user-agent") || "";
      if (isIgnoredAnalyticsHit(rawPath, ua)) {
        return jsonResponse({ ok: true, ignored: true }, 200);
      }

      const metaObj = body.meta && typeof body.meta === "object" ? body.meta : {};
      const vw = Number(body.viewport_width) || 0;
      const utmSource = String(body.utm_source || "").slice(0, 80);
      const utmMedium = String(body.utm_medium || "").slice(0, 80);
      const utmCampaign = String(body.utm_campaign || "").slice(0, 120);
      const attributed = classifyAnalyticsSource({
        referrerHost: body.referrer_host || body.referrer || "",
        utmSource,
        utmMedium,
        meta: metaObj
      });

      const id = `EVT-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      const record = {
        id,
        created_at: new Date().toISOString(),
        event_name: String(body.event_name || "page_view").slice(0, 64),
        session_id: String(body.session_id || "").slice(0, 80),
        visitor_id: String(body.visitor_id || "").slice(0, 80),
        page_path: rawPath,
        page_title: String(body.page_title || "").slice(0, 160),
        page_type: String(body.page_type || "landing").slice(0, 32),
        town_slug: String(body.town_slug || "").slice(0, 80),
        town_name: String(body.town_name || "").slice(0, 80),
        device_type: normalizeDeviceType(body.device_type, vw, ua),
        referrer_host: attributed.referrer_host,
        source_channel: attributed.source_channel,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        viewport_width: vw,
        meta_json: JSON.stringify(metaObj)
      };

      if (supabaseUrl && supabaseKey) {
        const res = await fetch(`${supabaseUrl}/rest/v1/site_analytics_events`, {
          method: "POST",
          headers: { ...headers, Prefer: "return=minimal" },
          body: JSON.stringify(record)
        }).catch(() => null);
        if (res && !res.ok) {
          return jsonResponse({ ok: false, stored: false }, 202);
        }
      }

      return jsonResponse({ ok: true, id }, 200);
    }

    // 2. PROTECTED DASHBOARD SUMMARY (/api/analytics/summary?range=30d)
    if (path.endsWith("/summary") && req.method === "GET") {
      const authHeader = req.headers.get("authorization") || "";
      const token = authHeader.replace(/^Bearer\s+/i, "").trim();
      const session = verifySessionToken(token);
      if (!session) {
        return jsonResponse({ status: "error", error: "Unauthorized" }, 401);
      }

      const rangeKey = (url.searchParams.get("range") || "30d").toLowerCase();
      const rangeDays = { "24h": 1, today: 1, "7d": 7, "30d": 30, "90d": 90 }[rangeKey] || 30;
      const cutoffIso = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();

      let events = [];
      let supabaseConnected = false;
      let warning = "";

      if (supabaseUrl && supabaseKey) {
        const q = `${supabaseUrl}/rest/v1/site_analytics_events?created_at=gte.${encodeURIComponent(cutoffIso)}&order=created_at.desc&limit=10000`;
        const res = await fetch(q, { headers }).catch(() => null);
        if (res && res.ok) {
          events = await res.json();
          supabaseConnected = true;
        } else if (res) {
          warning = `Supabase query returned HTTP ${res.status}`;
        }
      }

      const summary = summarizeAnalyticsEvents(events, rangeKey);
      return jsonResponse({
        ...summary,
        supabase_connected: supabaseConnected,
        ...(warning ? { warning } : {})
      });
    }

    return jsonResponse({ error: "Not found" }, 404);
  } catch (err) {
    return jsonResponse({ error: err.message || "Analytics error" }, 500);
  }
};
