/**
 * Netlify Serverless Function: Resend Inbound Email Webhook & AI Agent Handler
 * Routes: POST /api/email/inbound
 */
import { AIEmailAgent } from "./services/ai-email-handler.mjs";

const RESEND_API_URL = "https://api.resend.com/emails";

export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const rawBody = await req.text();
    let payload = {};
    try {
      payload = JSON.parse(rawBody);
    } catch (e) {
      return new Response(JSON.stringify({ error: "Invalid JSON" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    console.log("[api-email-inbound] Received webhook event:", payload.type);

    // Only process email.received events
    if (payload.type !== "email.received" && !payload.data?.email_id && !payload.from) {
      return new Response(JSON.stringify({ status: "ignored", reason: "not_inbound_email" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const emailData = payload.data || payload;
    const emailId = emailData.email_id || emailData.id;
    let from = emailData.from || "";
    let subject = emailData.subject || "Inquiry";
    let textBody = emailData.text || "";
    let htmlBody = emailData.html || "";
    const messageId = emailData.message_id || emailId;

    // If body text is not provided in webhook payload, fetch from Resend REST API
    const resendApiKey = process.env.RESEND_API_KEY;
    if (emailId && (!textBody || textBody.length === 0) && resendApiKey) {
      try {
        console.log(`[api-email-inbound] Fetching full email content for ${emailId} from Resend...`);
        const fetchRes = await fetch(`${RESEND_API_URL}/${emailId}`, {
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
          }
        });

        if (fetchRes.ok) {
          const fullEmail = await fetchRes.json();
          from = from || fullEmail.from;
          subject = subject || fullEmail.subject;
          textBody = fullEmail.text || fullEmail.html || "";
          htmlBody = fullEmail.html || "";
        }
      } catch (fetchErr) {
        console.error("[api-email-inbound] Error fetching full email from Resend:", fetchErr);
      }
    }

    // Process email with Autonomous AI Email Agent
    const result = await AIEmailAgent.processInboundEmail({
      from,
      subject,
      textBody,
      htmlBody,
      messageId
    });

    return new Response(JSON.stringify({
      status: "processed",
      result
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (err) {
    console.error("[api-email-inbound] Webhook processing error:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
