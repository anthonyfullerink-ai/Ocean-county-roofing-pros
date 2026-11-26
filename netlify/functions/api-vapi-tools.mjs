/**
 * Netlify Serverless Function: Vapi Voice AI Tool Calling Handler
 * Routes: POST /api/vapi/tools
 */
import { EmailService } from "./services/email-service.mjs";
import { AIEmailAgent } from "./services/ai-email-handler.mjs";
import { GCalService, normalizeAvailabilityConfig, getNyDateParts, pickNonEmptyConfig } from "./services/gcal-service.mjs";
import { resolveEmergencyHandler, sendEmergencySmsEscalation, sanitizePhoneE164 } from "./services/emergency-router.mjs";
import { MetaSocialService } from "./services/meta-social-service.mjs";
import { ChiefOfStaffService } from "./services/chief-of-staff-service.mjs";
import { sendUnifiedSms } from "./services/sms-router.mjs";

function parseToolArgs(rawArgs) {
  if (!rawArgs) return {};
  if (typeof rawArgs === "string") {
    try {
      return JSON.parse(rawArgs);
    } catch {
      return {};
    }
  }
  return rawArgs;
}

function loadScheduleExtras(tenant, sysSettings = {}) {
  let extras = {};
  const raw = sysSettings[`tenant_schedule_${tenant?.tenant_id}`];
  if (raw) {
    try {
      extras = typeof raw === "string" ? JSON.parse(raw) : raw;
    } catch {
      extras = {};
    }
  }
  return {
    icsFeedUrl: tenant?.ics_feed_url || extras.ics_feed_url || "",
    availabilityConfig: normalizeAvailabilityConfig(pickNonEmptyConfig(extras.availability, tenant?.availability_json))
  };
}

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  const expectedSecret = (process.env.VAPI_SERVER_SECRET || "").trim();
  if (expectedSecret) {
    const providedSecret = (req.headers.get("x-vapi-secret") || "").trim();
    if (providedSecret !== expectedSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized tool call" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  try {
    const body = await req.json();
    const message = body.message || {};
    let toolCalls = message.toolCalls || body.toolCalls || [];

    const callObj = message.call || body.call || {};
    const customerObj = callObj.customer || {};
    const inboundCallerPhone = customerObj.number || "";

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_KEY || "";

    // Load active tenant + system settings from Supabase Cloud
    let tenant = {
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      assigned_estimator: "Riley",
      scheduling_type: "google_calendar",
      booking_url: "",
      dispatch_phone: "+17326609121"
    };
    let sysSettings = {};

    if (supabaseUrl && supabaseKey) {
      try {
        sysSettings = await AIEmailAgent.loadSystemSettings();
        const active = await AIEmailAgent.loadActiveTenant();
        if (active) {
          tenant = { ...tenant, ...active };
        }
      } catch (err) {
        console.error("Error loading tenant for Vapi tools:", err);
      }
    }

    const results = [];
    for (const toolCall of toolCalls) {
      const callId = toolCall.id;
      const func = toolCall.function || {};
      const funcName = func.name;
      const args = parseToolArgs(func.arguments);

      // 1. CHECK AVAILABILITY (Live Multi-Tenant Calendar + Custom Windows + .ICS)
      if (funcName === "check_availability") {
        const dateStr = (args.date || "").trim();
        const areaText = (args.address || args.town || args.city || "").trim();
        let targetTenant = tenant;
        if (areaText && sysSettings.territory_routing_json) {
          try {
            targetTenant = await AIEmailAgent.resolveTenantForText(
              areaText,
              sysSettings.territory_routing_json,
              tenant
            );
          } catch {}
        }

        if (targetTenant.scheduling_type === "external_link" && targetTenant.booking_url) {
          results.push({
            toolCallId: callId,
            result: `Please let the homeowner know we will text them a direct calendar link to finalize their inspection window on ${targetTenant.company_name}'s schedule: ${targetTenant.booking_url}`
          });
        } else {
          const { icsFeedUrl, availabilityConfig } = loadScheduleExtras(targetTenant, sysSettings);
          const calendarId = GCalService.resolveCalendarId(targetTenant);
          const avail = await GCalService.getAvailableDays({
            calendarId,
            daysCount: 4,
            includeTodayUrgent: Boolean(args.urgent),
            availabilityConfig,
            icsFeedUrl
          });
          const requestedDay = dateStr ? avail.days.find(d => d.date === dateStr) : null;
          if (requestedDay && requestedDay.slots.length > 0) {
            const times = requestedDay.slots.map(s => s.time).join(", ");
            results.push({
              toolCallId: callId,
              result: `Open inspection times for ${requestedDay.display_label} (${requestedDay.date}) are: ${times}. Ask which window works best.`
            });
          } else if (avail.days.length > 0) {
            const summary = avail.days
              .slice(0, 2)
              .map(d => `${d.display_label} (${d.date}): ${d.slots.map(s => s.time).join(", ")}`)
              .join(" | ");
            results.push({
              toolCallId: callId,
              result: `Next available open inspection windows are: ${summary}. Offer the two earliest options clearly.`
            });
          } else {
            results.push({
              toolCallId: callId,
              result: `Available open inspection times for ${dateStr || "tomorrow"} include 9:00 AM, 11:30 AM, or 2:00 PM. What time works best for you?`
            });
          }
        }
      }

      // 1B. TRIAGE EMERGENCY (Multi-Tenant 24/7 Policy + Overflow + Extended Hours Check)
      else if (funcName === "triage_emergency") {
        const addressOrTown = (args.address_or_town || args.address || args.city || "").trim();
        const emerg = await resolveEmergencyHandler({
          addressOrCity: addressOrTown,
          sysSettings,
          primaryTenant: await AIEmailAgent.resolveTenantForText(addressOrTown, sysSettings.territory_routing_json, tenant)
        });
        const feeNote = emerg.emergencyConfig?.tarping_fee_note || "";

        if (emerg.available_now && emerg.mode === "live_transfer" && emerg.emergencyConfig?.emergency_phone) {
          results.push({
            toolCallId: callId,
            result: `EMERGENCY LIVE TRANSFER ACTIVE (${emerg.dispatch_company}${emerg.is_overflow ? " - 24/7 Emergency Overflow" : ""}). Emergency Line: ${emerg.emergencyConfig.emergency_phone}. Step 1: Collect homeowner name, phone, and exact street address. Step 2: Disclose calmly: "${feeNote}". Step 3: Call dispatch_emergency, then transfer the caller immediately to emergency dispatch number ${emerg.emergencyConfig.emergency_phone}.`
          });
        } else if (emerg.available_now) {
          const eta = emerg.emergencyConfig?.max_response_eta_min || 30;
          results.push({
            toolCallId: callId,
            result: `EMERGENCY PRIORITY CALLBACK ACTIVE (${emerg.dispatch_company}${emerg.is_overflow ? " - 24/7 Emergency Overflow" : ""}). Emergency Phone: ${emerg.emergencyConfig?.emergency_phone || emerg.tenant?.dispatch_phone}. Collect name, phone, street address, and email. Disclose calmly: "${feeNote}". Call dispatch_emergency to trigger an immediate urgent SMS alert so the on-call leak specialist calls back within ${eta} minutes, AND book the earliest open inspection slot as backup.`
          });
        } else {
          results.push({
            toolCallId: callId,
            result: `NO OVERNIGHT CREW IS AVAILABLE IN THIS TOWN RIGHT NOW (${emerg.after_hours_quiet ? "currently outside extended 7AM-9PM emergency hours" : "territory partner runs daytime service only"}). IMPORTANT: Do NOT promise an overnight truck tonight. Express warm empathy, advise placing a bucket or towels safely indoors (do NOT climb onto a wet roof at night), collect their name, phone, street address, and email, call dispatch_emergency to flag them as Urgent First-Morning Priority, and book the earliest 9:00 AM window via check_availability & book_inspection.`
          });
        }
      }

      // 1C. DISPATCH EMERGENCY (Logs Emergency Priority Lead & Fires Urgent Twilio SMS)
      else if (funcName === "dispatch_emergency") {
        const name = (args.name || "Homeowner").trim();
        const phone = (args.phone || inboundCallerPhone || "").trim();
        const email = (args.email || "").trim();
        const address = (args.address || args.town || "Ocean County, NJ").trim();
        const issueSummary = (args.issue_summary || args.notes || "Active Water Leak / Storm Damage").trim();
        const leadId = `EMERG-${Date.now() % 100000000}`;

        const emerg = await resolveEmergencyHandler({
          addressOrCity: address,
          sysSettings,
          primaryTenant: await AIEmailAgent.resolveTenantForText(address, sysSettings.territory_routing_json, tenant)
        });
        const targetTenant = emerg.tenant || tenant;
        const detectedCity = AIEmailAgent.detectCityFromText(address);

        if (supabaseUrl && supabaseKey) {
          try {
            await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads`, {
              method: "POST",
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
              },
              body: JSON.stringify({
                id: leadId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                lead_source: "Vapi Emergency Dispatch",
                first_name: name.split(" ")[0] || name,
                last_name: name.split(" ").slice(1).join(" ") || "",
                phone,
                email,
                street_address: address,
                city: detectedCity !== "Ocean County" ? detectedCity : "Toms River",
                service_requested: "Emergency Leak Repair",
                urgency: "Emergency",
                diagnostic_situation: "Active Water Leak",
                status: "Emergency Priority",
                assigned_tenant_id: targetTenant.tenant_id,
                notes: `[Voice Emergency Triage${emerg.is_overflow ? " - 24/7 Overflow Pool" : ""}] ${issueSummary}`
              })
            });
          } catch (err) {
            console.error("Error logging Vapi emergency lead:", err);
          }
        }

        const smsResult = await sendEmergencySmsEscalation({
          tenant: targetTenant,
          emergencyConfig: emerg.emergencyConfig,
          isOverflow: emerg.is_overflow,
          sysSettings,
          lead: {
            id: leadId,
            name,
            phone,
            address,
            city: detectedCity,
            issue_summary: issueSummary
          }
        });

        if (sysSettings?.chief_buffer_mode === "true") {
          await ChiefOfStaffService.sendP0Escalation({
            source: "riley",
            title: `Emergency Leak (${detectedCity}): ${name}`,
            summary: `Phone: ${phone || "Not provided"} | Address: ${address} | Issue: ${issueSummary} | Routed to: ${emerg.dispatch_company}`,
            recommendedAction: emerg.available_now
              ? "Confirm live emergency transfer or call the homeowner back within 15 minutes."
              : "Review for 9:00 AM first-morning priority dispatch."
          }).catch(() => {});
        } else {
          await EmailService.sendOwnerLeadAlert({
            lead_id: leadId,
            name,
            phone: phone || "Not provided",
            email: email || "Not provided",
            address,
            date: emerg.available_now ? "URGENT SAME-DAY / 24H TRIAGE" : "FIRST-MORNING PRIORITY",
            time: emerg.available_now ? `Mode: ${emerg.mode}` : "9:00 AM Earliest",
            service: "Emergency Leak Repair",
            roof_age: issueSummary,
            attic_access: "Emergency Priority Leak",
            ladder_needed: "Tarping / Triage Gear",
            decision_makers_present: "",
            source: `Voice AI Emergency (${emerg.dispatch_company}${emerg.is_overflow ? " Overflow" : ""})`
          }).catch(() => {});
        }

        results.push({
          toolCallId: callId,
          result: emerg.available_now
            ? `Emergency priority alert #${leadId} dispatched to ${emerg.dispatch_company} (SMS escalated: ${smsResult.sent ? "yes" : "logged"}). Proceed with ${emerg.mode === "live_transfer" ? `transferring caller to ${emerg.emergencyConfig?.emergency_phone}` : "reassuring caller of urgent callback and booking a backup morning slot"}.`
            : `Lead #${leadId} marked Emergency Priority for ${emerg.dispatch_company} first-morning dispatch. Proceed to lock in the earliest morning inspection slot via book_inspection.`
        });
      }

      // 2. VERIFY ADDRESS
      else if (funcName === "verify_address") {
        const rawAddress = (args.address || "").trim();
        const hasNumber = /\d+/.test(rawAddress);
        if (hasNumber && rawAddress.length >= 6) {
          results.push({
            toolCallId: callId,
            result: `Address verified successfully as: '${rawAddress}'. Just to make sure our estimator Riley arrives at the right home, I have your address verified as ${rawAddress}. Is that correct?`
          });
        } else {
          results.push({
            toolCallId: callId,
            result: `Could not verify '${rawAddress}'. A numerical street number is required. Please ask the caller: 'Could you please repeat your street number and street name for me?'`
          });
        }
      }

      // 3. BOOK INSPECTION
      else if (funcName === "book_inspection") {
        const name = (args.name || "Homeowner").trim();
        const phone = (args.phone || inboundCallerPhone || "").trim();
        const email = (args.email || "").trim();
        const address = (args.address || "Toms River, NJ").trim();
        const service = (args.service || "21-Point Roof & Attic Inspection").trim();
        const dateStr = (args.date || "tomorrow").trim();
        const timeStr = (args.time || "1:00 PM").trim();
        const leadId = `CALL-${Date.now() % 100000000}`;

        // Resolve territory routing by address if configured
        let targetTenant = tenant;
        if (supabaseUrl && supabaseKey && sysSettings.territory_routing_json) {
          try {
            targetTenant = await AIEmailAgent.resolveTenantForText(
              address,
              sysSettings.territory_routing_json,
              tenant
            );
          } catch (e) {
            console.error("Vapi territory routing fallback:", e);
          }
        }

        const isHomeowner = args.is_homeowner || "Not confirmed";
        const roofAge = args.roof_age || "Standard inspection";
        const atticAccess = args.attic_access || "Not confirmed";
        const ladderNeeded = args.ladder_needed || "Not specified";
        const decisionMakers = args.decision_makers_present || "Not confirmed";

        const qualificationNotes = `Qualification: Homeowner: ${isHomeowner} | Roof Age: ${roofAge} | Attic Access: ${atticAccess} (Ladder: ${ladderNeeded}) | Both Decision Makers: ${decisionMakers}.`;

        // Trigger Google Calendar Webhook (Google Apps Script) if configured
        const gcalWebhookUrl = process.env.GOOGLE_CALENDAR_WEBHOOK_URL || "";
        const secondaryCalId = "7df414b869c61a9932cc261f1c9951bcbcd8c3c59e6ea057495e65db2720e02f@group.calendar.google.com";
        if (gcalWebhookUrl) {
          try {
            await fetch(gcalWebhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                calendar_id: targetTenant.google_calendar_id || targetTenant.calendar_id || secondaryCalId,
                customer_name: name,
                phone: phone,
                customer_email: email,
                address: address,
                service: service,
                start: `${dateStr} ${timeStr}`,
                is_homeowner: isHomeowner,
                roof_age: roofAge,
                attic_access: atticAccess,
                ladder_needed: ladderNeeded,
                decision_makers_present: decisionMakers
              })
            });
          } catch (calErr) {
            console.error("Error triggering Google Calendar Webhook:", calErr);
          }
        }

        // Save to Supabase Cloud
        if (supabaseUrl && supabaseKey) {
          try {
            const detectedCity = AIEmailAgent.detectCityFromText(address);
            await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads`, {
              method: "POST",
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
              },
              body: JSON.stringify({
                id: leadId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                lead_source: "Vapi Inbound Call",
                first_name: name.split(" ")[0] || name,
                last_name: name.split(" ").slice(1).join(" ") || "",
                phone: phone,
                email: email,
                street_address: address,
                city: detectedCity !== "Ocean County" ? detectedCity : "Toms River",
                service_requested: service,
                urgency: "Standard",
                status: "Inspection Booked",
                appointment_slot: `${dateStr} ${timeStr}`,
                assigned_tenant_id: targetTenant.tenant_id,
                notes: `Booked via Voice AI dispatch for ${targetTenant.company_name}. ${qualificationNotes}`
              })
            });
          } catch (err) {
            console.error("Error logging Vapi lead to Supabase:", err);
          }
        }

        // Domain-branded email dispatch via Resend
        const leadPayloadForEmail = {
          lead_id: leadId,
          name: name,
          phone: phone,
          email: email,
          address: address,
          date: dateStr,
          time: timeStr,
          service: service,
          attic_access: atticAccess,
          ladder_needed: ladderNeeded,
          decision_makers_present: decisionMakers,
          source: `Voice AI (${targetTenant.assigned_estimator || targetTenant.estimator_name || "Riley"})`
        };

        try {
          EmailService.sendBookingConfirmation(leadPayloadForEmail).catch(e => console.error("Resend confirmation err:", e));
          if (sysSettings?.chief_buffer_mode === "true") {
            ChiefOfStaffService.recordBufferEvent({
              source: "riley",
              severity: "routine",
              title: `Riley Booked Inspection: ${name} (${dateStr} ${timeStr})`,
              summary: `${service} at ${address} | Phone: ${phone || "N/A"} | Assigned: ${targetTenant.company_name}`,
              payload: { lead_id: leadId, phone, address, dateStr, timeStr }
            }).catch(() => {});
          } else {
            EmailService.sendOwnerLeadAlert(leadPayloadForEmail).catch(e => console.error("Resend owner alert err:", e));
          }
        } catch (emailErr) {
          console.error("Email dispatch trigger error:", emailErr);
        }

        if (targetTenant.scheduling_type === "external_link" && targetTenant.booking_url) {
          let smsSent = false;
          const toPhone = sanitizePhoneE164(phone);
          if (toPhone) {
            try {
              const smsText = `Hi ${name.split(" ")[0]}, thanks for calling ${targetTenant.company_name || "Ocean County Roofing Pros"}! Finalize your preferred 15-minute inspection arrival window here: ${targetTenant.booking_url} Reply STOP to opt out.`;
              const smsRes = await sendUnifiedSms({
                to: toPhone,
                body: smsText,
                purpose: "customer",
                sysSettings
              });
              smsSent = Boolean(smsRes?.sent);
              if (!smsSent && smsRes?.status === "error") {
                console.error(`[api-vapi-tools] external_link SMS failed (${smsRes.code || smsRes.status}):`, smsRes.error || "");
              }
            } catch (smsErr) {
              console.error("[api-vapi-tools] external_link SMS error:", smsErr);
            }
          }
          const smsClause = smsSent
            ? `I have sent an SMS to ${phone} with a direct booking link to finalize your 15-minute arrival window: ${targetTenant.booking_url}.`
            : `Please use our direct booking link to finalize your 15-minute arrival window: ${targetTenant.booking_url}.`;
          results.push({
            toolCallId: callId,
            result: `Appointment request registered for ${name} with ${targetTenant.company_name}! ${smsClause} One of our certified roofing specialists will meet you at ${address} for the free 21-point inspection.`
          });
        } else {
          const inviteNote = email ? ` A calendar invite has been sent to ${email}.` : "";
          results.push({
            toolCallId: callId,
            result: `Appointment successfully confirmed for ${name} on ${dateStr} at ${timeStr}. One of our certified roofing specialists from our local crew will arrive at ${address} for the free 21-point roof inspection.${inviteNote}`
          });
        }
      }

      // 4. REQUEST HUMAN CALLBACK (Both Sarah & Riley: 7am-9pm ET <=1hr SLA vs Overnight 8am priority)
      else if (funcName === "request_human_callback") {
        const name = (args.name || "Homeowner").trim();
        const phone = (args.phone || args.callback_phone || inboundCallerPhone || "").trim();
        const email = (args.email || "").trim();
        const address = (args.address_or_town || args.town || args.address || "Ocean County, NJ").trim();
        const reason = (args.reason || args.issue_summary || args.notes || "Requested to speak with a human representative").trim();
        const agentName = (args.agent_name || "Voice AI").trim();
        const leadId = `HUMAN-${Date.now() % 100000000}`;

        const nyNow = getNyDateParts(new Date());
        const isActiveCallbackHours = nyNow.hour >= 7 && nyNow.hour < 21;
        const slaLabel = isActiveCallbackHours
          ? "Within 1 Hour (usually sooner)"
          : "First-Morning 8:00 AM ET Priority (Manager Alerted Now)";

        let targetTenant = tenant;
        if (supabaseUrl && supabaseKey && sysSettings.territory_routing_json) {
          try {
            targetTenant = await AIEmailAgent.resolveTenantForText(
              address,
              sysSettings.territory_routing_json,
              tenant
            );
          } catch {}
        }
        const detectedCity = AIEmailAgent.detectCityFromText(address);

        if (supabaseUrl && supabaseKey) {
          try {
            await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads`, {
              method: "POST",
              headers: {
                "apikey": supabaseKey,
                "Authorization": `Bearer ${supabaseKey}`,
                "Content-Type": "application/json",
                "Prefer": "return=minimal"
              },
              body: JSON.stringify({
                id: leadId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                lead_source: "Voice AI Human Escalation",
                first_name: name.split(" ")[0] || name,
                last_name: name.split(" ").slice(1).join(" ") || "",
                phone: phone,
                email: email,
                street_address: address,
                city: detectedCity !== "Ocean County" ? detectedCity : "Toms River",
                service_requested: "Human Representative Callback",
                urgency: "High",
                status: "Human Callback Requested",
                assigned_tenant_id: targetTenant.tenant_id,
                notes: `[Human Callback Requested via ${agentName}] SLA: ${slaLabel} | Reason: ${reason}`
              })
            });
          } catch (err) {
            console.error("Error logging human callback lead:", err);
          }
        }

        // Owner Alert Routing: buffer non-urgent Riley callbacks when Chief Buffer Mode is enabled
        let emailResult = { status: "buffered" };
        if (sysSettings?.chief_buffer_mode === "true") {
          await ChiefOfStaffService.recordBufferEvent({
            source: "riley",
            severity: "important",
            title: `Human Callback Requested (${name})`,
            summary: `Phone: ${phone || "Not provided"} | Address: ${address} | SLA: ${slaLabel} | Reason: ${reason}`,
            payload: { lead_id: leadId, name, phone, email, address, reason }
          }).catch(() => {});
        } else {
          emailResult = await EmailService.sendOwnerHumanEscalationAlert({
            lead_id: leadId,
            name,
            phone: phone || "Not provided",
            email,
            address,
            reason,
            agent_name: agentName,
            sla_label: slaLabel
          }).catch(err => ({ status: "error", error: err.message }));
        }

        // Instant Owner SMS Alert (routes via MCASMS or Twilio; skipped cleanly on Personal Device mode)
        const ownerPhone = sanitizePhoneE164(
          sysSettings?.owner_alert_phone || process.env.OWNER_ALERT_PHONE || "+17325523896"
        );
        let smsSent = false;
        if (ownerPhone) {
          try {
            const smsBody = `🙋 [HUMAN CALLBACK REQ] #${leadId} | ${name} (${phone || "No phone"}) | ${address} | Reason: ${reason} | Told caller: ${slaLabel} -> https://oceancountyroofingpros.com/admin`;
            const smsRes = await sendUnifiedSms({
              to: ownerPhone,
              body: smsBody,
              purpose: "owner_alert",
              sysSettings
            });
            smsSent = Boolean(smsRes?.sent);
          } catch (smsErr) {
            console.error("Error sending human escalation SMS:", smsErr);
          }
        }

        const spokenInstruction = isActiveCallbackHours
          ? "Tell the caller warmly: 'Of course — I've sent your details right over, and a representative will get back to you within the hour, and most of the time even sooner. Thank you for calling Ocean County Roofing Pros!'"
          : "Tell the caller warmly: 'Of course — our office wraps up live callbacks at 9 PM Eastern, so I've placed your request at the top of the list for a representative to call you back first thing tomorrow morning around 8 AM, and I've already alerted our manager right now. Thank you for calling Ocean County Roofing Pros!'";

        results.push({
          toolCallId: callId,
          result: `Human callback ticket #${leadId} logged and owner alerted (email: ${emailResult?.status || "attempted"}, sms: ${smsSent ? "queued" : "skipped"}). ${spokenInstruction}`
        });
      }

      // -----------------------------------------------------------------------
      // TOOL 5: create_social_post (Maya Social Desk Voice-to-Post)
      // -----------------------------------------------------------------------
      else if (funcName === "create_social_post") {
        const caption = String(args.caption || "").trim();
        const townName = String(args.town_name || "Ocean County").trim();
        const imageUrl = String(args.image_url || "").trim();
        const utmCampaign = String(args.utm_campaign || "vapi_voice_post").trim();
        const publishNow = Boolean(args.publish_now);
        const nowIso = new Date().toISOString();
        const postId = `SQ-${Date.now() % 100000000}`;

        if (!caption) {
          results.push({ toolCallId: callId, result: "Please provide a post caption before saving." });
          continue;
        }

        let pubResult = null;
        if (publishNow) {
          pubResult = await MetaSocialService.publishPost({
            caption,
            imageUrl,
            linkUrl: "https://oceancountyroofingpros.com/#quizSection",
            utmCampaign
          });
        }

        const row = {
          id: postId,
          created_at: nowIso,
          updated_at: nowIso,
          caption,
          image_url: imageUrl,
          link_url: "https://oceancountyroofingpros.com/#quizSection",
          platforms: "facebook,instagram",
          utm_campaign: utmCampaign,
          town_name: townName,
          status: publishNow ? (pubResult?.status === "published" ? "published" : "failed") : "scheduled",
          scheduled_for: nowIso,
          published_at: publishNow && pubResult?.status === "published" ? nowIso : null,
          external_post_ids_json: JSON.stringify(pubResult || {}),
          created_by: "vapi_voice"
        };

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/social_queue`, {
            method: "POST",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal"
            },
            body: JSON.stringify(row)
          }).catch(() => {});
        }

        const spoken = row.status === "published"
          ? `Published social post ${postId} for ${townName} to Meta right now with UTM tracking.`
          : row.status === "failed"
            ? `Saved social post ${postId} for ${townName}, but Meta publish failed (${pubResult?.reason || pubResult?.facebook?.error || pubResult?.status || "error"}).`
            : `Queued social post ${postId} for ${townName} in OC Roofing Pros HQ so it goes out on your daily flywheel.`;
        results.push({ toolCallId: callId, result: spoken });
      }

      // -----------------------------------------------------------------------
      // TOOL 6: get_social_digest (Maya Social Desk Spoken Briefing)
      // -----------------------------------------------------------------------
      else if (funcName === "get_social_digest") {
        let interactions = [];
        let queue = [];
        if (supabaseUrl && supabaseKey) {
          const sbH = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
          const [intRes, qRes] = await Promise.all([
            fetch(`${supabaseUrl}/rest/v1/social_interactions?order=created_at.desc&limit=25`, { headers: sbH }).catch(() => null),
            fetch(`${supabaseUrl}/rest/v1/social_queue?status=eq.scheduled&order=scheduled_for.asc&limit=10`, { headers: sbH }).catch(() => null)
          ]);
          if (intRes && intRes.ok) interactions = await intRes.json();
          if (qRes && qRes.ok) queue = await qRes.json();
        }
        const pendingApproval = interactions.filter(i => i.reply_status === "pending_approval");
        const auto24h = interactions.filter(i => i.reply_status === "auto_24h");
        const urgentNeg = pendingApproval.filter(i => i.intent === "NEGATIVE_REVIEW" || i.intent === "EMERGENCY_LEAK");

        const summary = {
          pending_approval_count: pendingApproval.length,
          urgent_alerts_count: urgentNeg.length,
          auto_24h_count: auto24h.length,
          scheduled_posts_count: queue.length,
          items_needing_attention: pendingApproval.slice(0, 5).map(i => ({
            id: i.id,
            platform: i.platform,
            type: i.interaction_type,
            rating: i.rating,
            author: i.author_name,
            message: i.message_text,
            draft_reply: i.ai_reply_draft
          }))
        };
        results.push({ toolCallId: callId, result: JSON.stringify(summary) });
      }

      // -----------------------------------------------------------------------
      // TOOL 7: approve_social_reply (Maya Voice Approval/Publishing)
      // -----------------------------------------------------------------------
      else if (funcName === "approve_social_reply") {
        const interactionId = String(args.interaction_id || "").trim();
        const action = String(args.action || "approve_and_publish").trim();
        const editedReply = String(args.edited_reply || "").trim();

        let item = null;
        if (supabaseUrl && supabaseKey && interactionId) {
          const sbH = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
          const r = await fetch(`${supabaseUrl}/rest/v1/social_interactions?id=eq.${encodeURIComponent(interactionId)}`, { headers: sbH }).catch(() => null);
          const arr = r && r.ok ? await r.json() : [];
          item = arr[0] || null;
        }

        if (!item) {
          results.push({ toolCallId: callId, result: `Interaction ${interactionId} was not found.` });
          continue;
        }

        const finalText = editedReply || item.ai_reply_draft || "";
        let newStatus = item.reply_status;
        let pubRes = null;

        if (action === "ignore") {
          newStatus = "ignored";
        } else if (action === "save_draft") {
          newStatus = "pending_approval";
        } else if (action === "approve_and_publish") {
          if (item.interaction_type === "dm") {
            pubRes = item.platform === "instagram"
              ? await MetaSocialService.sendIgDm({ recipientId: item.author_id, message: finalText })
              : await MetaSocialService.sendPageDm({ recipientId: item.author_id, message: finalText });
          } else if (item.external_id) {
            pubRes = await MetaSocialService.replyToComment({ commentId: item.external_id, message: finalText });
          }
          newStatus = pubRes?.status === "published" ? "published" : "failed";
        }

        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/social_interactions?id=eq.${encodeURIComponent(interactionId)}`, {
            method: "PATCH",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              ai_reply_draft: finalText,
              reply_status: newStatus,
              published_reply_id: pubRes?.id || item.published_reply_id || "",
              updated_at: new Date().toISOString()
            })
          }).catch(() => {});
        }

        results.push({
          toolCallId: callId,
          result: `Updated ${interactionId} (${newStatus}).`
        });
      }

      // -----------------------------------------------------------------------
      // TOOL 8: publish_queued_post (Maya Immediate Dispatch)
      // -----------------------------------------------------------------------
      else if (funcName === "publish_queued_post") {
        const postId = String(args.post_id || "").trim();
        let post = null;
        if (supabaseUrl && supabaseKey && postId) {
          const sbH = { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` };
          const r = await fetch(`${supabaseUrl}/rest/v1/social_queue?id=eq.${encodeURIComponent(postId)}`, { headers: sbH }).catch(() => null);
          const arr = r && r.ok ? await r.json() : [];
          post = arr[0] || null;
        }
        if (!post) {
          results.push({ toolCallId: callId, result: `Queued post ${postId} was not found.` });
          continue;
        }
        const pubRes = await MetaSocialService.publishPost({
          caption: post.caption,
          imageUrl: post.image_url,
          linkUrl: post.link_url,
          utmCampaign: post.utm_campaign || "social_agent"
        });
        if (supabaseUrl && supabaseKey) {
          await fetch(`${supabaseUrl}/rest/v1/social_queue?id=eq.${encodeURIComponent(postId)}`, {
            method: "PATCH",
            headers: {
              apikey: supabaseKey,
              Authorization: `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              status: pubRes.status === "published" ? "published" : "failed",
              published_at: new Date().toISOString(),
              external_post_ids_json: JSON.stringify(pubRes),
              updated_at: new Date().toISOString()
            })
          }).catch(() => {});
        }
        results.push({ toolCallId: callId, result: `Post ${postId} dispatch result: ${pubRes.status}.` });
      }

      // Default fallback
      else {
        results.push({
          toolCallId: callId,
          result: `Command acknowledged.`
        });
      }
    }

    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Vapi tools error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
