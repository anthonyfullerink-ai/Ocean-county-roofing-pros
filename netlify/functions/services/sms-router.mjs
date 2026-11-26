/**
 * Unified Outbound SMS Router (MCASMS Native Android SIM Relay + Twilio Fallback)
 * Dependency-free Node ESM module for Netlify Functions.
 *
 * Supports:
 * - MCASMS Inbound Cloud Relay (https://missedcallautosms.com/api/dispatch-sms)
 * - Twilio Programmable Messaging REST API
 * - Personal Device vs Dedicated Business Device loop guards
 * - TCPA STOP opt-out suppression persisted in Supabase system_settings
 */
import { AIEmailAgent } from "./ai-email-handler.mjs";

const DEFAULT_MCASMS_RELAY_URL = "https://missedcallautosms.com/api/dispatch-sms";
const DEFAULT_CALLBACK_BASE = "https://oceancountyroofingpros.com/api/mcasms/webhook";

export function normalizePhoneDigits(raw) {
  if (!raw || typeof raw !== "string") return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 10) return "";
  return digits.slice(-10);
}

export function sanitizePhoneE164(raw) {
  if (!raw || typeof raw !== "string") return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return raw.trim();
}

export function parseOptOutSet(sysSettings = {}) {
  const raw = sysSettings?.sms_opt_outs_json;
  if (!raw) return new Set();
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.map((p) => normalizePhoneDigits(String(p || ""))).filter(Boolean));
  } catch {
    return new Set();
  }
}

export function isOptedOut(phone, sysSettings = {}) {
  const norm = normalizePhoneDigits(String(phone || ""));
  if (!norm) return false;
  return parseOptOutSet(sysSettings).has(norm);
}

export async function recordOptOut(phone, fetchFn = fetch) {
  const norm = normalizePhoneDigits(String(phone || ""));
  if (!norm) return { recorded: false, reason: "invalid_phone" };

  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (!supabaseUrl || !supabaseKey) {
    return { recorded: false, reason: "supabase_unconfigured", phone10: norm };
  }

  const headers = {
    apikey: supabaseKey,
    Authorization: `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };

  let existingList = [];
  try {
    const getRes = await fetchFn(
      `${supabaseUrl}/rest/v1/system_settings?key=eq.sms_opt_outs_json&limit=1`,
      { headers }
    );
    if (getRes.ok) {
      const rows = await getRes.json().catch(() => []);
      if (rows[0]?.value) {
        const parsed = JSON.parse(rows[0].value);
        if (Array.isArray(parsed)) existingList = parsed;
      }
    }
  } catch (err) {
    console.warn("[sms-router] Failed reading existing sms_opt_outs_json:", err.message);
  }

  const set = new Set(existingList.map((p) => normalizePhoneDigits(String(p || ""))).filter(Boolean));
  const alreadyPresent = set.has(norm);
  set.add(norm);

  if (!alreadyPresent) {
    try {
      await fetchFn(`${supabaseUrl}/rest/v1/system_settings`, {
        method: "POST",
        headers: { ...headers, Prefer: "resolution=merge-duplicates" },
        body: JSON.stringify({
          key: "sms_opt_outs_json",
          value: JSON.stringify(Array.from(set)),
          updated_at: new Date().toISOString()
        })
      });
    } catch (err) {
      console.error("[sms-router] Failed persisting sms_opt_outs_json:", err.message);
      return { recorded: false, reason: err.message, phone10: norm };
    }
  }

  return { recorded: true, phone10: norm, count: set.size };
}

export function isPersonalSelfNumber(toPhone, sysSettings = {}) {
  const targetNorm = normalizePhoneDigits(String(toPhone || ""));
  const deviceNorm = normalizePhoneDigits(
    String(sysSettings?.mcasms_device_phone || process.env.MCASMS_DEVICE_PHONE || "")
  );
  if (!targetNorm || !deviceNorm) return false;
  return targetNorm === deviceNorm;
}

export function resolveSmsProvider(sysSettings = {}) {
  const mode = String(sysSettings?.sms_provider || process.env.SMS_PROVIDER || "auto")
    .trim()
    .toLowerCase();
  const hasMcasms = Boolean((process.env.MCASMS_LICENSE_KEY || "").trim());
  const hasTwilio = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);

  if (mode === "mcasms") return "mcasms";
  if (mode === "twilio") return "twilio";
  if (hasMcasms) return "mcasms";
  if (hasTwilio) return "twilio";
  return "none";
}

export function buildMcasmsCallbackUrl() {
  const secret = (process.env.MCASMS_WEBHOOK_SECRET || "").trim();
  const base = `${DEFAULT_CALLBACK_BASE}?kind=callback`;
  return secret ? `${base}&token=${encodeURIComponent(secret)}` : base;
}

export async function sendViaMcasms({ to, body, simSlot = 1, callbackUrl = "", fetchFn = fetch }) {
  const endpoint = (process.env.MCASMS_RELAY_URL || DEFAULT_MCASMS_RELAY_URL).trim();
  const licenseKey = (process.env.MCASMS_LICENSE_KEY || "").trim();
  const slotNum = Number(simSlot) || 1;

  if (!licenseKey) {
    return {
      sent: false,
      provider: "mcasms",
      status: "unconfigured",
      reason: "MCASMS_LICENSE_KEY not set",
      to,
      body
    };
  }

  try {
    const res = await fetchFn(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-License-Key": licenseKey
      },
      body: JSON.stringify({
        to,
        message: body,
        sim_slot: slotNum,
        callback_url: callbackUrl || buildMcasmsCallbackUrl()
      }),
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok && (data.success || data.status === "DISPATCHED_TO_DEVICE")) {
      return {
        sent: true,
        provider: "mcasms",
        status: "dispatched_to_device",
        fcm_message_id: data.fcm_message_id || null,
        sim_slot: Number(data.sim_slot || slotNum) || slotNum,
        to: data.phone || to,
        body
      };
    }

    return {
      sent: false,
      provider: "mcasms",
      status: "error",
      code: res.status,
      error: data.error || data.message || `MCASMS HTTP ${res.status}`,
      to,
      body
    };
  } catch (err) {
    return {
      sent: false,
      provider: "mcasms",
      status: "error",
      code: 0,
      error: err?.message || "MCASMS network error",
      to,
      body
    };
  }
}

export async function sendViaTwilio({ to, body, fetchFn = fetch }) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const twilioPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";

  if (!twilioSid || !twilioToken) {
    return {
      sent: false,
      provider: "twilio",
      status: "mock_logged",
      reason: "Twilio credentials not set in environment",
      to,
      from: twilioPhone,
      body
    };
  }

  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
  try {
    const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        To: to,
        From: twilioPhone,
        Body: body
      })
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        sent: false,
        provider: "twilio",
        status: "error",
        error: data.message || "Twilio error",
        code: res.status,
        to,
        from: twilioPhone,
        body
      };
    }

    return {
      sent: true,
      provider: "twilio",
      status: "dispatched",
      sid: data.sid || null,
      to,
      from: twilioPhone,
      body
    };
  } catch (err) {
    return {
      sent: false,
      provider: "twilio",
      status: "error",
      code: 0,
      error: err?.message || "Twilio network error",
      to,
      from: twilioPhone,
      body
    };
  }
}

export async function sendUnifiedSms({
  to,
  body,
  purpose = "customer",
  simSlot = null,
  sysSettings = null,
  fetchFn = fetch
} = {}) {
  const toPhone = sanitizePhoneE164(String(to || ""));
  const msgBody = String(body || "").trim();

  if (!toPhone || !msgBody) {
    return {
      sent: false,
      status: "invalid_input",
      reason: "Missing destination phone or message body"
    };
  }

  const settings = sysSettings != null ? sysSettings : await AIEmailAgent.loadSystemSettings().catch(() => ({}));

  if (purpose !== "emergency_partner" && purpose !== "owner_alert" && isOptedOut(toPhone, settings)) {
    return {
      sent: false,
      provider: "suppressed",
      status: "opted_out",
      reason: "Recipient previously opted out (STOP)",
      to: toPhone
    };
  }

  const provider = resolveSmsProvider(settings);

  if (provider === "mcasms") {
    const deviceMode = String(settings.mcasms_device_mode || "personal").toLowerCase();
    const sendOwnerAlerts = String(settings.mcasms_send_owner_alerts || "false").toLowerCase() === "true";

    if (isPersonalSelfNumber(toPhone, settings) || (deviceMode === "personal" && purpose === "owner_alert" && !sendOwnerAlerts)) {
      return {
        sent: false,
        provider: "mcasms",
        status: "skipped_personal_device",
        reason: "Owner/self SMS skipped in Personal Device mode (Email/Elena alerts remain active)",
        to: toPhone
      };
    }

    const resolvedSimSlot = Number(simSlot || settings.mcasms_sim_slot || process.env.MCASMS_SIM_SLOT || 1) || 1;
    return await sendViaMcasms({
      to: toPhone,
      body: msgBody,
      simSlot: resolvedSimSlot,
      fetchFn
    });
  }

  if (provider === "twilio") {
    return await sendViaTwilio({ to: toPhone, body: msgBody, fetchFn });
  }

  return {
    sent: false,
    provider: "none",
    status: "mock_logged",
    reason: "No SMS provider configured (MCASMS_LICENSE_KEY or Twilio credentials missing)",
    to: toPhone,
    body: msgBody
  };
}
