// ==============================================================================
// OCEAN COUNTY ROOFING PROS - RESEND TRANSACTIONAL EMAIL SERVICE
// ==============================================================================

const RESEND_API_URL = "https://api.resend.com/emails";

function toIcsUtcStamp(isoStr) {
  const dt = new Date(isoStr);
  if (Number.isNaN(dt.getTime())) return "";
  return dt.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(val) {
  return String(val || "")
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

export function buildIcsAttachment({ leadId, summary, location, description, startIso, endIso }) {
  const dtStart = toIcsUtcStamp(startIso);
  const dtEnd = toIcsUtcStamp(endIso);
  if (!dtStart || !dtEnd) return null;
  const dtStamp = toIcsUtcStamp(new Date().toISOString());
  const uid = `${String(leadId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "")}@oceancountyroofingpros.com`;
  const icsLines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Ocean County Roofing Pros//Dispatch//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${dtStamp}`,
    `DTSTART:${dtStart}`,
    `DTEND:${dtEnd}`,
    `SUMMARY:${escapeIcsText(summary || "Roof Inspection - Ocean County Roofing Pros")}`,
    `LOCATION:${escapeIcsText(location || "Ocean County, NJ")}`,
    `DESCRIPTION:${escapeIcsText(description || "21-Point Roof & Attic Inspection")}`,
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  return {
    filename: "roof-inspection.ics",
    content: Buffer.from(icsLines, "utf-8").toString("base64")
  };
}

export class EmailService {
  static getApiKey() {
    return process.env.RESEND_API_KEY || "";
  }

  static getFromAddress() {
    return process.env.EMAIL_FROM_ADDRESS || "Ocean County Roofing Pros <inspections@oceancountyroofingpros.com>";
  }

  static getReplyToAddress() {
    return process.env.EMAIL_REPLY_TO || "riley@oceancountyroofingpros.com";
  }

  static getOwnerAlertEmail() {
    return process.env.OWNER_ALERT_EMAIL || "anthony.fuller.ink@gmail.com";
  }

  /**
   * Dispatches a raw email payload to Resend REST API
   */
  static async sendEmail(payload) {
    const apiKey = this.getApiKey();
    if (!apiKey) {
      console.warn("[EmailService] RESEND_API_KEY is not set. Email dispatch skipped.");
      return { status: "skipped", reason: "missing_api_key" };
    }

    try {
      const response = await fetch(RESEND_API_URL, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();
      if (!response.ok) {
        console.error("[EmailService] Resend API Error:", response.status, data);
        return { status: "error", code: response.status, data };
      }

      console.log(`[EmailService] Email successfully sent to ${payload.to}: ${data.id}`);
      return { status: "success", id: data.id };
    } catch (err) {
      console.error("[EmailService] Network error during dispatch:", err.message);
      return { status: "error", error: err.message };
    }
  }

  /**
   * 1. Send Homeowner Inspection Confirmation Email
   */
  static async sendBookingConfirmation(lead) {
    const toEmail = lead.email || lead.customer_email;
    if (!toEmail || !toEmail.includes("@")) {
      console.log("[EmailService] No valid customer email provided. Skipping confirmation email.");
      return null;
    }

    const name = lead.name || lead.first_name || "Valued Homeowner";
    const address = lead.address || lead.street_address || "Ocean County, NJ";
    const date = lead.date || lead.appointment_date || "Tomorrow";
    const time = lead.time || lead.appointment_time || "1:00 PM";
    const service = lead.service || "Free 21-Point Roof & Attic Inspection";
    const atticNote = lead.attic_access || "Attic inspection included";
    const ladderNote = lead.ladder_needed || "Standard ladder gear";

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #1e293b; margin: 0; padding: 24px; }
    .container { max-width: 600px; margin: 0 auto; background: #ffffff; border-radius: 20px; overflow: hidden; border: 1px solid #e2e8f0; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.05); }
    .header { background: #0A486D; padding: 32px 24px; text-align: center; }
    .header h1 { color: #ffffff; margin: 0; font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
    .header p { color: #17ABA4; margin: 6px 0 0; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
    .content { padding: 32px 28px; }
    .highlight-card { background: #f0fdf4; border-left: 4px solid #10b981; padding: 18px; border-radius: 0 12px 12px 0; margin: 24px 0; }
    .details-table { width: 100%; border-collapse: collapse; margin: 20px 0; }
    .details-table td { padding: 10px 0; border-bottom: 1px solid #f1f5f9; font-size: 14px; }
    .details-table td.label { color: #64748b; font-weight: 600; width: 35%; }
    .details-table td.value { color: #0f172a; font-weight: 700; }
    .prep-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 20px; margin: 24px 0; }
    .prep-item { margin-bottom: 12px; font-size: 13px; color: #334155; line-height: 1.5; }
    .footer { background: #0f172a; padding: 24px; text-align: center; color: #94a3b8; font-size: 12px; }
    .btn { display: inline-block; background: #0A486D; color: #ffffff; padding: 14px 28px; border-radius: 12px; text-decoration: none; font-weight: bold; font-size: 14px; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>OCEAN COUNTY ROOFING PROS</h1>
      <p>Appointment Confirmation</p>
    </div>
    <div class="content">
      <h2 style="font-size: 20px; color: #0f172a; margin-top: 0;">Hi ${name},</h2>
      <p style="font-size: 15px; color: #475569; line-height: 1.6;">
        Your <strong>${service}</strong> has been confirmed on our dispatch calendar. Our certified roofing specialist will arrive during your scheduled window to perform a complete 21-point exterior roof, flashing, and attic moisture evaluation and provide a transparent written estimate.
      </p>

      <div class="highlight-card">
        <div style="font-size: 12px; font-weight: 800; color: #065f46; text-transform: uppercase;">Confirmed Inspection Window</div>
        <div style="font-size: 18px; font-weight: 800; color: #047857; margin-top: 4px;">${date} at ${time}</div>
      </div>

      <table class="details-table">
        <tr>
          <td class="label">Property Address:</td>
          <td class="value">${address}</td>
        </tr>
        <tr>
          <td class="label">Assigned Desk:</td>
          <td class="value">Riley Davis (Scheduling Desk)</td>
        </tr>
        <tr>
          <td class="label">Attic Inspection:</td>
          <td class="value">${atticNote} (${ladderNote})</td>
        </tr>
      </table>

      <div class="prep-box">
        <div style="font-weight: 800; color: #0f172a; font-size: 14px; margin-bottom: 12px;">Inspection Day Checklist:</div>
        <div class="prep-item">✓ <strong>Exterior Perimeter Access:</strong> Please ensure walkways and exterior access around the home are clear for ladder setup and roof photo documentation. (Aerial drone diagnostics available upon request for steep or complex roofs.)</div>
        <div class="prep-item">✓ <strong>Attic Access:</strong> Please ensure hallways or closets leading to the attic hatch are accessible for interior decking &amp; moisture checks.</div>
        <div class="prep-item">✓ <strong>All Decision-Makers:</strong> Please ensure all homeowners are present so our specialist can walk through the photo report and exact written estimate with you.</div>
      </div>

      <p style="font-size: 13px; color: #64748b; margin-top: 24px;">
        Need to adjust your time window or have questions beforehand? Simply reply directly to this email or call our direct dispatch line at <strong>(732) 660-9121</strong>.
      </p>

      <div style="margin-top: 28px; padding-top: 20px; border-top: 1px solid #e2e8f0; font-size: 13px; color: #334155;">
        Warm regards,<br>
        <strong>Riley Davis</strong><br>
        Lead Scheduling Coordinator | Ocean County Roofing Pros<br>
        <span style="color: #64748b;">A Division of Offgrid Media, LLC</span>
      </div>
    </div>
    <div class="footer">
      <p style="margin: 0 0 6px;">Ocean County Roofing Pros • 24/7 Dispatch Desk: (732) 660-9121</p>
      <p style="margin: 0;">https://oceancountyroofingpros.com • Toms River, NJ</p>
    </div>
  </div>
</body>
</html>
    `;

    const icsAttachment = (lead.start_iso && lead.end_iso)
      ? buildIcsAttachment({
          leadId: lead.lead_id,
          summary: `Roof Inspection: ${name}`,
          location: address,
          description: `${service} | Lead #${lead.lead_id || "Web"}`,
          startIso: lead.start_iso,
          endIso: lead.end_iso
        })
      : null;

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [toEmail],
      reply_to: this.getReplyToAddress(),
      subject: `Confirmed: Free 21-Point Roof Inspection for ${address} (${date})`,
      html: htmlContent,
      ...(icsAttachment ? { attachments: [icsAttachment] } : {})
    });
  }

  /**
   * 2. Send Real-Time Owner Lead Alert
   */
  static async sendOwnerLeadAlert(lead) {
    const ownerEmail = this.getOwnerAlertEmail();
    if (!ownerEmail) return null;

    const leadId = lead.lead_id || `LEAD-${Date.now()}`;
    const name = lead.name || lead.first_name || "Unknown Caller";
    const phone = lead.phone || lead.inbound_phone || "Not provided";
    const email = lead.email || lead.customer_email || "Not provided";
    const address = lead.address || lead.street_address || "Not provided";
    const date = lead.date || lead.appointment_date || "Pending";
    const time = lead.time || lead.appointment_time || "Pending";
    const scope = lead.roof_age || lead.service || "Inspection & Estimate";
    const architecture = lead.home_architecture || "";
    const notes = lead.notes || "";
    const attic = lead.attic_access || "";
    const ladder = lead.ladder_needed || "";
    const decisionMakers = lead.decision_makers_present || "";
    const source = lead.source || "Voice AI (Riley / Sarah)";

    const optionalRows = [
      architecture ? `<div class="item"><span class="label">Home Architecture:</span> <span class="val">${architecture}</span></div>` : "",
      attic ? `<div class="item"><span class="label">Attic Access:</span> <span class="val">${attic}${ladder ? ` (${ladder})` : ""}</span></div>` : "",
      decisionMakers ? `<div class="item"><span class="label">Both Decision-Makers:</span> <span class="val">${decisionMakers}</span></div>` : "",
      notes ? `<div class="item"><span class="label">Notes:</span> <span class="val">${notes}</span></div>` : ""
    ].filter(Boolean).join("\n    ");

    const headlineLabel = source.includes("Step 3 Captured")
      ? `Captured: ${date} (${time})`
      : `Confirmed: ${date} at ${time}`;

    const subject = source.includes("Step 3 Captured")
      ? `🚨 [Lead Captured - Selecting Time] ${name} - ${address}`
      : (source.includes("Booked Calendar")
          ? `🚨 [Confirmed Booking] ${name} - ${address} (${date} @ ${time})`
          : `🚨 [New Lead] ${name} - ${address} (${date} @ ${time})`);

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: monospace; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 12px; padding: 24px; max-width: 600px; margin: 0 auto; }
    h2 { color: #38bdf8; margin-top: 0; }
    .item { margin-bottom: 12px; }
    .label { color: #94a3b8; font-weight: bold; }
    .val { color: #f8fafc; font-weight: bold; }
    .highlight { background: #064e3b; color: #6ee7b7; padding: 8px 12px; border-radius: 6px; display: inline-block; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🚨 NEW ROOFING INSPECTION DISPATCHED</h2>
    <div class="item"><span class="label">Lead ID:</span> <span class="val">${leadId}</span></div>
    <div class="item"><span class="label">Source:</span> <span class="val">${source}</span></div>
    <div class="item highlight">${headlineLabel}</div>
    <hr style="border: 0; border-top: 1px solid #334155; margin: 16px 0;">
    <div class="item"><span class="label">Homeowner:</span> <span class="val">${name}</span></div>
    <div class="item"><span class="label">Phone:</span> <span class="val"><a href="tel:${phone}" style="color: #38bdf8;">${phone}</a></span></div>
    <div class="item"><span class="label">Email:</span> <span class="val">${email}</span></div>
    <div class="item"><span class="label">Address:</span> <span class="val">${address}</span></div>
    <div class="item"><span class="label">Roof Scope / Symptoms:</span> <span class="val">${scope}</span></div>
    ${optionalRows}
  </div>
</body>
</html>
    `;

    const icsAttachment = (lead.start_iso && lead.end_iso)
      ? buildIcsAttachment({
          leadId,
          summary: `Roof Inspection: ${name}`,
          location: address,
          description: `Homeowner: ${name}\nPhone: ${phone}\nEmail: ${email}\nAddress: ${address}\nService: ${scope}`,
          startIso: lead.start_iso,
          endIso: lead.end_iso
        })
      : null;

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [ownerEmail],
      reply_to: email.includes("@") ? email : this.getReplyToAddress(),
      subject,
      html: htmlContent,
      ...(icsAttachment ? { attachments: [icsAttachment] } : {})
    });
  }

  /**
   * 2B. Send Real-Time Owner Alert when a Voice Caller Requests a Human Representative
   */
  static async sendOwnerHumanEscalationAlert(escalation) {
    const ownerEmail = this.getOwnerAlertEmail();
    if (!ownerEmail) return null;

    const leadId = escalation.lead_id || `HUMAN-${Date.now() % 100000000}`;
    const name = escalation.name || "Homeowner";
    const phone = escalation.phone || "Not provided";
    const email = escalation.email || "";
    const address = escalation.address || "Ocean County, NJ";
    const reason = escalation.reason || "Requested to speak with a human representative";
    const agentName = escalation.agent_name || "Voice AI";
    const slaLabel = escalation.sla_label || "Within 1 Hour (usually sooner)";

    const safe = (v) => String(v || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");

    const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #0f172a; color: #e2e8f0; padding: 20px; }
    .card { background: #1e293b; border: 2px solid #f59e0b; border-radius: 14px; padding: 24px; max-width: 600px; margin: 0 auto; }
    h2 { color: #fbbf24; margin-top: 0; }
    .badge { background: #78350f; color: #fde68a; padding: 8px 12px; border-radius: 8px; display: inline-block; font-weight: 700; margin-bottom: 14px; font-size: 13px; }
    .item { margin-bottom: 10px; font-size: 14px; }
    .label { color: #94a3b8; font-weight: 700; }
    .val { color: #f8fafc; font-weight: 600; }
    .btn { display: inline-block; background: #0d9488; color: #ffffff; padding: 12px 20px; border-radius: 10px; text-decoration: none; font-weight: 800; margin-top: 14px; margin-right: 8px; }
  </style>
</head>
<body>
  <div class="card">
    <h2>🙋 CALLER REQUESTED A HUMAN REPRESENTATIVE</h2>
    <div class="badge">⏱️ Promised Caller: ${safe(slaLabel)}</div>
    <div class="item"><span class="label">Ticket ID:</span> <span class="val">${safe(leadId)}</span></div>
    <div class="item"><span class="label">AI Agent Handled By:</span> <span class="val">${safe(agentName)}</span></div>
    <hr style="border: 0; border-top: 1px solid #334155; margin: 14px 0;">
    <div class="item"><span class="label">Caller Name:</span> <span class="val">${safe(name)}</span></div>
    <div class="item"><span class="label">Callback Phone:</span> <span class="val"><a href="tel:${safe(phone)}" style="color: #38bdf8;">${safe(phone)}</a></span></div>
    <div class="item"><span class="label">Town / Address:</span> <span class="val">${safe(address)}</span></div>
    ${email ? `<div class="item"><span class="label">Email:</span> <span class="val">${safe(email)}</span></div>` : ""}
    <div class="item"><span class="label">Reason / Request:</span> <span class="val">${safe(reason)}</span></div>
    <div>
      ${phone && phone !== "Not provided" ? `<a href="tel:${safe(phone)}" class="btn">📞 Call ${safe(name)} Now</a>` : ""}
      <a href="https://oceancountyroofingpros.com/admin" class="btn" style="background:#334155;">Open Admin CRM &rarr;</a>
    </div>
  </div>
</body>
</html>`;

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [ownerEmail],
      reply_to: email.includes("@") ? email : this.getReplyToAddress(),
      subject: `🙋 [Human Requested] ${name} (${phone}) — ${address}`,
      html: htmlContent,
      text: `CALLER REQUESTED A HUMAN REPRESENTATIVE\nTicket: ${leadId}\nPromised SLA: ${slaLabel}\nName: ${name}\nPhone: ${phone}\nLocation: ${address}\nReason: ${reason}\nAgent: ${agentName}\nAdmin CRM: https://oceancountyroofingpros.com/admin`
    });
  }

  /**
   * Build a Gmail/Outlook-compatible table-based HTML email signature with logo & CTA
   */
  static buildSignatureHtml({
    senderName = "Riley Davis",
    senderTitle = "Lead Scheduling Coordinator",
    senderEmail = "riley@oceancountyroofingpros.com"
  } = {}) {
    return `
<table cellpadding="0" cellspacing="0" border="0" style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;border-top:2px solid #0d9488;padding-top:14px;margin-top:18px;max-width:520px;width:100%;">
  <tr>
    <td style="padding-bottom:10px;">
      <a href="https://oceancountyroofingpros.com" style="text-decoration:none;">
        <img src="https://oceancountyroofingpros.com/static/images/logo-horizontal.png" alt="Ocean County Roofing Pros" width="180" style="display:block;border:0;height:auto;max-width:180px;">
      </a>
    </td>
  </tr>
  <tr>
    <td style="font-size:15px;font-weight:700;color:#0f172a;line-height:1.3;">${senderName}</td>
  </tr>
  <tr>
    <td style="font-size:13px;color:#0d9488;font-weight:600;padding-bottom:6px;">${senderTitle} &nbsp;|&nbsp; Ocean County Roofing Pros</td>
  </tr>
  <tr>
    <td style="font-size:12px;color:#475569;padding-bottom:8px;">Licensed &amp; Insured &nbsp;&bull;&nbsp; CertainTeed ShingleMaster&trade; &nbsp;&bull;&nbsp; Toms River &amp; Ocean County, NJ</td>
  </tr>
  <tr>
    <td style="font-size:13px;color:#334155;padding-bottom:12px;">
      <a href="tel:+17326609121" style="color:#0A486D;font-weight:600;text-decoration:none;">(732) 660-9121</a>
      &nbsp;&bull;&nbsp;
      <a href="mailto:${senderEmail}" style="color:#0A486D;text-decoration:none;">${senderEmail}</a>
      &nbsp;&bull;&nbsp;
      <a href="https://oceancountyroofingpros.com" style="color:#0A486D;text-decoration:none;">oceancountyroofingpros.com</a>
    </td>
  </tr>
  <tr>
    <td style="padding-bottom:10px;">
      <a href="https://oceancountyroofingpros.com/#book" style="display:inline-block;background-color:#0A486D;color:#ffffff;font-size:13px;font-weight:700;text-decoration:none;padding:9px 16px;border-radius:8px;">Schedule Free 21-Point Roof &amp; Attic Inspection &rarr;</a>
    </td>
  </tr>
  <tr>
    <td style="font-size:11px;color:#64748b;">24/7 Emergency Storm Tarping &amp; Leak Triage &nbsp;&bull;&nbsp; Operated by Offgrid Media, LLC</td>
  </tr>
</table>`;
  }

  /**
   * 3. AI Agent Automated Outbound Response (Signed by Active Estimator)
   */
  static async sendAgentReply(toEmail, subject, textBody, inReplyToMessageId = null, tenant = null) {
    const headers = {};
    if (inReplyToMessageId) {
      headers["In-Reply-To"] = inReplyToMessageId;
      headers["References"] = inReplyToMessageId;
    }

    const estimator = tenant?.estimator_name ? (tenant.estimator_name === "Riley" ? "Riley Davis" : tenant.estimator_name) : "Riley Davis";
    const dispatchPhone = "(732) 660-9121";
    const signatureHtml = this.buildSignatureHtml({
      senderName: estimator,
      senderTitle: "Lead Scheduling Coordinator",
      senderEmail: "riley@oceancountyroofingpros.com"
    });

    const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #1e293b; line-height: 1.6;">
  ${textBody.replace(/\n/g, "<br>")}
  ${signatureHtml}
</div>
    `;

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [toEmail],
      reply_to: this.getReplyToAddress(),
      subject: subject.startsWith("Re:") ? subject : `Re: ${subject}`,
      html: htmlBody,
      text: `${textBody}\n\n--\n${estimator}\nLead Scheduling Coordinator | Ocean County Roofing Pros\nDirect Dispatch: ${dispatchPhone}\nWebsite: https://oceancountyroofingpros.com\nOcean County Roofing Pros is operated by Offgrid Media, LLC`,
      headers
    });
  }

  /**
   * 4. Forward Inbound Domain Email Directly to Owner Gmail (with Reply-To preserved)
   */
  static async forwardInboundToOwner({ toAliases = [], from = "", subject = "Inbound Email", textBody = "", htmlBody = "" }) {
    const ownerEmail = this.getOwnerAlertEmail();
    const aliasList = Array.isArray(toAliases) && toAliases.length > 0
      ? toAliases
      : ["info@oceancountyroofingpros.com"];
    const aliasLabel = aliasList.map((addr) => addr.split("@")[0]).join(", ");

    const emailMatch = String(from || "").match(/<([^>]+)>/);
    const senderAddress = (emailMatch ? emailMatch[1] : String(from || "")).trim();
    const isNoReply = /no[-_.]?reply|mailer-daemon|postmaster/i.test(senderAddress);
    const replyTo = senderAddress.includes("@") && !isNoReply ? senderAddress : this.getReplyToAddress();

    const escapedFrom = String(from || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const escapedAliases = aliasList.join(", ")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
    const escapedText = String(textBody || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>");

    const bannerHtml = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; background: #f1f5f9; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 13px; color: #334155;">
  <div><strong>To:</strong> ${escapedAliases}</div>
  <div><strong>From:</strong> ${escapedFrom}</div>
  <div><strong>Reply-To:</strong> ${replyTo}</div>
</div>`;

    const forwardedHtml = `${bannerHtml}${htmlBody || `<div style="font-family: sans-serif; font-size: 14px; color: #0f172a;">${escapedText}</div>`}`;
    const forwardedText = `To: ${aliasList.join(", ")}\nFrom: ${from}\nReply-To: ${replyTo}\n\n${textBody || ""}`;

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [ownerEmail],
      reply_to: replyTo,
      subject: `[To: ${aliasLabel}] ${subject || "Inbound Email"}`,
      html: forwardedHtml,
      text: forwardedText
    });
  }
}
