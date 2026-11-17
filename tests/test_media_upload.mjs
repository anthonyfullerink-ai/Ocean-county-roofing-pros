import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import mediaUploadHandler, {
  resolveTownInfo,
  generateLocalizedSeoSummary,
  injectExifIntoJpeg
} from "../netlify/functions/api-media-upload.mjs";

function makeMinimalJpeg() {
  // SOI (FF D8) + APP0 (FF E0 00 10 ...) + SOS (FF DA) + dummy entropy + EOI (FF D9)
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00,
    0xaa, 0xbb,
    0xff, 0xd9
  ]);
}

test("netlify.toml routes /api/media/upload to /.netlify/functions/api-media-upload", () => {
  const tomlPath = path.resolve(process.cwd(), "netlify.toml");
  const toml = fs.readFileSync(tomlPath, "utf8");
  assert.match(toml, /from\s*=\s*"\/api\/media\/upload"/);
  assert.match(toml, /to\s*=\s*"\/\.netlify\/functions\/api-media-upload"/);
});

test("resolveTownInfo and generateLocalizedSeoSummary resolve Ocean County towns", () => {
  const brick = resolveTownInfo("roofing-brick-nj");
  assert.equal(brick.town_name, "Brick Township");
  assert.equal(brick.lat, 40.0598);

  const barnegat = resolveTownInfo("08005");
  assert.equal(barnegat.slug, "roofing-barnegat-nj");

  const fallback = resolveTownInfo("unknown-town");
  assert.equal(fallback.slug, "roofing-toms-river-nj");

  const summary = generateLocalizedSeoSummary({
    townInfo: brick,
    neighborhood: "Herbertsville",
    serviceType: "Full Roof Replacement",
    shingleSystem: "CertainTeed Landmark PRO",
    caption: "Completed architectural roof."
  });
  assert.ok(summary.includes("Herbertsville section of Brick Township, NJ (08723)"));
  assert.ok(summary.includes("CertainTeed Landmark PRO"));
});

test("injectExifIntoJpeg embeds valid APP1 Exif GPS header and leaves non-JPEG untouched", () => {
  const jpeg = makeMinimalJpeg();
  const stamped = injectExifIntoJpeg(jpeg, 40.0598, -74.1399, "Brick NJ Roof");

  assert.equal(stamped[0], 0xff);
  assert.equal(stamped[1], 0xd8);
  assert.equal(stamped[2], 0xff);
  assert.equal(stamped[3], 0xe1); // APP1
  assert.equal(stamped.subarray(6, 12).toString("ascii"), "Exif\0\0");
  assert.equal(stamped.subarray(12, 14).toString("ascii"), "MM");
  assert.ok(stamped.includes(Buffer.from("Ocean County Roofing Pros SEO Geo-Tagger", "ascii")));
  // Still ends with EOI
  assert.equal(stamped[stamped.length - 2], 0xff);
  assert.equal(stamped[stamped.length - 1], 0xd9);

  // Non-JPEG buffer (PNG signature) should be returned unchanged
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const untouched = injectExifIntoJpeg(png, 40.0598, -74.1399, "PNG Roof");
  assert.deepEqual(untouched, png);
});

test("api-media-upload.mjs rejects non-POST methods and invalid file types", async () => {
  const getRes = await mediaUploadHandler(
    new Request("https://oceancountyroofingpros.com/api/media/upload", { method: "GET" })
  );
  assert.equal(getRes.status, 405);

  const fd = new FormData();
  fd.append("town", "roofing-toms-river-nj");
  fd.append("file", new File(["not an image"], "malware.txt", { type: "text/plain" }));

  const badFileRes = await mediaUploadHandler(
    new Request("https://oceancountyroofingpros.com/api/media/upload", {
      method: "POST",
      body: fd
    })
  );
  assert.equal(badFileRes.status, 400);
  const badBody = await badFileRes.json();
  assert.match(badBody.detail, /Invalid image file type/i);
});

test("api-media-upload.mjs handles owner JPEG upload, auto-creates missing bucket, and saves approved project", async () => {
  const originalFetch = global.fetch;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_KEY;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_service_key";

  let storageAttempts = 0;
  let bucketCreated = false;
  let uploadedBytes = null;
  let insertedProject = null;

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();

    if (u.includes("/storage/v1/object/") && method === "POST") {
      storageAttempts++;
      if (storageAttempts === 1) {
        return new Response(JSON.stringify({ error: "Bucket not found" }), { status: 404 });
      }
      uploadedBytes = Buffer.from(opts.body);
      return new Response(JSON.stringify({ Key: "job-photos/test.jpg" }), { status: 200 });
    }
    if (u.endsWith("/storage/v1/bucket") && method === "POST") {
      bucketCreated = true;
      return new Response(JSON.stringify({ name: "job-photos" }), { status: 200 });
    }
    if (u.includes("/rest/v1/job_projects") && method === "POST") {
      insertedProject = JSON.parse(opts.body);
      return new Response(JSON.stringify([insertedProject]), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    const fd = new FormData();
    fd.append("town", "roofing-brick-nj");
    fd.append("neighborhood", "Herbertsville");
    fd.append("shingle_system", "CertainTeed Landmark PRO");
    fd.append("caption", "Pewter architectural install");
    fd.append("uploaded_by", "owner");
    fd.append("file", new File([makeMinimalJpeg()], "brick-roof.jpg", { type: "image/jpeg" }));

    const res = await mediaUploadHandler(
      new Request("https://oceancountyroofingpros.com/api/media/upload", {
        method: "POST",
        body: fd
      })
    );
    assert.equal(res.status, 200);
    const data = await res.json();

    assert.equal(data.status, "success");
    assert.equal(bucketCreated, true);
    assert.equal(storageAttempts, 2);
    assert.equal(data.storage_uploaded, true);
    assert.equal(data.supabase_saved, true);
    assert.equal(data.verified_gps.exif_stamped, true);
    assert.equal(data.verified_gps.lat, 40.0598);
    assert.equal(data.verified_gps.lon, -74.1399);

    assert.ok(uploadedBytes);
    assert.equal(uploadedBytes[2], 0xff);
    assert.equal(uploadedBytes[3], 0xe1);

    assert.equal(insertedProject.approval_status, "approved");
    assert.equal(insertedProject.auto_publish_at, null);
    assert.ok(insertedProject.created_at);
    assert.ok(!Number.isNaN(Date.parse(insertedProject.created_at)));
    assert.equal(insertedProject.town_slug, "roofing-brick-nj");
    assert.match(insertedProject.image_webp_url, /^https:\/\/mock-supabase\.local\/storage\/v1\/object\/public\/job-photos\/projects\/roofing-brick-nj\/brick-roof_\d+\.jpg$/);
    assert.equal(data.project.gps_lat, 40.0598);
    assert.equal(data.project.gps_lng, -74.1399);
  } finally {
    global.fetch = originalFetch;
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origKey === undefined) delete process.env.SUPABASE_KEY;
    else process.env.SUPABASE_KEY = origKey;
  }
});

test("api-media-upload.mjs returns 400 on malformed JSON or missing Content-Type, and validates JSON base64 uploads", async () => {
  const badJsonRes = await mediaUploadHandler(
    new Request("https://oceancountyroofingpros.com/api/media/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{bad-json"
    })
  );
  assert.equal(badJsonRes.status, 400);

  const noCtRes = await mediaUploadHandler(
    new Request("https://oceancountyroofingpros.com/api/media/upload", {
      method: "POST",
      body: "plain text body"
    })
  );
  assert.equal(noCtRes.status, 400);

  const badExtJsonRes = await mediaUploadHandler(
    new Request("https://oceancountyroofingpros.com/api/media/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        town: "Toms River",
        filename: "payload.exe",
        content_type: "application/octet-stream",
        image_base64: makeMinimalJpeg().toString("base64")
      })
    })
  );
  assert.equal(badExtJsonRes.status, 400);

  const originalFetch = global.fetch;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_KEY;
  process.env.SUPABASE_URL = "https://mock-supabase.local///";
  process.env.SUPABASE_KEY = "mock_service_key";

  let storageUrl = "";
  let uploadedBytes = null;
  let insertedUrl = "";
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/storage/v1/object/")) {
      storageUrl = u;
      uploadedBytes = Buffer.from(opts.body);
      return new Response(JSON.stringify({ Key: "ok" }), { status: 200 });
    }
    if (u.includes("/rest/v1/job_projects")) {
      insertedUrl = u;
      return new Response(JSON.stringify([JSON.parse(opts.body)]), { status: 201 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const dataUrl = `data:image/jpeg;base64,${makeMinimalJpeg().toString("base64")}`;
    const res = await mediaUploadHandler(
      new Request("https://oceancountyroofingpros.com/api/media/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          town: "Manahawkin",
          filename: "roof-data-url.jpg",
          image_base64: dataUrl
        })
      })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.verified_gps.exif_stamped, true);
    assert.ok(!storageUrl.includes("//storage"));
    assert.ok(!insertedUrl.includes("//rest"));
    assert.equal(uploadedBytes[0], 0xff);
    assert.equal(uploadedBytes[1], 0xd8);
    assert.equal(uploadedBytes[2], 0xff);
    assert.equal(uploadedBytes[3], 0xe1);
  } finally {
    global.fetch = originalFetch;
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origKey === undefined) delete process.env.SUPABASE_KEY;
    else process.env.SUPABASE_KEY = origKey;
  }
});

test("injectExifIntoJpeg handles 0xFF fill bytes before markers", () => {
  const paddedJpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xda, 0x00, 0x02,
    0xaa, 0xff, 0xd9
  ]);
  const stamped = injectExifIntoJpeg(paddedJpeg, 39.9537, -74.1979, "Padded JPEG");
  assert.equal(stamped[2], 0xff);
  assert.equal(stamped[3], 0xe1);
  assert.equal(stamped[stamped.length - 2], 0xff);
  assert.equal(stamped[stamped.length - 1], 0xd9);
});

test("api-media-upload.mjs queues contractor upload without file into 24h hybrid queue", async () => {
  const originalFetch = global.fetch;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_KEY;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_service_key";

  let insertedProject = null;
  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes("/rest/v1/job_projects") && opts.method === "POST") {
      insertedProject = JSON.parse(opts.body);
      return new Response(JSON.stringify([insertedProject]), { status: 201 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  try {
    const fd = new FormData();
    fd.append("town", "roofing-point-pleasant-nj");
    fd.append("uploaded_by", "contractor");
    fd.append("tenant_id", "client_joe_the_roofer");
    fd.append("caption", "Bay Head Border ridge cap");

    const res = await mediaUploadHandler(
      new Request("https://oceancountyroofingpros.com/api/media/upload", {
        method: "POST",
        body: fd
      })
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, "success");
    assert.match(data.message, /24h auto-publish/i);
    assert.equal(insertedProject.approval_status, "pending_auto_24h");
    assert.ok(insertedProject.auto_publish_at);
    assert.ok(!Number.isNaN(Date.parse(insertedProject.auto_publish_at)));
    assert.equal(data.storage_uploaded, false);
    assert.equal(insertedProject.image_webp_url, "/static/images/heroes/hero-coastal-bayfront.webp");
  } finally {
    global.fetch = originalFetch;
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origKey === undefined) delete process.env.SUPABASE_KEY;
    else process.env.SUPABASE_KEY = origKey;
  }
});

test("api-media-upload.mjs returns 502 when Supabase job_projects insert fails", async () => {
  const originalFetch = global.fetch;
  const origUrl = process.env.SUPABASE_URL;
  const origKey = process.env.SUPABASE_KEY;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_service_key";

  global.fetch = async (url) => {
    if (String(url).includes("/rest/v1/job_projects")) {
      return new Response("permission denied", { status: 403 });
    }
    return new Response("{}", { status: 200 });
  };

  try {
    const fd = new FormData();
    fd.append("town", "Toms River");
    const res = await mediaUploadHandler(
      new Request("https://oceancountyroofingpros.com/api/media/upload", {
        method: "POST",
        body: fd
      })
    );
    assert.equal(res.status, 502);
  } finally {
    global.fetch = originalFetch;
    if (origUrl === undefined) delete process.env.SUPABASE_URL;
    else process.env.SUPABASE_URL = origUrl;
    if (origKey === undefined) delete process.env.SUPABASE_KEY;
    else process.env.SUPABASE_KEY = origKey;
  }
});
