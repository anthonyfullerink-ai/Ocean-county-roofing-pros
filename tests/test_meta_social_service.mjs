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

test("MetaSocialService uses graph.instagram.com when standalone IG_ACCESS_TOKEN is set", async () => {
  const calls = [];
  const originalFetch = global.fetch;
  process.env.META_PAGE_ID = "1466735946524886";
  process.env.META_IG_USER_ID = "17841451222467033";
  process.env.META_ACCESS_TOKEN = "fb_page_token";
  process.env.IG_ACCESS_TOKEN = "standalone_ig_token";

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    if (String(url).startsWith("https://graph.facebook.com/v21.0/1466735946524886/photos")) {
      return { ok: true, status: 200, json: async () => ({ id: "fb_photo_2", post_id: "1466735946524886_888" }) };
    }
    if (String(url) === "https://graph.instagram.com/v21.0/17841451222467033/media") {
      assert.equal(body.access_token, "standalone_ig_token");
      return { ok: true, status: 200, json: async () => ({ id: "ig_standalone_c1" }) };
    }
    if (String(url) === "https://graph.instagram.com/v21.0/17841451222467033/media_publish") {
      assert.equal(body.access_token, "standalone_ig_token");
      return { ok: true, status: 200, json: async () => ({ id: "ig_standalone_p1" }) };
    }
    throw new Error(`Unexpected URL: ${url}`);
  };

  try {
    const res = await MetaSocialService.publishPost({
      caption: "Standalone IG Login publish test",
      imageUrl: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg"
    });
    assert.equal(res.status, "published");
    assert.equal(res.facebook.status, "published");
    assert.equal(res.instagram.status, "published");
    assert.equal(res.instagram.id, "ig_standalone_p1");
    assert.equal(calls.length, 3);
  } finally {
    delete process.env.IG_ACCESS_TOKEN;
    global.fetch = originalFetch;
  }
});

test("MetaSocialService.publishToFacebookPage appends tracked linkUrl to /photos caption only when not already present", async () => {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url: String(url), body });
    return { ok: true, status: 200, json: async () => ({ id: "fb_photo_utm_1", post_id: "1466735946524886_777" }) };
  };

  try {
    await MetaSocialService.publishToFacebookPage({
      pageId: "1466735946524886",
      token: "fb_token",
      caption: "Ocean County Coastal Wind Ratings Explained",
      imageUrl: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg",
      linkUrl: "https://oceancountyroofingpros.com/blog/wind-ratings",
      utmCampaign: "blog_guide_share"
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0].body.message, /https:\/\/oceancountyroofingpros\.com\/blog\/wind-ratings\?utm_source=facebook&utm_medium=social&utm_campaign=blog_guide_share/);

    await MetaSocialService.publishToFacebookPage({
      pageId: "1466735946524886",
      token: "fb_token",
      caption: "Check out https://oceancountyroofingpros.com/blog/wind-ratings for details",
      imageUrl: "https://oceancountyroofingpros.com/static/images/hero-drone-poster.jpg",
      linkUrl: "https://oceancountyroofingpros.com/blog/wind-ratings",
      utmCampaign: "blog_guide_share"
    });
    assert.equal(calls.length, 2);
    assert.equal(calls[1].body.message, "Check out https://oceancountyroofingpros.com/blog/wind-ratings for details");
  } finally {
    global.fetch = originalFetch;
  }
});
