/**
 * Netlify Serverless Function: Meta Social Engagement & Reviews Webhook
 * Routes:
 *   - GET  /api/meta/webhook  (Meta Developer App verification challenge)
 *   - POST /api/meta/webhook  (Facebook Page comments/ratings, Messenger DMs, Instagram comments/DMs)
 */
import crypto from "crypto";
import { MetaSocialService } from "./services/meta-social-service.mjs";
import { EmailService } from "./services/email-service.mjs";

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

export function verifyMetaWebhookSignature(rawBody, signatureHeader, appSecret) {
  if (!appSecret) return true; // Signature verification enforced whenever META_APP_SECRET is configured
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", appSecret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function triggerVapiOutboundCallback({ phone, name = "Homeowner", source = "Social DM" }) {
  const apiKey = process.env.VAPI_API_KEY;
  const phoneId = process.env.VAPI_PHONE_NUMBER_ID;
  const assistantId = process.env.VAPI_OUTBOUND_ASSISTANT_ID || process.env.VAPI_ESTIMATOR_ID || "e86a1d27-c226-4018-96f0-e434eb53b895";
  if (!apiKey || !phoneId || !phone) return { status: "skipped" };

  const res = await fetch("https://api.vapi.ai/call/phone", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      phoneNumberId: phoneId,
      assistantId,
      customer: { number: phone, name },
      assistantOverrides: {
        variableValues: {
          customerName: name,
          leadSource: source
        }
      }
    })
  }).catch(() => null);

  return res && res.ok ? { status: "queued" } : { status: "error" };
}

export default async (req) => {
  const url = new URL(req.url);

  // 1. META WEBHOOK VERIFICATION CHALLENGE (GET)
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge") || "";
    const expectedToken = (process.env.META_WEBHOOK_VERIFY_TOKEN || "ocrp_meta_verify_2026").trim();

    if (mode === "subscribe" && token === expectedToken) {
      return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
    }
    return jsonResponse({ error: "Forbidden: invalid verify token" }, 403);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const rawBody = await req.text();
  const appSecret = (process.env.META_APP_SECRET || "").trim();
  const sigHeader = req.headers.get("x-hub-signature-256") || "";
  if (!verifyMetaWebhookSignature(rawBody, sigHeader, appSecret)) {
    return jsonResponse({ error: "Invalid webhook signature" }, 401);
  }

  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";
  const sbHeaders = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  let sysSettings = {};
  if (supabaseUrl && supabaseKey) {
    const sRes = await fetch(`${supabaseUrl}/rest/v1/system_settings?select=key,value`, { headers: sbHeaders }).catch(() => null);
    if (sRes && sRes.ok) {
      for (const row of await sRes.json()) sysSettings[row.key] = row.value;
    }
  }

  const autoReplyEnabled = sysSettings.social_auto_reply_enabled !== "false";
  const pageId = (process.env.META_PAGE_ID || "1466735946524886").trim();
  const igUserId = (process.env.META_IG_USER_ID || "").trim();
  const objectType = body.object || "page"; // "page" or "instagram"
  const entries = Array.isArray(body.entry) ? body.entry : [];
  const processed = [];

  for (const entry of entries) {
    // A. Messenger / Instagram Direct Messages
    const messagingEvents = Array.isArray(entry.messaging) ? entry.messaging : [];
    for (const ev of messagingEvents) {
      if (!ev.message || ev.message.is_echo) continue;
      const senderId = ev.sender?.id || "";
      if (!senderId || senderId === pageId || senderId === igUserId) continue;

      const text = ev.message.text || "";
      const platform = objectType === "instagram" ? "instagram" : "facebook";
      const cls = MetaSocialService.classifySocialMessage({ text, interactionType: "dm" });
      const phone = MetaSocialService.extractPhoneNumber(text);

      let leadId = "";
      if (phone && supabaseUrl && supabaseKey) {
        leadId = `SOC-LEAD-${Date.now() % 10000000}`;
        await fetch(`${supabaseUrl}/rest/v1/leads`, {
          method: "POST",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify({
            id: leadId,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            lead_source: platform === "instagram" ? "Instagram DM" : "Facebook DM",
            first_name: "Social",
            last_name: "Homeowner",
            phone,
            city: "Ocean County",
            state: "NJ",
            service_requested: cls.intent === "EMERGENCY_LEAK" ? "Emergency Leak Repair" : "Free 21-Point Roof & Attic Inspection",
            urgency: cls.intent === "EMERGENCY_LEAK" ? "Emergency" : "High",
            notes: `Captured from ${platform} DM: ${text.slice(0, 300)}`,
            assigned_tenant_id: "client_joe_the_roofer",
            status: "New Lead"
          })
        }).catch(() => {});

        if (sysSettings.enable_vapi_callback !== "false") {
          await triggerVapiOutboundCallback({ phone, name: "Homeowner", source: `${platform} DM` });
        }
      }

      let replyRes = { status: "held" };
      let replyStatus = cls.reply_status;
      if (autoReplyEnabled && cls.reply_status === "auto_reply" && cls.draft) {
        replyRes = platform === "instagram"
          ? await MetaSocialService.sendIgDm({ igUserId, recipientId: senderId, message: cls.draft })
          : await MetaSocialService.sendPageDm({ recipientId: senderId, message: cls.draft });
        if (replyRes.status === "published") replyStatus = "published";
        else replyStatus = "pending_approval";
      } else if (cls.reply_status === "auto_reply") {
        replyStatus = "pending_approval";
      }

      const row = {
        id: `SOC-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        platform,
        interaction_type: "dm",
        external_id: ev.message.mid || "",
        post_id: "",
        author_name: "Social Visitor",
        author_id: senderId,
        rating: 0,
        message_text: text,
        intent: cls.intent,
        ai_reply_draft: cls.draft,
        reply_status: replyStatus,
        published_reply_id: replyRes.id || "",
        lead_id: leadId
      };
      if (supabaseUrl && supabaseKey) {
        await fetch(`${supabaseUrl}/rest/v1/social_interactions`, {
          method: "POST",
          headers: { ...sbHeaders, Prefer: "return=minimal" },
          body: JSON.stringify(row)
        }).catch(() => {});
      }
      processed.push({ ...row, dispatch: replyRes });
    }

    // B. Page Feed Comments / Ratings & Instagram Comments
    const changes = Array.isArray(entry.changes) ? entry.changes : [];
    for (const ch of changes) {
      const val = ch.value || {};
      const field = ch.field || "";

      if (field === "feed" && val.item === "comment" && val.verb === "add") {
        const senderId = val.from?.id || "";
        if (senderId === pageId) continue; // Ignore our own Page replies
        const commentId = val.comment_id || "";
        const authorName = val.from?.name || "Neighbor";
        const text = val.message || "";
        const cls = MetaSocialService.classifySocialMessage({ text, interactionType: "comment", authorName });

        let replyRes = { status: "held" };
        let replyStatus = cls.reply_status;
        if (autoReplyEnabled && cls.reply_status === "auto_reply" && cls.draft && commentId) {
          replyRes = await MetaSocialService.replyToComment({ commentId, message: cls.draft });
          replyStatus = replyRes.status === "published" ? "published" : "pending_approval";
        } else if (cls.reply_status === "auto_reply") {
          replyStatus = "pending_approval";
        }

        if (cls.requires_owner_alert) {
          await EmailService.sendEmail({
            from: EmailService.getFromAddress(),
            to: sysSettings.owner_alert_email || process.env.OWNER_ALERT_EMAIL || "anthony.fuller.ink@gmail.com",
            subject: `[Social Alert: ${cls.intent}] Facebook comment from ${authorName}`,
            html: `<p><strong>${authorName}</strong> commented:</p><blockquote>${text}</blockquote><p>Suggested draft: ${cls.draft}</p>`
          }).catch(() => {});
        }

        const row = {
          id: `SOC-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          platform: "facebook",
          interaction_type: "comment",
          external_id: commentId,
          post_id: val.post_id || "",
          author_name: authorName,
          author_id: senderId,
          rating: 0,
          message_text: text,
          intent: cls.intent,
          ai_reply_draft: cls.draft,
          reply_status: replyStatus,
          published_reply_id: replyRes.id || ""
        };
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/social_interactions`, {
            method: "POST",
            headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(row)
          }).catch(() => {});
        }
        processed.push({ ...row, dispatch: replyRes });
      } else if (field === "comments") {
        // Instagram comment webhook
        const senderId = val.from?.id || "";
        if (senderId === igUserId) continue;
        const commentId = val.id || "";
        const authorName = val.from?.username || "IG Neighbor";
        const text = val.text || "";
        const cls = MetaSocialService.classifySocialMessage({ text, interactionType: "comment", authorName });

        let replyRes = { status: "held" };
        let replyStatus = cls.reply_status;
        if (autoReplyEnabled && cls.reply_status === "auto_reply" && cls.draft && commentId) {
          replyRes = await MetaSocialService.replyToComment({ commentId, message: cls.draft });
          replyStatus = replyRes.status === "published" ? "published" : "pending_approval";
        } else if (cls.reply_status === "auto_reply") {
          replyStatus = "pending_approval";
        }

        const row = {
          id: `SOC-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          platform: "instagram",
          interaction_type: "comment",
          external_id: commentId,
          post_id: val.media?.id || "",
          author_name: authorName,
          author_id: senderId,
          rating: 0,
          message_text: text,
          intent: cls.intent,
          ai_reply_draft: cls.draft,
          reply_status: replyStatus,
          published_reply_id: replyRes.id || ""
        };
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/social_interactions`, {
            method: "POST",
            headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(row)
          }).catch(() => {});
        }
        processed.push({ ...row, dispatch: replyRes });
      } else if (field === "ratings") {
        // Facebook Page Recommendation / Rating
        const rating = Number(val.rating || (val.recommendation_type === "positive" ? 5 : 1));
        const authorName = val.reviewer?.name || "Facebook Homeowner";
        const text = val.review_text || (val.recommendation_type === "positive" ? "Recommended Ocean County Roofing Pros" : "Negative recommendation");
        const cls = MetaSocialService.classifySocialMessage({ text, interactionType: "review", rating, authorName });

        if (cls.requires_owner_alert) {
          await EmailService.sendEmail({
            from: EmailService.getFromAddress(),
            to: sysSettings.owner_alert_email || process.env.OWNER_ALERT_EMAIL || "anthony.fuller.ink@gmail.com",
            subject: `[URGENT: ${rating}★ Social Review] Approval Required — ${authorName}`,
            html: `<p><strong>${authorName}</strong> left a ${rating}★ Facebook review:</p><blockquote>${text}</blockquote><p>Held for your approval in OC Roofing Pros HQ (/admin):</p><p>${cls.draft}</p>`
          }).catch(() => {});
        }

        const row = {
          id: `SOC-REV-${Date.now()}-${crypto.randomBytes(2).toString("hex")}`,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          platform: "facebook",
          interaction_type: "review",
          external_id: val.open_graph_story_id || "",
          post_id: "",
          author_name: authorName,
          author_id: val.reviewer?.id || "",
          rating,
          message_text: text,
          intent: cls.intent,
          ai_reply_draft: cls.draft,
          reply_status: cls.reply_status, // Negative (1-3★) ALWAYS "pending_approval", 4-5★ "auto_24h"
          auto_publish_at: cls.reply_status === "auto_24h" ? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() : null
        };
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/social_interactions`, {
            method: "POST",
            headers: { ...sbHeaders, Prefer: "return=minimal" },
            body: JSON.stringify(row)
          }).catch(() => {});
        }
        processed.push(row);
      }
    }
  }

  return jsonResponse({ status: "received", processed_count: processed.length, processed });
};
