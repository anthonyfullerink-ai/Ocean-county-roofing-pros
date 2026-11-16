/**
 * Netlify Scheduled Function: Automated Ongoing Local SEO Flywheel
 * Schedule: Daily at 6:00 AM EST (11:00 UTC)
 *
 * 1. Auto-promotes expired 24h contractor job photos, GBP post drafts, and AI review replies.
 * 2. Dispatches promoted GBP posts to `gbp_webhook_url` if configured.
 * 3. Triggers `netlify_build_hook_url` only when new proof/reviews are promoted so `dist/`
 *    and `sitemap.xml` <lastmod> dates stay fresh for Googlebot without wasting build minutes.
 */
import { MetaSocialService } from "./services/meta-social-service.mjs";

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
    const maxMetaPostsPerRun = Math.max(1, Number(process.env.MAX_META_POSTS_PER_RUN || sys.max_meta_posts_per_day || 2));
    let promotedCount = 0;
    let metaPostsSent = 0;
    const metaResults = [];

    async function publishMetaWithCap(payload) {
      if (metaPostsSent >= maxMetaPostsPerRun) {
        return { status: "skipped", reason: "daily_cap_reached" };
      }
      const res = await MetaSocialService.publishPost(payload);
      if (res?.facebook?.status === "published" || res?.instagram?.status === "published" || res?.status === "published") {
        metaPostsSent++;
      }
      return res;
    }

    // 2. Promote expired 24h pending job photos & cross-post to Meta (FB + IG)
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

      const town = p.town || "Ocean County, NJ";
      const caption = p.caption || p.title || `Completed roofing project in ${town} by Ocean County Roofing Pros! Need a free 21-point roof & attic inspection (aerial drone diagnostics available upon request)? Call (732) 660-9121 or visit https://oceancountyroofingpros.com`;
      const imageUrl = p.image_url || p.photo_url || "";
      if (MetaSocialService.isPublicHttpsUrl(imageUrl)) {
        try {
          const metaRes = await publishMetaWithCap({
            caption,
            imageUrl,
            linkUrl: "https://oceancountyroofingpros.com"
          });
          metaResults.push({ type: "project", id: p.id, ...metaRes });
        } catch (e) {}
      }
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

      try {
        const metaRes = await publishMetaWithCap({
          caption: post.summary || post.content || post.title || "Ocean County Roofing Pros Update — (732) 660-9121",
          imageUrl: post.image_url || "",
          linkUrl: post.cta_url || "https://oceancountyroofingpros.com"
        });
        metaResults.push({ type: "gbp_post", id: post.id, ...metaRes });
      } catch (e) {}
    }

    // 4B. Promote expired 24h blog_posts drafts -> published + Meta teaser + IndexNow
    const promotedBlogUrls = [];
    try {
      const blogRes = await fetch(
        `${supabaseUrl}/rest/v1/blog_posts?status=eq.draft_auto_24h`,
        { headers }
      );
      const blogDrafts = blogRes.ok ? await blogRes.json() : [];
      const nowMs = Date.now();
      const cutoffMs = Date.parse(cutoffIso);
      const nowIso = new Date(nowMs).toISOString();
      for (const article of blogDrafts) {
        const autoPublishMs = article.auto_publish_at ? Date.parse(article.auto_publish_at) : NaN;
        const createdMs = article.created_at ? Date.parse(article.created_at) : NaN;
        const isReady = Number.isFinite(autoPublishMs)
          ? autoPublishMs <= nowMs
          : Number.isFinite(createdMs)
            ? createdMs < cutoffMs
            : true;
        if (!isReady) continue;

        const patchBlog = await fetch(`${supabaseUrl}/rest/v1/blog_posts?id=eq.${encodeURIComponent(article.id)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            status: "published",
            published_at: article.published_at || nowIso,
            auto_publish_at: null,
            updated_at: nowIso
          })
        });
        if (!patchBlog.ok) continue;
        promotedCount++;
        const articleUrl = `https://oceancountyroofingpros.com/blog/${article.slug}`;
        promotedBlogUrls.push(articleUrl);

        if (!article.meta_shared) {
          try {
            const relImg = (article.hero_image_url || "").trim();
            const publicImageUrl = /^https?:\/\//i.test(relImg)
              ? relImg.replace(/^http:\/\//i, "https://").replace(/\.webp$/i, ".jpg")
              : relImg
                ? `https://oceancountyroofingpros.com${relImg.startsWith("/") ? "" : "/"}${relImg.replace(/\.webp$/i, ".jpg")}`
                : "";
            const metaRes = await publishMetaWithCap({
              caption: article.social_caption || `${article.title} — ${article.excerpt || "Ocean County Roofing Pros Local Guide"}`,
              imageUrl: publicImageUrl,
              linkUrl: articleUrl,
              pageId: sys.meta_page_id,
              igUserId: sys.meta_ig_user_id,
              pageToken: sys.meta_page_access_token
            });
            metaResults.push({ type: "blog_post", id: article.id, slug: article.slug, ...metaRes });
            if (metaRes?.facebook?.status === "published" || metaRes?.instagram?.status === "published" || metaRes?.status === "published") {
              await fetch(`${supabaseUrl}/rest/v1/blog_posts?id=eq.${encodeURIComponent(article.id)}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ meta_shared: true, updated_at: new Date().toISOString() })
              });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // 4C. Process scheduled voice-dictated posts in social_queue (respecting daily Meta cap)
    try {
      const nowIso = new Date().toISOString();
      const sqRes = await fetch(
        `${supabaseUrl}/rest/v1/social_queue?status=eq.scheduled&scheduled_for=lte.${encodeURIComponent(nowIso)}&order=scheduled_for.asc&limit=5`,
        { headers }
      );
      const dueSocialPosts = sqRes.ok ? await sqRes.json() : [];
      for (const sp of dueSocialPosts) {
        const metaRes = await publishMetaWithCap({
          caption: sp.caption,
          imageUrl: sp.image_url || "",
          linkUrl: sp.link_url || "https://oceancountyroofingpros.com/#quizSection",
          utmCampaign: sp.utm_campaign || "social_agent"
        });
        metaResults.push({ type: "social_queue", id: sp.id, ...metaRes });
        if (metaRes.status === "published") {
          await fetch(`${supabaseUrl}/rest/v1/social_queue?id=eq.${encodeURIComponent(sp.id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "published",
              published_at: nowIso,
              external_post_ids_json: JSON.stringify(metaRes),
              updated_at: nowIso
            })
          });
          promotedCount++;
        }
      }
    } catch (e) {}

    // 4D. Promote expired 24h 4-5 star social review replies (1-3 star held for owner approval)
    try {
      const nowIso = new Date().toISOString();
      const siRes = await fetch(
        `${supabaseUrl}/rest/v1/social_interactions?reply_status=eq.auto_24h&auto_publish_at=lte.${encodeURIComponent(nowIso)}&limit=20`,
        { headers }
      );
      const dueReplies = siRes.ok ? await siRes.json() : [];
      for (const item of dueReplies) {
        if (Number(item.rating || 0) > 0 && Number(item.rating) <= 3) continue; // Guardrail
        let pubRes = { status: "published" };
        if (item.external_id && item.ai_reply_draft) {
          pubRes = await MetaSocialService.replyToComment({
            commentId: item.external_id,
            message: item.ai_reply_draft
          });
        }
        await fetch(`${supabaseUrl}/rest/v1/social_interactions?id=eq.${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            reply_status: "published",
            published_reply_id: pubRes?.id || "",
            updated_at: nowIso
          })
        });
        promotedCount++;
      }
    } catch (e) {}

    // 5. Trigger Netlify Build Hook & IndexNow Ping only when new proof/reviews/blog posts published
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
        const indexNowUrls = [
          "https://oceancountyroofingpros.com/",
          "https://oceancountyroofingpros.com/blog",
          "https://oceancountyroofingpros.com/roofing-toms-river-nj",
          "https://oceancountyroofingpros.com/roofing-brick-nj",
          "https://oceancountyroofingpros.com/roofing-point-pleasant-nj",
          "https://oceancountyroofingpros.com/roofing-jackson-nj",
          "https://oceancountyroofingpros.com/roofing-lacey-nj",
          "https://oceancountyroofingpros.com/roofing-lakewood-nj",
          "https://oceancountyroofingpros.com/roofing-barnegat-nj",
          "https://oceancountyroofingpros.com/roofing-manahawkin-nj",
          "https://oceancountyroofingpros.com/roofing-howell-nj",
          "https://oceancountyroofingpros.com/roofing-freehold-nj",
          ...promotedBlogUrls
        ];
        const idxRes = await fetch("https://api.indexnow.org/indexnow", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({
            host: "oceancountyroofingpros.com",
            key: "ocrp2026indexnow84eb54d7",
            keyLocation: "https://oceancountyroofingpros.com/ocrp2026indexnow84eb54d7.txt",
            urlList: indexNowUrls
          })
        });
        indexNowPinged = idxRes.ok;
      } catch (e) {}
    }

    return new Response(
      JSON.stringify({
        status: "success",
        promoted_count: promotedCount,
        meta_posts_sent: metaPostsSent,
        max_meta_posts_per_run: maxMetaPostsPerRun,
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
