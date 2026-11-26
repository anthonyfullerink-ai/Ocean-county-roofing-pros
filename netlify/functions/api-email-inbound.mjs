/**
 * Netlify Serverless Function: Resend Inbound Email Webhook & AI Agent Handler
 * Routes: POST /api/email/inbound
 */
import { AIEmailAgent } from "./services/ai-email-handler.mjs";
import { EmailService } from "./services/email-service.mjs";
import { ChiefOfStaffService } from "./services/chief-of-staff-service.mjs";

const RESEND_RECEIVING_API_URL = "https://api.resend.com/emails/receiving";

function extractSenderAddress(fromHeader) {
  const raw = String(fromHeader || "").trim();
  const match = raw.match(/<([^>]+)>/);
  return (match ? match[1] : raw).trim().toLowerCase();
}

function extractRecipientAddresses(toField) {
  const items = Array.isArray(toField)
    ? toField
    : String(toField || "").split(",");
  return items
    .map((entry) => {
      const s = String(entry || "").trim();
      const match = s.match(/<([^>]+)>/);
      return (match ? match[1] : s).trim().toLowerCase();
    })
    .filter((addr) => addr.includes("@"));
}

function isOwnerDirectAlias(toAddresses) {
  const configured = (process.env.OWNER_DIRECT_ALIASES || "anthony@oceancountyroofingpros.com")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return toAddresses.some((addr) => configured.includes(addr));
}

function shouldBypassAutoReply(senderEmail, toAddresses) {
  if (isOwnerDirectAlias(toAddresses)) return true;

  const ownerEmail = EmailService.getOwnerAlertEmail().toLowerCase();
  if (senderEmail === ownerEmail) return true;
  if (senderEmail.endsWith("@oceancountyroofingpros.com")) return true;

  // Never AI-reply to automated system/verification/directory emails
  if (/^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?|verify|security)@/i.test(senderEmail)) {
    return true;
  }
  if (/@(mail\.instagram\.com|facebookmail\.com|yelp\.com|accounts\.google\.com|google\.com|bing\.com)$/i.test(senderEmail)) {
    return true;
  }
  return false;
}

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

    const toAddresses = extractRecipientAddresses(to);
    const senderAddress = extractSenderAddress(from);
    const ownerEmail = EmailService.getOwnerAlertEmail().toLowerCase();

    // Executive Chief of Staff ("Elena") Direct Two-Way Email Routing
    if (
      ChiefOfStaffService.isChiefRecipient(toAddresses, subject) &&
      (senderAddress === ownerEmail || senderAddress.endsWith("@oceancountyroofingpros.com") || payload.allow_test_owner === true)
    ) {
      console.log(`[api-email-inbound] Routing owner email to Elena Chief of Staff (to=${toAddresses.join(",")}, from=${senderAddress})`);
      const chiefResult = await ChiefOfStaffService.handleOwnerInboundEmail({
        from,
        to: toAddresses,
        subject,
        textBody,
        messageId
      });
      return new Response(JSON.stringify({
        status: "handled_by_chief",
        chiefResult
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Direct owner aliases (e.g. anthony@), owner's Gmail, or automated/no-reply senders:
    // Forward straight to Gmail without triggering Riley AI auto-reply.
    if (shouldBypassAutoReply(senderAddress, toAddresses)) {
      console.log(`[api-email-inbound] Bypassing AI auto-reply and forwarding to owner Gmail (to=${toAddresses.join(",")}, from=${senderAddress})`);
      const forwardResult = await EmailService.forwardInboundToOwner({
        toAliases: toAddresses,
        from,
        subject,
        textBody,
        htmlBody
      });

      return new Response(JSON.stringify({
        status: "forwarded_to_owner",
        skipped_ai: true,
        to: toAddresses,
        forwardResult
      }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Process business/lead email with Autonomous Rank-and-Rent AI Email Agent
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

    // Forward ALL inbound business emails (including spam) to owner Gmail
    await EmailService.forwardInboundToOwner({
      toAliases: toAddresses,
      from,
      subject: result?.status === "silenced_spam" ? `[SPAM] ${subject}` : subject,
      textBody,
      htmlBody
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
