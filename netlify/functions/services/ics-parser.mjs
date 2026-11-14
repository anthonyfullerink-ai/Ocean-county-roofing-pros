/**
 * Dependency-Free iCalendar (.ics) Busy-Interval Parser
 * Extracts read-only VEVENT busy windows (Google Calendar Secret iCal URL, Outlook, Apple iCloud)
 * over a target [rangeStart, rangeEnd] window without requiring OAuth credentials.
 */
import { getNyDateParts, nyLocalToDate, addDaysIso } from "./gcal-service.mjs";

const WEEKDAY_BY_CODE = {
  SU: "Sun",
  MO: "Mon",
  TU: "Tue",
  WE: "Wed",
  TH: "Thu",
  FR: "Fri",
  SA: "Sat"
};

/**
 * Parses an iCal timestamp string (YYYYMMDD, YYYYMMDDTHHMMSS, or YYYYMMDDTHHMMSSZ) into a Date.
 */
export function parseIcsTimestamp(rawVal, tzId = "") {
  if (!rawVal) return null;
  const val = rawVal.trim();

  // All-day DATE format (YYYYMMDD) -> treat in America/New_York
  const dateOnlyMatch = val.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (dateOnlyMatch) {
    const isoDate = `${dateOnlyMatch[1]}-${dateOnlyMatch[2]}-${dateOnlyMatch[3]}`;
    return { date: nyLocalToDate(isoDate, 0, 0).date, allDay: true, isoDate };
  }

  // Date-time format (YYYYMMDDTHHMMSS[Z])
  const dtMatch = val.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!dtMatch) return null;

  const [, y, m, d, hh, mm, ss, isUtc] = dtMatch;
  if (isUtc === "Z") {
    return {
      date: new Date(Date.UTC(Number(y), Number(m) - 1, Number(d), Number(hh), Number(mm), Number(ss))),
      allDay: false
    };
  }

  // Interpret local/TZID timestamp in Eastern Time (default dispatch zone)
  const isoDate = `${y}-${m}-${d}`;
  const baseDate = nyLocalToDate(isoDate, Number(hh), Number(mm)).date;
  return {
    date: new Date(baseDate.getTime() + Number(ss) * 1000),
    allDay: false,
    tzId
  };
}

function unfoldIcsLines(icsText) {
  return String(icsText || "")
    .replace(/\r\n[ \t]/g, "")
    .replace(/\n[ \t]/g, "")
    .split(/\r?\n/);
}

function parsePropLine(line) {
  const colonIdx = line.indexOf(":");
  if (colonIdx === -1) return null;
  const left = line.slice(0, colonIdx);
  const value = line.slice(colonIdx + 1).trim();
  const parts = left.split(";");
  const name = parts[0].toUpperCase();
  const params = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf("=");
    if (eq !== -1) {
      params[parts[i].slice(0, eq).toUpperCase()] = parts[i].slice(eq + 1);
    }
  }
  return { name, params, value };
}

/**
 * Expands simple WEEKLY/DAILY RRULE occurrences inside [rangeStartMs, rangeEndMs].
 */
function expandRecurringInstances(ev, rangeStartMs, rangeEndMs) {
  const durationMs = Math.max(ev.endMs - ev.startMs, 15 * 60 * 1000);
  const parts = {};
  for (const seg of (ev.rrule || "").split(";")) {
    const [k, v] = seg.split("=");
    if (k && v) parts[k.toUpperCase()] = v.toUpperCase();
  }

  const freq = parts.FREQ;
  const interval = Math.max(parseInt(parts.INTERVAL || "1", 10) || 1, 1);
  let untilMs = rangeEndMs;
  if (parts.UNTIL) {
    const untilParsed = parseIcsTimestamp(parts.UNTIL);
    if (untilParsed) untilMs = Math.min(untilMs, untilParsed.date.getTime());
  }

  const instances = [];
  if (freq !== "WEEKLY" && freq !== "DAILY") {
    if (ev.endMs > rangeStartMs && ev.startMs < rangeEndMs) {
      instances.push({ start: new Date(ev.startMs).toISOString(), end: new Date(ev.endMs).toISOString() });
    }
    return instances;
  }

  const evStartParts = getNyDateParts(new Date(ev.startMs));
  const byDays = parts.BYDAY
    ? parts.BYDAY.split(",").map(c => WEEKDAY_BY_CODE[c.slice(-2)]).filter(Boolean)
    : [evStartParts.weekday];

  const rangeStartNy = getNyDateParts(new Date(rangeStartMs));
  const maxScanDays = Math.min(Math.ceil((rangeEndMs - rangeStartMs) / (24 * 60 * 60 * 1000)) + 2, 21);
  let countLimit = parts.COUNT ? parseInt(parts.COUNT, 10) : Infinity;

  if (freq === "DAILY") {
    for (let d = 0; d < maxScanDays && instances.length < countLimit; d += interval) {
      const isoDate = addDaysIso(rangeStartNy.isoDate, d);
      const occStart = nyLocalToDate(isoDate, evStartParts.hour, evStartParts.minute).date.getTime();
      if (occStart < ev.startMs || occStart > untilMs || occStart >= rangeEndMs) continue;
      const occEnd = occStart + durationMs;
      if (occEnd > rangeStartMs) {
        instances.push({ start: new Date(occStart).toISOString(), end: new Date(occEnd).toISOString() });
      }
    }
    return instances;
  }

  // WEEKLY
  for (let d = 0; d < maxScanDays && instances.length < countLimit; d++) {
    const isoDate = addDaysIso(rangeStartNy.isoDate, d);
    const probe = nyLocalToDate(isoDate, evStartParts.hour, evStartParts.minute).date;
    const nyMeta = getNyDateParts(probe);
    if (!byDays.includes(nyMeta.weekday)) continue;

    const weeksSince = Math.floor((probe.getTime() - ev.startMs) / (7 * 24 * 60 * 60 * 1000));
    if (weeksSince >= 0 && interval > 1 && weeksSince % interval !== 0) continue;

    const occStart = probe.getTime();
    if (occStart < ev.startMs || occStart > untilMs || occStart >= rangeEndMs) continue;
    const occEnd = occStart + durationMs;
    if (occEnd > rangeStartMs) {
      instances.push({ start: new Date(occStart).toISOString(), end: new Date(occEnd).toISOString() });
    }
  }

  return instances;
}

/**
 * Parses iCalendar (.ics) text and returns busy [{ start, end }] intervals intersecting [rangeStart, rangeEnd].
 */
export function parseIcsBusyIntervals(icsText, rangeStartDate, rangeEndDate) {
  const rangeStartMs = rangeStartDate.getTime();
  const rangeEndMs = rangeEndDate.getTime();
  const lines = unfoldIcsLines(icsText);

  const busy = [];
  let cur = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "BEGIN:VEVENT") {
      cur = {};
      continue;
    }
    if (line === "END:VEVENT" && cur) {
      const cancelled = String(cur.status || "").toUpperCase() === "CANCELLED";
      const transparent = String(cur.transp || "").toUpperCase() === "TRANSPARENT";
      if (!cancelled && !transparent && cur.startMs != null) {
        const endMs = cur.endMs != null
          ? cur.endMs
          : cur.allDay
            ? cur.startMs + 24 * 60 * 60 * 1000
            : cur.startMs + 60 * 60 * 1000;

        if (cur.rrule) {
          busy.push(...expandRecurringInstances({ ...cur, endMs }, rangeStartMs, rangeEndMs));
        } else if (endMs > rangeStartMs && cur.startMs < rangeEndMs) {
          busy.push({
            start: new Date(cur.startMs).toISOString(),
            end: new Date(endMs).toISOString()
          });
        }
      }
      cur = null;
      continue;
    }

    if (!cur) continue;
    const prop = parsePropLine(line);
    if (!prop) continue;

    if (prop.name === "DTSTART") {
      const parsed = parseIcsTimestamp(prop.value, prop.params.TZID || "");
      if (parsed) {
        cur.startMs = parsed.date.getTime();
        cur.allDay = parsed.allDay;
      }
    } else if (prop.name === "DTEND") {
      const parsed = parseIcsTimestamp(prop.value, prop.params.TZID || "");
      if (parsed) {
        cur.endMs = parsed.date.getTime();
      }
    } else if (prop.name === "STATUS") {
      cur.status = prop.value;
    } else if (prop.name === "TRANSP") {
      cur.transp = prop.value;
    } else if (prop.name === "RRULE") {
      cur.rrule = prop.value;
    }
  }

  return busy;
}

/**
 * Fetches and parses busy windows from a contractor's read-only .ics feed URL (fail-open).
 */
export async function fetchIcsBusyIntervals(icsUrl, rangeStartDate, rangeEndDate, fetchFn = fetch) {
  if (!icsUrl || typeof icsUrl !== "string") {
    return { checked: false, busy: [], error: null };
  }
  const cleanUrl = icsUrl.trim().replace(/^webcal:\/\//i, "https://");
  if (!cleanUrl.startsWith("https://") && !cleanUrl.startsWith("http://")) {
    return { checked: false, busy: [], error: "URL must start with https://" };
  }

  try {
    const res = await fetchFn(cleanUrl, {
      method: "GET",
      headers: { Accept: "text/calendar, text/plain" },
      signal: typeof AbortSignal !== "undefined" && AbortSignal.timeout ? AbortSignal.timeout(4000) : undefined
    });
    if (!res.ok) {
      return { checked: false, busy: [], error: `Calendar feed returned HTTP ${res.status}` };
    }
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) {
      return { checked: false, busy: [], error: "URL did not return a valid iCalendar (.ics) feed" };
    }
    const busy = parseIcsBusyIntervals(text, rangeStartDate, rangeEndDate);
    return { checked: true, busy, error: null };
  } catch (err) {
    return { checked: false, busy: [], error: err.message };
  }
}
