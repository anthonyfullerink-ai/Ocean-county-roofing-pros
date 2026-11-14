import test from "node:test";
import assert from "node:assert/strict";
import { GCalService, nyLocalToDate, parseSlotDateTime } from "../netlify/functions/services/gcal-service.mjs";
import { parseIcsBusyIntervals, fetchIcsBusyIntervals } from "../netlify/functions/services/ics-parser.mjs";
import {
  normalizeEmergencyConfig,
  isWithinEmergencyHours,
  resolveEmergencyHandler
} from "../netlify/functions/services/emergency-router.mjs";
import calendarHandler from "../netlify/functions/api-calendar.mjs";
import webformHandler from "../netlify/functions/api-webform.mjs";
import adminHandler from "../netlify/functions/api-admin.mjs";
import vapiToolsHandler from "../netlify/functions/api-vapi-tools.mjs";
import vapiWebhookHandler from "../netlify/functions/api-vapi-webhook.mjs";
import twilioSmsHandler from "../netlify/functions/api-twilio-sms.mjs";

test("GCalService filters Sundays, busy conflicts, and same-day 90m lead buffer", async () => {
  // Friday Nov 13, 2026 at 10:15 AM EST
  const fakeNow = nyLocalToDate("2026-11-13", 10, 15).date;

  // Saturday Nov 14 has 11:30 AM busy on Apps Script calendar
  const satBusyStart = nyLocalToDate("2026-11-14", 11, 0).date.toISOString();
  const satBusyEnd = nyLocalToDate("2026-11-14", 12, 30).date.toISOString();

  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = "https://script.google.com/macros/s/mock/exec";

  const mockFetch = async () =>
    new Response(
      JSON.stringify({
        status: "success",
        action: "availability",
        busy: [{ start: satBusyStart, end: satBusyEnd }]
      }),
      { status: 200 }
    );

  // Urgent=true starts Friday Nov 13 (should skip 9:00 AM & 11:30 AM due to 90m buffer, offer 2:00 PM & 4:30 PM)
  const urgentAvail = await GCalService.getAvailableDays({
    calendarId: "primary",
    daysCount: 4,
    includeTodayUrgent: true,
    now: fakeNow,
    fetchFn: mockFetch
  });

  assert.equal(urgentAvail.live_calendar_checked, true);
  assert.equal(urgentAvail.calendar_source, "apps_script");
  const friday = urgentAvail.days.find(d => d.date === "2026-11-13");
  assert.ok(friday, "Urgent same-day Friday should be present");
  assert.deepEqual(
    friday.slots.map(s => s.time),
    ["2:00 PM", "4:30 PM"]
  );

  // Saturday Nov 14 should exclude 11:30 AM due to busy overlap
  const saturday = urgentAvail.days.find(d => d.date === "2026-11-14");
  assert.ok(saturday);
  assert.deepEqual(
    saturday.slots.map(s => s.time),
    ["9:00 AM", "2:00 PM", "4:30 PM"]
  );

  // Sunday Nov 15 must be skipped cleanly
  const sunday = urgentAvail.days.find(d => d.date === "2026-11-15");
  assert.equal(sunday, undefined);
});

test("GCalService detects pre-flight conflicts on booking", async () => {
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = "https://script.google.com/macros/s/mock/exec";

  const conflictSlot = parseSlotDateTime("2026-11-14", "2:00 PM");
  const mockFetch = async (_url, opts = {}) => {
    if ((opts.method || "GET").toUpperCase() === "GET") {
      return new Response(
        JSON.stringify({
          busy: [
            {
              start: conflictSlot.startIso,
              end: conflictSlot.endIso
            }
          ]
        }),
        { status: 200 }
      );
    }
    throw new Error("Should not POST createEvent when conflict exists");
  };

  const result = await GCalService.bookAppointment({
    calendarId: "primary",
    leadId: "WEB-101",
    customerName: "Jane Doe",
    phone: "7325550199",
    address: "100 Main St, Toms River, NJ",
    service: "Roof Inspection",
    dateStr: "2026-11-14",
    timeStr: "2:00 PM",
    fetchFn: mockFetch
  });

  assert.equal(result.status, "conflict");
});

test("Netlify api-webform.mjs and api-calendar.mjs end-to-end capture-first + email mode + booking", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = "https://script.google.com/macros/s/mock/exec";
  process.env.RESEND_API_KEY = "";
  process.env.TWILIO_ACCOUNT_SID = "";

  const networkLog = [];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    networkLog.push({ u, method, body: opts.body });

    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([{ setting_key: "territory_routing_json", setting_value: "{}" }]), { status: 200 });
    }
    if (u.includes("/rest/v1/tenants")) {
      return new Response(
        JSON.stringify([
          {
            tenant_id: "client_joe_the_roofer",
            company_name: "Joe The Roofer LLC",
            scheduling_type: "google_calendar",
            is_active: true
          }
        ]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/leads") && method === "POST") {
      return new Response("", { status: 201 });
    }
    if (u.includes("/rest/v1/leads") && method === "PATCH") {
      return new Response(null, { status: 204 });
    }
    if (u.includes("script.google.com") && method === "GET") {
      return new Response(JSON.stringify({ status: "success", busy: [] }), { status: 200 });
    }
    if (u.includes("script.google.com") && method === "POST") {
      return new Response(
        JSON.stringify({
          status: "success",
          eventId: "evt_gcal_999",
          start: "2026-11-16T14:00:00.000Z",
          end: "2026-11-16T15:00:00.000Z"
        }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    // 1. Standard form missing phone -> 400
    const badReq = new Request("https://oceancountyroofingpros.com/api/leads/webform", {
      method: "POST",
      body: JSON.stringify({ first_name: "NoPhone", phone: "   " })
    });
    const badRes = await webformHandler(badReq);
    assert.equal(badRes.status, 400);

    // 2. Email-only inquiry mode without phone -> 200
    const emailReq = new Request("https://oceancountyroofingpros.com/api/leads/webform", {
      method: "POST",
      body: JSON.stringify({
        first_name: "Mary Email",
        phone: "",
        email: "mary@example.com",
        city: "Brick",
        contact_preference: "email",
        notes: "[Direct Email Inquiry] Need shingle replacement quote"
      })
    });
    const emailRes = await webformHandler(emailReq);
    assert.equal(emailRes.status, 200);
    const emailBody = await emailRes.json();
    assert.ok(emailBody.lead_id.startsWith("WEB-"));

    // 3. GET /api/calendar/availability
    const availReq = new Request("https://oceancountyroofingpros.com/api/calendar/availability?city=Toms+River&days=5");
    const availRes = await calendarHandler(availReq);
    assert.equal(availRes.status, 200);
    const availJson = await availRes.json();
    assert.equal(availJson.scheduling_type, "google_calendar");
    assert.ok(availJson.days.length > 0);
    assert.ok(availJson.days[0].slots.length > 0);

    // 4. POST /api/calendar/book updates lead & creates event
    const chosenDay = availJson.days[0];
    const chosenSlot = chosenDay.slots[0];
    const bookReq = new Request("https://oceancountyroofingpros.com/api/calendar/book", {
      method: "POST",
      body: JSON.stringify({
        lead_id: emailBody.lead_id,
        date: chosenDay.date,
        display_day: chosenDay.display_label,
        time: chosenSlot.time,
        name: "John Smith",
        phone: "7325550123",
        email: "john@example.com",
        address: "123 Bay Ave, Toms River, NJ",
        city: "Toms River"
      })
    });
    const bookRes = await calendarHandler(bookReq);
    assert.equal(bookRes.status, 200);
    const bookJson = await bookRes.json();
    assert.equal(bookJson.status, "success");
    assert.equal(bookJson.event_id, "evt_gcal_999");

    const patchCall = networkLog.find(c => c.u.includes(`/rest/v1/leads?id=eq.${emailBody.lead_id}`) && c.method === "PATCH");
    assert.ok(patchCall, "Expected Supabase lead PATCH after calendar confirmation");
    assert.equal(JSON.parse(patchCall.body).status, "Inspection Booked");
  } finally {
    global.fetch = originalFetch;
  }
});

test("ics-parser extracts UTC, TZID, weekly RRULE busy windows and skips CANCELLED/TRANSPARENT events", () => {
  const sampleIcs = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "DTSTART:20261114T140000Z", // 9:00 AM EST
    "DTEND:20261114T150000Z",   // 10:00 AM EST
    "SUMMARY:Supplier Delivery",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261114T113000",
    "DTEND;TZID=America/New_York:20261114T123000",
    "STATUS:CANCELLED",
    "SUMMARY:Cancelled Job",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261114T163000",
    "DTEND;TZID=America/New_York:20261114T173000",
    "TRANSP:TRANSPARENT",
    "SUMMARY:Free Reminder",
    "END:VEVENT",
    "BEGIN:VEVENT",
    "DTSTART;TZID=America/New_York:20261113T140000",
    "DTEND;TZID=America/New_York:20261113T150000",
    "RRULE:FREQ=WEEKLY;BYDAY=FR",
    "SUMMARY:Weekly Crew Meeting",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const startRange = nyLocalToDate("2026-11-13", 0, 0).date;
  const endRange = nyLocalToDate("2026-11-22", 23, 59).date;
  const busy = parseIcsBusyIntervals(sampleIcs, startRange, endRange);

  // Expect Nov 14 14:00Z + two weekly Friday meetings (Nov 13 & Nov 20)
  assert.equal(busy.length, 3);
  assert.equal(busy[0].start, "2026-11-14T14:00:00.000Z");
});

test("GCalService honors custom contractor availability, blackout dates, daily caps, and .ics feed conflicts", async () => {
  const fakeNow = nyLocalToDate("2026-11-13", 10, 0).date; // Friday
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = "";

  // ICS blocks Saturday Nov 14 at 2:00 PM EST (19:00 UTC)
  const icsBody = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "DTSTART:20261114T190000Z",
    "DTEND:20261114T200000Z",
    "SUMMARY:Personal Appointment",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");

  const mockFetch = async () => new Response(icsBody, { status: 200 });

  const avail = await GCalService.getAvailableDays({
    calendarId: "primary",
    daysCount: 5,
    availabilityConfig: {
      days_of_week: ["Sat", "Mon", "Tue"],
      windows: ["9:00 AM", "2:00 PM"],
      min_notice: "next_day",
      max_per_day: 2,
      blackout_dates: ["2026-11-16"] // Monday blacked out
    },
    icsFeedUrl: "https://calendar.google.com/calendar/ical/test/basic.ics",
    bookedCountsByDate: {
      "2026-11-17": 2 // Tuesday capped out at max_per_day = 2
    },
    now: fakeNow,
    fetchFn: mockFetch
  });

  // Saturday Nov 14: 2:00 PM blocked by .ics, leaving only 9:00 AM
  const sat = avail.days.find(d => d.date === "2026-11-14");
  assert.ok(sat, "Saturday should be present");
  assert.deepEqual(sat.slots.map(s => s.time), ["9:00 AM"]);

  // Sunday closed, Monday 11-16 blacked out, Tuesday 11-17 full (2/2)
  assert.equal(avail.days.find(d => d.date === "2026-11-15"), undefined);
  assert.equal(avail.days.find(d => d.date === "2026-11-16"), undefined);
  assert.equal(avail.days.find(d => d.date === "2026-11-17"), undefined);
});

test("External embed detection, /api/calendar/webhook, /api/portal/test-ics, and /api/portal/settings preserve sensitive tenant fields", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = "";
  process.env.RESEND_API_KEY = "";

  const dbTenants = [
    {
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      estimator_name: "Riley Davis",
      dispatch_phone: "+17326609121",
      email: "riley@joetheroofer.com",
      scheduling_type: "external_link",
      booking_url: "https://calendly.com/joe-roofer/inspection",
      calendar_id: "secret-cal@group.calendar.google.com",
      portal_pin: "9988",
      monthly_retainer: 2500,
      is_active: true
    }
  ];
  const dbSettings = [];
  const leadPatches = [];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();

    if (u.includes("calendar.example.com/feed.ics")) {
      return new Response(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:20261120T140000Z\r\nDTEND:20261120T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR",
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/tenants") && method === "GET") {
      return new Response(JSON.stringify(dbTenants), { status: 200 });
    }
    if (u.includes("/rest/v1/tenants") && method === "POST") {
      const payload = JSON.parse(opts.body);
      Object.assign(dbTenants[0], payload);
      return new Response(JSON.stringify(dbTenants), { status: 201 });
    }
    if (u.includes("/rest/v1/system_settings") && method === "GET") {
      return new Response(JSON.stringify(dbSettings), { status: 200 });
    }
    if (u.includes("/rest/v1/system_settings") && method === "POST") {
      const row = JSON.parse(opts.body);
      const existing = dbSettings.find(s => s.key === row.key);
      if (existing) existing.value = row.value;
      else dbSettings.push(row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }
    if (u.includes("/rest/v1/leads") && method === "PATCH") {
      leadPatches.push({ url: u, body: JSON.parse(opts.body) });
      return new Response(null, { status: 204 });
    }
    return new Response("[]", { status: 200 });
  };

  try {
    // 1. Availability exposes embed_supported: true for Calendly URL
    const extAvailRes = await calendarHandler(
      new Request("https://oceancountyroofingpros.com/api/calendar/availability?city=Toms+River")
    );
    assert.equal(extAvailRes.status, 200);
    const extAvail = await extAvailRes.json();
    assert.equal(extAvail.scheduling_type, "external_link");
    assert.equal(extAvail.embed_supported, true);

    // 2. Calendly webhook auto-updates lead status + appointment_slot
    const whRes = await calendarHandler(
      new Request("https://oceancountyroofingpros.com/api/calendar/webhook", {
        method: "POST",
        body: JSON.stringify({
          event: "invitee.created",
          payload: {
            email: "homeowner@example.com",
            name: "Sam Homeowner",
            scheduled_event: { start_time: "2026-11-18T14:00:00Z" },
            tracking: { utm_content: "WEB-777" }
          }
        })
      })
    );
    assert.equal(whRes.status, 200);
    const whJson = await whRes.json();
    assert.equal(whJson.provider, "calendly");
    assert.equal(whJson.lead_id, "WEB-777");
    assert.equal(leadPatches.length, 1);
    assert.equal(leadPatches[0].body.status, "Inspection Booked");

    // 3. POST /api/portal/test-ics validates iCalendar feed
    const icsTestRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/portal/test-ics", {
        method: "POST",
        body: JSON.stringify({ ics_feed_url: "https://calendar.example.com/feed.ics" })
      })
    );
    assert.equal(icsTestRes.status, 200);
    const icsTestJson = await icsTestRes.json();
    assert.equal(icsTestJson.checked, true);

    // 4. POST /api/portal/settings saves availability + preserves portal_pin, calendar_id, monthly_retainer, is_active
    const saveRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/portal/settings", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: "client_joe_the_roofer",
          company_name: "Joe The Roofer LLC",
          estimator_name: "Riley Davis",
          scheduling_type: "google_calendar",
          booking_url: "",
          dispatch_phone: "+17326609121",
          email: "riley@joetheroofer.com",
          ics_feed_url: "https://calendar.example.com/feed.ics",
          availability: {
            days_of_week: ["Mon", "Wed", "Fri"],
            windows: ["9:00 AM", "2:00 PM"],
            min_notice: "48h",
            max_per_day: 3,
            blackout_dates: ["2026-11-26"]
          }
        })
      })
    );
    assert.equal(saveRes.status, 200);
    assert.equal(dbTenants[0].portal_pin, "9988");
    assert.equal(dbTenants[0].calendar_id, "secret-cal@group.calendar.google.com");
    assert.equal(dbTenants[0].monthly_retainer, 2500);
    assert.equal(dbTenants[0].is_active, true);
    const savedSchedRow = dbSettings.find(s => s.key === "tenant_schedule_client_joe_the_roofer");
    assert.ok(savedSchedRow, "Expected tenant schedule mirror in system_settings");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Emergency dispatch router resolves daytime opt-out, extended quiet hours, and county overflow", async () => {
  const daytimePartner = {
    tenant_id: "brick_daytime",
    company_name: "Brick Daytime Roofing",
    dispatch_phone: "+17325550101"
  };
  const stormOverflow = {
    tenant_id: "county_overflow",
    company_name: "24/7 Storm Tarping LLC",
    dispatch_phone: "+17325550199"
  };
  const extendedPartner = {
    tenant_id: "extended_partner",
    company_name: "Extended Hours Roofers",
    dispatch_phone: "+17325550188"
  };

  const extendedCfg = normalizeEmergencyConfig({
    emergency_enabled: true,
    emergency_mode: "live_transfer",
    emergency_phone: "7325550188",
    emergency_hours: "extended_7am_9pm",
    max_response_eta_min: 15
  });
  assert.equal(extendedCfg.emergency_phone, "+17325550188");

  const middayEt = nyLocalToDate("2026-11-13", 14, 0).date;
  const lateNightEt = nyLocalToDate("2026-11-13", 23, 30).date;
  assert.equal(isWithinEmergencyHours(extendedCfg, middayEt), true);
  assert.equal(isWithinEmergencyHours(extendedCfg, lateNightEt), false);

  const settingsWithOverflow = {
    tenant_emergency_brick_daytime: JSON.stringify({ emergency_enabled: false }),
    tenant_emergency_county_overflow: JSON.stringify({
      emergency_enabled: true,
      emergency_mode: "live_transfer",
      emergency_phone: "+17325550199",
      emergency_hours: "24_7"
    }),
    emergency_dispatch_policy: JSON.stringify({ overflow_tenant_id: "county_overflow" })
  };

  // 1. Daytime partner opted out -> routes to county overflow
  const overflowRes = await resolveEmergencyHandler({
    addressOrCity: "Brick, NJ",
    sysSettings: settingsWithOverflow,
    primaryTenant: daytimePartner,
    tenants: [daytimePartner, stormOverflow],
    now: lateNightEt
  });
  assert.equal(overflowRes.available_now, true);
  assert.equal(overflowRes.is_overflow, true);
  assert.equal(overflowRes.mode, "live_transfer");
  assert.equal(overflowRes.tenant.tenant_id, "county_overflow");

  // 2. Extended-hours partner at 11:30 PM ET with no overflow -> honest quiet hours morning priority
  const quietRes = await resolveEmergencyHandler({
    addressOrCity: "Toms River, NJ",
    sysSettings: {
      tenant_emergency_extended_partner: JSON.stringify(extendedCfg),
      emergency_dispatch_policy: JSON.stringify({ overflow_tenant_id: "" })
    },
    primaryTenant: extendedPartner,
    tenants: [extendedPartner],
    now: lateNightEt
  });
  assert.equal(quietRes.available_now, false);
  assert.equal(quietRes.after_hours_quiet, true);
  assert.equal(quietRes.mode, "morning_priority");
  assert.equal(quietRes.reason, "quiet_hours");
});

test("Vapi tools (triage_emergency, dispatch_emergency, check_availability), portal emergency settings, and webform emergency escalation", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.TWILIO_ACCOUNT_SID = "AC_MOCK";
  process.env.TWILIO_AUTH_TOKEN = "mock_token";
  process.env.TWILIO_PHONE_NUMBER = "+17326609121";
  process.env.GOOGLE_SERVICE_ACCOUNT_JSON = "";
  process.env.GOOGLE_CALENDAR_WEBHOOK_URL = "";

  const dbTenants = [
    {
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      estimator_name: "Riley Davis",
      dispatch_phone: "+17326609121",
      email: "riley@joetheroofer.com",
      scheduling_type: "google_calendar",
      calendar_id: "cal-123",
      portal_pin: "4455",
      monthly_retainer: 2000,
      is_active: true
    },
    {
      tenant_id: "overflow_storm_co",
      company_name: "Jersey Shore Emergency Tarping",
      estimator_name: "Mike Storm",
      dispatch_phone: "+17325550999",
      email: "dispatch@stormtarping.com",
      scheduling_type: "google_calendar",
      portal_pin: "8899",
      monthly_retainer: 1500,
      is_active: false
    }
  ];
  const dbSettings = [
    {
      key: "tenant_schedule_client_joe_the_roofer",
      value: JSON.stringify({ days_of_week: ["Sat"], windows: ["9:00 AM", "4:30 PM"], min_notice: "next_day" })
    },
    { key: "tenant_emergency_client_joe_the_roofer", value: JSON.stringify({ emergency_enabled: false }) }
  ];
  const insertedLeads = [];
  const twilioMessages = [];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/rest/v1/tenants") && method === "GET") {
      if (u.includes("tenant_id=eq.overflow_storm_co")) {
        return new Response(JSON.stringify([dbTenants[1]]), { status: 200 });
      }
      if (u.includes("is_active=eq.true")) {
        return new Response(JSON.stringify([dbTenants[0]]), { status: 200 });
      }
      return new Response(JSON.stringify(dbTenants), { status: 200 });
    }
    if (u.includes("/rest/v1/tenants") && method === "POST") {
      return new Response(JSON.stringify(dbTenants), { status: 201 });
    }
    if (u.includes("/rest/v1/system_settings") && method === "GET") {
      return new Response(JSON.stringify(dbSettings), { status: 200 });
    }
    if (u.includes("/rest/v1/system_settings") && method === "POST") {
      const row = JSON.parse(opts.body);
      const ex = dbSettings.find(s => s.key === row.key);
      if (ex) ex.value = row.value;
      else dbSettings.push(row);
      return new Response(JSON.stringify([row]), { status: 201 });
    }
    if (u.includes("/rest/v1/leads") && method === "POST") {
      const lead = JSON.parse(opts.body);
      insertedLeads.push(lead);
      return new Response(JSON.stringify([lead]), { status: 201 });
    }
    if (u.includes("/rest/v1/leads") && method === "GET") {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("api.twilio.com") && method === "POST") {
      twilioMessages.push(String(opts.body));
      return new Response(JSON.stringify({ sid: "SM_MOCK" }), { status: 201 });
    }
    return new Response("[]", { status: 200 });
  };

  try {
    // 1. Triage emergency before overflow configured -> honest NO OVERNIGHT CREW
    const triageOffRes = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            toolCalls: [{ id: "tc-1", function: { name: "triage_emergency", arguments: { address_or_town: "Toms River, NJ" } } }]
          }
        })
      })
    );
    const triageOffJson = await triageOffRes.json();
    assert.match(triageOffJson.results[0].result, /NO OVERNIGHT CREW IS AVAILABLE/);

    // 2. Enable emergency_config via /api/portal/settings & set overflow via /api/admin/routing
    const portalSaveRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/portal/settings", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: "overflow_storm_co",
          company_name: "Jersey Shore Emergency Tarping",
          estimator_name: "Mike Storm",
          dispatch_phone: "+17325550999",
          emergency_config: {
            emergency_enabled: true,
            emergency_mode: "live_transfer",
            emergency_phone: "7325550999",
            emergency_hours: "24_7",
            max_response_eta_min: 15,
            tarping_fee_note: "Emergency tarping quote approved upfront."
          }
        })
      })
    );
    assert.equal(portalSaveRes.status, 200);

    const routeRes = await adminHandler(
      new Request("https://oceancountyroofingpros.com/api/admin/routing", {
        method: "POST",
        body: JSON.stringify({
          territory_routing: {},
          emergency_dispatch_policy: { overflow_tenant_id: "overflow_storm_co" }
        })
      })
    );
    assert.equal(routeRes.status, 200);

    // 3. Triage emergency now routes to live transfer overflow partner + live check_availability works
    const triageOnRes = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            toolCalls: [
              { id: "tc-2", function: { name: "triage_emergency", arguments: { address_or_town: "Toms River, NJ" } } },
              {
                id: "tc-3",
                function: {
                  name: "dispatch_emergency",
                  arguments: {
                    name: "Pat Homeowner",
                    phone: "7325550144",
                    address: "42 Oak St, Toms River, NJ",
                    issue_summary: "Active leak over kitchen"
                  }
                }
              },
              { id: "tc-4", function: { name: "check_availability", arguments: { requested_date: "" } } }
            ]
          }
        })
      })
    );
    const vapiJson = await triageOnRes.json();
    assert.match(vapiJson.results[0].result, /EMERGENCY LIVE TRANSFER ACTIVE/);
    assert.match(vapiJson.results[0].result, /\+17325550999/);
    assert.match(vapiJson.results[1].result, /Emergency priority alert #EMERG-.*dispatched to Jersey Shore Emergency Tarping/);
    assert.match(vapiJson.results[2].result, /Next available open inspection windows are:/);
    assert.equal(insertedLeads[0].status, "Emergency Priority");
    assert.equal(insertedLeads[0].assigned_tenant_id, "overflow_storm_co");
    assert.ok(twilioMessages.some(b => decodeURIComponent(b).includes("+17325550999")));

    // 4. Webform Active Water Leak routes to Emergency Priority + returns emergency_dispatch
    const webRes = await webformHandler(
      new Request("https://oceancountyroofingpros.com/api/leads/webform", {
        method: "POST",
        body: JSON.stringify({
          first_name: "Casey",
          phone: "7325550133",
          city: "Toms River",
          situation: "Active Water Leak",
          urgency: "Emergency",
          notes: "Shingles torn off"
        })
      })
    );
    assert.equal(webRes.status, 200);
    const webJson = await webRes.json();
    assert.equal(webJson.emergency_dispatch.available_now, true);
    assert.equal(webJson.emergency_dispatch.is_overflow, true);
    assert.equal(insertedLeads[1].status, "Emergency Priority");
  } finally {
    global.fetch = originalFetch;
  }
});

test("Vapi request_human_callback, Twilio inbound SMS webhook, and Admin Toll-Free diagnostics", async () => {
  const originalFetch = global.fetch;
  process.env.SUPABASE_URL = "https://mock-supabase.local";
  process.env.SUPABASE_KEY = "mock_key";
  process.env.RESEND_API_KEY = "re_mock";
  process.env.OWNER_ALERT_EMAIL = "anthony.fuller.ink@gmail.com";
  process.env.OWNER_ALERT_PHONE = "+17325523896";
  process.env.TWILIO_ACCOUNT_SID = "AC_MOCK";
  process.env.TWILIO_AUTH_TOKEN = "mock_token";
  process.env.TWILIO_PHONE_NUMBER = "+18669001221";
  process.env.VAPI_API_KEY = "vapi_mock";

  const insertedLeads = [];
  const emailsSent = [];
  const smsSent = [];

  global.fetch = async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    if (u.includes("/rest/v1/tenants")) {
      return new Response(
        JSON.stringify([{ tenant_id: "client_joe_the_roofer", company_name: "Joe The Roofer LLC", is_active: true }]),
        { status: 200 }
      );
    }
    if (u.includes("/rest/v1/system_settings")) {
      return new Response(JSON.stringify([]), { status: 200 });
    }
    if (u.includes("/rest/v1/leads") && method === "POST") {
      const lead = JSON.parse(opts.body);
      insertedLeads.push(lead);
      return new Response(JSON.stringify([lead]), { status: 201 });
    }
    if (u.includes("api.resend.com/emails")) {
      emailsSent.push(JSON.parse(opts.body));
      return new Response(JSON.stringify({ id: "email_human_mock" }), { status: 200 });
    }
    if (u.includes("api.resend.com/domains")) {
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }
    if (u.includes("api.vapi.ai")) {
      return new Response(JSON.stringify({ id: "asst" }), { status: 200 });
    }
    if (u.includes("api.twilio.com") && u.includes("/Messages.json") && method === "POST") {
      smsSent.push(String(opts.body));
      return new Response(JSON.stringify({ sid: "SM_HUMAN_MOCK" }), { status: 201 });
    }
    if (u.includes("api.twilio.com/2010-04-01/Accounts/")) {
      return new Response(JSON.stringify({ sid: "AC_MOCK", status: "active" }), { status: 200 });
    }
    if (u.includes("messaging.twilio.com/v1/Tollfree/Verifications")) {
      return new Response(
        JSON.stringify({ verifications: [{ tollfree_phone_number: "+18669001221", status: "IN_REVIEW" }] }),
        { status: 200 }
      );
    }
    return new Response("{}", { status: 200 });
  };

  try {
    // 1. Vapi request_human_callback tool logs Human Callback Requested + fires Resend Email & Twilio SMS
    const toolRes = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        body: JSON.stringify({
          message: {
            type: "tool-calls",
            call: { customer: { number: "+17325550122" } },
            toolCalls: [
              {
                id: "tc-human-1",
                function: {
                  name: "request_human_callback",
                  arguments: {
                    name: "jordan",
                    address_or_town: "Brick, NJ",
                    reason: "Wants to discuss a commercial flat roof quote with the owner",
                    agent_name: "Sarah"
                  }
                }
              }
            ]
          }
        })
      })
    );
    assert.equal(toolRes.status, 200);
    const toolJson = await toolRes.json();
    assert.match(toolJson.results[0].result, /Human callback ticket #HUMAN-/);
    assert.match(toolJson.results[0].result, /(within the hour|8 AM)/);
    assert.equal(insertedLeads[0].status, "Human Callback Requested");
    assert.equal(insertedLeads[0].phone, "+17325550122");
    assert.equal(emailsSent.length, 1);
    assert.match(emailsSent[0].subject, /\[Human Requested\] jordan/);
    assert.equal(smsSent.length, 1);
    assert.ok(decodeURIComponent(smsSent[0]).includes("+17325523896"));

    // 2. Twilio inbound SMS webhook forwards customer reply via Resend & honors HELP/STOP
    const inboundRes = await twilioSmsHandler(
      new Request("https://oceancountyroofingpros.com/api/twilio/sms-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: "+17325550190", To: "+18669001221", Body: "Can someone call me at 4?" })
      })
    );
    assert.equal(inboundRes.status, 200);
    assert.match(await inboundRes.text(), /<Response><\/Response>/);
    assert.equal(emailsSent.length, 2);
    assert.match(emailsSent[1].subject, /\[Inbound SMS\]/);

    const helpRes = await twilioSmsHandler(
      new Request("https://oceancountyroofingpros.com/api/twilio/sms-inbound", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ From: "+17325550190", To: "+18669001221", Body: "HELP" })
      })
    );
    assert.match(await helpRes.text(), /Ocean County Roofing Pros/);

    // 3. Admin diagnostics surfaces live Toll-Free Verification status cleanly
    const diagRes = await adminHandler(new Request("https://oceancountyroofingpros.com/api/admin/diagnostics"));
    assert.equal(diagRes.status, 200);
    const diagJson = await diagRes.json();
    assert.equal(diagJson.checks.twilio.status, "online");
    assert.equal(diagJson.checks.twilio.tollfree_status, "IN_REVIEW");
    assert.equal(diagJson.checks.twilio.sms_approved, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("VAPI_SERVER_SECRET rejects missing or invalid x-vapi-secret and allows matching secret", async () => {
  const prevSecret = process.env.VAPI_SERVER_SECRET;
  const prevSupaUrl = process.env.SUPABASE_URL;
  process.env.VAPI_SERVER_SECRET = "test-vapi-secret-xyz";
  process.env.SUPABASE_URL = "";

  try {
    const badTool = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        body: JSON.stringify({ message: { toolCalls: [] } })
      })
    );
    assert.equal(badTool.status, 401);

    const wrongTool = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        headers: { "x-vapi-secret": "wrong" },
        body: JSON.stringify({ message: { toolCalls: [] } })
      })
    );
    assert.equal(wrongTool.status, 401);

    const okTool = await vapiToolsHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/tools", {
        method: "POST",
        headers: { "x-vapi-secret": "test-vapi-secret-xyz" },
        body: JSON.stringify({ message: { toolCalls: [] } })
      })
    );
    assert.equal(okTool.status, 200);

    const badHook = await vapiWebhookHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/webhook", {
        method: "POST",
        body: JSON.stringify({ message: { type: "status-update" } })
      })
    );
    assert.equal(badHook.status, 401);

    const okHook = await vapiWebhookHandler(
      new Request("https://oceancountyroofingpros.com/api/vapi/webhook", {
        method: "POST",
        headers: { "x-vapi-secret": "test-vapi-secret-xyz" },
        body: JSON.stringify({ message: { type: "status-update" } })
      })
    );
    assert.equal(okHook.status, 200);
  } finally {
    process.env.VAPI_SERVER_SECRET = prevSecret ?? "";
    process.env.SUPABASE_URL = prevSupaUrl ?? "";
  }
});
