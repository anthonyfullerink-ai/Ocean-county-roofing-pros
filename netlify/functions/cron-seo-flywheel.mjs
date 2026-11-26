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

const OCEAN_COUNTY_TOWN_PAGES = [
  { town: "Toms River", slug: "roofing-toms-river-nj", image: "https://oceancountyroofingpros.com/static/images/shingle-restored-after.jpg" },
  { town: "Brick", slug: "roofing-brick-nj", image: "https://oceancountyroofingpros.com/static/images/roofer-crew-action.jpg" },
  { town: "Point Pleasant", slug: "roofing-point-pleasant-nj", image: "https://oceancountyroofingpros.com/static/images/drone-thermal-inspection.jpg" },
  { town: "Jackson", slug: "roofing-jackson-nj", image: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg" },
  { town: "Lacey", slug: "roofing-lacey-nj", image: "https://oceancountyroofingpros.com/static/images/shingle-restored-after.jpg" },
  { town: "Lakewood", slug: "roofing-lakewood-nj", image: "https://oceancountyroofingpros.com/static/images/roofer-crew-action.jpg" },
  { town: "Barnegat", slug: "roofing-barnegat-nj", image: "https://oceancountyroofingpros.com/static/images/drone-thermal-inspection.jpg" },
  { town: "Manahawkin", slug: "roofing-manahawkin-nj", image: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg" },
  { town: "Howell", slug: "roofing-howell-nj", image: "https://oceancountyroofingpros.com/static/images/shingle-restored-after.jpg" },
  { town: "Freehold", slug: "roofing-freehold-nj", image: "https://oceancountyroofingpros.com/static/images/roofer-crew-action.jpg" }
];

const SEASONAL_ROOFING_TIPS = [
  {
    id: "tip-coastal-wind",
    caption: "Living near the Barnegat Bay or Atlantic coast? 130+ MPH wind-rated architectural shingles with 6-nail fastening and stainless/galvanized flashing help prevent lift during nor'easters. Book a free 21-point roof & attic inspection at (732) 660-9121.",
    image_url: "https://oceancountyroofingpros.com/static/images/drone-thermal-inspection.jpg",
    link_url: "https://oceancountyroofingpros.com/#quizSection",
    utm_campaign: "seasonal_tip_wind",
    town_name: "Ocean County"
  },
  {
    id: "tip-attic-ventilation",
    caption: "Balanced ridge & soffit attic ventilation lowers summer shingle temperatures and prevents winter condensation & ice dams across Ocean County homes. Schedule a free 21-point roof & attic check at (732) 660-9121.",
    image_url: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg",
    link_url: "https://oceancountyroofingpros.com/#quizSection",
    utm_campaign: "seasonal_tip_ventilation",
    town_name: "Ocean County"
  },
  {
    id: "tip-flashing-check",
    caption: "Most Ocean County roof leaks start at chimney, skylight, and valley flashing — not the field shingles. Salt air accelerates corrosion on older step flashing. Get a free 21-point inspection: (732) 660-9121.",
    image_url: "https://oceancountyroofingpros.com/static/images/roofer-crew-action.jpg",
    link_url: "https://oceancountyroofingpros.com/#quizSection",
    utm_campaign: "seasonal_tip_flashing",
    town_name: "Ocean County"
  },
  {
    id: "tip-gutter-ice-water",
    caption: "Before the next coastal storm hits, check that gutters drain freely and eaves have proper ice-and-water shield protection. Request a free 60-second estimate or 21-point inspection at (732) 660-9121.",
    image_url: "https://oceancountyroofingpros.com/static/images/shingle-restored-after.jpg",
    link_url: "https://oceancountyroofingpros.com/#quizSection",
    utm_campaign: "seasonal_tip_storm_prep",
    town_name: "Ocean County"
  }
];

function toPublicMetaImageUrl(relImg) {
  const trimmed = String(relImg || "").trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/^http:\/\//i, "https://").replace(/\.webp$/i, ".jpg");
  }
  return `https://oceancountyroofingpros.com${trimmed.startsWith("/") ? "" : "/"}${trimmed.replace(/\.webp$/i, ".jpg")}`;
}

function normalizeSocialCaption(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

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
      `${supabaseUrl}/rest/v1/job_projects?approval_status=eq.pending_auto_24h&created_at=lt.${encodeURIComponent(cutoffIso)}`,
      { headers }
    );
    const pendingProjects = projRes.ok ? await projRes.json() : [];
    for (const p of pendingProjects) {
      await fetch(`${supabaseUrl}/rest/v1/job_projects?id=eq.${encodeURIComponent(p.id)}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ approval_status: "approved" })
      });
      promotedCount++;

      const town = p.town_name || p.town || "Ocean County, NJ";
      const caption = p.caption || p.ai_seo_summary || p.title || `Completed roofing project in ${town} by Ocean County Roofing Pros! Need a free 21-point roof & attic inspection (aerial drone diagnostics available upon request)? Call (732) 660-9121 or visit https://oceancountyroofingpros.com`;
      const imageUrl = p.image_geotagged_jpg_url || p.image_webp_url || p.image_url || p.photo_url || "";
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
            const baseCaption4b = (article.social_caption || `${article.title} — ${article.excerpt || "Ocean County Roofing Pros Local Guide"}`).trim();
            const caption4b = /\(732\)\s*660-9121|oceancountyroofingpros\.com/i.test(baseCaption4b)
              ? baseCaption4b
              : `${baseCaption4b}\n\nCall (732) 660-9121 or read the full local guide:`;
            const metaRes = await publishMetaWithCap({
              caption: caption4b,
              imageUrl: publicImageUrl,
              linkUrl: articleUrl,
              utmCampaign: "blog_guide_share",
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

      // 4B-2. Share already-published blog_posts with meta_shared=false (1 per run within cap)
      if (metaPostsSent < maxMetaPostsPerRun) {
        const unsharedBlogRes = await fetch(
          `${supabaseUrl}/rest/v1/blog_posts?status=eq.published&meta_shared=eq.false&order=published_at.asc&limit=5`,
          { headers }
        );
        const unsharedBlogs = unsharedBlogRes.ok ? await unsharedBlogRes.json() : [];
        const targetArticle = (Array.isArray(unsharedBlogs) ? unsharedBlogs : []).find(
          (a) => a && a.status === "published" && a.meta_shared !== true
        );
        if (targetArticle) {
          const articleUrl = `https://oceancountyroofingpros.com/blog/${targetArticle.slug}`;
          const publicImageUrl = toPublicMetaImageUrl(targetArticle.hero_image_url);
          try {
            const baseCaption4b2 = (targetArticle.social_caption || `${targetArticle.title} — ${targetArticle.excerpt || "Ocean County Roofing Pros Local Guide"}`).trim();
            const caption4b2 = /\(732\)\s*660-9121|oceancountyroofingpros\.com/i.test(baseCaption4b2)
              ? baseCaption4b2
              : `${baseCaption4b2}\n\nCall (732) 660-9121 or read the full local guide:`;
            const metaRes = await publishMetaWithCap({
              caption: caption4b2,
              imageUrl: publicImageUrl,
              linkUrl: articleUrl,
              utmCampaign: "blog_guide_share",
              pageId: sys.meta_page_id,
              igUserId: sys.meta_ig_user_id,
              pageToken: sys.meta_page_access_token
            });
            metaResults.push({ type: "blog_post_unshared", id: targetArticle.id, slug: targetArticle.slug, ...metaRes });
            if (metaRes?.facebook?.status === "published" || metaRes?.instagram?.status === "published" || metaRes?.status === "published") {
              await fetch(`${supabaseUrl}/rest/v1/blog_posts?id=eq.${encodeURIComponent(targetArticle.id)}`, {
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
    let autoSeededSocial = false;
    try {
      const nowIso = new Date().toISOString();
      const todayStr = nowIso.slice(0, 10);
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
          utmCampaign: sp.utm_campaign || "social_agent",
          pageId: sys.meta_page_id,
          igUserId: sys.meta_ig_user_id,
          pageToken: sys.meta_page_access_token
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
        } else if (!(metaRes.status === "skipped" && metaRes.reason === "daily_cap_reached")) {
          await fetch(`${supabaseUrl}/rest/v1/social_queue?id=eq.${encodeURIComponent(sp.id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({
              status: "failed",
              external_post_ids_json: JSON.stringify(metaRes),
              updated_at: nowIso
            })
          });
        }
      }

      // 4C-2. Auto-seed 1 unique post/day when social_queue has no pending scheduled posts for the day
      if (dueSocialPosts.length === 0 && metaPostsSent === 0 && metaPostsSent < maxMetaPostsPerRun) {
        const recentSqRes = await fetch(
          `${supabaseUrl}/rest/v1/social_queue?select=id,status,scheduled_for,published_at,caption,created_at&order=created_at.desc&limit=50`,
          { headers }
        );
        const recentSocial = recentSqRes.ok ? await recentSqRes.json() : [];
        const recentList = Array.isArray(recentSocial) ? recentSocial : [];
        const hasTodayPost = recentList.some((row) => {
          const schedDay = String(row?.scheduled_for || "").slice(0, 10);
          const pubDay = String(row?.published_at || "").slice(0, 10);
          return (row?.status === "scheduled" && schedDay === todayStr) ||
                 (row?.status === "published" && pubDay === todayStr);
        });

        if (!hasTodayPost) {
          const usedCaptions = new Set(
            recentList.map((r) => normalizeSocialCaption(r?.caption)).filter(Boolean)
          );
          const dayIndex = Math.floor(Date.now() / 86400000);

          const townCandidates = OCEAN_COUNTY_TOWN_PAGES.map((_, idx) => {
            const t = OCEAN_COUNTY_TOWN_PAGES[(dayIndex + idx) % OCEAN_COUNTY_TOWN_PAGES.length];
            return {
              caption: `Homeowners in ${t.town}, NJ: Protect your home against coastal wind & salt air with a GAF/CertainTeed architectural roof system. Book a free 21-point roof & attic inspection (aerial drone diagnostics available) at (732) 660-9121 or https://oceancountyroofingpros.com/${t.slug}`,
              image_url: t.image,
              link_url: `https://oceancountyroofingpros.com/${t.slug}`,
              utm_campaign: `town_${t.slug}`,
              town_name: t.town
            };
          });

          const unsharedGuideRes = await fetch(
            `${supabaseUrl}/rest/v1/blog_posts?status=eq.published&meta_shared=eq.false&order=published_at.asc&limit=5`,
            { headers }
          );
          const unsharedGuides = unsharedGuideRes.ok ? await unsharedGuideRes.json() : [];
          const blogCandidates = (Array.isArray(unsharedGuides) ? unsharedGuides : [])
            .filter((b) => b && b.status === "published" && b.meta_shared !== true)
            .map((b) => ({
              blog_post_id: b.id,
              caption: b.social_caption || `${b.title} — ${b.excerpt || "Read our Ocean County Roofing Pros homeowner guide."}`,
              image_url: toPublicMetaImageUrl(b.hero_image_url) || "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg",
              link_url: `https://oceancountyroofingpros.com/blog/${b.slug}`,
              utm_campaign: "blog_guide_auto_seed",
              town_name: "Ocean County"
            }));

          const tipCandidates = SEASONAL_ROOFING_TIPS.map((_, idx) => {
            return SEASONAL_ROOFING_TIPS[(dayIndex + idx) % SEASONAL_ROOFING_TIPS.length];
          });

          const pillarOrder = dayIndex % 3;
          const orderedPools = pillarOrder === 0
            ? [townCandidates, blogCandidates, tipCandidates]
            : pillarOrder === 1
              ? [blogCandidates, tipCandidates, townCandidates]
              : [tipCandidates, townCandidates, blogCandidates];

          const allCandidates = [...orderedPools[0], ...orderedPools[1], ...orderedPools[2]];
          let selected = allCandidates.find(
            (c) => c && c.caption && !usedCaptions.has(normalizeSocialCaption(c.caption))
          );
          if (!selected && allCandidates.length > 0) {
            // All candidates appeared in recent 50 rows; pick the least recently used one
            let oldestIdx = -1;
            for (const c of allCandidates) {
              if (!c || !c.caption) continue;
              const norm = normalizeSocialCaption(c.caption);
              const idx = recentList.findIndex((r) => normalizeSocialCaption(r?.caption) === norm);
              if (idx > oldestIdx) {
                oldestIdx = idx;
                selected = c;
              }
            }
          }

          if (selected) {
            const metaRes = await publishMetaWithCap({
              caption: selected.caption,
              imageUrl: selected.image_url || "",
              linkUrl: selected.link_url || "https://oceancountyroofingpros.com/#quizSection",
              utmCampaign: selected.utm_campaign || "auto_flywheel",
              pageId: sys.meta_page_id,
              igUserId: sys.meta_ig_user_id,
              pageToken: sys.meta_page_access_token
            });
            metaResults.push({ type: "social_queue_auto_seed", ...metaRes });

            const isPublished = metaRes?.facebook?.status === "published" || metaRes?.instagram?.status === "published" || metaRes?.status === "published";
            const seedRow = {
              id: `SQ-AUTO-${todayStr}-${Date.now().toString(36)}`,
              created_at: nowIso,
              updated_at: nowIso,
              caption: selected.caption,
              image_url: selected.image_url || "",
              link_url: selected.link_url || "https://oceancountyroofingpros.com/#quizSection",
              platforms: "facebook,instagram",
              utm_campaign: selected.utm_campaign || "auto_flywheel",
              town_name: selected.town_name || "Ocean County",
              status: isPublished ? "published" : (metaRes?.status === "skipped" ? "scheduled" : "failed"),
              scheduled_for: nowIso,
              published_at: isPublished ? nowIso : null,
              external_post_ids_json: JSON.stringify(metaRes),
              created_by: "auto_flywheel"
            };

            await fetch(`${supabaseUrl}/rest/v1/social_queue`, {
              method: "POST",
              headers: { ...headers, Prefer: "return=minimal" },
              body: JSON.stringify(seedRow)
            });

            if (isPublished && selected.blog_post_id) {
              await fetch(`${supabaseUrl}/rest/v1/blog_posts?id=eq.${encodeURIComponent(selected.blog_post_id)}`, {
                method: "PATCH",
                headers,
                body: JSON.stringify({ meta_shared: true, updated_at: nowIso })
              });
            }
            autoSeededSocial = true;
          }
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
        let pubRes = { status: "skipped", reason: "missing_external_id_or_draft" };
        if (item.external_id && item.ai_reply_draft) {
          pubRes = await MetaSocialService.replyToComment({
            commentId: item.external_id,
            message: item.ai_reply_draft
          });
        }
        const replyPublished = pubRes?.status === "published";
        await fetch(`${supabaseUrl}/rest/v1/social_interactions?id=eq.${encodeURIComponent(item.id)}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            reply_status: replyPublished ? "published" : "failed",
            published_reply_id: pubRes?.id || "",
            updated_at: nowIso
          })
        });
        if (replyPublished) promotedCount++;
      }
    } catch (e) {}

    // 5. Trigger Netlify Build Hook & IndexNow Ping only when new proof/reviews/blog posts published
    let rebuildTriggered = false;
    let indexNowPinged = false;
    const buildHook = (sys.netlify_build_hook_url || "").trim() || (process.env.NETLIFY_BUILD_HOOK_URL || "").trim();
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
        auto_seeded_social: autoSeededSocial,
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
