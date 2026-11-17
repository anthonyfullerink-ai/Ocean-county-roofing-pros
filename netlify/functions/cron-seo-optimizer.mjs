/**
 * Netlify Scheduled Function: Closed-Loop Search Ranking & Self-Optimizing SEO Engine (Agent 7)
 * Schedule: Weekly on Mondays at 7:00 AM EST (12:00 UTC)
 */
import crypto from "crypto";
import { GscService } from "./services/gsc-service.mjs";

export const config = {
  schedule: "0 12 * * 1"
};

function titleCase(str = "") {
  return String(str || "")
    .trim()
    .split(/\s+/)
    .map(w => (w.length <= 2 && /^(nj|in|of|to|or|on|at)$/i.test(w) ? w.toUpperCase() === "NJ" ? "NJ" : w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

export function buildOptimizedMeta({ pagePath = "/", targetQuery = "" } = {}) {
  const cleanQ = titleCase(targetQuery || "Roof Replacement Ocean County NJ");
  const titleBase = cleanQ.length <= 36
    ? `${cleanQ} | Free 21-Point Inspection`
    : `${cleanQ.slice(0, 44).trim()} | Free Quote`;
  const proposedTitle = titleBase.slice(0, 62);
  const proposedDesc = `${cleanQ} by NJ licensed & insured specialists. Compare GAF, CertainTeed & Owens Corning systems with a free 21-point roof & attic inspection & written price lock.`.slice(0, 160);
  return {
    page_path: pagePath,
    proposed_meta_title: proposedTitle,
    proposed_meta_description: proposedDesc
  };
}

export function evaluateExperimentOutcome(exp, currentMetric) {
  const basePos = Number(exp.baseline_position || 0);
  const baseCtr = Number(exp.baseline_ctr || 0);
  const curPos = Number(currentMetric?.position ?? basePos);
  const curCtr = Number(currentMetric?.ctr ?? baseCtr);
  const curImp = Number(currentMetric?.impressions ?? 0);

  const posRegressed = basePos > 0 && curPos > basePos + 3.0;
  const ctrRegressed = baseCtr > 0 && curImp >= 100 && curCtr < baseCtr * 0.8;

  if (posRegressed || ctrRegressed) {
    return {
      nextStatus: "reverted",
      latest_position: curPos,
      latest_ctr: curCtr,
      reason: `Auto-reverted after 14d check: pos ${basePos}->${curPos}, ctr ${(baseCtr * 100).toFixed(2)}%->${(curCtr * 100).toFixed(2)}%`
    };
  }
  return {
    nextStatus: "kept",
    latest_position: curPos,
    latest_ctr: curCtr,
    reason: `Kept after 14d check: pos ${basePos}->${curPos}, ctr ${(baseCtr * 100).toFixed(2)}%->${(curCtr * 100).toFixed(2)}%`
  };
}

export default async () => {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";

  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ status: "skipped", reason: "Supabase not configured" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const snapDate = nowIso.slice(0, 10);

    // 1. Load system_settings + existing experiments + blog_posts
    const [setRes, expRes, blogRes] = await Promise.all([
      fetch(`${supabaseUrl}/rest/v1/system_settings?select=key,value`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/seo_experiments?order=created_at.desc&limit=100`, { headers }).catch(() => null),
      fetch(`${supabaseUrl}/rest/v1/blog_posts?select=id,slug,title&limit=100`, { headers }).catch(() => null)
    ]);
    const sys = {};
    if (setRes && setRes.ok) {
      for (const r of await setRes.json()) sys[r.key] = r.value;
    }
    const experiments = expRes && expRes.ok ? await expRes.json() : [];
    const blogPosts = blogRes && blogRes.ok ? await blogRes.json() : [];

    // 2. Pull live GSC data if credentials configured
    const gscRes = await GscService.querySearchAnalytics({
      siteUrl: sys.gsc_site_url || process.env.GSC_SITE_URL || "https://oceancountyroofingpros.com/",
      days: 28,
      rowLimit: 250
    });
    const gscRows = Array.isArray(gscRes.rows) ? gscRes.rows : [];

    let snapshotsSaved = 0;
    for (const row of gscRows.slice(0, 100)) {
      const id = "GSC-" + crypto.createHash("sha1").update(`${snapDate}|${row.page_path}|${row.query}`).digest("hex").slice(0, 12);
      const up = await fetch(`${supabaseUrl}/rest/v1/seo_ranking_snapshots`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
        body: JSON.stringify({
          id,
          created_at: nowIso,
          snapshot_date: snapDate,
          page_url: row.page_url,
          page_path: row.page_path,
          query: row.query,
          clicks: row.clicks,
          impressions: row.impressions,
          ctr: row.ctr,
          position: row.position
        })
      }).catch(() => null);
      if (up && up.ok) snapshotsSaved++;
    }

    const metricByKey = new Map();
    for (const r of gscRows) {
      metricByKey.set(`${r.page_path}|${r.query.toLowerCase()}`, r);
    }

    let overridesChanged = false;
    let promotedCount = 0;
    let keptCount = 0;
    let revertedCount = 0;
    let stagedCount = 0;
    let blogDraftsStaged = 0;

    // 3. Evaluate active experiments >= 14 days old (auto-rollback guardrail)
    const fourteenDaysMs = 14 * 24 * 60 * 60 * 1000;
    for (const exp of experiments) {
      if (exp.status === "active" && exp.activated_at) {
        const actMs = Date.parse(exp.activated_at);
        if (Number.isFinite(actMs) && nowMs - actMs >= fourteenDaysMs) {
          const curMetric = metricByKey.get(`${exp.page_path}|${String(exp.target_query || "").toLowerCase()}`);
          if (curMetric) {
            const evalOut = evaluateExperimentOutcome(exp, curMetric);
            await fetch(`${supabaseUrl}/rest/v1/seo_experiments?id=eq.${encodeURIComponent(exp.id)}`, {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                status: evalOut.nextStatus,
                latest_position: evalOut.latest_position,
                latest_ctr: evalOut.latest_ctr,
                evaluated_at: nowIso,
                reason: evalOut.reason,
                updated_at: nowIso
              })
            }).catch(() => {});
            if (evalOut.nextStatus === "reverted") {
              revertedCount++;
              overridesChanged = true;
            } else {
              keptCount++;
            }
          }
        }
      }

      // 4. Promote expired pending_24h experiments -> active
      if (exp.status === "pending_24h" && exp.auto_apply_at) {
        const dueMs = Date.parse(exp.auto_apply_at);
        if (Number.isFinite(dueMs) && dueMs <= nowMs) {
          await fetch(`${supabaseUrl}/rest/v1/seo_experiments?id=eq.${encodeURIComponent(exp.id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "active",
              activated_at: nowIso,
              updated_at: nowIso
            })
          }).catch(() => {});
          promotedCount++;
          overridesChanged = true;
        }
      }
    }

    // 5. Stage up to 2 new striking-distance title/meta experiments (impressions >= 100)
    const activeOrPendingPaths = new Set(
      experiments.filter(e => e.status === "pending_24h" || e.status === "active").map(e => e.page_path)
    );
    const opportunities = gscRows
      .filter(r => r.impressions >= 100 && ((r.position >= 8 && r.position <= 25) || r.ctr < 0.025))
      .sort((a, b) => b.impressions - a.impressions);

    const autoApplyIso = new Date(nowMs + 24 * 60 * 60 * 1000).toISOString();
    for (const opp of opportunities) {
      if (stagedCount >= 2) break;
      if (activeOrPendingPaths.has(opp.page_path)) continue;

      const meta = buildOptimizedMeta({ pagePath: opp.page_path, targetQuery: opp.query });
      const expId = `SEOEXP-${Date.now().toString(36).toUpperCase()}-${stagedCount + 1}`;
      await fetch(`${supabaseUrl}/rest/v1/seo_experiments`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({
          id: expId,
          created_at: nowIso,
          updated_at: nowIso,
          page_path: opp.page_path,
          target_query: opp.query,
          proposed_meta_title: meta.proposed_meta_title,
          proposed_meta_description: meta.proposed_meta_description,
          baseline_position: opp.position,
          baseline_ctr: opp.ctr,
          baseline_impressions: opp.impressions,
          latest_position: opp.position,
          latest_ctr: opp.ctr,
          status: "pending_24h",
          auto_apply_at: autoApplyIso,
          reason: `Striking distance: pos ${opp.position}, ${opp.impressions} imp, CTR ${(opp.ctr * 100).toFixed(2)}%`
        })
      }).catch(() => {});
      activeOrPendingPaths.add(opp.page_path);
      stagedCount++;
    }

    // 6. Stage up to 1 uncovered high-impression query as a draft_auto_24h blog post
    const existingBlogSlugs = new Set(blogPosts.map(b => String(b.slug || "").toLowerCase()));
    const existingBlogTitles = blogPosts.map(b => String(b.title || "").toLowerCase());
    for (const opp of opportunities) {
      if (blogDraftsStaged >= 1) break;
      const slug = opp.query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      if (!slug || existingBlogSlugs.has(slug)) continue;
      if (existingBlogTitles.some(t => t.includes(opp.query.toLowerCase().slice(0, 18)))) continue;

      const title = `${titleCase(opp.query)} — Ocean County Homeowner Guide`;
      await fetch(`${supabaseUrl}/rest/v1/blog_posts`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({
          id: `BLOG-SEO-${Date.now().toString(36).toUpperCase()}`,
          slug,
          title,
          meta_title: `${title}`.slice(0, 62),
          meta_description: `Compare GAF, CertainTeed, and Owens Corning options for ${opp.query} in Ocean County, NJ with a free 21-point roof & attic inspection.`,
          category: "Coastal Materials",
          excerpt: `Local NJ homeowner guide answering common questions about ${opp.query} across Toms River, Brick & Ocean County.`,
          target_towns_json: JSON.stringify([{ label: "Toms River", slug: "roofing-toms-river-nj" }]),
          sections_json: JSON.stringify([
            {
              heading: `What Ocean County Homeowners Should Know About ${titleCase(opp.query)}`,
              body: `When evaluating ${opp.query}, compare manufacturer wind warranties (130–160 MPH), ice-and-water barrier coverage, and attic ventilation. Schedule a free 21-point roof & attic inspection (aerial drone diagnostics available upon request) for a written comparison.`
            }
          ]),
          faqs_json: JSON.stringify([]),
          hero_image_url: "/static/images/shingle-restored-after.webp",
          hero_image_alt: title,
          status: "draft_auto_24h",
          auto_publish_at: autoApplyIso,
          created_at: nowIso,
          updated_at: nowIso
        })
      }).catch(() => {});
      blogDraftsStaged++;
    }

    // 7. Trigger Netlify rebuild if active overrides changed
    let rebuildTriggered = false;
    const buildHook = (sys.netlify_build_hook_url || "").trim();
    if (overridesChanged && buildHook.startsWith("https://")) {
      const bhRes = await fetch(buildHook, { method: "POST" }).catch(() => null);
      rebuildTriggered = Boolean(bhRes && bhRes.ok);
    }

    return new Response(
      JSON.stringify({
        status: "success",
        gsc_status: gscRes.status,
        snapshots_saved: snapshotsSaved,
        promoted_to_active: promotedCount,
        kept_winners: keptCount,
        auto_reverted: revertedCount,
        staged_experiments: stagedCount,
        blog_drafts_staged: blogDraftsStaged,
        rebuild_triggered: rebuildTriggered
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
