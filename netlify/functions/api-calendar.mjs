/**
 * Netlify Serverless Function: Live Calendar Availability, Self-Booking & External Scheduler Webhooks
 * Routes:
 *   GET  /api/calendar/availability
 *   POST /api/calendar/book
 *   POST /api/calendar/webhook  (Calendly, HubSpot Meetings, Cal.com, & client postMessage bridge)
 */
import { EmailService } from "./services/email-service.mjs";
import { AIEmailAgent } from "./services/ai-email-handler.mjs";
import { GCalService, formatPropertyAddress, getNyDateParts, normalizeAvailabilityConfig } from "./services/gcal-service.mjs";
import { resolveEmergencyHandler } from "./services/emergency-router.mjs";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    }
  });
}

function isEmbedSupportedUrl(urlStr) {
  if (!urlStr) return false;
  const lower = String(urlStr).toLowerCase();
  return (
    lower.includes("calendly.com") ||
    lower.includes("hubspot.com") ||
    lower.includes("cal.com") ||
    lower.includes("acuityscheduling.com")
  );
}

async function resolveTenantAndSchedule(locationText = "") {
  let tenant = {
    tenant_id: "client_joe_the_roofer",
    company_name: "Joe The Roofer LLC",
    estimator_name: "Riley Davis",
    email: "",
    scheduling_type: "google_calendar",
    booking_url: "",
    calendar_id: process.env.GOOGLE_CALENDAR_ID || "",
    ics_feed_url: "",
    availability_json: null
  };
  let sysSettings = {};

  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (supabaseUrl && supabaseKey) {
    try {
      sysSettings = await AIEmailAgent.loadSystemSettings();
      if (locationText) {
        tenant = await AIEmailAgent.resolveTenantForText(
          locationText,
          sysSettings.territory_routing_json
        );
      } else {
        tenant = await AIEmailAgent.loadActiveTenant();
      }
    } catch (err) {
      console.warn("[api-calendar] Tenant resolution fallback:", err.message);
    }
  }

  // Hydrate resilient schedule config stored in system_settings (fallback-safe before manual ALTER TABLE)
  let scheduleExtras = {};
  const rawSchedule = sysSettings[`tenant_schedule_${tenant.tenant_id}`];
  if (rawSchedule) {
    try {
      scheduleExtras = typeof rawSchedule === "string" ? JSON.parse(rawSchedule) : rawSchedule;
    } catch {
      scheduleExtras = {};
    }
  }

  const icsFeedUrl = tenant.ics_feed_url || scheduleExtras.ics_feed_url || "";
  const availabilityConfig = normalizeAvailabilityConfig(
    tenant.availability_json || scheduleExtras.availability || null
  );

  return { tenant, sysSettings, icsFeedUrl, availabilityConfig };
}

async function fetchBookedCountsByDate(tenantId) {
  const counts = {};
  const supabaseUrl = process.env.SUPABASE_URL || "";
  const supabaseKey = process.env.SUPABASE_KEY || "";
  if (!supabaseUrl || !supabaseKey || !tenantId) return counts;

  try {
    const res = await fetch(
      `${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?assigned_tenant_id=eq.${encodeURIComponent(tenantId)}&status=eq.${encodeURIComponent("Inspection Booked")}&select=appointment_slot`,
      {
        headers: {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`
        }
      }
    );
    if (res.ok) {
      const rows = await res.json();
      for (const row of rows) {
        const m = String(row.appointment_slot || "").match(/^(\d{4}-\d{2}-\d{2})/);
        if (m) {
          counts[m[1]] = (counts[m[1]] || 0) + 1;
        }
      }
    }
  } catch (err) {
    console.warn("[api-calendar] Could not fetch booked counts:", err.message);
  }
  return counts;
}

function formatNySlot(isoTimestamp) {
  if (!isoTimestamp) return { slotText: "", dateStr: "", timeStr: "" };
  const dt = new Date(isoTimestamp);
  if (Number.isNaN(dt.getTime())) return { slotText: String(isoTimestamp), dateStr: "", timeStr: "" };
  const parts = getNyDateParts(dt);
  const timeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(dt);
  return {
    dateStr: parts.isoDate,
    timeStr,
    slotText: `${parts.isoDate} ${timeStr}`
  };
}

function parseExternalWebhookPayload(body) {
  // 1. Calendly v2 webhook (event === "invitee.created")
  if (body?.event === "invitee.created" && body?.payload) {
    const p = body.payload;
    const startIso = p.scheduled_event?.start_time || p.scheduled_event?.startTime || "";
    const tracking = p.tracking || {};
    const leadId = tracking.utm_content || tracking.utm_term || "";
    const email = p.email || "";
    const name = p.name || "";
    return { provider: "calendly", startIso, leadId, email, name };
  }

  // 2. Cal.com webhook (triggerEvent === "BOOKING_CREATED")
  if (body?.triggerEvent === "BOOKING_CREATED" && body?.payload) {
    const p = body.payload;
    const startIso = p.startTime || "";
    const leadId = p.metadata?.lead_id || "";
    const attendee = Array.isArray(p.attendees) ? p.attendees[0] : null;
    const email = attendee?.email || p.responses?.email?.value || "";
    const name = attendee?.name || p.responses?.name?.value || "";
    return { provider: "cal.com", startIso, leadId, email, name };
  }

  // 3. HubSpot Meetings / Client postMessage bridge / Generic webhook
  const startIso =
    body?.start_time ||
    body?.startTime ||
    body?.payload?.startTime ||
    body?.meeting?.startTime ||
    "";
  const leadId = body?.lead_id || body?.utm_content || body?.metadata?.lead_id || "";
  const email = body?.email || body?.attendee_email || body?.contact?.email || "";
  const name = body?.name || "";
  const provider = body?.provider || "external_scheduler";
  const dateStr = body?.date || "";
  const timeStr = body?.time || "";
  return { provider, startIso, leadId, email, name, dateStr, timeStr };
}

export default async (req) => {
  const url = new URL(req.url);
  const path = url.pathname || "";

  // 1. GET /api/calendar/availability
  if (req.method === "GET" && path.endsWith("/availability")) {
    try {
      const city = url.searchParams.get("city") || "";
      const includeToday = url.searchParams.get("urgent") === "true";
      const daysCount = Math.min(Math.max(parseInt(url.searchParams.get("days") || "6", 10) || 6, 1), 10);

      const { tenant, sysSettings, icsFeedUrl, availabilityConfig } = await resolveTenantAndSchedule(city);
      const emerg = await resolveEmergencyHandler({
        addressOrCity: city,
        sysSettings,
        primaryTenant: tenant
      });
      const emergency_dispatch = {
        available_now: emerg.available_now,
        is_overflow: emerg.is_overflow,
        mode: emerg.mode,
        after_hours_quiet: emerg.after_hours_quiet,
        dispatch_company: emerg.dispatch_company,
        tarping_fee_note: emerg.emergencyConfig?.tarping_fee_note || ""
      };

      if (tenant.scheduling_type === "external_link" && tenant.booking_url) {
        return json({
          status: "success",
          scheduling_type: "external_link",
          booking_url: tenant.booking_url,
          embed_supported: isEmbedSupportedUrl(tenant.booking_url),
          company_name: tenant.company_name,
          emergency_dispatch,
          days: []
        });
      }

      const calendarId = GCalService.resolveCalendarId(tenant);
      const bookedCountsByDate = await fetchBookedCountsByDate(tenant.tenant_id);
      const availability = await GCalService.getAvailableDays({
        calendarId,
        daysCount,
        includeTodayUrgent: includeToday,
        availabilityConfig,
        icsFeedUrl,
        bookedCountsByDate
      });

      return json({
        status: "success",
        scheduling_type: "google_calendar",
        company_name: tenant.company_name,
        emergency_dispatch,
        ...availability
      });
    } catch (err) {
      console.error("[api-calendar] availability error:", err);
      return json({ status: "error", message: err.message }, 500);
    }
  }

  // 2. POST /api/calendar/book
  if (req.method === "POST" && path.endsWith("/book")) {
    try {
      const body = await req.json();
      const leadId = (body.lead_id || "").trim();
      const dateStr = (body.date || "").trim();
      const timeStr = (body.time || "").trim();
      const displayDay = (body.display_day || dateStr).trim();
      const name = (body.name || body.first_name || "Homeowner").trim();
      const phone = (body.phone || "").trim();
      const email = (body.email || "").trim();
      const address = (body.address || "Ocean County, NJ").trim();
      const city = (body.city || "Toms River").trim();
      const formattedAddress = formatPropertyAddress(address, city);
      const service = (body.service || "21-Point Roof & Attic Inspection").trim();

      if (!dateStr || !timeStr) {
        return json({ detail: "Date and inspection window are required." }, 400);
      }
      if (!EMAIL_REGEX.test(email)) {
        return json({ detail: "Valid email address is required." }, 400);
      }

      const { tenant, icsFeedUrl } = await resolveTenantAndSchedule(`${formattedAddress} ${city}`);
      if (tenant.scheduling_type === "external_link" && tenant.booking_url) {
        return json({
          status: "external_redirect",
          scheduling_type: "external_link",
          booking_url: tenant.booking_url,
          embed_supported: isEmbedSupportedUrl(tenant.booking_url)
        });
      }

      const calendarId = GCalService.resolveCalendarId(tenant);
      const bookResult = await GCalService.bookAppointment({
        calendarId,
        leadId,
        customerName: name,
        phone,
        customerEmail: email,
        contractorEmail: tenant.email || "",
        ownerEmail: EmailService.getOwnerAlertEmail(),
        icsFeedUrl,
        address: formattedAddress,
        service,
        dateStr,
        timeStr,
        diagnosticSituation: body.diagnostic_situation || "",
        homeArchitecture: body.home_architecture || "",
        notes: body.notes || ""
      });

      if (bookResult.status === "conflict") {
        return json({
          status: "conflict",
          message: bookResult.message
        }, 409);
      }

      const appointmentSlot = `${dateStr} ${timeStr}`.trim();

      const supabaseUrl = process.env.SUPABASE_URL || "";
      const supabaseKey = process.env.SUPABASE_KEY || "";
      if (supabaseUrl && supabaseKey && leadId) {
        try {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?id=eq.${encodeURIComponent(leadId)}`, {
            method: "PATCH",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              appointment_slot: appointmentSlot,
              status: "Inspection Booked",
              updated_at: new Date().toISOString()
            })
          });
        } catch (dbErr) {
          console.error("[api-calendar] Supabase lead patch error:", dbErr);
        }
      }

      const twilioSid = process.env.TWILIO_ACCOUNT_SID;
      const twilioToken = process.env.TWILIO_AUTH_TOKEN;
      const twilioPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";
      if (twilioSid && twilioToken && phone && !phone.toLowerCase().includes("email")) {
        try {
          const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
          const smsText = `Confirmed! Hi ${name.split(" ")[0]}, your free 21-point roof inspection with Ocean County Roofing Pros is locked in for ${displayDay} at ${timeStr} at ${formattedAddress}. Ref #${leadId || "WEB"}. Reply STOP to opt out.`;
          await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
            method: "POST",
            headers: {
              Authorization: `Basic ${auth}`,
              "Content-Type": "application/x-www-form-urlencoded"
            },
            body: new URLSearchParams({
              To: phone,
              From: twilioPhone,
              Body: smsText
            })
          });
        } catch (smsErr) {
          console.error("[api-calendar] Twilio booking SMS error:", smsErr);
        }
      }

      const emailPayload = {
        lead_id: leadId || `BOOK-${Date.now() % 100000000}`,
        name,
        phone: phone || "Not provided",
        email,
        address: formattedAddress,
        date: displayDay,
        time: timeStr,
        start_iso: bookResult.start || "",
        end_iso: bookResult.end || "",
        service,
        roof_age: body.diagnostic_situation || service,
        home_architecture: body.home_architecture || "",
        notes: body.notes || "",
        attic_access: "",
        ladder_needed: "",
        decision_makers_present: "",
        source: "Website Self-Booked Calendar"
      };

      const emailTasks = [
        EmailService.sendOwnerLeadAlert(emailPayload).catch(e => console.error("Owner booked alert err:", e))
      ];
      if (email && email.includes("@")) {
        emailTasks.push(
          EmailService.sendBookingConfirmation(emailPayload).catch(e => console.error("Customer booked email err:", e))
        );
      }
      await Promise.allSettled(emailTasks);

      return json({
        status: "success",
        lead_id: leadId,
        appointment_slot: appointmentSlot,
        display_day: displayDay,
        time: timeStr,
        event_id: bookResult.event_id,
        html_link: bookResult.html_link || null,
        start_iso: bookResult.start,
        end_iso: bookResult.end,
        provider: bookResult.provider
      });
    } catch (err) {
      console.error("[api-calendar] book error:", err);
      return json({ status: "error", message: err.message }, 500);
    }
  }

  // 3. POST /api/calendar/webhook (Calendly / HubSpot / Cal.com auto-sync)
  if (req.method === "POST" && path.endsWith("/webhook")) {
    try {
      const body = await req.json();
      const parsed = parseExternalWebhookPayload(body);

      let slotInfo = parsed.startIso
        ? formatNySlot(parsed.startIso)
        : {
            dateStr: parsed.dateStr || "",
            timeStr: parsed.timeStr || "",
            slotText: `${parsed.dateStr || ""} ${parsed.timeStr || ""}`.trim()
          };
      const appointmentSlot = slotInfo.slotText || `Confirmed via ${parsed.provider}`;

      const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
      const supabaseKey = process.env.SUPABASE_KEY || "";
      let updatedLeadId = parsed.leadId;

      if (supabaseUrl && supabaseKey) {
        let filterQuery = "";
        if (updatedLeadId) {
          filterQuery = `id=eq.${encodeURIComponent(updatedLeadId)}`;
        } else if (parsed.email && parsed.email.includes("@")) {
          const lookupRes = await fetch(
            `${supabaseUrl}/rest/v1/leads?email=eq.${encodeURIComponent(parsed.email.trim())}&order=created_at.desc&limit=1`,
            {
              headers: {
                apikey: supabaseKey,
                Authorization: `Bearer ${supabaseKey}`
              }
            }
          );
          if (lookupRes.ok) {
            const matches = await lookupRes.json();
            if (matches.length > 0) {
              updatedLeadId = matches[0].id;
              filterQuery = `id=eq.${encodeURIComponent(updatedLeadId)}`;
            }
          }
        }

        if (filterQuery) {
          await fetch(`${supabaseUrl}/rest/v1/leads?${filterQuery}`, {
            method: "PATCH",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify({
              status: "Inspection Booked",
              appointment_slot: appointmentSlot,
              updated_at: new Date().toISOString()
            })
          });
        }
      }

      if (parsed.name || parsed.email) {
        await EmailService.sendOwnerLeadAlert({
          lead_id: updatedLeadId || "EXT-BOOK",
          name: parsed.name || "External Scheduler Lead",
          phone: "See CRM record",
          email: parsed.email || "Not provided",
          address: "Ocean County, NJ",
          date: slotInfo.dateStr || "Booked Online",
          time: slotInfo.timeStr || appointmentSlot,
          service: "Roof Inspection",
          source: `External Webhook (${parsed.provider})`
        }).catch(() => {});
      }

      return json({
        status: "success",
        provider: parsed.provider,
        lead_id: updatedLeadId || null,
        appointment_slot: appointmentSlot
      });
    } catch (err) {
      console.error("[api-calendar] webhook error:", err);
      return json({ status: "error", message: err.message }, 500);
    }
  }

  return json({ error: "Not found or method not allowed" }, 405);
};
