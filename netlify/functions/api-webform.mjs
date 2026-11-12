/**
 * Netlify Serverless Function: Inbound Web Form Handler
 * Routes: POST /api/leads/webform
 */
import { EmailService } from "./services/email-service.mjs";

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json();
    const phone = (body.phone || "").trim();
    if (!phone) {
      return new Response(JSON.stringify({ detail: "Phone number is required." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const firstName = (body.first_name || "Homeowner").trim();
    const lastName = (body.last_name || "").trim();
    const service = body.service || "Roof Replacement";
    const address = body.address || "";
    const city = body.city || "Toms River";
    const leadId = `WEB-${Date.now() % 100000000}`;

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_KEY || "";

    let schedulingType = "google_calendar";
    let bookingUrl = "";
    let activeTenantId = "client_joe_the_roofer";

    // 1. Fetch active tenant from Supabase Cloud
    if (supabaseUrl && supabaseKey) {
      try {
        const tenantRes = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants?is_active=eq.true&limit=1`, {
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`
          }
        });
        if (tenantRes.ok) {
          const tenants = await tenantRes.json();
          if (tenants.length > 0) {
            const t = tenants[0];
            activeTenantId = t.tenant_id;
            schedulingType = t.scheduling_type || "google_calendar";
            bookingUrl = t.booking_url || "";
          }
        }
      } catch (err) {
        console.error("Error fetching active tenant:", err);
      }
    }

    // 2. Insert Lead record into Supabase Cloud
    if (supabaseUrl && supabaseKey) {
      try {
        const leadPayload = {
          id: leadId,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          lead_source: "Website Form",
          first_name: firstName,
          last_name: lastName,
          phone: phone,
          email: body.email || "",
          street_address: address,
          city: city,
          service_requested: service,
          urgency: body.urgency || "Standard",
          diagnostic_situation: body.diagnostic_situation || "",
          home_architecture: body.home_architecture || "",
          notes: body.notes || "",
          assigned_tenant_id: activeTenantId,
          status: "New Lead",
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

    // 3. Send SMS if Twilio credentials exist
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";

    if (twilioSid && twilioToken) {
      try {
        let msgBody = `Hi ${firstName}, thanks for contacting Ocean County Roofing Pros! We received your request for ${service} in ${city}. Our local estimator will arrive at the scheduled time for your free 21-point inspection. Reply STOP to opt out.`;
        if (schedulingType === "external_link" && bookingUrl) {
          msgBody = `Hi ${firstName}, thanks for contacting Ocean County Roofing Pros! We received your request for ${service} in ${city}. Please finalize your preferred 15-minute arrival window on our live dispatch calendar: ${bookingUrl} Reply STOP to opt out.`;
        }

        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            To: phone,
            From: twilioPhone,
            Body: msgBody
          })
        });
      } catch (err) {
        console.error("Error dispatching SMS:", err);
      }
    }

    // 4. Send Domain-Branded Email Alerts via Resend
    const customerEmail = body.email || "";
    const emailLeadPayload = {
      lead_id: leadId,
      name: `${firstName} ${lastName}`.trim(),
      phone: phone,
      email: customerEmail,
      address: `${address}, ${city}, NJ`.trim(),
      date: body.preferred_date || "Pending Dispatch",
      time: body.preferred_time || "Pending Dispatch",
      service: service,
      roof_age: body.diagnostic_situation || service,
      attic_access: body.attic_access || "Attic access pending confirmation",
      ladder_needed: "Standard",
      decision_makers_present: "Yes",
      source: "Website Lead Form"
    };

    try {
      if (customerEmail && customerEmail.includes("@")) {
        EmailService.sendBookingConfirmation(emailLeadPayload).catch(e => console.error("Webform confirmation email err:", e));
      }
      EmailService.sendOwnerLeadAlert(emailLeadPayload).catch(e => console.error("Webform owner email err:", e));
    } catch (eErr) {
      console.error("Webform email dispatch err:", eErr);
    }

    return new Response(JSON.stringify({
      status: "success",
      message: "Lead received successfully. Estimator dispatch initiated.",
      lead_id: leadId,
      scheduling_type: schedulingType,
      booking_url: schedulingType === "external_link" && bookingUrl ? bookingUrl : null,
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
