/**
 * Netlify Serverless Function: Unified Job-Site Photo Upload & EXIF GPS Geo-Tagger
 * Route: POST /api/media/upload
 *
 * Supports both Owner Command Center (/admin -> immediate live "approved")
 * and Contractor Partner Portal (/portal -> 24h hybrid queue "pending_auto_24h").
 */
import crypto from "crypto";

const OCEAN_COUNTY_TOWNS = [
  {
    slug: "roofing-toms-river-nj",
    town_name: "Toms River",
    zip_codes: ["08753", "08754", "08755", "08757"],
    neighborhoods: ["Silverton", "Green Island", "North Dover", "Pleasant Plains", "East Dover", "Gilford Park"],
    coastal_risk: "Heavy salt-air degradation and 110+ MPH coastal nor'easter wind exposure across Barnegat Bay.",
    lat: 39.9537,
    lon: -74.1979,
    hero_image_url: "/static/images/heroes/hero-hub-toms-river.webp"
  },
  {
    slug: "roofing-brick-nj",
    town_name: "Brick Township",
    zip_codes: ["08723", "08724"],
    neighborhoods: ["Herbertsville", "Midstreams", "Cedarcroft", "Osbornville", "Baywood", "Cherry Quay"],
    coastal_risk: "High humidity and fierce wind gusts sweeping off the Metedeconk River and Barnegat Bay.",
    lat: 40.0598,
    lon: -74.1399,
    hero_image_url: "/static/images/heroes/hero-coastal-bayfront.webp"
  },
  {
    slug: "roofing-point-pleasant-nj",
    town_name: "Point Pleasant",
    zip_codes: ["08742"],
    neighborhoods: ["Point Pleasant Beach", "Point Pleasant Boro", "Bay Head Border", "Sunshine Harbor"],
    coastal_risk: "Direct Atlantic oceanfront nor'easters, driving salt spray, and extreme gale-force wind requirements.",
    lat: 40.0829,
    lon: -74.0682,
    hero_image_url: "/static/images/heroes/hero-coastal-bayfront.webp"
  },
  {
    slug: "roofing-jackson-nj",
    town_name: "Jackson",
    zip_codes: ["08527"],
    neighborhoods: ["Brookwood", "Whitesville", "Holmansville", "Cassville", "Legler"],
    coastal_risk: "Expansive rooflines vulnerable to heavy winter freeze-thaw cycles, ice dams, and high wind shear.",
    lat: 40.1448,
    lon: -74.3674,
    hero_image_url: "/static/images/heroes/hero-inland-pine.webp"
  },
  {
    slug: "roofing-lacey-nj",
    town_name: "Lacey Township",
    zip_codes: ["08731", "08734"],
    neighborhoods: ["Forked River", "Lanoka Harbor", "Barnegat Pines", "Bamber Lake"],
    coastal_risk: "Waterfront lagoon wind shear and intense sun UV deterioration on aged 3-tab shingles.",
    lat: 39.8665,
    lon: -74.1957,
    hero_image_url: "/static/images/heroes/hero-coastal-bayfront.webp"
  },
  {
    slug: "roofing-lakewood-nj",
    town_name: "Lakewood",
    zip_codes: ["08701"],
    neighborhoods: ["Lake Carasaljo", "Original Leisure Village", "Oak Street Corridor", "Pine Park", "Coventry Square"],
    coastal_risk: "Multi-gable colonial rooflines exposed to heavy seasonal downpours, valley flashing wear, and high wind gusts.",
    lat: 40.0979,
    lon: -74.2176,
    hero_image_url: "/static/images/heroes/hero-inland-pine.webp"
  },
  {
    slug: "roofing-barnegat-nj",
    town_name: "Barnegat",
    zip_codes: ["08005"],
    neighborhoods: ["Barnegat Light Border", "Mirage", "Heritage Point", "Pheasant Run", "Settlers Landing"],
    coastal_risk: "Direct bayfront salt air corrosion and severe coastal squalls sweeping across Barnegat Inlet.",
    lat: 39.7532,
    lon: -74.2226,
    hero_image_url: "/static/images/heroes/hero-coastal-bayfront.webp"
  },
  {
    slug: "roofing-manahawkin-nj",
    town_name: "Manahawkin",
    zip_codes: ["08050"],
    neighborhoods: ["Beach Haven West", "Ocean Acres", "Stafford Park", "Cedar Bonnet Island", "Mallard Island"],
    coastal_risk: "Extreme barrier-island and lagoon wind uplift requiring 160 MPH hurricane-grade shingle fastening.",
    lat: 39.6940,
    lon: -74.2588,
    hero_image_url: "/static/images/heroes/hero-coastal-bayfront.webp"
  },
  {
    slug: "roofing-howell-nj",
    town_name: "Howell",
    zip_codes: ["07731"],
    neighborhoods: ["Ramtown", "Freewood Acres", "Candlewood", "Land O'Pines", "Southard"],
    coastal_risk: "Severe seasonal thunderstorm winds, falling pine branches, and attic ventilation moisture traps.",
    lat: 40.1698,
    lon: -74.2254,
    hero_image_url: "/static/images/heroes/hero-inland-pine.webp"
  },
  {
    slug: "roofing-freehold-nj",
    town_name: "Freehold",
    zip_codes: ["07728"],
    neighborhoods: ["Freehold Boro", "Freehold Township", "East Freehold", "Stonehurst", "Silverside"],
    coastal_risk: "Aging suburban roof decks and valley leak intrusion during prolonged rainfall events.",
    lat: 40.2601,
    lon: -74.2738,
    hero_image_url: "/static/images/heroes/hero-inland-pine.webp"
  }
];

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/heic",
  "image/heif"
]);

const ALLOWED_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"]);

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function resolveTownInfo(query) {
  if (!query || typeof query !== "string") return OCEAN_COUNTY_TOWNS[0];
  const q = query.trim().toLowerCase();
  if (!q) return OCEAN_COUNTY_TOWNS[0];

  for (const t of OCEAN_COUNTY_TOWNS) {
    if (
      t.slug.toLowerCase() === q ||
      t.town_name.toLowerCase() === q ||
      (t.zip_codes || []).includes(q)
    ) {
      return t;
    }
  }
  for (const t of OCEAN_COUNTY_TOWNS) {
    const firstWord = t.town_name.toLowerCase().split(" ")[0];
    if (q.includes(firstWord) || t.slug.toLowerCase().includes(q)) {
      return t;
    }
  }
  return OCEAN_COUNTY_TOWNS[0];
}

export function generateLocalizedSeoSummary({ townInfo, neighborhood, serviceType, shingleSystem, caption }) {
  const townName = townInfo?.town_name || "Toms River";
  const zipCode = (townInfo?.zip_codes && townInfo.zip_codes[0]) || "08753";
  const coastalRisk = townInfo?.coastal_risk || "Jersey Shore nor'easter wind gusts and coastal humidity.";
  const hoodStr = neighborhood ? ` in the ${neighborhood} section of ${townName}` : ` in ${townName}`;
  const captionClean = (caption || "").trim().replace(/\.+$/, "") || `Completed ${serviceType}`;

  return (
    `${captionClean}${hoodStr}, NJ (${zipCode}). ` +
    `Installed ${shingleSystem} engineered to protect against ${coastalRisk.toLowerCase()} ` +
    `Includes full tear-off to the deck, ice-and-water leak barrier, and magnetic yard sweep.`
  );
}

function decimalToDmsRational(decDeg) {
  const absDeg = Math.abs(Number(decDeg) || 0);
  const deg = Math.floor(absDeg);
  const remMin = (absDeg - deg) * 60;
  const min = Math.floor(remMin);
  const secScaled = Math.round((remMin - min) * 60 * 10000);
  return [
    [deg, 1],
    [min, 1],
    [secScaled, 10000]
  ];
}

/**
 * Builds a valid big-endian TIFF/EXIF APP1 segment containing Software,
 * ImageDescription, and GPS Latitude/Longitude IFD tags.
 */
export function buildExifGpsApp1(lat, lon, description = "Ocean County NJ Roof Installation") {
  const softwareStr = "Ocean County Roofing Pros SEO Geo-Tagger\0";
  const descClean = String(description || "Ocean County NJ Roof Installation").slice(0, 180) + "\0";

  const softwareBuf = Buffer.from(softwareStr, "ascii");
  const descBuf = Buffer.from(descClean, "utf8");

  // Big-endian TIFF header (8 bytes): "MM", 0x002A, offset to IFD0 = 8
  // IFD0 has 3 entries:
  //   0x010E ImageDescription (ASCII=2)
  //   0x0131 Software (ASCII=2)
  //   0x8825 GPSInfoIFDPointer (LONG=4, count=1, value=offset)
  const ifd0Offset = 8;
  const ifd0Count = 3;
  const ifd0Size = 2 + ifd0Count * 12 + 4; // 42 bytes -> ends at 50

  const descOffset = ifd0Offset + ifd0Size;
  const softwareOffset = descOffset + descBuf.length;
  const gpsIfdOffset = softwareOffset + softwareBuf.length;

  // GPS IFD has 5 entries:
  //   0x0000 GPSVersionID (BYTE=1, count=4, inline 2,0,0,0)
  //   0x0001 GPSLatitudeRef (ASCII=2, count=2, inline "N\0\0\0" or "S\0\0\0")
  //   0x0002 GPSLatitude (RATIONAL=5, count=3, offset)
  //   0x0003 GPSLongitudeRef (ASCII=2, count=2, inline "E\0\0\0" or "W\0\0\0")
  //   0x0004 GPSLongitude (RATIONAL=5, count=3, offset)
  const gpsIfdCount = 5;
  const gpsIfdSize = 2 + gpsIfdCount * 12 + 4; // 66 bytes

  const latValuesOffset = gpsIfdOffset + gpsIfdSize; // 24 bytes (3 * 8)
  const lonValuesOffset = latValuesOffset + 24;      // 24 bytes (3 * 8)
  const tiffTotalLen = lonValuesOffset + 24;

  const tiff = Buffer.alloc(tiffTotalLen);
  // TIFF header (Big-Endian)
  tiff.write("MM", 0, 2, "ascii");
  tiff.writeUInt16BE(42, 2);
  tiff.writeUInt32BE(ifd0Offset, 4);

  let pos = ifd0Offset;
  tiff.writeUInt16BE(ifd0Count, pos);
  pos += 2;

  const writeIfdEntry = (tag, type, count, valueOrOffset) => {
    tiff.writeUInt16BE(tag, pos);
    tiff.writeUInt16BE(type, pos + 2);
    tiff.writeUInt32BE(count, pos + 4);
    if (Buffer.isBuffer(valueOrOffset)) {
      valueOrOffset.copy(tiff, pos + 8, 0, 4);
    } else {
      tiff.writeUInt32BE(valueOrOffset >>> 0, pos + 8);
    }
    pos += 12;
  };

  // IFD0 entries (sorted by tag ID ascending per TIFF spec)
  writeIfdEntry(0x010e, 2, descBuf.length, descOffset);
  writeIfdEntry(0x0131, 2, softwareBuf.length, softwareOffset);
  writeIfdEntry(0x8825, 4, 1, gpsIfdOffset);
  tiff.writeUInt32BE(0, pos); // next IFD = 0

  descBuf.copy(tiff, descOffset);
  softwareBuf.copy(tiff, softwareOffset);

  // GPS IFD
  pos = gpsIfdOffset;
  tiff.writeUInt16BE(gpsIfdCount, pos);
  pos += 2;

  const latRef = lat >= 0 ? "N" : "S";
  const lonRef = lon >= 0 ? "E" : "W";

  writeIfdEntry(0x0000, 1, 4, Buffer.from([2, 0, 0, 0]));
  writeIfdEntry(0x0001, 2, 2, Buffer.from(`${latRef}\0\0\0`, "ascii"));
  writeIfdEntry(0x0002, 5, 3, latValuesOffset);
  writeIfdEntry(0x0003, 2, 2, Buffer.from(`${lonRef}\0\0\0`, "ascii"));
  writeIfdEntry(0x0004, 5, 3, lonValuesOffset);
  tiff.writeUInt32BE(0, pos); // next IFD = 0

  const latDms = decimalToDmsRational(lat);
  const lonDms = decimalToDmsRational(lon);
  for (let i = 0; i < 3; i++) {
    tiff.writeUInt32BE(latDms[i][0] >>> 0, latValuesOffset + i * 8);
    tiff.writeUInt32BE(latDms[i][1] >>> 0, latValuesOffset + i * 8 + 4);
    tiff.writeUInt32BE(lonDms[i][0] >>> 0, lonValuesOffset + i * 8);
    tiff.writeUInt32BE(lonDms[i][1] >>> 0, lonValuesOffset + i * 8 + 4);
  }

  const exifHeader = Buffer.from("Exif\0\0", "ascii");
  const segmentLen = 2 + exifHeader.length + tiff.length;
  const app1 = Buffer.alloc(2 + segmentLen);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  app1.writeUInt16BE(segmentLen, 2);
  exifHeader.copy(app1, 4);
  tiff.copy(app1, 4 + exifHeader.length);
  return app1;
}

/**
 * Injects our GPS EXIF APP1 segment right after JPEG SOI (0xFF 0xD8),
 * stripping any existing APP1 Exif segments so GPS coordinates are authoritative.
 */
export function injectExifIntoJpeg(jpegBuffer, lat, lon, description) {
  if (!Buffer.isBuffer(jpegBuffer) || jpegBuffer.length < 4) return jpegBuffer;
  if (jpegBuffer[0] !== 0xff || jpegBuffer[1] !== 0xd8) return jpegBuffer;

  const app1 = buildExifGpsApp1(lat, lon, description);
  const chunks = [jpegBuffer.subarray(0, 2), app1];

  let offset = 2;
  while (offset + 4 <= jpegBuffer.length) {
    if (jpegBuffer[offset] !== 0xff) {
      chunks.push(jpegBuffer.subarray(offset));
      break;
    }
    const marker = jpegBuffer[offset + 1];
    // Skip JPEG 0xFF fill bytes
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // SOS (0xDA) or EOI (0xD9) -> copy rest of file verbatim
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(jpegBuffer.subarray(offset));
      break;
    }
    // Standalone markers without length (0x00, 0x01 TEM, 0xD0..0xD8 RSTn/SOI)
    if (marker === 0x00 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      chunks.push(jpegBuffer.subarray(offset, offset + 2));
      offset += 2;
      continue;
    }
    const segLen = jpegBuffer.readUInt16BE(offset + 2);
    const nextOffset = offset + 2 + segLen;
    if (nextOffset > jpegBuffer.length || segLen < 2) {
      chunks.push(jpegBuffer.subarray(offset));
      break;
    }
    // Skip existing APP1 Exif segment so ours is the single authoritative EXIF
    const isExistingExif =
      marker === 0xe1 &&
      segLen >= 8 &&
      jpegBuffer.subarray(offset + 4, offset + 10).toString("ascii") === "Exif\0\0";
    if (!isExistingExif) {
      chunks.push(jpegBuffer.subarray(offset, nextOffset));
    }
    offset = nextOffset;
  }

  return Buffer.concat(chunks);
}

function sanitizeStem(filename) {
  const base = String(filename || "job_photo.jpg").replace(/\.[^.]+$/, "");
  const clean = base.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
  return clean || "job_photo";
}

function detectExtension(filename, contentType) {
  const match = String(filename || "").toLowerCase().match(/\.([a-z0-9]+)$/);
  if (match && ALLOWED_IMAGE_EXTENSIONS.has(match[1])) {
    return match[1] === "jpeg" ? "jpg" : match[1];
  }
  const ct = String(contentType || "").toLowerCase();
  if (ct.includes("webp")) return "webp";
  if (ct.includes("png")) return "png";
  if (ct.includes("gif")) return "gif";
  if (ct.includes("heic")) return "heic";
  if (ct.includes("heif")) return "heif";
  return "jpg";
}

async function uploadToSupabaseStorage({ supabaseUrl, supabaseKey, bucket, objectPath, buffer, contentType }) {
  const uploadUrl = `${supabaseUrl}/storage/v1/object/${encodeURIComponent(bucket)}/${objectPath}`;
  const storageHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": contentType,
    "x-upsert": "true"
  };

  let res = await fetch(uploadUrl, {
    method: "POST",
    headers: storageHeaders,
    body: buffer
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    // Auto-provision public bucket if missing
    if (res.status === 404 || /bucket.*not found/i.test(errText)) {
      await fetch(`${supabaseUrl}/storage/v1/bucket`, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ id: bucket, name: bucket, public: true })
      }).catch(() => null);

      res = await fetch(uploadUrl, {
        method: "POST",
        headers: storageHeaders,
        body: buffer
      });
    }
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => `HTTP ${res.status}`);
    return { uploaded: false, error: detail };
  }

  const publicUrl = `${supabaseUrl}/storage/v1/object/public/${encodeURIComponent(bucket)}/${objectPath}`;
  return { uploaded: true, publicUrl };
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return jsonResponse({ detail: "Method not allowed" }, 405);
  }

  try {
    const contentTypeHeader = (req.headers.get("content-type") || "").toLowerCase();
    let townQuery = "Toms River";
    let neighborhood = "";
    let serviceType = "Full Roof Replacement";
    let shingleSystem = "CertainTeed Landmark PRO";
    let caption = "";
    let uploadedBy = "owner";
    let tenantId = "client_joe_the_roofer";
    let fileBuffer = null;
    let fileName = "job_photo.jpg";
    let fileMimeType = "image/jpeg";

    if (contentTypeHeader.includes("application/json")) {
      let body;
      try {
        body = await req.json();
      } catch {
        return jsonResponse({ detail: "Invalid JSON request body." }, 400);
      }
      if (!body || typeof body !== "object") {
        return jsonResponse({ detail: "Invalid JSON request body." }, 400);
      }
      townQuery = body.town || "Toms River";
      neighborhood = body.neighborhood || "";
      serviceType = body.service_type || "Full Roof Replacement";
      shingleSystem = body.shingle_system || "CertainTeed Landmark PRO";
      caption = body.caption || "";
      uploadedBy = body.uploaded_by || "owner";
      tenantId = body.tenant_id || "client_joe_the_roofer";
      if (body.image_base64) {
        let b64 = String(body.image_base64).trim();
        const dataUrlMatch = b64.match(/^data:([^;]+);base64,(.+)$/i);
        if (dataUrlMatch) {
          fileMimeType = body.content_type || dataUrlMatch[1];
          b64 = dataUrlMatch[2];
        } else {
          fileMimeType = body.content_type || "image/jpeg";
        }
        fileName = body.filename || "job_photo.jpg";
        const extFromName = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";
        const isValidMime = !fileMimeType || fileMimeType === "application/octet-stream" || ALLOWED_IMAGE_MIME_TYPES.has(fileMimeType.toLowerCase());
        const isValidExt = !extFromName || ALLOWED_IMAGE_EXTENSIONS.has(extFromName);
        if (!isValidMime || !isValidExt) {
          return jsonResponse(
            { detail: "Invalid image file type. Please upload a JPG, PNG, or WebP photo." },
            400
          );
        }
        fileBuffer = Buffer.from(b64, "base64");
      }
    } else {
      let formData;
      try {
        formData = await req.formData();
      } catch {
        return jsonResponse(
          { detail: "Invalid request body. Expected multipart/form-data or application/json." },
          400
        );
      }
      townQuery = String(formData.get("town") || "Toms River");
      neighborhood = String(formData.get("neighborhood") || "");
      serviceType = String(formData.get("service_type") || "Full Roof Replacement");
      shingleSystem = String(formData.get("shingle_system") || "CertainTeed Landmark PRO");
      caption = String(formData.get("caption") || "");
      uploadedBy = String(formData.get("uploaded_by") || "owner");
      tenantId = String(formData.get("tenant_id") || "client_joe_the_roofer");

      const file = formData.get("file");
      if (file && typeof file === "object" && typeof file.arrayBuffer === "function") {
        fileName = file.name || "job_photo.jpg";
        fileMimeType = file.type || "image/jpeg";
        const extFromName = (fileName.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || "";

        if (file.size > 0) {
          const isValidMime = !fileMimeType || fileMimeType === "application/octet-stream" || ALLOWED_IMAGE_MIME_TYPES.has(fileMimeType.toLowerCase());
          const isValidExt = !extFromName || ALLOWED_IMAGE_EXTENSIONS.has(extFromName);
          if (!isValidMime || !isValidExt) {
            return jsonResponse(
              { detail: "Invalid image file type. Please upload a JPG, PNG, or WebP photo." },
              400
            );
          }
          const arrBuf = await file.arrayBuffer();
          fileBuffer = Buffer.from(arrBuf);
        }
      }
    }

    const townInfo = resolveTownInfo(townQuery);
    const townName = townInfo.town_name || "Toms River";
    const townSlug = townInfo.slug || "roofing-toms-river-nj";
    const resolvedNeighborhood = neighborhood.trim() || (townInfo.neighborhoods && townInfo.neighborhoods[0]) || "Central";
    const lat = Number(townInfo.lat ?? 39.9537);
    const lon = Number(townInfo.lon ?? -74.1979);

    const aiSeoSummary = generateLocalizedSeoSummary({
      townInfo,
      neighborhood: resolvedNeighborhood,
      serviceType,
      shingleSystem,
      caption: caption || `Verified ${serviceType} project`
    });

    const uploader = (uploadedBy || "owner").trim().toLowerCase();
    const isOwner = uploader === "owner";
    const approvalStatus = isOwner ? "approved" : "pending_auto_24h";
    const autoPublishAt = isOwner ? null : new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    let processedBuffer = fileBuffer;
    let exifStamped = false;
    const ext = detectExtension(fileName, fileMimeType);
    const uploadContentType =
      ext === "webp"
        ? "image/webp"
        : ext === "png"
          ? "image/png"
          : ext === "gif"
            ? "image/gif"
            : ext === "heic"
              ? "image/heic"
              : ext === "heif"
                ? "image/heif"
                : "image/jpeg";

    if (processedBuffer && processedBuffer.length >= 4 && processedBuffer[0] === 0xff && processedBuffer[1] === 0xd8) {
      processedBuffer = injectExifIntoJpeg(processedBuffer, lat, lon, aiSeoSummary);
      exifStamped = true;
    }

    const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/+$/, "");
    const supabaseKey = process.env.SUPABASE_KEY || "";
    const bucket = process.env.SUPABASE_MEDIA_BUCKET || "job-photos";

    let imageWebpUrl = townInfo.hero_image_url || "/static/images/heroes/hero-hub-toms-river.webp";
    let imageGeotaggedJpgUrl = imageWebpUrl;
    let storageUploaded = false;

    if (processedBuffer && processedBuffer.length > 0 && supabaseUrl && supabaseKey) {
      const ts = Date.now();
      const stem = sanitizeStem(fileName);
      const objectPath = `projects/${townSlug}/${stem}_${ts}.${ext}`;
      const storageRes = await uploadToSupabaseStorage({
        supabaseUrl,
        supabaseKey,
        bucket,
        objectPath,
        buffer: processedBuffer,
        contentType: uploadContentType
      });

      if (storageRes.uploaded) {
        imageWebpUrl = storageRes.publicUrl;
        imageGeotaggedJpgUrl = storageRes.publicUrl;
        storageUploaded = true;
      } else {
        console.warn("[api-media-upload] Supabase Storage upload fallback:", storageRes.error);
      }
    }

    const nowIso = new Date().toISOString();
    const projectId = `proj_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`;
    const dbRecord = {
      id: projectId,
      created_at: nowIso,
      town_slug: townSlug,
      town_name: townName,
      neighborhood: resolvedNeighborhood,
      service_type: serviceType,
      shingle_system: shingleSystem,
      caption: caption.trim() || `${shingleSystem} installation in ${resolvedNeighborhood}, ${townName}`,
      ai_seo_summary: aiSeoSummary,
      image_webp_url: imageWebpUrl,
      image_geotagged_jpg_url: imageGeotaggedJpgUrl,
      lat,
      lon,
      uploaded_by: uploader,
      tenant_id: tenantId,
      approval_status: approvalStatus,
      auto_publish_at: autoPublishAt
    };

    let savedRecord = dbRecord;
    let supabaseSaved = false;

    if (supabaseUrl && supabaseKey) {
      const dbRes = await fetch(`${supabaseUrl}/rest/v1/job_projects`, {
        method: "POST",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=representation"
        },
        body: JSON.stringify(dbRecord)
      });

      if (!dbRes.ok) {
        const errText = await dbRes.text().catch(() => "");
        console.error("[api-media-upload] Supabase job_projects insert failed:", dbRes.status, errText);
        return jsonResponse({ detail: `Failed to save job project: ${errText || dbRes.status}` }, 502);
      }

      const rows = await dbRes.json().catch(() => []);
      if (Array.isArray(rows) && rows[0]) {
        savedRecord = rows[0];
      }
      supabaseSaved = true;
    }

    return jsonResponse({
      status: "success",
      message:
        approvalStatus === "approved"
          ? "Photo GPS-tagged & published live immediately!"
          : "Photo GPS-tagged & queued for 24h auto-publish!",
      project: {
        ...savedRecord,
        gps_lat: savedRecord.lat ?? lat,
        gps_lng: savedRecord.lon ?? lon
      },
      verified_gps: {
        has_gps: true,
        exif_stamped: exifStamped,
        lat,
        lon
      },
      storage_uploaded: storageUploaded,
      supabase_saved: supabaseSaved
    });
  } catch (err) {
    console.error("[api-media-upload] Error:", err);
    return jsonResponse({ detail: err.message || "Media upload failed." }, 500);
  }
};
