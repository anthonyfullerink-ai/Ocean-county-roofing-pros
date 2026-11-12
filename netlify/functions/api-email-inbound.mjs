/**
 * Netlify Serverless Function: Resend Inbound Email Webhook & AI Agent Handler
 * Routes: POST /api/email/inbound
 */
import { AIEmailAgent } from "./services/ai-email-handler.mjs";

const RESEND_RECEIVING_API_URL = "https://api.resend.com/emails/receiving";

function stripHtmlTags(html) {
  if (!html) return "";
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<\/(div|p|br|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

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

    // Only process email.received events (or direct test payloads)
    if (payload.type !== "email.received" && !payload.data?.email_id && !payload.from) {
      return new Response(JSON.stringify({ status: "ignored", reason: "not_inbound_email" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    const emailData = payload.data || payload;
    const emailId = emailData.email_id || emailData.id;
    let from = emailData.from || "";
    let to = emailData.to || [];
    let subject = emailData.subject || "Roofing Inquiry";
    let textBody = emailData.text || "";
    let htmlBody = emailData.html || "";
    let messageId = emailData.message_id || emailId;
    let emailHeaders = emailData.headers || {};

    // Fetch full inbound email content from Resend Receiving API
    const resendApiKey = process.env.RESEND_API_KEY;
    if (emailId && (!textBody || textBody.trim().length === 0) && resendApiKey) {
      try {
        console.log(`[api-email-inbound] Fetching full email content for ${emailId} from Resend Receiving API...`);
        const fetchRes = await fetch(`${RESEND_RECEIVING_API_URL}/${emailId}`, {
          headers: {
            "Authorization": `Bearer ${resendApiKey}`,
            "Content-Type": "application/json"
          }
        });

        if (fetchRes.ok) {
          const fullEmail = await fetchRes.json();
          from = fullEmail.headers?.from || fullEmail.from || from;
          to = fullEmail.to || to;
          subject = fullEmail.subject || subject;
          htmlBody = fullEmail.html || htmlBody;
          textBody = fullEmail.text || stripHtmlTags(htmlBody) || "";
          messageId = fullEmail.message_id || messageId;
          emailHeaders = fullEmail.headers || emailHeaders;
          console.log(`[api-email-inbound] Successfully retrieved inbound text body (${textBody.length} chars).`);
        } else {
          console.error(`[api-email-inbound] Resend Receiving API returned ${fetchRes.status}`);
        }
      } catch (fetchErr) {
        console.error("[api-email-inbound] Error fetching inbound email from Resend:", fetchErr);
      }
    } else if (!textBody && htmlBody) {
      textBody = stripHtmlTags(htmlBody);
    }

    // Process email with Autonomous Rank-and-Rent AI Email Agent
    const result = await AIEmailAgent.processInboundEmail({
      from,
      to,
      subject,
      textBody,
      htmlBody,
      messageId,
      emailId,
      headers: emailHeaders
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
