import test from "node:test";
import assert from "node:assert/strict";
import { MetaSocialService } from "../netlify/functions/services/meta-social-service.mjs";

test("MetaSocialService publishes photo post to both Facebook Page and Instagram Business", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  process.env.META_PAGE_ID = "1466735946524886";
  process.env.META_IG_USER_ID = "17841451222467033";
  process.env.META_ACCESS_TOKEN = "test_meta_token";

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    if (String(url).endsWith("/1466735946524886/photos")) {
      return { ok: true, status: 200, json: async () => ({ id: "fb_photo_1", post_id: "1466735946524886_999" }) };
    }
    if (String(url).endsWith("/17841451222467033/media")) {
      return { ok: true, status: 200, json: async () => ({ id: "ig_container_1" }) };
    }
    if (String(url).endsWith("/17841451222467033/media_publish")) {
      return { ok: true, status: 200, json: async () => ({ id: "ig_media_1" }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const res = await MetaSocialService.publishPost({
      caption: "CertainTeed Landmark PRO install in Toms River, NJ!",
      imageUrl: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg"
    });
    assert.equal(res.status, "published");
    assert.equal(res.facebook.status, "published");
    assert.equal(res.facebook.id, "1466735946524886_999");
    assert.equal(res.instagram.status, "published");
    assert.equal(res.instagram.id, "ig_media_1");
    assert.equal(calls.length, 3);
  } finally {
    global.fetch = originalFetch;
  }
});

test("MetaSocialService falls back to Facebook feed post and skips Instagram when no imageUrl", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  process.env.META_PAGE_ID = "1466735946524886";
  process.env.META_IG_USER_ID = "17841451222467033";
  process.env.META_ACCESS_TOKEN = "test_meta_token";

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ id: "1466735946524886_feed_1" }) };
  };

  try {
    const res = await MetaSocialService.publishPost({
      caption: "24/7 Emergency Tarping active across Ocean County",
      linkUrl: "https://oceancountyroofingpros.com"
    });
    assert.equal(res.status, "published");
    assert.equal(res.facebook.status, "published");
    assert.equal(res.instagram.status, "skipped");
    assert.equal(res.instagram.reason, "instagram_requires_public_https_image_url");
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/1466735946524886\/feed$/);
  } finally {
    global.fetch = originalFetch;
  }
});
