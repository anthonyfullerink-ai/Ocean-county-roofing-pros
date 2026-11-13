/**
 * Netlify Scheduled Function: Automated Ongoing Local SEO Flywheel
 * Schedule: Daily at 6:00 AM EST (11:00 UTC)
 *
 * 1. Auto-promotes expired 24h contractor job photos, GBP post drafts, and AI review replies.
 * 2. Dispatches promoted GBP posts to `gbp_webhook_url` if configured.
 * 3. Triggers `netlify_build_hook_url` only when new proof/reviews are promoted so `dist/`
 *    and `sitemap.xml` <lastmod> dates stay fresh for Googlebot without wasting build minutes.
 */
export const config = {
  schedule: "0 11 * * *"
};

export default async (req, context) => {
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_KEY || "";

  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ status: "skipped", reason: "Supabase not configured" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const headers = {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    // 1. Load system_settings
    const setRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?select=key,value`, { headers });
    const setRows = setRes.ok ? await setRes.json() : [];
    const sys = {};
    for (const r of setRows) sys[r.key] = r.value;

    if (sys.auto_publish_24h !== "true") {
      return new Response(JSON.stringify({ status: "skipped", reason: "auto_publish_24h is disabled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const cutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    let promotedCount = 0;

    // 2. Promote expired 24h pending job photos
    const projRes = await fetch(
      `${supabaseUrl}/rest/v1/job_projects?status=eq.pending_auto_24h&created_at=lt.${encodeURIComponent(cutoffIso)}`,
      { headers }
    );
    const pendingProjects = projRes.ok ? await projRes.json() : [];
    for (const p of pendingProjects) {
      await fetch(`${supabaseUrl}/rest/v1/job_projects?id=eq.${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ status: "approved" })
      });
      promotedCount++;
    }

    // 3. Promote expired 24h pending review replies
    const revRes = await fetch(
      `${supabaseUrl}/rest/v1/reviews?reply_status=eq.pending&created_at=lt.${encodeURIComponent(cutoffIso)}`,
      { headers }
    );
    const pendingReviews = revRes.ok ? await revRes.json() : [];
    for (const rev of pendingReviews) {
      await fetch(`${supabaseUrl}/rest/v1/reviews?id=eq.${encodeURIComponent(rev.id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ reply_status: "published" })
      });
      promotedCount++;
    }

    // 4. Promote expired 24h GBP post drafts & forward to gbp_webhook_url if configured
    const gbpRes = await fetch(
      `${supabaseUrl}/rest/v1/gbp_posts?status=eq.draft_auto_24h&created_at=lt.${encodeURIComponent(cutoffIso)}`,
      { headers }
    );
    const pendingGbp = gbpRes.ok ? await gbpRes.json() : [];
    const gbpWebhook = (sys.gbp_webhook_url || "").trim();
    for (const post of pendingGbp) {
      let webhookDispatched = false;
      if (gbpWebhook && gbpWebhook.startsWith("http")) {
        try {
          const wh = await fetch(gbpWebhook, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(post)
          });
          webhookDispatched = wh.ok;
        } catch (e) {}
      }
      await fetch(`${supabaseUrl}/rest/v1/gbp_posts?id=eq.${encodeURIComponent(post.id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          status: webhookDispatched ? "published" : "approved",
          webhook_dispatched: webhookDispatched
        })
      });
      promotedCount++;
    }

    // 5. Trigger Netlify Build Hook & IndexNow Ping only when new proof/reviews published
    let rebuildTriggered = false;
    let indexNowPinged = false;
    const buildHook = (sys.netlify_build_hook_url || "").trim();
    if (promotedCount > 0 && sys.auto_seo_rebuild_enabled !== "false" && buildHook.startsWith("https://")) {
      try {
        const bhRes = await fetch(buildHook, { method: "POST" });
        rebuildTriggered = bhRes.ok;
      } catch (e) {}
    }

    if (promotedCount > 0) {
      try {
        const idxRes = await fetch("https://api.indexnow.org/indexnow", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            host: "oceancountyroofingpros.com",
            key: "ocrp2026indexnow84eb54d7",
            keyLocation: "https://oceancountyroofingpros.com/ocrp2026indexnow84eb54d7.txt",
            urlList: [
              "https://oceancountyroofingpros.com/",
              "https://oceancountyroofingpros.com/roofing-toms-river-nj",
              "https://oceancountyroofingpros.com/roofing-brick-nj",
              "https://oceancountyroofingpros.com/roofing-point-pleasant-nj",
              "https://oceancountyroofingpros.com/roofing-jackson-nj",
              "https://oceancountyroofingpros.com/roofing-lacey-nj",
              "https://oceancountyroofingpros.com/roofing-lakewood-nj",
              "https://oceancountyroofingpros.com/roofing-barnegat-nj",
              "https://oceancountyroofingpros.com/roofing-manahawkin-nj",
              "https://oceancountyroofingpros.com/roofing-howell-nj",
              "https://oceancountyroofingpros.com/roofing-freehold-nj"
            ]
          })
        });
        indexNowPinged = idxRes.ok;
      } catch (e) {}
    }

    return new Response(
      JSON.stringify({
        status: "success",
        promoted_count: promotedCount,
        rebuild_triggered: rebuildTriggered,
        indexnow_pinged: indexNowPinged,
        checked_at: new Date().toISOString()
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("cron-seo-flywheel error:", err);
    return new Response(JSON.stringify({ status: "error", message: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
