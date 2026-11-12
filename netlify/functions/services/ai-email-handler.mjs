// ==============================================================================
// OCEAN COUNTY ROOFING PROS - AUTONOMOUS AI EMAIL AGENT (RILEY DAVIS)
// ==============================================================================
import { EmailService } from "./email-service.mjs";

const RILEY_SYSTEM_PROMPT = `
You are Riley Davis, the Lead Scheduling Coordinator at Ocean County Roofing Pros.
Our office is based in Toms River, NJ, serving homeowners across Ocean County and Monmouth County.
Ocean County Roofing Pros is operated by Offgrid Media, LLC.

YOUR CORE VALUES & RULES:
1. Speak with professional warmth, confidence, and authoritative roofing expertise.
2. We provide FREE 21-Point Drone & Thermal Roof Inspections using 4K optical and FLIR thermal cameras.
3. NEVER provide blind dollar estimates or ballpark roof prices over email. Explain that roof slope, decking condition, flashing, ventilation, and underlayment must be inspected via drone and attic scan first to give an exact, guaranteed price.
4. Materials we specialize in: Coastal-rated architectural shingles (CertainTeed Landmark Pro, GAF Timberline HDZ with LayerLock, Owens Corning Duration) engineered for 130 MPH coastal wind gusts, salt air corrosion resistance, and synthetic underlayment with ice & water shield.
5. Inquiries requiring attic access: Explain our technician uses thermal cameras inside the attic to identify invisible moisture before it stains ceilings.
6. If an email expresses frustration, demands a refund/legal action, or reports water actively pouring inside the house, classify as ESCALATION and reassure the customer that our field operations manager has been immediately paged.
7. Tone: Helpful, proactive, concise, completely free of generic robot fluff.

SIGNATURE FORMAT:
Warm regards,
Riley Davis
Lead Scheduling Coordinator | Ocean County Roofing Pros
Direct Dispatch: (732) 660-9121
https://oceancountyroofingpros.com
`;

export class AIEmailAgent {
  /**
   * Classify intent and formulate autonomous response
   */
  static async processInboundEmail({ from, subject, textBody, htmlBody, messageId }) {
    console.log(`[AIEmailAgent] Processing inbound email from: ${from} | Subject: ${subject}`);

    const senderEmail = this.extractEmailAddress(from);
    const senderName = this.extractName(from) || "Valued Homeowner";

    // 1. Look up existing lead in Supabase (if available)
    const existingLead = await this.lookupLead(senderEmail);

    // 2. Classify intent
    const intentData = await this.classifyIntent(subject, textBody);
    console.log(`[AIEmailAgent] Classified Intent:`, intentData);

    let replyText = "";
    let shouldAlertOwner = false;
    let escalationReason = "";

    switch (intentData.intent) {
      case "RESCHEDULE": {
        const newDate = intentData.extracted_date || "your requested date";
        const newTime = intentData.extracted_time || "your requested time";
        
        if (existingLead) {
          await this.updateLeadAppointment(existingLead.id, `${newDate} ${newTime}`);
        }

        replyText = `Hi ${senderName},\n\nI have received your request to reschedule your Free 21-Point Drone Roof Inspection. I have updated our dispatch board for ${newDate} at ${newTime} for your property.\n\nOur certified technician will arrive with our 4K optical and thermal drone equipment during that window. Please ensure your driveway has an open spot for safe drone launch and attic access remains clear.\n\nIf you need any further adjustments, feel free to reply directly to this email or call our dispatch desk at (732) 660-9121.`;
        shouldAlertOwner = true;
        escalationReason = `Customer rescheduled inspection to ${newDate} @ ${newTime}`;
        break;
      }

      case "CANCELLATION": {
        if (existingLead) {
          await this.updateLeadStatus(existingLead.id, "Inspection Cancelled");
        }
        replyText = `Hi ${senderName},\n\nI have processed your cancellation for your scheduled roof inspection. We appreciate you letting us know in advance so our crew can adjust their daily route.\n\nIf you ever notice wind damage, missing shingles after a coastal nor'easter, or need a second opinion on your roof down the road, please don't hesitate to reach back out to us.`;
        shouldAlertOwner = true;
        escalationReason = `Customer requested cancellation of inspection.`;
        break;
      }

      case "ESCALATION": {
        replyText = `Hi ${senderName},\n\nThank you for reaching out to us. I have personally flagged your message and forwarded your notes directly to our Field Operations Manager and Owner so we can give this our immediate, priority attention.\n\nSomeone from our senior management team will be contacting you directly today. If this is an active roof leak emergency requiring emergency tarping, please call our 24/7 urgent dispatch desk immediately at (732) 660-9121.`;
        shouldAlertOwner = true;
        escalationReason = `URGENT ESCALATION: ${intentData.summary || subject}`;
        break;
      }

      case "PRICE_QUESTION": {
        replyText = `Hi ${senderName},\n\nThanks for reaching out about pricing! Because every roof in Ocean County has unique dimensions, roof pitch, ventilation requirements, and varying degrees of coastal storm wear, we never give blind ballpark numbers over email that could be inaccurate.\n\nInstead, we offer our 100% Free 21-Point Drone & Thermal Roof Inspection. Our technician flies a high-definition 4K drone over your entire roof line, inspects flashing, valleys, and vents, and conducts a thermal scan of your attic decking. At the end, you'll receive a detailed photo report and an exact, line-item proposal with zero obligation.\n\nWould you like to schedule an inspection this week? Reply with your address and whether morning or afternoon works best for you!`;
        break;
      }

      case "INSPECTION_QUESTION":
      default: {
        // Generate AI contextual response using LLM or structured knowledge
        replyText = await this.generateSmartResponse({
          senderName,
          subject,
          textBody,
          existingLead
        });
        break;
      }
    }

    // 3. Dispatch the email response via Resend
    const sendResult = await EmailService.sendAgentReply(senderEmail, subject, replyText, messageId);

    // 4. If escalated or rescheduled, alert the business owner
    if (shouldAlertOwner) {
      await this.notifyOwner({
        senderName,
        senderEmail,
        subject,
        textBody,
        escalationReason,
        replyText
      });
    }

    return {
      status: "success",
      intent: intentData.intent,
      replySentTo: senderEmail,
      sendResult
    };
  }

  /**
   * Classify intent from subject and body
   */
  static async classifyIntent(subject, body) {
    const text = `${subject} ${body}`.toLowerCase();

    // Check Escalation
    if (text.includes("leak") && (text.includes("emergency") || text.includes("pouring") || text.includes("ceiling collapsed")) ||
        text.includes("lawyer") || text.includes("attorney") || text.includes("complaint") || text.includes("sue") || text.includes("terrible")) {
      return { intent: "ESCALATION", summary: "Urgent issue or complaint detected" };
    }

    // Check Reschedule
    if (text.includes("reschedule") || text.includes("change time") || text.includes("different day") || text.includes("move appointment") || text.includes("can we do")) {
      // Simple regex extractor for dates/times
      const dateMatch = body.match(/(monday|tuesday|wednesday|thursday|friday|saturday|tomorrow|next week|\d{1,2}\/\d{1,2})/i);
      const timeMatch = body.match(/(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i);
      return {
        intent: "RESCHEDULE",
        extracted_date: dateMatch ? dateMatch[0] : "your requested date",
        extracted_time: timeMatch ? timeMatch[0] : "your requested time"
      };
    }

    // Check Cancellation
    if (text.includes("cancel") && (text.includes("appointment") || text.includes("inspection") || text.includes("don't come") || text.includes("do not come"))) {
      return { intent: "CANCELLATION" };
    }

    // Check Price Quote
    if (text.includes("how much") || text.includes("cost") || text.includes("price") || text.includes("quote") || text.includes("estimate for a new roof")) {
      return { intent: "PRICE_QUESTION" };
    }

    return { intent: "INSPECTION_QUESTION" };
  }

  /**
   * Generates a conversational response matching Riley Davis's persona
   */
  static async generateSmartResponse({ senderName, subject, textBody, existingLead }) {
    // If Netlify AI Gateway or OpenAI/Gemini is configured, we can call it.
    // Otherwise, we provide accurate domain responses for common questions.
    const text = textBody.toLowerCase();

    if (text.includes("drone") || text.includes("how does the inspection work") || text.includes("what do you check")) {
      return `Hi ${senderName},\n\nGreat question! Our Free 21-Point Inspection uses both high-resolution 4K optical and FLIR thermal drones.\n\nHere is what we inspect:\n1. 4K Drone Aerial Scan: We inspect every shingle plane, ridge cap, chimney flashing, plumbing boots, and valley seals for wind lift or micro-cracking.\n2. Thermal Moisture Detection: Our thermal sensors detect trapped moisture under the shingles before it leaks into your living areas.\n3. Attic & Decking Scan: We check the underside of the roof deck for ventilation efficiency and signs of wood rot.\n\nAt the end of the 30-minute visit, our specialist walks you through all the photos and reports on an iPad with no high-pressure sales pitch.`;
    }

    if (text.includes("warranty") || text.includes("certainteed") || text.includes("gaf") || text.includes("materials")) {
      return `Hi ${senderName},\n\nThanks for asking about our materials! Living near the Jersey Shore, roofs face unique coastal challenges including high salt air and severe wind gusts.\n\nWe primarily install CertainTeed Landmark Pro and GAF Timberline HDZ architectural shingles. These systems feature:\n• 130 MPH Wind Warranty Protection\n• Dual-layer fiberglass construction\n• StreakFighter algae resistance against coastal humidity\n• Lifetime limited manufacturer warranties with transferrable protection\n\nOur specialist will have physical shingle samples during your inspection so you can see the color options and texture in person.`;
    }

    if (text.includes("insurance") || text.includes("storm damage") || text.includes("hail") || text.includes("wind")) {
      return `Hi ${senderName},\n\nWe work extensively with storm damage insurance claims across Ocean County. Our 4K drone scan generates timestamped, high-resolution documentation of wind-creased and missing shingles that adjusters require for claim approvals.\n\nWe can provide you with our complete inspection photo packet to submit to your carrier, and our specialists are happy to meet your adjuster on-site to ensure all storm damage is accounted for.`;
    }

    // Default polite coordination reply
    const aptInfo = existingLead && existingLead.appointment_slot ? ` for your appointment on ${existingLead.appointment_slot}` : "";
    return `Hi ${senderName},\n\nThank you for reaching out to Ocean County Roofing Pros! I have received your message${aptInfo}.\n\nOur team is reviewing your inquiry and will follow up with any additional details needed. If you need to make urgent changes to your inspection or have specific questions about our free 21-point drone evaluation, please don't hesitate to give our dispatch desk a direct call at (732) 660-9121.\n\nWe look forward to taking great care of your roof!`;
  }

  /**
   * Helper: extract pure email address from "Name <email@domain.com>"
   */
  static extractEmailAddress(raw) {
    if (!raw) return "";
    const match = raw.match(/<([^>]+)>/);
    return match ? match[1].trim() : raw.trim();
  }

  /**
   * Helper: extract name from "Name <email@domain.com>"
   */
  static extractName(raw) {
    if (!raw) return "";
    if (raw.includes("<")) {
      return raw.split("<")[0].replace(/"/g, "").trim();
    }
    return "";
  }

  /**
   * Lookup lead by email in Supabase
   */
  static async lookupLead(email) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey || !email) return null;

    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?email=eq.${encodeURIComponent(email)}&limit=1`, {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`
        }
      });
      if (res.ok) {
        const leads = await res.json();
        return leads.length > 0 ? leads[0] : null;
      }
    } catch (e) {
      console.error("[AIEmailAgent] Supabase lookup error:", e);
    }
    return null;
  }

  /**
   * Update lead appointment slot in Supabase
   */
  static async updateLeadAppointment(leadId, newSlot) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    try {
      await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?id=eq.${leadId}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          appointment_slot: newSlot,
          status: "Inspection Rescheduled",
          updated_at: new Date().toISOString()
        })
      });
      console.log(`[AIEmailAgent] Updated lead ${leadId} appointment slot to: ${newSlot}`);
    } catch (e) {
      console.error("[AIEmailAgent] Supabase reschedule update error:", e);
    }
  }

  /**
   * Update lead status in Supabase
   */
  static async updateLeadStatus(leadId, status) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) return;

    try {
      await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?id=eq.${leadId}`, {
        method: "PATCH",
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          status: status,
          updated_at: new Date().toISOString()
        })
      });
    } catch (e) {
      console.error("[AIEmailAgent] Supabase status update error:", e);
    }
  }

  /**
   * Alert owner via SMS and Email
   */
  static async notifyOwner({ senderName, senderEmail, subject, textBody, escalationReason, replyText }) {
    const ownerEmail = process.env.OWNER_ALERT_EMAIL || "anthony.fuller.ink@gmail.com";
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";
    const ownerPhone = process.env.OWNER_ALERT_PHONE || "+17325523896";

    // 1. Send SMS to Owner
    if (twilioSid && twilioToken && ownerPhone) {
      try {
        const smsMsg = `🚨 [ROOFING EMAIL ALERT] ${escalationReason} | From: ${senderName} (${senderEmail}) | Riley auto-replied and flagged file.`;
        const auth = Buffer.from(`${twilioSid}:${twilioToken}`).toString("base64");
        await fetch(`https://api.twilio.com/2010-04-01/Accounts/${twilioSid}/Messages.json`, {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded"
          },
          body: new URLSearchParams({
            To: ownerPhone,
            From: twilioPhone,
            Body: smsMsg
          })
        });
        console.log(`[AIEmailAgent] Dispatched escalation SMS to owner: ${ownerPhone}`);
      } catch (err) {
        console.error("[AIEmailAgent] Owner SMS dispatch error:", err);
      }
    }

    // 2. Send Email alert to Owner
    const alertHtml = `
      <div style="font-family: monospace; background: #0f172a; color: #f8fafc; padding: 20px; border-radius: 8px;">
        <h2 style="color: #ef4444; margin-top: 0;">🚨 AI EMAIL AGENT: ACTION REQUIRED</h2>
        <p><strong>Reason:</strong> ${escalationReason}</p>
        <p><strong>Customer:</strong> ${senderName} &lt;${senderEmail}&gt;</p>
        <p><strong>Subject:</strong> ${subject}</p>
        <hr style="border-color: #334155;">
        <p><strong>Incoming Message:</strong></p>
        <blockquote style="background: #1e293b; padding: 12px; border-left: 4px solid #38bdf8;">${textBody}</blockquote>
        <p><strong>Riley Davis Automated Reply Dispatched:</strong></p>
        <blockquote style="background: #1e293b; padding: 12px; border-left: 4px solid #10b981;">${replyText.replace(/\n/g, "<br>")}</blockquote>
      </div>
    `;

    await EmailService.sendEmail({
      from: EmailService.getFromAddress(),
      to: [ownerEmail],
      reply_to: senderEmail,
      subject: `🚨 [Agent Flag] ${escalationReason} - ${senderName}`,
      html: alertHtml
    });
  }
}
