/**
 * Multi-Tenant 24-Hour Emergency Dispatch Router & Twilio Escalation Helper
 * Dependency-free Node ESM module for Netlify Functions.
 *
 * Resolves whether an active roof leak / storm breach for a given Ocean/Monmouth town
 * should be handled by:
 *   1. The town's assigned / primary active contractor (when opted into 24/7 or extended hours)
 *   2. The county-wide 24/7 Emergency Overflow Partner configured in /admin
 *   3. Honest Next-Morning Priority Capture (9:00 AM earliest slot) when no overnight crew is active
 */
import { AIEmailAgent } from "./ai-email-handler.mjs";
import { getNyDateParts } from "./gcal-service.mjs";

export const DEFAULT_EMERGENCY_CONFIG = {
  emergency_enabled: false,
  emergency_mode: "sms_callback", // "sms_callback" | "live_transfer"
  emergency_phone: "",
  emergency_hours: "24_7", // "24_7" | "extended_7am_9pm"
  after_hours_behavior: "sms_and_first_slot",
  tarping_fee_note: "Free daytime emergency inspection; after-hours tarping quote provided upfront before any work begins.",
  max_response_eta_min: 30
};

export function sanitizePhoneE164(raw) {
  if (!raw || typeof raw !== "string") return "";
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.trim().startsWith("+") && digits.length >= 10) return `+${digits}`;
  return raw.trim();
}

export function normalizeEmergencyConfig(raw, fallbackPhone = "") {
  let parsed = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = {};

  const enabled = Boolean(parsed.emergency_enabled);
  const mode = parsed.emergency_mode === "live_transfer" ? "live_transfer" : "sms_callback";
  const hours = parsed.emergency_hours === "extended_7am_9pm" ? "extended_7am_9pm" : "24_7";
  const phone = sanitizePhoneE164(parsed.emergency_phone || "") || sanitizePhoneE164(fallbackPhone || "");
  const feeNote = typeof parsed.tarping_fee_note === "string" && parsed.tarping_fee_note.trim()
    ? parsed.tarping_fee_note.trim()
    : DEFAULT_EMERGENCY_CONFIG.tarping_fee_note;
  const etaRaw = parseInt(parsed.max_response_eta_min ?? DEFAULT_EMERGENCY_CONFIG.max_response_eta_min, 10);
  const maxResponseEtaMin = Number.isFinite(etaRaw) ? Math.min(Math.max(etaRaw, 5), 180) : 30;

  return {
    emergency_enabled: enabled,
    emergency_mode: mode,
    emergency_phone: phone,
    emergency_hours: hours,
    after_hours_behavior: "sms_and_first_slot",
    tarping_fee_note: feeNote,
    max_response_eta_min: maxResponseEtaMin
  };
}

export function isWithinEmergencyHours(emergencyConfig, now = new Date()) {
  if (!emergencyConfig?.emergency_enabled) return false;
  if (emergencyConfig.emergency_hours !== "extended_7am_9pm") return true;
  const ny = getNyDateParts(now);
  return ny.hour >= 7 && ny.hour < 21;
}

export function parseEmergencyPolicy(sysSettings = {}) {
  const raw = sysSettings?.emergency_dispatch_policy;
  if (!raw) return { overflow_tenant_id: "" };
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return {
      overflow_tenant_id: String(parsed?.overflow_tenant_id || "").trim()
    };
  } catch {
    return { overflow_tenant_id: "" };
  }
}

export function getTenantEmergencyConfig(tenant, sysSettings = {}) {
  if (!tenant) return normalizeEmergencyConfig(null, "");
  const rawFromSettings = sysSettings[`tenant_emergency_${tenant.tenant_id}`];
  return normalizeEmergencyConfig(
    rawFromSettings || tenant.emergency_config || tenant.emergency_config_json || null,
    tenant.dispatch_phone || ""
  );
}

async function fetchTenantRecordById(tenantId, fetchFn = fetch) {
  const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (!supabaseUrl || !supabaseKey || !tenantId) return null;
  try {
    const res = await fetchFn(
      `${supabaseUrl}/rest/v1/tenants?tenant_id=eq.${encodeURIComponent(tenantId)}&limit=1`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );
    if (res.ok) {
      const rows = await res.json();
      return rows[0] || null;
    }
  } catch (err) {
    console.warn("[emergency-router] Could not fetch overflow tenant:", err.message);
  }
  return null;
}

/**
 * Resolves the authoritative contractor & escalation policy for an emergency roof leak.
 */
export async function resolveEmergencyHandler({
  addressOrCity = "",
  sysSettings = null,
  primaryTenant = null,
  tenants = null,
  now = new Date(),
  fetchFn = fetch
} = {}) {
  const settingsMap = sysSettings || (await AIEmailAgent.loadSystemSettings().catch(() => ({})));
  const resolvedPrimary =
    primaryTenant ||
    (await AIEmailAgent.resolveTenantForText(addressOrCity, settingsMap.territory_routing_json));

  const primaryCfg = getTenantEmergencyConfig(resolvedPrimary, settingsMap);
  const primaryActiveNow = isWithinEmergencyHours(primaryCfg, now);

  if (primaryActiveNow) {
    return {
      tenant: resolvedPrimary,
      emergencyConfig: primaryCfg,
      available_now: true,
      is_overflow: false,
      mode: primaryCfg.emergency_mode,
      after_hours_quiet: false,
      reason: "primary_partner",
      dispatch_company: resolvedPrimary?.company_name || "Ocean County Roofing Pros"
    };
  }

  // Primary partner opted out or in quiet hours -> check County-Wide Emergency Overflow Partner
  const policy = parseEmergencyPolicy(settingsMap);
  const overflowId = policy.overflow_tenant_id;
  if (overflowId && overflowId !== resolvedPrimary?.tenant_id) {
    let overflowTenant = Array.isArray(tenants)
      ? tenants.find(t => t.tenant_id === overflowId) || null
      : null;
    if (!overflowTenant) {
      overflowTenant = await fetchTenantRecordById(overflowId, fetchFn);
    }

    if (overflowTenant) {
      const overflowCfg = getTenantEmergencyConfig(overflowTenant, settingsMap);
      if (isWithinEmergencyHours(overflowCfg, now)) {
        return {
          tenant: overflowTenant,
          primary_tenant: resolvedPrimary,
          emergencyConfig: overflowCfg,
          available_now: true,
          is_overflow: true,
          mode: overflowCfg.emergency_mode,
          after_hours_quiet: false,
          reason: "overflow_partner",
          dispatch_company: overflowTenant.company_name || "24/7 Emergency Overflow Crew"
        };
      }
    }
  }

  const afterHoursQuiet = Boolean(primaryCfg.emergency_enabled && !primaryActiveNow);
  return {
    tenant: resolvedPrimary,
    emergencyConfig: primaryCfg,
    available_now: false,
    is_overflow: false,
    mode: "morning_priority",
    after_hours_quiet: afterHoursQuiet,
    reason: afterHoursQuiet ? "quiet_hours" : "no_24h_partner",
    dispatch_company: resolvedPrimary?.company_name || "Ocean County Roofing Pros"
  };
}

/**
 * Fires immediate high-priority Twilio SMS alerts to the assigned emergency phone (and owner desk if enabled).
 */
export async function sendEmergencySmsEscalation({
  tenant,
  emergencyConfig,
  lead = {},
  isOverflow = false,
  sysSettings = {},
  fetchFn = fetch
} = {}) {
  const twilioSid = process.env.TWILIO_ACCOUNT_SID;
  const twilioToken = process.env.TWILIO_AUTH_TOKEN;
  const fromPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";
  const targetPhone = sanitizePhoneE164(
    emergencyConfig?.emergency_phone || tenant?.dispatch_phone || process.env.OWNER_ALERT_PHONE || "+17326609121"
  );

  if (!twilioSid || !twilioToken || !targetPhone) {
    return { sent: false, reason: "twilio_unconfigured_or_no_phone", to: targetPhone };
  }

  const overflowTag = isOverflow ? " [OVERFLOW POOL]" : "";
  const leadId = lead.id || lead.lead_id || "URGENT";
  const name = lead.name || lead.first_name || "Homeowner";
  const phone = lead.phone || "No phone provided";
  const address = lead.address || lead.street_address || lead.city || "Ocean County, NJ";
  const summary = lead.issue_summary || lead.service || lead.notes || "Active Water Leak / Storm Breach";

  const smsText = `🚨 [24/7 EMERGENCY LEAK${overflowTag}] #${leadId} | ${name} (${phone}) | ${address} | Issue: ${summary}. Please call homeowner ASAP!`;
  const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");

  try {
    const res = await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        To: targetPhone,
        From: fromPhone,
        Body: smsText
      })
    });

    // Optional owner copy if emergency_phone is different from owner alert phone
    const ownerPhone = sanitizePhoneE164(
      sysSettings?.owner_alert_phone || process.env.OWNER_ALERT_PHONE || ""
    );
    if (
      ownerPhone &&
      ownerPhone !== targetPhone &&
      String(sysSettings?.alert_on_emergency ?? "true").toLowerCase() !== "false"
    ) {
      await fetchFn(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
        method: "POST",
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          To: ownerPhone,
          From: fromPhone,
          Body: `[Owner CC -> ${tenant?.company_name || "Partner"}] ${smsText}`
        })
      }).catch(() => {});
    }

    if (!res.ok) {
      return { sent: false, to: targetPhone, status: res.status };
    }
    const data = await res.json().catch(() => ({}));
    return { sent: true, to: targetPhone, sid: data.sid || null };
  } catch (err) {
    return { sent: false, to: targetPhone, error: err.message };
  }
}
