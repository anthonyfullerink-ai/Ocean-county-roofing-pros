// ==============================================================================
// OCEAN COUNTY ROOFING PROS - RESEND TRANSACTIONAL EMAIL SERVICE
// ==============================================================================

const RESEND_API_URL = "https://api.resend.com/emails";

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
    const service = lead.service || "Free 21-Point Drone & Thermal Roof Inspection";
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
        Your <strong>${service}</strong> has been confirmed on our dispatch calendar. Our certified roofing specialist will arrive during your scheduled window with high-definition 4K optical and FLIR thermal drone equipment.
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
        <div class="prep-item">✓ <strong>Drone Perimeter:</strong> Please keep driveways and front yards clear of parked vehicles for safe drone launch.</div>
        <div class="prep-item">✓ <strong>Attic Access:</strong> Please ensure hallways or closets leading to the attic hatch are accessible for thermal scans.</div>
        <div class="prep-item">✓ <strong>All Decision-Makers:</strong> Please ensure all homeowners are present so our specialist can walk through the high-resolution photo scan with you on an iPad.</div>
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

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [toEmail],
      reply_to: this.getReplyToAddress(),
      subject: `Confirmed: Free 21-Point Roof Inspection for ${address} (${date})`,
      html: htmlContent
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
    const attic = lead.attic_access || "Yes";
    const ladder = lead.ladder_needed || "Standard";
    const decisionMakers = lead.decision_makers_present || "Yes";
    const source = lead.source || "Voice AI (Riley / Sarah)";

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
    <div class="item highlight">Confirmed: ${date} at ${time}</div>
    <hr style="border: 0; border-top: 1px solid #334155; margin: 16px 0;">
    <div class="item"><span class="label">Homeowner:</span> <span class="val">${name}</span></div>
    <div class="item"><span class="label">Phone:</span> <span class="val"><a href="tel:${phone}" style="color: #38bdf8;">${phone}</a></span></div>
    <div class="item"><span class="label">Email:</span> <span class="val">${email}</span></div>
    <div class="item"><span class="label">Address:</span> <span class="val">${address}</span></div>
    <div class="item"><span class="label">Roof Scope / Symptoms:</span> <span class="val">${scope}</span></div>
    <div class="item"><span class="label">Attic Access:</span> <span class="val">${attic} (${ladder})</span></div>
    <div class="item"><span class="label">Both Decision-Makers:</span> <span class="val">${decisionMakers}</span></div>
  </div>
</body>
</html>
    `;

    return await this.sendEmail({
      from: this.getFromAddress(),
      to: [ownerEmail],
      reply_to: email.includes("@") ? email : this.getReplyToAddress(),
      subject: `🚨 [New Lead] ${name} - ${address} (${date} @ ${time})`,
      html: htmlContent
    });
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

    const htmlBody = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 15px; color: #1e293b; line-height: 1.6;">
  ${textBody.replace(/\n/g, "<br>")}
  <br><br>
  --<br>
  <strong>${estimator}</strong><br>
  Lead Scheduling Coordinator | Ocean County Roofing Pros<br>
  Direct Dispatch: ${dispatchPhone}<br>
  Website: <a href="https://oceancountyroofingpros.com">https://oceancountyroofingpros.com</a><br>
  <span style="color: #64748b; font-size: 12px;">Ocean County Roofing Pros is operated by Offgrid Media, LLC</span>
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
}
