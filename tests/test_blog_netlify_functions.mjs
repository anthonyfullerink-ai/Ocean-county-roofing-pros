import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import adminHandler from "../netlify/functions/api-admin.mjs";
import flywheelHandler from "../netlify/functions/cron-seo-flywheel.mjs";

test("Netlify api-admin.mjs handles bootstrap + blog CRUD + publish Meta cross-post", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_supabase_key";
  process.env.ADMIN_USERNAME = "admin";
  process.env.ADMIN_PASSWORD = "test_password";
  process.env.META_PAGE_ID = "1466735946524886";
  process.env.META_IG_USER_ID = "17841451222467033";
  process.env.META_ACCESS_TOKEN = "test_meta_token";

  const mockPosts = [
    {
      id: "BLOG-OC-101",
      slug: "ocean-county-coastal-wind-ratings-110-vs-130-vs-160-mph",
      title: "Coastal Wind Ratings",
      status: "published"
    }
  ];
  const calls = [];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });

    if (u.includes("/rest/v1/blog_posts") && method === "GET") {
      return new Response(JSON.stringify(mockPosts), { status: 200 });
    }
    if (u.includes("/rest/v1/blog_posts") && method === "POST") {
      const row = JSON.parse(opts.body);
      mockPosts.unshift(row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }
    if (u.includes("/rest/v1/blog_posts") && method === "PATCH") {
      const patch = JSON.parse(opts.body);
      const updated = {
        id: "BLOG-NODE-1",
        slug: "brick-nj-coastal-roof-checklist",
        title: "Brick NJ Coastal Roof Checklist",
        excerpt: "Compare GAF, CertainTeed, and Owens Corning.",
        hero_image_url: "/static/blog/brick-nj-coastal-roof-checklist/hero.webp",
        ...patch
      };
      return new Response(JSON.stringify([updated]), { status: 200 });
    }
    if (u.includes("/rest/v1/blog_posts") && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && u.endsWith("/photos")) {
      return new Response(JSON.stringify({ id: "fb_1", post_id: "1466_1" }), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && u.endsWith("/media")) {
      return new Response(JSON.stringify({ id: "ig_container_1" }), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && u.endsWith("/media_publish")) {
      return new Response(JSON.stringify({ id: "ig_1" }), { status: 200 });
    }
    if (u.includes("/rest/v1/")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${method} ${u}`);
  };

  try {
    // 1. Login -> obtain HMAC session Bearer token
    const authRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password: "test_password" })
      })
    );
    assert.equal(authRes.status, 200);
    const { token } = await authRes.json();
    assert.ok(token);
    const authHeaders = { Authorization: `Bearer ${token}` };

    // 2. Bootstrap includes blog_posts
    const bootRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/bootstrap", {
        method: "GET",
        headers: authHeaders
      })
    );
    assert.equal(bootRes.status, 200);
    const bootJson = await bootRes.json();
    assert.equal(bootJson.blog_posts.length, 1);

    // 3. Create blog post (published -> auto_publish_at must be null, not "")
    const pubPostRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          id: "BLOG-WITH-LEADS-1",
          title: "Brick NJ Leads & Settings Roof Cost Guide",
          status: "published",
          target_towns: "Brick",
          excerpt: "Compare GAF, CertainTeed, and Owens Corning."
        })
      })
    );
    assert.equal(pubPostRes.status, 200);
    const pubPostCall = calls.filter(c => c.u.includes("/rest/v1/blog_posts") && c.method === "POST").pop();
    assert.equal(pubPostCall.body.auto_publish_at, null);

    // 3B. Action on ID containing "leads" is not hijacked by /leads handler, and draft sets auto_publish_at
    const draftActRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog/BLOG-WITH-LEADS-1/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ action: "draft" })
      })
    );
    assert.equal(draftActRes.status, 200);
    const draftPatchCall = calls.filter(c => c.u.includes("id=eq.BLOG-WITH-LEADS-1") && c.method === "PATCH").pop();
    assert.equal(draftPatchCall.body.status, "draft_auto_24h");
    assert.ok(Date.parse(draftPatchCall.body.auto_publish_at) > Date.now());

    // 3C. PATCH serializes target_towns -> target_towns_json, coerces empty timestamps to null, and clears auto_publish_at when status=published
    const patchRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog/BLOG-WITH-LEADS-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ target_towns: ["Brick", "Toms River"], auto_publish_at: "" })
      })
    );
    assert.equal(patchRes.status, 200);
    const patchBody = calls.filter(c => c.u.includes("id=eq.BLOG-WITH-LEADS-1") && c.method === "PATCH").pop().body;
    assert.equal(patchBody.auto_publish_at, null);
    assert.equal(patchBody.target_towns, undefined);
    assert.ok(patchBody.target_towns_json.includes("roofing-brick-nj"));

    const patchPubRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog/BLOG-WITH-LEADS-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ status: "published" })
      })
    );
    assert.equal(patchPubRes.status, 200);
    const patchPubBody = calls.filter(c => c.u.includes("id=eq.BLOG-WITH-LEADS-1") && c.method === "PATCH").pop().body;
    assert.equal(patchPubBody.status, "published");
    assert.equal(patchPubBody.auto_publish_at, null);
    assert.ok(patchPubBody.published_at);

    // 3D. Create draft blog post
    const postRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({
          id: "BLOG-NODE-1",
          title: "Brick NJ Coastal Roof Checklist",
          category: "Coastal Engineering",
          target_towns: "Brick, Toms River",
          hero_image_url: "/static/blog/brick-nj-coastal-roof-checklist/hero.webp",
          excerpt: "Compare GAF, CertainTeed, and Owens Corning."
        })
      })
    );
    assert.equal(postRes.status, 200);
    const postJson = await postRes.json();
    assert.equal(postJson.post.slug, "brick-nj-coastal-roof-checklist");

    // 4. Publish action + Meta cross-post converts .webp -> .jpg public HTTPS URL
    const actRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog/BLOG-NODE-1/action", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders },
        body: JSON.stringify({ action: "publish", share_meta: true })
      })
    );
    assert.equal(actRes.status, 200);
    const actJson = await actRes.json();
    const publishPatchCall = calls.filter(c => c.u.includes("id=eq.BLOG-NODE-1") && c.method === "PATCH").find(c => c.body?.status === "published");
    assert.equal(publishPatchCall.body.auto_publish_at, null);
    assert.equal(actJson.meta.status, "published");
    assert.equal(actJson.meta.facebook.status, "published");
    assert.equal(actJson.meta.instagram.status, "published");
    const igCreateCall = calls.find(c => c.u.endsWith("/17841451222467033/media"));
    assert.equal(
      igCreateCall.body.image_url,
      "https://oceancountyroofingpros.com/static/blog/brick-nj-coastal-roof-checklist/hero.jpg"
    );

    // 5. Delete post
    const delRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/blog/BLOG-NODE-1", {
        method: "DELETE",
        headers: authHeaders
      })
    );
    assert.equal(delRes.status, 200);
    assert.equal((await delRes.json()).deleted_id, "BLOG-NODE-1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Netlify cron-seo-flywheel.mjs promotes expired 24h blog_posts, publishes Meta teaser, and pings IndexNow", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_supabase_key";
  process.env.META_PAGE_ID = "1466735946524886";
  process.env.META_IG_USER_ID = "17841451222467033";
  process.env.META_ACCESS_TOKEN = "test_meta_token";

  const calls = [];
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    calls.push({ u, method, body: opts.body ? JSON.parse(opts.body) : null });

    if (u.includes("/rest/v1/system_settings")) {
      return new Response(
        JSON.stringify([
          { key: "auto_publish_24h", value: "true" },
          { key: "auto_seo_rebuild_enabled", value: "true" },
          { key: "netlify_build_hook_url", value: "https://api.netlify.com/build_hooks/test123" }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/blog_posts") && method === "GET") {
      return new Response(
        JSON.stringify([
          {
            id: "BLOG-AUTO-24H",
            slug: "point-pleasant-coastal-skylight-flashing",
            title: "Point Pleasant Coastal Skylight Flashing",
            excerpt: "VELUX and step flashing protection for NJ Shore homes.",
            hero_image_url: "/static/blog/point-pleasant-coastal-skylight-flashing/hero.webp",
            auto_publish_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            meta_shared: false
          },
          {
            id: "BLOG-FUTURE-24H",
            slug: "future-queued-draft",
            title: "Future Queued Draft",
            excerpt: "Should wait until auto_publish_at expires.",
            hero_image_url: "/static/images/shingle-restored-after.webp",
            created_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
            auto_publish_at: new Date(Date.now() + 18 * 60 * 60 * 1000).toISOString(),
            meta_shared: false
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/blog_posts") && method === "PATCH") {
      return new Response(JSON.stringify([{ id: "BLOG-AUTO-24H" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && u.endsWith("/photos")) {
      return new Response(JSON.stringify({ id: "fb_b1", post_id: "1466_b1" }), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && u.endsWith("/media")) {
      return new Response(JSON.stringify({ id: "ig_b_container" }), { status: 200 });
    }
    if (u.includes("graph.facebook.com") && u.endsWith("/media_publish")) {
      return new Response(JSON.stringify({ id: "ig_b1" }), { status: 200 });
    }
    if (u.includes("api.netlify.com/build_hooks/test123")) {
      return new Response("ok", { status: 200 });
    }
    if (u === "https://api.indexnow.org/indexnow") {
      return new Response("ok", { status: 200 });
    }
    throw new Error(`Unexpected fetch URL: ${method} ${u}`);
  };

  try {
    const res = await flywheelHandler(new Request("https://oceancountyroofingpros.com/.netlify/functions/cron-seo-flywheel"));
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "success");
    assert.equal(data.promoted_count, 1);
    assert.equal(data.rebuild_triggered, true);
    assert.equal(data.indexnow_pinged, true);

    const statusPatch = calls.find(c => c.u.includes("id=eq.BLOG-AUTO-24H") && c.body?.status === "published");
    assert.ok(statusPatch, "Expected PATCH promoting BLOG-AUTO-24H to published");
    assert.equal(statusPatch.body.auto_publish_at, null);

    const futurePatch = calls.find(c => c.u.includes("id=eq.BLOG-FUTURE-24H") && c.body?.status === "published");
    assert.equal(futurePatch, undefined, "Expected BLOG-FUTURE-24H with future auto_publish_at not to be promoted");

    const metaPatch = calls.find(c => c.u.includes("id=eq.BLOG-AUTO-24H") && c.body?.meta_shared === true);
    assert.ok(metaPatch, "Expected PATCH marking meta_shared=true");

    const idxCall = calls.find(c => c.u === "https://api.indexnow.org/indexnow");
    assert.ok(idxCall.body.urlList.includes("https://oceancountyroofingpros.com/blog"));
    assert.ok(idxCall.body.urlList.includes("https://oceancountyroofingpros.com/blog/point-pleasant-coastal-skylight-flashing"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("admin_control_plane.js previewBlogPost renders question/answer, q/a FAQs, and s.callout", () => {
  const jsPath = path.resolve("app/static/js/admin_control_plane.js");
  const code = fs.readFileSync(jsPath, "utf8");
  const iframeStub = {
    src: "",
    srcdoc: "",
    style: {},
    getAttribute(attr) { return this[attr] || null; },
    hasAttribute(attr) { return Boolean(this[attr]); },
    removeAttribute(attr) { delete this[attr]; }
  };
  const elements = { livePreviewIframe: iframeStub };
  const context = vm.createContext({
    console,
    URL,
    localStorage: { getItem: () => null, setItem: () => {} },
    document: {
      addEventListener: () => {},
      getElementById: (id) => elements[id] || null,
      querySelectorAll: () => []
    },
    window: {},
    switchRightTab: () => {}
  });
  vm.runInContext(code, context);
  vm.runInContext(
    `STATE.blog_posts = [{
      id: "BLOG-PREVIEW-1",
      slug: "draft-preview-guide",
      status: "draft_auto_24h",
      title: "Draft Preview Guide",
      category: "Coastal Materials",
      excerpt: "Preview summary.",
      target_towns: [{ label: "Toms River", slug: "roofing-toms-river-nj" }],
      sections: [
        null,
        {
          heading: "Section One",
          paragraphs: ["Body copy"],
          bullets: ["Bullet one"],
          table: {
            headers: ["Tier", "Rating"],
            rows: [["Coastal", "160 MPH"]]
          },
          callout: { title: "Coastal Note", body: "Important wind uplift note." }
        },
        {
          heading: "Section Two",
          paragraphs: ["More copy"],
          callout: "String callout fallback."
        },
        {
          heading: "Section Three",
          paragraphs: ["Blank callout test"],
          callout: "   "
        }
      ],
      faqs: [
        null,
        { question: "Modern Question?", answer: "Modern Answer." },
        { q: "Legacy Q?", a: "Legacy A." }
      ]
    }];
    previewBlogPost("BLOG-PREVIEW-1");`,
    context
  );
  assert.ok(iframeStub.srcdoc.includes("Coastal Note"));
  assert.ok(iframeStub.srcdoc.includes("Important wind uplift note."));
  assert.ok(iframeStub.srcdoc.includes("String callout fallback."));
  assert.ok(iframeStub.srcdoc.includes("<table"));
  assert.ok(iframeStub.srcdoc.includes("160 MPH"));
  assert.ok(iframeStub.srcdoc.includes("Modern Question?"));
  assert.ok(iframeStub.srcdoc.includes("Modern Answer."));
  assert.ok(iframeStub.srcdoc.includes("Legacy Q?"));
  assert.ok(iframeStub.srcdoc.includes("Legacy A."));
});
