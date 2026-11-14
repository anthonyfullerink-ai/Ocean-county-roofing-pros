/**
 * Google Calendar Service (Dependency-Free Node ESM for Netlify Functions)
 * Supports:
 * 1. Direct Google Calendar v3 REST API via Service Account JWT (`GOOGLE_SERVICE_ACCOUNT_JSON`)
 * 2. Google Apps Script Web App webhook (`GOOGLE_CALENDAR_WEBHOOK_URL`)
 * 3. Deterministic Eastern Time (America/New_York) curated inspection windows
 */
import crypto from "node:crypto";
import { fetchIcsBusyIntervals } from "./ics-parser.mjs";

const NY_TIMEZONE = "America/New_York";
const DEFAULT_SECONDARY_CALENDAR =
  "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com";

export const CURATED_WINDOWS = [
  { id: "09:00", hour: 9, minute: 0, label: "9:00 AM", tag: "Morning" },
  { id: "11:30", hour: 11, minute: 30, label: "11:30 AM", tag: "Midday" },
  { id: "14:00", hour: 14, minute: 0, label: "2:00 PM", tag: "Afternoon" },
  { id: "16:30", hour: 16, minute: 30, label: "4:30 PM", tag: "Late Day" }
];

export const DEFAULT_AVAILABILITY = {
  days_of_week: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
  windows: ["9:00 AM", "11:30 AM", "2:00 PM", "4:30 PM"],
  min_notice: "next_day", // same_day_2h | next_day | 48h
  max_per_day: 4,
  blackout_dates: []
};

export function normalizeAvailabilityConfig(raw) {
  let parsed = raw;
  if (typeof raw === "string" && raw.trim()) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = {};
    }
  }
  if (!parsed || typeof parsed !== "object") parsed = {};

  const validDays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const daysOfWeek = Array.isArray(parsed.days_of_week) && parsed.days_of_week.length > 0
    ? parsed.days_of_week.filter(d => validDays.includes(d))
    : DEFAULT_AVAILABILITY.days_of_week;

  const validWinLabels = CURATED_WINDOWS.map(w => w.label);
  const windows = Array.isArray(parsed.windows) && parsed.windows.length > 0
    ? parsed.windows.filter(w => validWinLabels.includes(w))
    : DEFAULT_AVAILABILITY.windows;

  const minNotice = ["same_day_2h", "next_day", "48h"].includes(parsed.min_notice)
    ? parsed.min_notice
    : DEFAULT_AVAILABILITY.min_notice;

  const maxPerDay = Number.isFinite(Number(parsed.max_per_day))
    ? Math.max(0, parseInt(parsed.max_per_day, 10))
    : DEFAULT_AVAILABILITY.max_per_day;

  const blackoutDates = Array.isArray(parsed.blackout_dates)
    ? parsed.blackout_dates.map(d => String(d).trim()).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
    : [];

  return {
    days_of_week: daysOfWeek.length > 0 ? daysOfWeek : DEFAULT_AVAILABILITY.days_of_week,
    windows: windows.length > 0 ? windows : DEFAULT_AVAILABILITY.windows,
    min_notice: minNotice,
    max_per_day: maxPerDay,
    blackout_dates: blackoutDates
  };
}

const INSPECTION_DURATION_MS = 60 * 60 * 1000;
let cachedAccessToken = null;
let cachedAccessTokenExp = 0;

/**
 * Computes YYYY-MM-DD, weekday, and UTC offset minutes for America/New_York at any instant.
 */
export function getNyDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "shortOffset"
  });

  const parts = {};
  for (const p of formatter.formatToParts(date)) {
    parts[p.type] = p.value;
  }

  // shortOffset yields e.g. "GMT-5" or "GMT-4"
  const tzRaw = parts.timeZoneName || "GMT-5";
  const match = tzRaw.match(/GMT([+-]\d{1,2})(?::(\d{2}))?/);
  let offsetMinutes = -300;
  if (match) {
    const hrs = parseInt(match[1], 10);
    const mins = parseInt(match[2] || "0", 10);
    offsetMinutes = hrs * 60 + (hrs < 0 ? -mins : mins);
  }

  return {
    year: parseInt(parts.year, 10),
    month: parseInt(parts.month, 10),
    day: parseInt(parts.day, 10),
    hour: parseInt(parts.hour, 10),
    minute: parseInt(parts.minute, 10),
    weekday: parts.weekday,
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    offsetMinutes
  };
}

/**
 * Converts a New York calendar date (YYYY-MM-DD) + hour/minute into an exact UTC Date + ISO-with-offset.
 */
export function nyLocalToDate(isoDate, hour, minute) {
  const [y, m, d] = isoDate.split("-").map(Number);
  // First guess assuming EST (-05:00 -> +5h UTC)
  const approxUtc = new Date(Date.UTC(y, m - 1, d, hour + 5, minute, 0, 0));
  const actualParts = getNyDateParts(approxUtc);
  const utcMs = Date.UTC(y, m - 1, d, hour, minute, 0, 0) - actualParts.offsetMinutes * 60 * 1000;
  const exactDate = new Date(utcMs);

  const offsetHours = Math.trunc(actualParts.offsetMinutes / 60);
  const absH = String(Math.abs(offsetHours)).padStart(2, "0");
  const absM = String(Math.abs(actualParts.offsetMinutes % 60)).padStart(2, "0");
  const sign = actualParts.offsetMinutes >= 0 ? "+" : "-";
  const offsetStr = `${sign}${absH}:${absM}`;

  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  return {
    date: exactDate,
    isoWithOffset: `${isoDate}T${hh}:${mm}:00${offsetStr}`
  };
}

export function addDaysIso(isoDate, deltaDays) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + deltaDays, 12, 0, 0));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
}

export function parseSlotDateTime(dateStr, timeStr) {
  // Parse 12-hour or 24-hour time string into { hour, minute }
  let hour = 13;
  let minute = 0;
  const cleanTime = (timeStr || "").trim().toUpperCase();
  const m12 = cleanTime.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/);
  const m24 = cleanTime.match(/^(\d{1,2}):(\d{2})$/);

  if (m12) {
    hour = parseInt(m12[1], 10);
    minute = parseInt(m12[2] || "0", 10);
    if (m12[3] === "PM" && hour < 12) hour += 12;
    if (m12[3] === "AM" && hour === 12) hour = 0;
  } else if (m24) {
    hour = parseInt(m24[1], 10);
    minute = parseInt(m24[2], 10);
  }

  let isoDate = (dateStr || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    const todayIso = getNyDateParts(new Date()).isoDate;
    isoDate = isoDate.toLowerCase().includes("today") ? todayIso : addDaysIso(todayIso, 1);
  }

  const startInfo = nyLocalToDate(isoDate, hour, minute);
  const endDate = new Date(startInfo.date.getTime() + INSPECTION_DURATION_MS);
  const endParts = getNyDateParts(endDate);
  const endOffset = endInfoOffset(endParts.offsetMinutes);
  const endIso = `${endParts.isoDate}T${String(endParts.hour).padStart(2, "0")}:${String(endParts.minute).padStart(2, "0")}:00${endOffset}`;

  return {
    isoDate,
    startDate: startInfo.date,
    endDate,
    startIso: startInfo.isoWithOffset,
    endIso
  };
}

function endInfoOffset(offsetMinutes) {
  const absH = String(Math.abs(Math.trunc(offsetMinutes / 60))).padStart(2, "0");
  const absM = String(Math.abs(offsetMinutes % 60)).padStart(2, "0");
  return `${offsetMinutes >= 0 ? "+" : "-"}${absH}:${absM}`;
}

/**
 * Signs and exchanges a Google Service Account JSON credential for an OAuth2 access token.
 */
async function getServiceAccountToken(saJsonRaw, fetchFn = fetch) {
  if (cachedAccessToken && Date.now() < cachedAccessTokenExp - 60000) {
    return cachedAccessToken;
  }

  const sa = typeof saJsonRaw === "string" ? JSON.parse(saJsonRaw) : saJsonRaw;
  if (!sa?.client_email || !sa?.private_key) {
    throw new Error("Invalid GOOGLE_SERVICE_ACCOUNT_JSON");
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(
    JSON.stringify({
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/calendar",
      aud: "https://oauth2.googleapis.com/token",
      iat: nowSec,
      exp: nowSec + 3600
    })
  ).toString("base64url");

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key, "base64url");
  const jwt = `${header}.${claims}.${signature}`;

  const tokenRes = await fetchFn("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt
    })
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text();
    throw new Error(`Google OAuth failed (${tokenRes.status}): ${errText}`);
  }

  const tokenData = await tokenRes.json();
  cachedAccessToken = tokenData.access_token;
  cachedAccessTokenExp = Date.now() + (tokenData.expires_in || 3600) * 1000;
  return cachedAccessToken;
}

export class GCalService {
  static resolveCalendarId(tenant) {
    return (
      (tenant && (tenant.calendar_id || tenant.google_calendar_id)) ||
      process.env.GOOGLE_CALENDAR_ID ||
      DEFAULT_SECONDARY_CALENDAR
    );
  }

  /**
   * Queries busy windows across [startDate, endDate] from Service Account or Apps Script webhook.
   */
  static async fetchBusyIntervals({ calendarId, timeMinIso, timeMaxIso, fetchFn = fetch }) {
    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (saJson && saJson.trim()) {
      try {
        const token = await getServiceAccountToken(saJson, fetchFn);
        const res = await fetchFn("https://www.googleapis.com/calendar/v3/freeBusy", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            timeMin: timeMinIso,
            timeMax: timeMaxIso,
            timeZone: NY_TIMEZONE,
            items: [{ id: calendarId }]
          })
        });
        if (res.ok) {
          const data = await res.json();
          const calBusy = data?.calendars?.[calendarId]?.busy || [];
          return { liveChecked: true, source: "service_account", busy: calBusy };
        }
      } catch (err) {
        console.warn("[GCalService] Service Account freeBusy fallback:", err.message);
      }
    }

    const webhookUrl = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
    if (webhookUrl && webhookUrl.trim()) {
      try {
        const url = new URL(webhookUrl.trim());
        url.searchParams.set("action", "availability");
        url.searchParams.set("calendar_id", calendarId);
        url.searchParams.set("start", timeMinIso);
        url.searchParams.set("end", timeMaxIso);

        const res = await fetchFn(url.toString(), { method: "GET" });
        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.busy)) {
            return { liveChecked: true, source: "apps_script", busy: data.busy };
          }
          // Legacy doGet without freeBusy support
          return { liveChecked: false, source: "apps_script_legacy", busy: [] };
        }
      } catch (err) {
        console.warn("[GCalService] Apps Script availability fallback:", err.message);
      }
    }

    return { liveChecked: false, source: "unconfigured", busy: [] };
  }

  /**
   * Builds bookable inspection windows honoring contractor working hours, notice buffers,
   * daily caps, blackout dates, Google Calendar Free/Busy, and optional read-only .ics feed.
   */
  static async getAvailableDays({
    calendarId,
    daysCount = 7,
    includeTodayUrgent = false,
    availabilityConfig = null,
    icsFeedUrl = "",
    bookedCountsByDate = {},
    now = new Date(),
    fetchFn = fetch
  }) {
    const rules = normalizeAvailabilityConfig(availabilityConfig);
    const todayNy = getNyDateParts(now);

    let startOffset = 1;
    if (includeTodayUrgent || rules.min_notice === "same_day_2h") {
      startOffset = 0;
    } else if (rules.min_notice === "48h") {
      startOffset = 2;
    }

    const scanDays = daysCount + 7; // Buffer for closed weekdays & blackout dates

    const rangeStartInfo = nyLocalToDate(addDaysIso(todayNy.isoDate, startOffset), 0, 0);
    const rangeEndInfo = nyLocalToDate(addDaysIso(todayNy.isoDate, startOffset + scanDays), 23, 59);

    const [calResult, icsResult] = await Promise.all([
      this.fetchBusyIntervals({
        calendarId,
        timeMinIso: rangeStartInfo.date.toISOString(),
        timeMaxIso: rangeEndInfo.date.toISOString(),
        fetchFn
      }),
      icsFeedUrl
        ? fetchIcsBusyIntervals(icsFeedUrl, rangeStartInfo.date, rangeEndInfo.date, fetchFn)
        : Promise.resolve({ checked: false, busy: [] })
    ]);

    const combinedBusy = [...(calResult.busy || []), ...(icsResult.busy || [])];
    const parsedBusy = combinedBusy
      .map(b => ({
        startMs: new Date(b.start).getTime(),
        endMs: new Date(b.end).getTime()
      }))
      .filter(b => !Number.isNaN(b.startMs) && !Number.isNaN(b.endMs));

    const days = [];
    const leadBufferMs = rules.min_notice === "same_day_2h" ? 120 * 60 * 1000 : 90 * 60 * 1000;
    const allowedWindows = CURATED_WINDOWS.filter(w => rules.windows.includes(w.label));

    for (let offset = startOffset; offset <= startOffset + scanDays && days.length < daysCount; offset++) {
      const isoDate = addDaysIso(todayNy.isoDate, offset);
      if (rules.blackout_dates.includes(isoDate)) {
        continue;
      }

      if (rules.max_per_day > 0 && (bookedCountsByDate[isoDate] || 0) >= rules.max_per_day) {
        continue;
      }

      const midDay = nyLocalToDate(isoDate, 12, 0).date;
      const nyMeta = getNyDateParts(midDay);

      if (!rules.days_of_week.includes(nyMeta.weekday)) {
        continue;
      }

      const openSlots = [];
      for (const win of allowedWindows) {
        const slotStart = nyLocalToDate(isoDate, win.hour, win.minute).date;
        const slotStartMs = slotStart.getTime();
        const slotEndMs = slotStartMs + INSPECTION_DURATION_MS;

        if (slotStartMs < now.getTime() + leadBufferMs) {
          continue;
        }

        const hasConflict = parsedBusy.some(b => b.startMs < slotEndMs && b.endMs > slotStartMs);
        if (!hasConflict) {
          openSlots.push({
            id: win.id,
            time: win.label,
            tag: win.tag,
            start_iso: nyLocalToDate(isoDate, win.hour, win.minute).isoWithOffset
          });
        }
      }

      if (openSlots.length > 0) {
        const dayTitle = new Intl.DateTimeFormat("en-US", {
          timeZone: NY_TIMEZONE,
          weekday: "short",
          month: "short",
          day: "numeric"
        }).format(midDay);

        let relativeLabel = nyMeta.weekday;
        if (offset === 0) relativeLabel = "Today";
        else if (offset === 1) relativeLabel = "Tomorrow";

        days.push({
          date: isoDate,
          relative_label: relativeLabel,
          display_label: dayTitle,
          slots: openSlots
        });
      }
    }

    return {
      calendar_id: calendarId,
      live_calendar_checked: calResult.liveChecked || icsResult.checked,
      calendar_source: icsResult.checked
        ? `${calResult.source}+ics_feed`
        : calResult.source,
      ics_synced: icsResult.checked,
      days
    };
  }

  /**
   * Books a 60-minute Google Calendar inspection event after verifying no conflict exists.
   * Invites both homeowner email and contractor dispatch email (deduplicated) when provided.
   */
  static async bookAppointment({
    calendarId,
    leadId,
    customerName,
    phone,
    customerEmail,
    contractorEmail = "",
    icsFeedUrl = "",
    address,
    service,
    dateStr,
    timeStr,
    diagnosticSituation = "",
    homeArchitecture = "",
    notes = "",
    fetchFn = fetch
  }) {
    const parsed = parseSlotDateTime(dateStr, timeStr);
    const startMs = parsed.startDate.getTime();
    const endMs = parsed.endDate.getTime();

    // 1. Pre-flight conflict check against live calendar + contractor .ics feed
    const [calBusy, icsBusy] = await Promise.all([
      this.fetchBusyIntervals({
        calendarId,
        timeMinIso: new Date(startMs - 5 * 60 * 1000).toISOString(),
        timeMaxIso: new Date(endMs + 5 * 60 * 1000).toISOString(),
        fetchFn
      }),
      icsFeedUrl
        ? fetchIcsBusyIntervals(icsFeedUrl, parsed.startDate, parsed.endDate, fetchFn)
        : Promise.resolve({ checked: false, busy: [] })
    ]);

    const combinedBusy = [...(calBusy.busy || []), ...(icsBusy.busy || [])];
    const conflict = combinedBusy.some(b => {
      const bs = new Date(b.start).getTime();
      const be = new Date(b.end).getTime();
      return bs < endMs && be > startMs;
    });

    if (conflict) {
      return {
        status: "conflict",
        message: "That inspection window was just claimed. Please select another open time."
      };
    }

    const summary = `Roof Inspection: ${customerName || "Homeowner"}`;
    const fullDescription = [
      `Customer: ${customerName || "Homeowner"}`,
      `Phone: ${phone || "Not provided"}`,
      `Email: ${customerEmail || "Not provided"}`,
      `Address: ${address || "Ocean County, NJ"}`,
      `Service: ${service || "21-Point Roof & Attic Inspection"}`,
      `Lead ID: ${leadId || "Web"}`,
      "",
      `Situation: ${diagnosticSituation || "Standard"}`,
      `Home Architecture: ${homeArchitecture || "Standard"}`,
      `Notes: ${notes || "Booked online"}`,
      "",
      "Dispatched via Ocean County Roofing Pros"
    ].join("\n");

    const guestEmails = [];
    if (customerEmail && customerEmail.includes("@")) {
      guestEmails.push(customerEmail.trim());
    }
    if (contractorEmail && contractorEmail.includes("@") && !guestEmails.includes(contractorEmail.trim())) {
      guestEmails.push(contractorEmail.trim());
    }

    // 2. Prefer direct Service Account Calendar API if configured
    const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
    if (saJson && saJson.trim()) {
      try {
        const token = await getServiceAccountToken(saJson, fetchFn);
        const eventBody = {
          summary,
          location: address || "Ocean County, NJ",
          description: fullDescription,
          start: { dateTime: parsed.startIso, timeZone: NY_TIMEZONE },
          end: { dateTime: parsed.endIso, timeZone: NY_TIMEZONE },
          reminders: {
            useDefault: false,
            overrides: [
              { method: "popup", minutes: 15 },
              { method: "popup", minutes: 60 },
              { method: "email", minutes: 1440 }
            ]
          }
        };
        if (guestEmails.length > 0) {
          eventBody.attendees = guestEmails.map(email => ({ email }));
        }

        const sendUpdates = eventBody.attendees ? "all" : "none";
        const res = await fetchFn(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=${sendUpdates}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify(eventBody)
          }
        );

        if (res.ok) {
          const created = await res.json();
          return {
            status: "success",
            provider: "google_calendar_api",
            event_id: created.id,
            html_link: created.htmlLink || null,
            start: parsed.startIso,
            end: parsed.endIso
          };
        }
      } catch (err) {
        console.warn("[GCalService] Direct API createEvent failed, trying webhook:", err.message);
      }
    }

    // 3. Google Apps Script Webhook fallback
    const webhookUrl = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
    if (webhookUrl && webhookUrl.trim()) {
      try {
        const res = await fetchFn(webhookUrl.trim(), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "book",
            check_conflict: true,
            calendar_id: calendarId,
            lead_id: leadId,
            customer_name: customerName || "Homeowner",
            phone: phone || "",
            customer_email: guestEmails.join(","),
            address: address || "Ocean County, NJ",
            service: service || "21-Point Roof & Attic Inspection",
            diagnostic_situation: diagnosticSituation,
            home_architecture: homeArchitecture,
            notes,
            start: parsed.startIso,
            end: parsed.endIso
          })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.status === "conflict") {
            return {
              status: "conflict",
              message: data.message || "Selected window is already booked."
            };
          }
          return {
            status: "success",
            provider: "apps_script",
            event_id: data.eventId || null,
            start: data.start || parsed.startIso,
            end: data.end || parsed.endIso
          };
        }
      } catch (err) {
        console.error("[GCalService] Webhook createEvent error:", err.message);
      }
    }

    return {
      status: "queued",
      provider: "crm_only",
      event_id: null,
      start: parsed.startIso,
      end: parsed.endIso
    };
  }
}
