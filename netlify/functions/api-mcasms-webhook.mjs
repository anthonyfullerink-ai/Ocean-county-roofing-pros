/**
 * Netlify Serverless Function: Missed Call Auto SMS (MCASMS) Active Web Target & Delivery Callback
 * Routes: POST /api/mcasms/webhook (and ?kind=callback)
 *
 * Handles:
 * - TEST_PING / mcasms.ping_test verification pings from MCASMS Android Settings
 * - Delivery receipts from SendAutoTextWorker (including unescaped JSON fallback)
 * - Inbound sms.received & opt_out.received events with Personal Device privacy filtering
 */
import crypto from "crypto";
import { AIEmailAgent } from "./services/ai-email-handler.mjs";
import { EmailService } from "./services/email-service.mjs";
import { ChiefOfStaffService } from "./services/chief-of-staff-service.mjs";
import { normalizePhoneDigits, recordOptOut } from "./services/sms-router.mjs";

const OPT_OUT_KEYWORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]);
const AUTOMATED_OTP_REGEX = /\b(verification code|security code|one-time|one time|passcode|2fa|otp|do not share)\b/i;

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeEqualHexOrUtf8(a, b) {
  const bufA = Buffer.from(String(a || ""), "utf8");
  const bufB = Buffer.from(String(b || ""), "utf8");
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function verifyMcasmsAuth({ rawText = "", signatureHeader = "", queryToken = "", secret = "" } = {}) {
  const cleanSecret = String(secret || "").trim();
  if (!cleanSecret) {
    return { ok: true, mode: "open" };
  }

  const token = String(queryToken || "").trim();
  if (token && safeEqualHexOrUtf8(token, cleanSecret)) {
    return { ok: true, mode: "token" };
  }

  const sig = String(signatureHeader || "").trim().toLowerCase();
  if (sig) {
    const expectedHmac = crypto
      .createHmac("sha256", cleanSecret)
      .update(String(rawText || ""), "utf8")
      .digest("hex")
      .toLowerCase();
    if (safeEqualHexOrUtf8(sig, expectedHmac)) {
      return { ok: true, mode: "hmac" };
    }
  }

  return { ok: false };
}

export function parseMcasmsPayload(rawText = "") {
  const trimmed = String(rawText || "").trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    // SendAutoTextWorker.kt builds delivery callback JSON with raw string interpolation,
    // which can break JSON.parse when message bodies contain quotes or newlines.
    const extractStr = (key) => {
      const m = trimmed.match(new RegExp(`"${key}"\\s*:\\s*"([^"\\r\\n]*)"`, "i"));
      return m ? m[1] : "";
    };
    const extractNum = (key) => {
      const m = trimmed.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, "i"));
      return m ? parseInt(m[1], 10) : null;
    };

    return {
      _parsed_fallback: true,
      kind: "delivery_callback",
      status: extractStr("status"),
      phoneNumber: extractStr("phoneNumber"),
      error: extractStr("error"),
      simSlot: extractNum("simSlot") || 1,
      timestamp: extractStr("timestamp")
    };
  }
}

function maskPhone(phone = "") {
  const digits = normalizePhoneDigits(phone);
  return digits ? `***-***-${digits.slice(-4)}` : "unknown";
}

async function findMatchingLeadByPhone(phone, fetchFn = fetch) {
  const target10 = normalizePhoneDigits(phone);
  if (!target10) return null;

  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (!supabaseUrl || !supabaseKey) return null;

  const last7 = target10.slice(-7);
  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  try {
    const res = await fetchFn(
      `${supabaseUrl}/rest/v1/leads?phone=ilike.*${encodeURIComponent(last7)}*&order=created_at.desc&limit=10`,
      { headers }
    );
    if (!res.ok) return null;
    const rows = await res.json().catch(() => []);
    if (!Array.isArray(rows)) return null;
    return rows.find((row) => normalizePhoneDigits(String(row?.phone || "")) === target10) || null;
  } catch (err) {
    console.warn("[api-mcasms-webhook] Lead lookup failed:", err.message);
    return null;
  }
}

async function appendLeadNote(lead, noteLine, fetchFn = fetch) {
  if (!lead?.id || !noteLine) return false;
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (!supabaseUrl || !supabaseKey) return false;

  const updatedNotes = lead.notes ? `${lead.notes}\n${noteLine}` : noteLine;
  try {
    const res = await fetchFn(
      `${supabaseUrl}/rest/v1/leads?id=eq.${encodeURIComponent(lead.id)}`,
      {
        method: "PATCH",
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
          Prefer: "return=minimal"
        },
        body: JSON.stringify({
          notes: updatedNotes,
          updated_at: new Date().toISOString()
        })
      }
    );
    return res.ok;
  } catch (err) {
    console.warn("[api-mcasms-webhook] Lead note patch error:", err.message);
    return false;
  }
}

export function createMcasmsWebhookHandler({
  fetchFn = fetch,
  loadSettings = () => AIEmailAgent.loadSystemSettings(),
  sendEmail = (args) => EmailService.sendEmail(args),
  getOwnerEmail = () => EmailService.getOwnerAlertEmail(),
  recordBuffer = (args) => ChiefOfStaffService.recordBufferEvent(args),
  persistOptOut = (phone) => recordOptOut(phone, fetchFn)
} = {}) {
  return async (req) => {
    if (req.method === "GET" || req.method === "OPTIONS") {
      return jsonResponse({ ok: true, service: "oc-roofing-mcasms-webhook" }, 200);
    }

    if (req.method !== "POST") {
      return jsonResponse({ ok: false, error: "Method not allowed" }, 405);
    }

    try {
      const url = new URL(req.url);
      const rawText = await req.text();
      const auth = verifyMcasmsAuth({
        rawText,
        signatureHeader: req.headers.get("x-signature") || "",
        queryToken: url.searchParams.get("token") || "",
        secret: process.env.MCASMS_WEBHOOK_SECRET || ""
      });

      if (!auth.ok) {
        return jsonResponse({ ok: false, error: "Invalid webhook signature or token" }, 401);
      }

      const payload = parseMcasmsPayload(rawText);
      const sysSettings = await Promise.resolve(loadSettings()).catch(() => ({}));
      const deviceMode = String(sysSettings?.mcasms_device_mode || "personal").toLowerCase();

      const eventRaw = String(payload.event || "").trim();
      const eventLower = eventRaw.toLowerCase();

      if (eventLower === "test_ping" || eventLower === "mcasms.ping_test") {
        return jsonResponse({
          ok: true,
          pong: true,
          event: eventRaw || "TEST_PING",
          mode: deviceMode
        });
      }

      const isDeliveryCallback =
        url.searchParams.get("kind") === "callback" ||
        payload.kind === "delivery_callback" ||
        ((String(payload.status || "").toUpperCase() === "SENT" ||
          String(payload.status || "").toUpperCase() === "FAILED") &&
          Boolean(payload.phoneNumber));

      if (isDeliveryCallback) {
        const cbStatus = String(payload.status || "UNKNOWN").toUpperCase();
        console.log(
          `[api-mcasms-webhook] Delivery callback: status=${cbStatus}, phone=${maskPhone(payload.phoneNumber)}, sim=${payload.simSlot || 1}${payload.error ? `, error=${payload.error}` : ""}`
        );
        return jsonResponse({
          ok: true,
          handled: "delivery_callback",
          status: cbStatus
        });
      }

      if (eventLower === "sms.sent") {
        return jsonResponse({ ok: true, handled: "sms.sent" });
      }

      if (eventLower !== "sms.received" && eventLower !== "opt_out.received") {
        return jsonResponse({ ok: true, ignored: eventRaw || "unknown" });
      }

      const callerPhone = String(payload.call?.caller_number || payload.phone || payload.from || "").trim();
      const messageBody = String(payload.sms?.body || payload.message || "").trim();
      const simSlot = Number(payload.sim_slot || 1) || 1;
      const upperMsg = messageBody.toUpperCase();
      const digits10 = normalizePhoneDigits(callerPhone);

      const isOptOutEvent = eventLower === "opt_out.received" || OPT_OUT_KEYWORDS.has(upperMsg);
      if (isOptOutEvent) {
        const matchedLead = await findMatchingLeadByPhone(callerPhone, fetchFn);
        if (deviceMode === "personal" && !matchedLead) {
          return jsonResponse({ ok: true, ignored: "personal_device_non_lead" });
        }

        await persistOptOut(callerPhone);
        const stamp = new Date().toISOString().split("T")[0];
        if (matchedLead) {
          await appendLeadNote(matchedLead, `[${stamp} SMS OPT-OUT via MCASMS]: "${messageBody || "STOP"}"`, fetchFn);
        }
        await Promise.resolve(
          recordBuffer({
            source: "mcasms_sms",
            severity: "important",
            title: `SMS Opt-Out Logged (${matchedLead ? `${matchedLead.first_name || ""} ${matchedLead.last_name || ""}`.trim() : callerPhone})`,
            summary: `Caller ${callerPhone} opted out via "${messageBody || "STOP"}". Future automated SMS suppressed.`,
            payload: { phone: callerPhone, lead_id: matchedLead?.id || null }
          })
        ).catch(() => {});

        return jsonResponse({
          ok: true,
          handled: "opt_out",
          matched_lead_id: matchedLead?.id || null
        });
      }

      // Skip shortcodes / non-10-digit senders and 2FA/OTP automated alerts
      if (!digits10 || AUTOMATED_OTP_REGEX.test(messageBody)) {
        return jsonResponse({ ok: true, ignored: "automated_or_shortcode" });
      }

      const matchedLead = await findMatchingLeadByPhone(callerPhone, fetchFn);

      // Personal Device Privacy Gate: discard personal non-lead texts with zero DB writes, logs, or emails
      if (deviceMode === "personal" && !matchedLead) {
        return jsonResponse({ ok: true, ignored: "personal_device_non_lead" });
      }

      const stamp = new Date().toISOString().split("T")[0];
      if (matchedLead) {
        await appendLeadNote(
          matchedLead,
          `[${stamp} Inbound SMS via MCASMS SIM ${simSlot}]: "${messageBody}"`,
          fetchFn
        );
      }

      const leadName = matchedLead
        ? `${matchedLead.first_name || ""} ${matchedLead.last_name || ""}`.trim() || "Homeowner"
        : "Caller";

      if (String(sysSettings?.chief_buffer_mode || "") === "true") {
        await Promise.resolve(
          recordBuffer({
            source: "mcasms_sms",
            severity: "important",
            title: `Inbound SMS Reply from ${leadName} (${callerPhone})`,
            summary: `Message (SIM ${simSlot}): "${messageBody}"${matchedLead?.id ? ` | Lead #${matchedLead.id}` : ""}`,
            payload: { phone: callerPhone, lead_id: matchedLead?.id || null, sim_slot: simSlot }
          })
        ).catch(() => {});
      }

      const ownerEmail = getOwnerEmail();
      if (ownerEmail) {
        const safeFrom = escapeHtml(callerPhone || "Unknown");
        const safeName = escapeHtml(leadName);
        const safeBody = escapeHtml(messageBody || "(empty SMS)").replace(/\n/g, "<br>");
        await Promise.resolve(
          sendEmail({
            from: EmailService.getFromAddress(),
            to: [ownerEmail],
            reply_to: matchedLead?.email || EmailService.getReplyToAddress(),
            subject: `💬 [Inbound SMS Reply] ${leadName} (${callerPhone})`,
            html: `
              <div style="font-family:sans-serif;padding:20px;background:#0f172a;color:#f8fafc;border-radius:12px;">
                <h3 style="margin-top:0;color:#2dd4bf;">Inbound SMS Reply (MCASMS SIM ${simSlot})</h3>
                <p><strong>Lead:</strong> ${safeName}${matchedLead?.id ? ` (#${escapeHtml(matchedLead.id)})` : ""}</p>
                <p><strong>From:</strong> <a href="tel:${safeFrom}" style="color:#38bdf8;">${safeFrom}</a></p>
                <div style="background:#1e293b;padding:14px;border-radius:8px;border:1px solid #334155;margin-top:10px;">
                  ${safeBody}
                </div>
              </div>`,
            text: `Inbound SMS Reply (MCASMS SIM ${simSlot})\nLead: ${leadName}${matchedLead?.id ? ` (#${matchedLead.id})` : ""}\nFrom: ${callerPhone}\nMessage:\n${messageBody}`
          })
        ).catch((err) => console.error("[api-mcasms-webhook] Owner email forward error:", err.message));
      }

      return jsonResponse({
        ok: true,
        handled: "sms.received",
        matched_lead_id: matchedLead?.id || null
      });
    } catch (err) {
      console.error("[api-mcasms-webhook] Error:", err.message);
      return jsonResponse({ ok: false, error: err.message }, 500);
    }
  };
}

export default createMcasmsWebhookHandler();
