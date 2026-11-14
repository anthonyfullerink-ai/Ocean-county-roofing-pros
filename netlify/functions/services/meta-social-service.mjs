/**
 * Meta Graph API Social Publisher (Facebook Page + Instagram Business)
 * Uses META_ACCESS_TOKEN, META_PAGE_ID, and META_IG_USER_ID from environment variables.
 */

const GRAPH_BASE_URL = "https://graph.facebook.com/v21.0";

export class MetaSocialService {
  static isPublicHttpsUrl(url) {
    return typeof url === "string" && /^https:\/\/.+/i.test(url.trim());
  }

  static async publishToFacebookPage({ pageId, token, caption, imageUrl = "", linkUrl = "" }) {
    if (!pageId || !token) {
      return { status: "skipped", reason: "missing_page_id_or_token" };
    }

    const usePhotoEndpoint = this.isPublicHttpsUrl(imageUrl);
    const endpoint = usePhotoEndpoint
      ? `${GRAPH_BASE_URL}/${encodeURIComponent(pageId)}/photos`
      : `${GRAPH_BASE_URL}/${encodeURIComponent(pageId)}/feed`;

    const payload = usePhotoEndpoint
      ? { url: imageUrl.trim(), message: caption, access_token: token }
      : {
          message: caption,
          link: this.isPublicHttpsUrl(linkUrl) ? linkUrl.trim() : "https://oceancountyroofingpros.com",
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

  static async publishToInstagram({ igUserId, token, caption, imageUrl = "" }) {
    if (!igUserId || !token) {
      return { status: "skipped", reason: "missing_ig_user_id_or_token" };
    }
    if (!this.isPublicHttpsUrl(imageUrl)) {
      return { status: "skipped", reason: "instagram_requires_public_https_image_url" };
    }

    const createRes = await fetch(`${GRAPH_BASE_URL}/${encodeURIComponent(igUserId)}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image_url: imageUrl.trim(),
        caption,
        access_token: token
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

    const publishRes = await fetch(`${GRAPH_BASE_URL}/${encodeURIComponent(igUserId)}/media_publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        creation_id: createData.id,
        access_token: token
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

  /**
   * Publish a promoted project, GBP post, or SEO blog guide to both Facebook Page & Instagram Business
   */
  static async publishPost({ caption, imageUrl = "", linkUrl = "", pageId = "", igUserId = "", pageToken = "" }) {
    const token = (pageToken || process.env.META_ACCESS_TOKEN || "").trim();
    const resolvedPageId = (pageId || process.env.META_PAGE_ID || "").trim();
    const resolvedIgUserId = (igUserId || process.env.META_IG_USER_ID || "").trim();

    if (!token || !resolvedPageId) {
      return { status: "skipped", reason: "Meta Graph API credentials not configured" };
    }

    const fb = await this.publishToFacebookPage({ pageId: resolvedPageId, token, caption, imageUrl, linkUrl });
    const ig = await this.publishToInstagram({ igUserId: resolvedIgUserId, token, caption, imageUrl });

    return {
      status: fb.status === "published" || ig.status === "published" ? "published" : "partial_or_error",
      facebook: fb,
      instagram: ig
    };
  }
}
