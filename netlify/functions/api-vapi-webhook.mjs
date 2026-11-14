/**
 * Netlify Serverless Function: Vapi Webhook & End-Of-Call Handler
 * Routes: POST /api/vapi/webhook, POST /api/vapi/end-of-call
 */
export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }

  const expectedSecret = (process.env.VAPI_SERVER_SECRET || "").trim();
  if (expectedSecret) {
    const providedSecret = (req.headers.get("x-vapi-secret") || "").trim();
    if (providedSecret !== expectedSecret) {
      return new Response(JSON.stringify({ error: "Unauthorized webhook request" }), {
        status: 401,
        headers: { "Content-Type": "application/json" }
      });
    }
  }

  try {
    const body = await req.json();
    const message = body.message || body;
    const type = message.type || body.type;

    if (type === "end-of-call-report") {
      const call = message.call || {};
      const transcript = message.transcript || call.transcript || "";
      const recordingUrl = message.recordingUrl || call.recordingUrl || "";
      const duration = message.durationSeconds || call.durationSeconds || 0;
      const customer = call.customer || {};
      const phone = customer.number || "";

      const supabaseUrl = process.env.SUPABASE_URL || "";
      const supabaseKey = process.env.SUPABASE_KEY || "";

      if (supabaseUrl && supabaseKey && phone) {
        try {
          await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?phone=eq.${encodeURIComponent(phone)}`, {
            method: "PATCH",
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`,
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              call_recording_url: recordingUrl,
              call_transcript: transcript,
              call_duration_sec: duration,
              updated_at: new Date().toISOString()
            })
          });
        } catch (err) {
          console.error("Error updating lead call report:", err);
        }
      }
    }

    return new Response(JSON.stringify({ status: "success" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("Vapi webhook error:", err);
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  }
};
