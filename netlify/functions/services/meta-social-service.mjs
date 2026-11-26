/**
 * Meta Graph API Social Publisher (Facebook Page + Instagram Business)
 * Uses META_ACCESS_TOKEN, META_PAGE_ID, META_IG_USER_ID, and optional standalone
 * IG_ACCESS_TOKEN (Instagram API with Instagram Login via graph.instagram.com).
 */

const GRAPH_BASE_URL = "https://graph.facebook.com/v21.0";
const IG_GRAPH_BASE_URL = "https://graph.instagram.com/v21.0";

export class MetaSocialService {
  static isPublicHttpsUrl(url) {
    return typeof url === "string" && /^https:\/\/.+/i.test(url.trim());
  }

  static appendSocialUtm(linkUrl, { source = "facebook", campaign = "social_agent" } = {}) {
    const raw = (this.isPublicHttpsUrl(linkUrl) ? linkUrl.trim() : "https://oceancountyroofingpros.com");
    try {
      const u = new URL(raw);
      if (!u.searchParams.has("utm_source")) u.searchParams.set("utm_source", source || "facebook");
      if (!u.searchParams.has("utm_medium")) u.searchParams.set("utm_medium", "social");
      if (!u.searchParams.has("utm_campaign")) u.searchParams.set("utm_campaign", campaign || "social_agent");
      return u.toString();
    } catch {
      return raw;
    }
  }

  static extractPhoneNumber(text = "") {
    const m = String(text || "").match(/(?:\+?1[-.\s]?)?\(?([2-9]\d{2})\)?[-.\s]?(\d{3})[-.\s]?(\d{4})/);
    if (!m) return "";
    return `+1${m[1]}${m[2]}${m[3]}`;
  }

  static classifySocialMessage({ text = "", interactionType = "comment", rating = 0, authorName = "Neighbor", town = "Ocean County" } = {}) {
    const lower = String(text || "").toLowerCase();
    const numRating = Number(rating) || 0;

    if (interactionType === "review" && numRating > 0 && numRating <= 3) {
      return {
        intent: "NEGATIVE_REVIEW",
        reply_status: "pending_approval",
        requires_owner_alert: true,
        draft: `Thank you for sharing your feedback, ${authorName}. Homeowner satisfaction in ${town} is our top priority — our manager has reviewed your note and is reaching out directly today to make this right. Please call us anytime at (732) 660-9121.`
      };
    }

    if (interactionType === "review" && numRating >= 4) {
      return {
        intent: "POSITIVE_REVIEW",
        reply_status: "auto_24h",
        requires_owner_alert: false,
        draft: `Thank you so much for the ${numRating}-star recommendation, ${authorName}! Our crew loves serving homeowners across ${town} & Ocean County. Enjoy peace of mind knowing your home is backed by our 21-point inspection and 50-year manufacturer warranty options!`
      };
    }

    if (/(crypto|bitcoin|whatsapp|telegram|seo services|backlink|dm me for promo|onlyfans|forex)/i.test(lower)) {
      return {
        intent: "SPAM_OR_TROLL",
        reply_status: "ignored",
        requires_owner_alert: false,
        draft: ""
      };
    }

    if (/(leak|water|dripping|ceiling|emergency|storm|tree fell|missing shingle|tarp)/i.test(lower)) {
      return {
        intent: "EMERGENCY_LEAK",
        reply_status: "auto_reply",
        requires_owner_alert: true,
        draft: `We're here to help right away! For urgent roof leaks in Ocean County, call our 24/7 dispatch desk at (732) 660-9121 or message us your street address & phone number so our on-call crew can prioritize triage.`
      };
    }

    if (/(how much|price|cost|estimate|quote|book|schedule|inspect|availability|financing|replace|repair)/i.test(lower)) {
      return {
        intent: "PRICE_OR_INSPECTION_INQUIRY",
        reply_status: "auto_reply",
        requires_owner_alert: false,
        draft: `Great question! Every home in Ocean County varies by roof size & pitch — you can get a 60-second estimate or book a free 21-point roof & attic inspection at https://oceancountyroofingpros.com/#quizSection (or call/text (732) 660-9121).`
      };
    }

    if (/(scam|rip off|terrible|worst|awful|never showed|rude|horrible|angry)/i.test(lower)) {
      return {
        intent: "NEGATIVE_REVIEW",
        reply_status: "pending_approval",
        requires_owner_alert: true,
        draft: `We take this seriously and want to look into it right away. Please reach out to our management desk at (732) 660-9121 or info@oceancountyroofingpros.com so we can resolve this directly.`
      };
    }

    if (/(great|awesome|looks amazing|nice work|clean|love it|thank|congrats|🔥|👏|👍)/i.test(lower)) {
      return {
        intent: "COMPLIMENT",
        reply_status: "auto_reply",
        requires_owner_alert: false,
        draft: `Thank you! Our Ocean County crews take huge pride in clean, coastal-grade roof installations. Let us know anytime you need a free 21-point roof & attic check!`
      };
    }

    return {
      intent: "GENERAL",
      reply_status: "auto_reply",
      requires_owner_alert: false,
      draft: `Thanks for reaching out to Ocean County Roofing Pros! Call or text us anytime at (732) 660-9121 or grab a fast estimate at https://oceancountyroofingpros.com/#quizSection.`
    };
  }

  static async publishToFacebookPage({ pageId, token, caption, imageUrl = "", linkUrl = "", utmCampaign = "social_agent" }) {
    if (!pageId || !token) {
      return { status: "skipped", reason: "missing_page_id_or_token" };
    }

    const usePhotoEndpoint = this.isPublicHttpsUrl(imageUrl);
    const endpoint = usePhotoEndpoint
      ? `${GRAPH_BASE_URL}/${encodeURIComponent(pageId)}/photos`
      : `${GRAPH_BASE_URL}/${encodeURIComponent(pageId)}/feed`;

    const trackedLink = this.appendSocialUtm(linkUrl, { source: "facebook", campaign: utmCampaign });
    const payload = usePhotoEndpoint
      ? { url: imageUrl.trim(), message: caption, access_token: token }
      : {
          message: caption,
          link: trackedLink,
          access_token: token
        };

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      return { status: "error", code: res.status, error: data?.error?.message || JSON.stringify(data) };
    }
    return { status: "published", id: data.post_id || data.id };
  }

  static async publishToInstagram({ igUserId, token, igToken = "", caption, imageUrl = "" }) {
    const standaloneIgToken = (igToken || process.env.IG_ACCESS_TOKEN || process.env.META_IG_ACCESS_TOKEN || "").trim();
    const resolvedToken = standaloneIgToken || (token || "").trim();
    const baseUrl = standaloneIgToken ? IG_GRAPH_BASE_URL : GRAPH_BASE_URL;
    const resolvedIgId = (igUserId || (standaloneIgToken ? "me" : "")).trim();

    if (!resolvedIgId || !resolvedToken) {
      return { status: "skipped", reason: "missing_ig_user_id_or_token" };
    }
    if (!this.isPublicHttpsUrl(imageUrl)) {
      return { status: "skipped", reason: "instagram_requires_public_https_image_url" };
    }

    const createRes = await fetch(`${baseUrl}/${encodeURIComponent(resolvedIgId)}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl.trim(),
        caption,
        access_token: resolvedToken
      })
    });
    const createData = await createRes.json();
    if (!createRes.ok || !createData?.id) {
      return {
        status: "error",
        stage: "create_container",
        code: createRes.status,
        error: createData?.error?.message || JSON.stringify(createData)
      };
    }

    const publishRes = await fetch(`${baseUrl}/${encodeURIComponent(resolvedIgId)}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: createData.id,
        access_token: resolvedToken
      })
    });
    const publishData = await publishRes.json();
    if (!publishRes.ok || !publishData?.id) {
      return {
        status: "error",
        stage: "media_publish",
        code: publishRes.status,
        error: publishData?.error?.message || JSON.stringify(publishData)
      };
    }
    return { status: "published", id: publishData.id };
  }

  static async replyToComment({ commentId, message, token = "" }) {
    const resolvedToken = (token || process.env.META_ACCESS_TOKEN || "").trim();
    if (!commentId || !message || !resolvedToken) {
      return { status: "skipped", reason: "missing_comment_id_message_or_token" };
    }
    const res = await fetch(`${GRAPH_BASE_URL}/${encodeURIComponent(commentId)}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, access_token: resolvedToken })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: "error", code: res.status, error: data?.error?.message || JSON.stringify(data) };
    }
    return { status: "published", id: data.id || "" };
  }

  static async sendPageDm({ recipientId, message, token = "" }) {
    const resolvedToken = (token || process.env.META_ACCESS_TOKEN || "").trim();
    if (!recipientId || !message || !resolvedToken) {
      return { status: "skipped", reason: "missing_recipient_message_or_token" };
    }
    const res = await fetch(`${GRAPH_BASE_URL}/me/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        messaging_type: "RESPONSE",
        access_token: resolvedToken
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: "error", code: res.status, error: data?.error?.message || JSON.stringify(data) };
    }
    return { status: "published", id: data.message_id || "" };
  }

  static async sendIgDm({ igUserId = "", recipientId, message, token = "" }) {
    const resolvedToken = (token || process.env.META_ACCESS_TOKEN || "").trim();
    const resolvedIg = (igUserId || process.env.META_IG_USER_ID || "").trim();
    if (!resolvedIg || !recipientId || !message || !resolvedToken) {
      return { status: "skipped", reason: "missing_ig_id_recipient_or_token" };
    }
    const res = await fetch(`${GRAPH_BASE_URL}/${encodeURIComponent(resolvedIg)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: message },
        access_token: resolvedToken
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: "error", code: res.status, error: data?.error?.message || JSON.stringify(data) };
    }
    return { status: "published", id: data.message_id || "" };
  }

  static async fetchPageRatings({ pageId = "", token = "" } = {}) {
    const resolvedToken = (token || process.env.META_ACCESS_TOKEN || "").trim();
    const resolvedPage = (pageId || process.env.META_PAGE_ID || "").trim();
    if (!resolvedPage || !resolvedToken) {
      return { status: "skipped", ratings: [] };
    }
    const res = await fetch(
      `${GRAPH_BASE_URL}/${encodeURIComponent(resolvedPage)}/ratings?fields=created_time,rating,recommendation_type,review_text,reviewer{id,name},open_graph_story{id}&limit=25&access_token=${encodeURIComponent(resolvedToken)}`
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { status: "error", code: res.status, error: data?.error?.message || JSON.stringify(data), ratings: [] };
    }
    return { status: "success", ratings: Array.isArray(data?.data) ? data.data : [] };
  }

  /**
   * Publish a promoted project, GBP post, or SEO blog guide to both Facebook Page & Instagram Business
   */
  static async publishPost({ caption, imageUrl = "", linkUrl = "", pageId = "", igUserId = "", pageToken = "", igToken = "", utmCampaign = "social_agent" }) {
    const token = (pageToken || process.env.META_ACCESS_TOKEN || "").trim();
    const standaloneIgToken = (igToken || process.env.IG_ACCESS_TOKEN || process.env.META_IG_ACCESS_TOKEN || "").trim();
    const resolvedPageId = (pageId || process.env.META_PAGE_ID || "").trim();
    const resolvedIgUserId = (igUserId || process.env.META_IG_USER_ID || "").trim();

    if ((!token || !resolvedPageId) && !standaloneIgToken) {
      return { status: "skipped", reason: "Meta Graph API credentials not configured" };
    }

    const fb = token && resolvedPageId
      ? await this.publishToFacebookPage({ pageId: resolvedPageId, token, caption, imageUrl, linkUrl, utmCampaign })
      : { status: "skipped", reason: "missing_fb_page_id_or_token" };
    const ig = await this.publishToInstagram({ igUserId: resolvedIgUserId, token, igToken: standaloneIgToken, caption, imageUrl });

    return {
      status: fb.status === "published" || ig.status === "published" ? "published" : "partial_or_error",
      facebook: fb,
      instagram: ig
    };
  }
}
