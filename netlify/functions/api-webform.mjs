/**
 * Netlify Serverless Function: Inbound Web Form Handler
 * Routes: POST /api/leads/webform
 */
import { EmailService } from "./services/email-service.mjs";
import { AIEmailAgent } from "./services/ai-email-handler.mjs";
import { resolveEmergencyHandler, sendEmergencySmsEscalation, sanitizePhoneE164 } from "./services/emergency-router.mjs";
import { formatPropertyAddress } from "./services/gcal-service.mjs";
import { ChiefOfStaffService } from "./services/chief-of-staff-service.mjs";
import { sendUnifiedSms } from "./services/sms-router.mjs";

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json();
    const contactPreference = (body.contact_preference || "calendar_flow").trim();
    const rawPhone = (body.phone || "").trim();
    const customerEmail = (body.email || "").trim();
    const isEmailValid = EMAIL_REGEX.test(customerEmail);
    const isEmailMode = contactPreference === "email" && isEmailValid;

    if (!isEmailValid) {
      return new Response(JSON.stringify({ detail: "Valid email address is required." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    if (!rawPhone && !isEmailMode) {
      return new Response(JSON.stringify({ detail: "Phone number is required." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const phone = rawPhone || "Email Inquiry";
    const isExplicitFalse = (v) => v === false || String(v).trim().toLowerCase() === "false";
    const smsConsent = !isExplicitFalse(body.consent_given) && !isExplicitFalse(body.sms_consent);
    const consentTag = body.consent_given !== undefined || body.sms_consent !== undefined
      ? ` [SMS Opt-In: ${smsConsent ? "Yes" : "No"}]`
      : "";
    const firstName = (body.first_name || "Homeowner").trim();
    const lastName = (body.last_name || "").trim();
    const service = body.service || "Roof Replacement";
    const address = (body.address || "").trim();
    const city = (body.city || "Toms River").trim();
    const formattedAddress = address ? formatPropertyAddress(address, city) : `${city}, NJ`;
    const leadId = `WEB-${Date.now() % 100000000}`;

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_KEY || "";

    const isEmergencyLead =
      body.urgency === "Emergency" ||
      body.diagnostic_situation === "Active Water Leak" ||
      /active water leak|emergency/i.test(service);

    let schedulingType = "google_calendar";
    let bookingUrl = "";
    let activeTenantId = "client_joe_the_roofer";
    let resolvedTenant = null;
    let sysSettings = {};
    let emergencyResolution = null;

    // 1. Resolve Tenant via Hybrid Territory Routing -> Active Default Partner (+ Emergency Overflow if active leak)
    if (supabaseUrl && supabaseKey) {
      try {
        sysSettings = await AIEmailAgent.loadSystemSettings();
        resolvedTenant = await AIEmailAgent.resolveTenantForText(
          `${address} ${city}`,
          sysSettings.territory_routing_json
        );
        if (isEmergencyLead) {
          emergencyResolution = await resolveEmergencyHandler({
            addressOrCity: `${address} ${city}`,
            sysSettings,
            primaryTenant: resolvedTenant
          });
          if (emergencyResolution?.tenant) {
            resolvedTenant = emergencyResolution.tenant;
          }
        }
        if (resolvedTenant) {
          activeTenantId = resolvedTenant.tenant_id || activeTenantId;
          schedulingType = resolvedTenant.scheduling_type || "google_calendar";
          bookingUrl = resolvedTenant.booking_url || "";
        }
      } catch (err) {
        console.error("Error resolving tenant:", err);
      }
    }

    // 2. Insert Lead record into Supabase Cloud
    if (supabaseUrl && supabaseKey) {
      try {
        const overflowTag = emergencyResolution?.is_overflow
          ? ` [Routed to 24/7 Emergency Overflow Partner: ${resolvedTenant?.company_name}]`
          : "";
        const leadPayload = {
          id: leadId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          lead_source: isEmailMode ? "Website Email Inquiry" : "Website Form",
          first_name: firstName,
          last_name: lastName,
          phone: phone,
          email: customerEmail,
          street_address: address ? formattedAddress : "",
          city: city,
          service_requested: service,
          urgency: isEmergencyLead ? "Emergency" : (body.urgency || "Standard"),
          diagnostic_situation: body.diagnostic_situation || "",
          home_architecture: body.home_architecture || "",
          notes: `${body.notes || ""}${overflowTag}${consentTag}`.trim(),
          assigned_tenant_id: activeTenantId,
          status: isEmergencyLead ? "Emergency Priority" : "New Lead",
          estimated_value: 12500.00
        };

        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify(leadPayload)
        });
      } catch (err) {
        console.error("Error writing lead to Supabase:", err);
      }
    }

    const backgroundDispatches = [];

    if (isEmergencyLead && emergencyResolution) {
      backgroundDispatches.push(
        sendEmergencySmsEscalation({
          tenant: resolvedTenant,
          emergencyConfig: emergencyResolution.emergencyConfig,
          isOverflow: emergencyResolution.is_overflow,
          sysSettings,
          lead: {
            id: leadId,
            name: `${firstName} ${lastName}`.trim(),
            phone,
            address: address ? `${address}, ${city}, NJ` : `${city}, NJ`,
            city,
            service,
            issue_summary: body.diagnostic_situation || service
          }
        }).catch(err => console.error("Emergency escalation SMS err:", err))
      );
    }

    // 3. Send SMS only if an SMS provider is configured, a real phone number was supplied, and SMS opt-in consent was granted
    const toPhone = sanitizePhoneE164(rawPhone);
    if (toPhone && smsConsent) {
      let msgBody = `Hi ${firstName}, thanks for contacting Ocean County Roofing Pros! We received your request for ${service} in ${city}. Select your preferred inspection time on screen, or reply here to coordinate. Reply STOP to opt out.`;
      if (schedulingType === "external_link" && bookingUrl) {
        msgBody = `Hi ${firstName}, thanks for contacting Ocean County Roofing Pros! We received your request for ${service} in ${city}. Please finalize your preferred 15-minute arrival window on our live dispatch calendar: ${bookingUrl} Reply STOP to opt out.`;
      }

      backgroundDispatches.push(
        sendUnifiedSms({
          to: toPhone,
          body: msgBody,
          purpose: "customer",
          sysSettings
        })
          .then((smsRes) => {
            if (!smsRes.sent && smsRes.status === "error") {
              const label = smsRes.provider === "mcasms" ? "MCASMS" : "Twilio";
              console.error(`[api-webform] ${label} SMS failed (${smsRes.code || smsRes.status}):`, smsRes.error || smsRes.reason || "");
            }
          })
          .catch(err => console.error("Error dispatching SMS:", err))
      );
    }

    // 4. Send Domain-Branded Email Alerts via Resend
    const emailLeadPayload = {
      lead_id: leadId,
      name: `${firstName} ${lastName}`.trim(),
      phone: phone,
      email: customerEmail,
      address: formattedAddress,
      date: body.preferred_date || (isEmailMode ? "Email Inquiry" : "Selecting Slot"),
      time: body.preferred_time || (isEmailMode ? "Reply via Email" : "Pending Calendar"),
      service: service,
      roof_age: body.diagnostic_situation || service,
      home_architecture: body.home_architecture || "",
      notes: `${body.notes || ""}${consentTag}`.trim(),
      attic_access: "",
      ladder_needed: "",
      decision_makers_present: "",
      source: isEmailMode ? "Website Email Inquiry" : "Website Lead Form (Step 3 Captured)"
    };

    if (sysSettings?.chief_buffer_mode === "true") {
      if (isEmergencyLead) {
        backgroundDispatches.push(
          ChiefOfStaffService.sendP0Escalation({
            source: "webform",
            title: `Emergency Webform Lead: ${firstName} ${lastName}`.trim() + ` (${city})`,
            summary: `Phone: ${phone} | Email: ${customerEmail} | Service: ${service} | Address: ${formattedAddress}`,
            recommendedAction: "Follow up immediately or confirm overflow dispatch."
          }).catch(e => console.error("Webform P0 escalation err:", e))
        );
      } else {
        backgroundDispatches.push(
          ChiefOfStaffService.recordBufferEvent({
            source: "webform",
            severity: "routine",
            title: `New Webform Lead: ${firstName} ${lastName}`.trim() + ` (${city})`,
            summary: `${service} | Phone: ${phone} | Email: ${customerEmail}`,
            payload: { lead_id: leadId, city, service }
          }).catch(e => console.error("Webform buffer err:", e))
        );
      }
    } else {
      backgroundDispatches.push(
        EmailService.sendOwnerLeadAlert(emailLeadPayload).catch(e => console.error("Webform owner email err:", e))
      );
    }

    if (isEmailMode) {
      const safeMsg = (body.notes || "Roof inspection & estimate request").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      backgroundDispatches.push(
        EmailService.sendEmail({
          from: EmailService.getFromAddress(),
          to: [customerEmail],
          reply_to: EmailService.getReplyToAddress(),
          subject: `We received your roofing inquiry for ${city} (#${leadId})`,
          html: `
            <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; background: #fff; border: 1px solid #e2e8f0; border-radius: 16px; overflow: hidden;">
              <div style="background: #0A486D; color: #fff; padding: 24px;">
                <h2 style="margin: 0; font-size: 20px;">OCEAN COUNTY ROOFING PROS</h2>
                <p style="margin: 4px 0 0; color: #17ABA4; font-size: 12px; font-weight: 700; text-transform: uppercase;">Inquiry Received (#${leadId})</p>
              </div>
              <div style="padding: 24px; color: #1e293b; font-size: 14px; line-height: 1.6;">
                <p>Hi ${firstName},</p>
                <p>Thank you for reaching out! Our scheduling coordinator Riley Davis received your message regarding <strong>${service}</strong> in <strong>${city}</strong> and will reply to this email thread shortly.</p>
                <div style="background: #f8fafc; border-left: 4px solid #17ABA4; padding: 14px; border-radius: 0 10px 10px 0; margin: 18px 0;">
                  <strong>Your Note:</strong><br>${safeMsg}
                </div>
                <p>Need faster dispatch or want to lock in a day/time directly? Reply to this email or call our 24/7 dispatch line at <strong>(732) 660-9121</strong>.</p>
              </div>
            </div>
          `
        }).catch(e => console.error("Email inquiry ack err:", e))
      );
    }

    await Promise.allSettled(backgroundDispatches);

    return new Response(JSON.stringify({
      status: "success",
      message: isEmailMode
        ? "Email inquiry sent! Check your inbox for a reply from Riley."
        : "Lead received successfully. Select your inspection window.",
      lead_id: leadId,
      sms_consent: smsConsent,
      assigned_tenant_id: activeTenantId,
      scheduling_type: schedulingType,
      booking_url: schedulingType === "external_link" && bookingUrl ? bookingUrl : null,
      emergency_dispatch: emergencyResolution
        ? {
            available_now: emergencyResolution.available_now,
            is_overflow: emergencyResolution.is_overflow,
            mode: emergencyResolution.mode,
            after_hours_quiet: emergencyResolution.after_hours_quiet,
            dispatch_company: emergencyResolution.dispatch_company,
            tarping_fee_note: emergencyResolution.emergencyConfig?.tarping_fee_note || ""
          }
        : null,
      outbound_callback_queued: false
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Webform error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
