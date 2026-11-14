/**
 * Netlify Serverless Function: Twilio Inbound SMS Webhook (+18669001221)
 * Routes: POST /api/twilio/sms-inbound
 *
 * Processes STOP/HELP compliance keywords and forwards inbound customer SMS replies
 * directly to OWNER_ALERT_EMAIL via Resend with valid empty TwiML response.
 */
import { EmailService } from "./services/email-service.mjs";

function xmlEscape(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function twimlResponse(messageText = "") {
  const inner = messageText ? `<Message>${xmlEscape(messageText)}</Message>` : "";
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`, {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

export default async (req) => {
  if (req.method !== "POST") {
    return twimlResponse("");
  }

  try {
    const contentType = (req.headers.get("content-type") || "").toLowerCase();
    let params = {};
    if (contentType.includes("application/json")) {
      params = await req.json();
    } else {
      const raw = await req.text();
      const form = new URLSearchParams(raw);
      params = Object.fromEntries(form.entries());
    }

    const fromPhone = String(params.From || params.from || "").trim();
    const toPhone = String(params.To || params.to || "+18669001221").trim();
    const bodyText = String(params.Body || params.body || "").trim();
    const upper = bodyText.toUpperCase();

    if (["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"].includes(upper)) {
      return twimlResponse("");
    }

    if (upper === "HELP" || upper === "INFO") {
      return twimlResponse(
        "Ocean County Roofing Pros: For immediate help call (732) 660-9121 or visit https://oceancountyroofingpros.com. Reply STOP to cancel."
      );
    }

    const safeFrom = xmlEscape(fromPhone || "Unknown");
    const safeTo = xmlEscape(toPhone);
    const safeBody = xmlEscape(bodyText || "(empty SMS)");
    const ownerEmail = EmailService.getOwnerAlertEmail();

    if (ownerEmail) {
      await EmailService.sendEmail({
        from: EmailService.getFromAddress(),
        to: [ownerEmail],
        reply_to: EmailService.getReplyToAddress(),
        subject: `💬 [Inbound SMS] Reply from ${fromPhone || "Caller"} to ${toPhone}`,
        html: `
          <div style="font-family:sans-serif;padding:20px;background:#0f172a;color:#f8fafc;border-radius:12px;">
            <h3 style="margin-top:0;color:#2dd4bf;">Inbound Text Message Received</h3>
            <p><strong>From:</strong> <a href="tel:${safeFrom}" style="color:#38bdf8;">${safeFrom}</a></p>
            <p><strong>To:</strong> ${safeTo}</p>
            <div style="background:#1e293b;padding:14px;border-radius:8px;border:1px solid #334155;margin-top:10px;">
              ${safeBody.replace(/\n/g, "<br>")}
            </div>
          </div>`,
        text: `Inbound SMS\nFrom: ${fromPhone}\nTo: ${toPhone}\nMessage:\n${bodyText}`
      }).catch(err => console.error("[api-twilio-sms] Forward error:", err.message));
    }

    return twimlResponse("");
  } catch (err) {
    console.error("[api-twilio-sms] Webhook parse error:", err);
    return twimlResponse("");
  }
};
