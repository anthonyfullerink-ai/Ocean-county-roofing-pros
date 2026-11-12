// ==============================================================================
// OCEAN COUNTY ROOFING PROS - AUTONOMOUS RANK-AND-RENT AI EMAIL AGENT
// ==============================================================================
import { EmailService } from "./email-service.mjs";

const OCEAN_COUNTY_TOWNS = [
  "Toms River",
  "Brick",
  "Lakewood",
  "Jackson",
  "Point Pleasant",
  "Manchester",
  "Lacey",
  "Forked River",
  "Barnegat",
  "Manahawkin",
  "Stafford",
  "Little Egg Harbor",
  "Beach Haven",
  "Seaside Heights",
  "Lavallette",
  "Howell",
  "Wall",
  "Freehold"
];

export class AIEmailAgent {
  /**
   * Main entry point for inbound emails via Resend webhook
   */
  static async processInboundEmail({ from, to, subject, textBody, htmlBody, messageId, emailId, headers }) {
    console.log(`[AIEmailAgent] Processing inbound email from: ${from} | Subject: ${subject}`);

    const senderEmail = this.extractEmailAddress(from);
    const headerName = this.extractName(from);

    // 1. Load custom rules & territory routing from Supabase system_settings
    const sysSettings = await this.loadSystemSettings();
    const customRules = sysSettings.email_agent_custom_rules || "";

    // 2. Match Existing Lead by Email (or prior thread)
    const existingLead = await this.lookupLeadByEmail(senderEmail);

    // 3. Resolve Contractor Partner (Hybrid Territory Routing -> Active Default Partner)
    const combinedText = `${subject || ""} ${textBody || ""} ${existingLead?.street_address || ""} ${existingLead?.city || ""}`;
    const tenant = await this.resolveTenantForText(combinedText, sysSettings.territory_routing_json);

    // 4. Analyze Email Content, Extract Entities, Classify Intent & Formulate Non-Canned Reply
    const analysis = await this.analyzeEmailWithAI({
      senderEmail,
      headerName,
      subject,
      textBody,
      tenant,
      existingLead,
      customRules
    });

    console.log(`[AIEmailAgent] Intent: ${analysis.intent} | Name: ${analysis.entities.name} | Phone: ${analysis.entities.phone} | Partner: ${tenant.company_name}`);

    // If Vendor / B2B Spam: log silently and abort outbound reply/alerts
    if (analysis.intent === "VENDOR_SPAM") {
      console.log(`[AIEmailAgent] Classified as VENDOR_SPAM from ${senderEmail}. Silencing alerts and auto-reply.`);
      return {
        status: "silenced_spam",
        intent: "VENDOR_SPAM",
        senderEmail
      };
    }

    // Re-check territory routing if AI extracted a specific street_address with a town name
    let finalTenant = tenant;
    if (analysis.entities?.street_address) {
      finalTenant = await this.resolveTenantForText(
        `${analysis.entities.street_address} ${combinedText}`,
        sysSettings.territory_routing_json,
        tenant
      );
    }

    // 5. Upsert Lead Record into Supabase (Tied to Assigned Contractor)
    const leadRecord = await this.upsertLeadRecord({
      existingLead,
      senderEmail,
      subject,
      textBody,
      analysis,
      tenant: finalTenant
    });

    // 6. If Appointment Booked or Rescheduled with Date/Address -> Trigger Calendar Sync & Branded Confirmation
    if (analysis.should_book_immediately && leadRecord) {
      await this.triggerCalendarWebhook(leadRecord, finalTenant);
      await EmailService.sendBookingConfirmation({
        lead_id: leadRecord.id,
        name: analysis.entities.name,
        phone: analysis.entities.phone,
        email: senderEmail,
        address: leadRecord.street_address || analysis.entities.street_address,
        date: analysis.entities.preferred_date || "Scheduled",
        time: analysis.entities.preferred_time || "Confirmed Window",
        service: leadRecord.service_requested || "Free 21-Point Drone & Thermal Roof Inspection",
        attic_access: "Attic access confirmed",
        ladder_needed: "Standard"
      });
    }

    // 7. Dispatch High-Converting Threaded Reply from Riley Davis
    let sendResult = null;
    if (analysis.reply_body) {
      sendResult = await EmailService.sendAgentReply(
        senderEmail,
        subject,
        analysis.reply_body,
        messageId,
        finalTenant
      );
    }

    // 8. Dual Alerting: Notify Platform Operator (Anthony) & Assigned Contractor (Tenant)
    if (analysis.should_alert_owner || analysis.should_alert_contractor) {
      await this.notifyOperatorAndContractor({
        leadId: leadRecord?.id || `EMAIL-${Date.now() % 1000000}`,
        senderName: analysis.entities.name,
        senderEmail,
        phone: analysis.entities.phone,
        address: analysis.entities.street_address,
        subject,
        textBody,
        intent: analysis.intent,
        escalationReason: analysis.escalation_reason,
        replyText: analysis.reply_body,
        tenant: finalTenant,
        alertOwner: analysis.should_alert_owner,
        alertContractor: analysis.should_alert_contractor
      });
    }

    return {
      status: "success",
      intent: analysis.intent,
      lead_id: leadRecord?.id,
      assigned_tenant: finalTenant.company_name,
      assigned_tenant_id: finalTenant.tenant_id,
      replySentTo: senderEmail,
      sendResult
    };
  }

  /**
   * Load system_settings key-values from Supabase
   */
  static async loadSystemSettings() {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) return {};
    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/system_settings?select=key,value`, {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`
        }
      });
      if (res.ok) {
        const rows = await res.json();
        const map = {};
        for (const r of rows) {
          map[r.key] = r.value;
        }
        return map;
      }
    } catch (e) {
      console.error("[AIEmailAgent] Error loading system_settings:", e);
    }
    return {};
  }

  /**
   * Resolve Contractor Tenant using Hybrid Territory Routing (Town Override -> Primary Active Partner)
   */
  static async resolveTenantForText(textToScan, territoryRoutingRaw = "", fallbackTenant = null) {
    const defaultActive = fallbackTenant || (await this.loadActiveTenant());
    if (!territoryRoutingRaw || !textToScan) return defaultActive;

    let routingMap = {};
    try {
      routingMap = typeof territoryRoutingRaw === "string" ? JSON.parse(territoryRoutingRaw) : territoryRoutingRaw;
    } catch (e) {
      return defaultActive;
    }

    if (!routingMap || Object.keys(routingMap).length === 0) return defaultActive;

    const lowerScan = textToScan.toLowerCase();
    let matchedTenantId = null;

    for (const [townKey, assignedTenantId] of Object.entries(routingMap)) {
      if (!assignedTenantId || assignedTenantId === "default") continue;
      const cleanTown = townKey
        .replace(/^roofing-/, "")
        .replace(/-nj$/, "")
        .replace(/-/g, " ")
        .toLowerCase()
        .trim();
      if (cleanTown && lowerScan.includes(cleanTown)) {
        matchedTenantId = assignedTenantId;
        break;
      }
    }

    if (!matchedTenantId || matchedTenantId === defaultActive.tenant_id) {
      return defaultActive;
    }

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (supabaseUrl && supabaseKey) {
      try {
        const res = await fetch(
          `${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants?tenant_id=eq.${encodeURIComponent(matchedTenantId)}&limit=1`,
          {
            headers: {
              "apikey": supabaseKey,
              "Authorization": `Bearer ${supabaseKey}`
            }
          }
        );
        if (res.ok) {
          const rows = await res.json();
          if (rows.length > 0) {
            return { ...defaultActive, ...rows[0] };
          }
        }
      } catch (e) {
        console.error("[AIEmailAgent] Error resolving territory tenant:", e);
      }
    }

    return {
      ...defaultActive,
      tenant_id: matchedTenantId,
      company_name: matchedTenantId
        .replace(/^client_/, "")
        .split("_")
        .map(w => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ")
    };
  }

  /**
   * Load the active Rank & Rent contractor tenant from Supabase
   */
  static async loadActiveTenant() {
    const defaultTenant = {
      tenant_id: "client_joe_the_roofer",
      company_name: "Joe The Roofer LLC",
      estimator_name: "Riley Davis",
      dispatch_phone: process.env.PRIMARY_PHONE || "+17326609121",
      email: "powurnj@gmail.com",
      scheduling_type: "google_calendar",
      booking_url: "",
      calendar_id: process.env.GOOGLE_CALENDAR_ID || ""
    };

    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey) return defaultTenant;

    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/tenants?is_active=eq.true&limit=1`, {
        headers: {
          "apikey": supabaseKey,
          "Authorization": `Bearer ${supabaseKey}`
        }
      });
      if (res.ok) {
        const tenants = await res.json();
        if (tenants.length > 0) {
          return { ...defaultTenant, ...tenants[0] };
        }
      }
    } catch (e) {
      console.error("[AIEmailAgent] Error loading active tenant:", e);
    }
    return defaultTenant;
  }

  /**
   * Intelligent AI Analysis (Uses Netlify AI Gateway / OpenAI / Gemini if active, with deep Entity Fallback)
   */
  static async analyzeEmailWithAI({ senderEmail, headerName, subject, textBody, tenant, existingLead, customRules = "" }) {
    const openaiKey = process.env.OPENAI_API_KEY;
    const openaiBaseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

    if (openaiKey) {
      try {
        const bookingLinkNote = tenant.booking_url
          ? `Direct Self-Booking Link: ${tenant.booking_url}`
          : `Standard Scheduling: Offer morning (9:00 AM - 12:00 PM) or afternoon (1:00 PM - 4:00 PM) inspection windows.`;

        const existingLeadContext = existingLead
          ? `EXISTING CUSTOMER THREAD FOUND IN CRM:
Lead ID: ${existingLead.id}
Name: ${existingLead.first_name} ${existingLead.last_name}
Phone: ${existingLead.phone}
Address: ${existingLead.street_address}
Status: ${existingLead.status}
Appointment Slot: ${existingLead.appointment_slot}
Prior Notes: ${existingLead.notes}`
          : `NEW COLD LEAD: No prior lead found for this email.`;

        const customBlock = customRules
          ? `\nCUSTOM OPERATOR INSTRUCTIONS FROM COMMAND CENTER:\n${customRules}\n`
          : "";

        const systemPrompt = `You are ${tenant.estimator_name || "Riley Davis"}, Lead Scheduling Coordinator for Ocean County Roofing Pros (operated by Offgrid Media, LLC, serving Ocean & Monmouth County, NJ).
Active Contractor Partner: ${tenant.company_name}. Direct Dispatch Phone: ${tenant.dispatch_phone}.
${bookingLinkNote}

${existingLeadContext}
${customBlock}
TASK: Analyze the incoming email and return ONLY valid JSON matching the exact schema below.

RULES:
1. Extract real customer name (prioritize name in email signature/body over corporate display headers like "Offgrid Media"), phone number, street address, and requested service.
2. NEVER provide blind dollar estimates over email. Explain that we offer a 100% Free 21-Point Drone & Thermal Roof Inspection (4K optical aerial scan + FLIR attic thermal imaging) to measure roof geometry and decking before giving an exact written proposal.
3. NEVER write a generic "we received your message and someone will follow up" boilerplate! Every reply must be personalized, address the sender by first name, reference any phone number or details they provided, and drive toward booking the free inspection.
4. For COLD_LEAD_ESTIMATE: Ask for their Ocean County street address (if not given), offer two specific arrival windows (Tomorrow morning 9AM-12PM or afternoon 1PM-4PM), acknowledge their phone number if provided so we can call them if easier, and include the booking link if available.
5. For THREADED_FOLLOWUP (when an existing lead replies with their address or confirms a time): Set "should_book_immediately": true, confirm the exact slot and address, and tell them what to expect on inspection day.
6. For VENDOR_SPAM (SEO pitches, software ads, B2B cold outreach): Set intent to "VENDOR_SPAM", "should_alert_owner": false, "should_alert_contractor": false, "reply_body": "".
7. For any real homeowner email (COLD_LEAD_ESTIMATE, THREADED_FOLLOWUP, RESCHEDULE, CANCELLATION, EMERGENCY_LEAK, GENERAL_QUESTION): Always set "should_alert_owner": true and "should_alert_contractor": true.
8. Do NOT include a sign-off signature block at the end of "reply_body" (the EmailService appends Riley's signature automatically).

JSON OUTPUT SCHEMA:
{
  "intent": "COLD_LEAD_ESTIMATE | THREADED_FOLLOWUP | RESCHEDULE | CANCELLATION | EMERGENCY_LEAK | VENDOR_SPAM | GENERAL_QUESTION",
  "entities": {
    "name": "string",
    "phone": "string",
    "street_address": "string",
    "service_requested": "string",
    "preferred_date": "string",
    "preferred_time": "string",
    "urgency": "Standard | Urgent | Emergency"
  },
  "should_book_immediately": boolean,
  "should_alert_owner": boolean,
  "should_alert_contractor": boolean,
  "escalation_reason": "string (1-sentence summary for the operator/contractor alert)",
  "reply_body": "string (the personalized plain-text email body without signature)"
}`;

        const userPrompt = `From Header: ${headerName} <${senderEmail}>
Subject: ${subject}
Body:
${textBody || "(Empty body)"}`;

        const res = await fetch(`${openaiBaseUrl.replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${openaiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            temperature: 0.3,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt }
            ]
          })
        });

        if (res.ok) {
          const completion = await res.json();
          const content = completion.choices?.[0]?.message?.content;
          if (content) {
            const parsed = JSON.parse(content);
            if (parsed.intent && parsed.entities) {
              console.log("[AIEmailAgent] Successfully processed via AI LLM Engine.");
              return parsed;
            }
          }
        } else {
          console.warn(`[AIEmailAgent] AI Gateway returned ${res.status}. Using intelligent deterministic fallback.`);
        }
      } catch (aiErr) {
        console.warn("[AIEmailAgent] AI Gateway exception, falling back to deterministic extractor:", aiErr.message);
      }
    }

    // High-Intelligence Deterministic Entity & Intent Fallback
    return this.deterministicAnalysis({ senderEmail, headerName, subject, textBody, tenant, existingLead, customRules });
  }

  /**
   * High-Intelligence Deterministic Extractor & Conversion Reply Generator
   * Guarantees zero dropped leads and non-canned responses even without external AI API keys.
   */
  static deterministicAnalysis({ senderEmail, headerName, subject, textBody, tenant, existingLead }) {
    const fullText = `${subject}\n${textBody}`.trim();
    const lowerText = fullText.toLowerCase();

    // 1. Extract Phone Number
    const phoneMatch = fullText.match(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/);
    const extractedPhone = phoneMatch ? phoneMatch[0].trim() : (existingLead?.phone || "");

    // 2. Extract Real Name (Prefer signature / body lines over generic header names)
    let extractedName = existingLead ? `${existingLead.first_name} ${existingLead.last_name}`.trim() : "";
    if (!extractedName) {
      const lines = (textBody || "").split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/^[A-Z][a-z]+\s+[A-Z][a-z]+$/.test(line) && !line.toLowerCase().includes("roof") && !line.toLowerCase().includes("media")) {
          extractedName = line;
          break;
        }
      }
      if (!extractedName && headerName && !headerName.toLowerCase().includes("offgrid")) {
        extractedName = headerName;
      }
      if (!extractedName) extractedName = headerName || "Homeowner";
    }
    const firstName = extractedName.split(" ")[0] || "there";

    // 3. Extract Address
    const addrMatch = fullText.match(/\b\d{1,5}\s+[A-Za-z0-9\s.,]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Parkway|Pkwy|Circle|Cir|Place|Pl)\b\.?(?:\s*,?\s*[A-Za-z\s]+)?/i);
    const extractedAddress = addrMatch ? addrMatch[0].trim() : (existingLead?.street_address || "");

    // 4. Extract Date & Time
    const dateMatch = fullText.match(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|today|next week|\d{1,2}\/\d{1,2})\b/i);
    const timeMatch = fullText.match(/\b(\d{1,2}(?::\d{2})?\s*(?:am|pm)|morning|afternoon)\b/i);
    const extractedDate = dateMatch ? dateMatch[0] : "";
    const extractedTime = timeMatch ? timeMatch[0] : "";

    // 5. Check Vendor / B2B Spam
    if (
      (lowerText.includes("seo") && lowerText.includes("ranking")) ||
      lowerText.includes("backlink") ||
      lowerText.includes("web design") ||
      lowerText.includes("unsubscribe") ||
      lowerText.includes("guest post") ||
      lowerText.includes("marketing agency")
    ) {
      return {
        intent: "VENDOR_SPAM",
        entities: { name: extractedName, phone: extractedPhone, street_address: "", service_requested: "Spam", preferred_date: "", preferred_time: "", urgency: "Standard" },
        should_book_immediately: false,
        should_alert_owner: false,
        should_alert_contractor: false,
        escalation_reason: "B2B Spam filtered",
        reply_body: ""
      };
    }

    // 6. Check Emergency Leak
    if (
      (lowerText.includes("leak") || lowerText.includes("water")) &&
      (lowerText.includes("emergency") || lowerText.includes("pouring") || lowerText.includes("ceiling") || lowerText.includes("dripping") || lowerText.includes("urgent"))
    ) {
      return {
        intent: "EMERGENCY_LEAK",
        entities: {
          name: extractedName,
          phone: extractedPhone,
          street_address: extractedAddress,
          service_requested: "Emergency Roof Leak Repair",
          preferred_date: "Today",
          preferred_time: "Priority Dispatch",
          urgency: "Emergency"
        },
        should_book_immediately: Boolean(extractedAddress),
        should_alert_owner: true,
        should_alert_contractor: true,
        escalation_reason: `🚨 URGENT LEAK INQUIRY from ${extractedName} (${extractedPhone || senderEmail})`,
        reply_body: `Hi ${firstName},\n\nI saw your message regarding an active roof leak and immediately escalated your request to our emergency dispatch manager with ${tenant.company_name}.\n\nIf water is actively coming into your living space right now, please place buckets to catch any drips and call our 24/7 Priority Dispatch line directly at (732) 660-9121 so our emergency tarping crew can get to you right away.${extractedAddress ? `\n\nWe have your property address flagged as ${extractedAddress}.` : `\n\nPlease reply immediately with your Ocean County street address and confirm if ${extractedPhone || "this phone number"} is the best number to reach you.`}`
      };
    }

    // 7. Check Cancellation
    if (lowerText.includes("cancel") && (lowerText.includes("appointment") || lowerText.includes("inspection") || lowerText.includes("don't come"))) {
      return {
        intent: "CANCELLATION",
        entities: { name: extractedName, phone: extractedPhone, street_address: extractedAddress, service_requested: "Cancellation", preferred_date: "", preferred_time: "", urgency: "Standard" },
        should_book_immediately: false,
        should_alert_owner: true,
        should_alert_contractor: true,
        escalation_reason: `Customer ${extractedName} requested inspection cancellation`,
        reply_body: `Hi ${firstName},\n\nI have processed your request to cancel your scheduled roof inspection and updated our dispatch route.\n\nIf you ever need a storm-damage check or a second opinion on your roof down the road, feel free to reply here or call us anytime at (732) 660-9121.`
      };
    }

    // 8. Check Reschedule
    if (lowerText.includes("reschedule") || lowerText.includes("change time") || lowerText.includes("different day") || lowerText.includes("move appointment")) {
      const targetDate = extractedDate || "your requested day";
      const targetTime = extractedTime || "your preferred window";
      return {
        intent: "RESCHEDULE",
        entities: {
          name: extractedName,
          phone: extractedPhone,
          street_address: extractedAddress,
          service_requested: existingLead?.service_requested || "Free 21-Point Drone Roof Inspection",
          preferred_date: targetDate,
          preferred_time: targetTime,
          urgency: "Standard"
        },
        should_book_immediately: Boolean(extractedDate || extractedTime),
        should_alert_owner: true,
        should_alert_contractor: true,
        escalation_reason: `Reschedule requested by ${extractedName} to ${targetDate} ${targetTime}`,
        reply_body: `Hi ${firstName},\n\nNo problem at all! I have updated our dispatch calendar to move your Free 21-Point Drone Roof Inspection to ${targetDate} (${targetTime}).${extractedAddress ? ` Our specialist will meet you at ${extractedAddress}.` : ""}\n\nPlease make sure the driveway is clear for safe drone takeoff and that attic access is available if needed. Call us at (732) 660-9121 if anything else changes!`
      };
    }

    // 9. Check Threaded Follow-Up (Existing Lead Providing Missing Address/Time)
    if (existingLead && (extractedAddress || extractedDate || extractedTime)) {
      const slotStr = `${extractedDate || "Upcoming"} ${extractedTime || "Arrival Window"}`.trim();
      const canBook = Boolean(extractedAddress && (extractedDate || extractedTime));
      return {
        intent: "THREADED_FOLLOWUP",
        entities: {
          name: extractedName,
          phone: extractedPhone,
          street_address: extractedAddress,
          service_requested: existingLead.service_requested || "Free 21-Point Drone Roof Inspection",
          preferred_date: extractedDate || "Pending",
          preferred_time: extractedTime || "Pending",
          urgency: "Standard"
        },
        should_book_immediately: canBook,
        should_alert_owner: true,
        should_alert_contractor: true,
        escalation_reason: `Follow-up from ${extractedName}: ${extractedAddress || ""} ${slotStr}`.trim(),
        reply_body: canBook
          ? `Hi ${firstName},\n\nPerfect — thank you for confirming! I have officially locked in your Free 21-Point Drone & Thermal Roof Inspection for ${slotStr} at ${extractedAddress}.\n\nOur certified roofing specialist will arrive with 4K optical and FLIR thermal drone equipment to evaluate your shingles, valleys, flashing, and attic decking, then walk you through the complete photo report on an iPad with an exact written estimate.\n\nI've also sent a formal appointment confirmation packet to your inbox. If you need anything before then, call us at (732) 660-9121!`
          : `Hi ${firstName},\n\nThanks for getting back to me! I've updated your file${extractedAddress ? ` with your property address (${extractedAddress})` : ""}.${!extractedAddress ? " Could you please reply with your Ocean County street address?" : ""}${!(extractedDate || extractedTime) ? " Would you prefer a morning window (9:00 AM - 12:00 PM) or an afternoon window (1:00 PM - 4:00 PM) tomorrow or Friday?" : ""}\n\nLet me know what works best and I will lock it right into our dispatch schedule!`
      };
    }

    // 10. Cold Lead Estimate / Roof Inspection Request (Default High-Conversion Funnel)
    const isEstimateOrQuote = lowerText.includes("estimate") || lowerText.includes("quote") || lowerText.includes("cost") || lowerText.includes("price") || lowerText.includes("roof") || lowerText.includes("replace") || lowerText.includes("inspect");

    const phoneAck = extractedPhone
      ? `\n\nI also noted your direct number as ${extractedPhone} — if you prefer, our scheduling desk can give you a quick 2-minute call to lock in your time, or you can simply reply here.`
      : `\n\nCould you also include the best phone number to reach you on?`;

    const bookingAction = tenant.booking_url
      ? `\n\nYou can lock in your preferred 15-minute arrival window directly on our live calendar here:\n👉 ${tenant.booking_url}\n\nOr reply directly to this email with:`
      : `\n\nTo get your inspection on the schedule, just hit reply with:`;

    const conversionReply = `Hi ${firstName},\n\nThanks for reaching out to Ocean County Roofing Pros about ${isEstimateOrQuote ? "getting an estimate on your roof" : "your roofing needs"}! We'd be glad to help.\n\nBecause every coastal home has different roof geometry, shingle wear, flashing integrity, and decking conditions, we start every estimate with our 100% Free 21-Point Drone & Thermal Roof Inspection. Our certified specialist uses 4K aerial cameras and FLIR thermal imaging to scan your entire roof and attic, then reviews the photos with you and gives you an exact, line-item written proposal with zero obligation.${bookingAction}\n1. Your Ocean County property street address${extractedAddress ? ` (I see ${extractedAddress} — let me know if that's correct)` : ""}\n2. Whether you prefer a Morning (9:00 AM - 12:00 PM) or Afternoon (1:00 PM - 4:00 PM) arrival window tomorrow or the next day${phoneAck}`;

    return {
      intent: "COLD_LEAD_ESTIMATE",
      entities: {
        name: extractedName,
        phone: extractedPhone,
        street_address: extractedAddress,
        service_requested: isEstimateOrQuote ? "Roof Estimate & 21-Point Inspection" : "Roofing Consultation",
        preferred_date: extractedDate,
        preferred_time: extractedTime,
        urgency: "Standard"
      },
      should_book_immediately: Boolean(extractedAddress && extractedDate && extractedTime),
      should_alert_owner: true,
      should_alert_contractor: true,
      escalation_reason: `New Cold Email Lead: ${extractedName}${extractedPhone ? ` (${extractedPhone})` : ""} asking about "${subject}"`,
      reply_body: conversionReply
    };
  }

  /**
   * Detect Ocean County town name from address or body text
   */
  static detectCityFromText(text) {
    if (!text) return "Ocean County";
    const lower = text.toLowerCase();
    for (const town of OCEAN_COUNTY_TOWNS) {
      if (lower.includes(town.toLowerCase())) {
        return town;
      }
    }
    return "Ocean County";
  }

  /**
   * Upsert Lead in Supabase CRM tied to Active Tenant
   */
  static async upsertLeadRecord({ existingLead, senderEmail, subject, textBody, analysis, tenant }) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    const leadId = existingLead?.id || `EMAIL-${Date.now() % 100000000}`;

    const entities = analysis.entities || {};
    const nameParts = (entities.name || "Homeowner").split(" ");
    const firstName = nameParts[0] || "Homeowner";
    const lastName = nameParts.slice(1).join(" ") || "";
    const nowIso = new Date().toISOString();

    const appointmentSlot = (entities.preferred_date || entities.preferred_time)
      ? `${entities.preferred_date || ""} ${entities.preferred_time || ""}`.trim()
      : (existingLead?.appointment_slot || "");

    let newStatus = existingLead?.status || "New Lead (Email)";
    if (analysis.should_book_immediately) newStatus = "Inspection Booked";
    else if (analysis.intent === "CANCELLATION") newStatus = "Inspection Cancelled";
    else if (analysis.intent === "RESCHEDULE") newStatus = "Inspection Rescheduled";
    else if (analysis.intent === "EMERGENCY_LEAK") newStatus = "Emergency Priority";

    const detectedCity = this.detectCityFromText(`${entities.street_address || ""} ${textBody || ""}`);
    const noteEntry = `[${nowIso.split("T")[0]} Email Inbound - ${analysis.intent}]: Subject: "${subject}" | Snippet: "${(textBody || "").slice(0, 140).replace(/\n/g, " ")}"`;

    if (!supabaseUrl || !supabaseKey) {
      return { id: leadId, first_name: firstName, last_name: lastName, street_address: entities.street_address, city: detectedCity, status: newStatus };
    }

    try {
      if (existingLead) {
        const patchPayload = {
          updated_at: nowIso,
          phone: entities.phone || existingLead.phone,
          street_address: entities.street_address || existingLead.street_address,
          city: detectedCity !== "Ocean County" ? detectedCity : (existingLead.city || "Ocean County"),
          appointment_slot: appointmentSlot,
          assigned_tenant_id: tenant.tenant_id || existingLead.assigned_tenant_id,
          status: newStatus,
          notes: `${existingLead.notes ? existingLead.notes + "\n" : ""}${noteEntry}`
        };
        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?id=eq.${existingLead.id}`, {
          method: "PATCH",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(patchPayload)
        });
        return { ...existingLead, ...patchPayload };
      } else {
        const insertPayload = {
          id: leadId,
          created_at: nowIso,
          updated_at: nowIso,
          lead_source: "Email Inbound",
          first_name: firstName,
          last_name: lastName,
          phone: entities.phone || "",
          email: senderEmail,
          street_address: entities.street_address || "",
          city: detectedCity,
          state: "NJ",
          service_requested: entities.service_requested || "Roof Inspection & Estimate",
          urgency: entities.urgency || "Standard",
          status: newStatus,
          appointment_slot: appointmentSlot,
          assigned_tenant_id: tenant.tenant_id,
          estimated_value: 12500.00,
          notes: noteEntry
        };
        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify(insertPayload)
        });
        return insertPayload;
      }
    } catch (e) {
      console.error("[AIEmailAgent] Supabase upsert error:", e);
      return null;
    }
  }

  /**
   * Trigger Google Calendar Sync when email conversation locks in a slot
   */
  static async triggerCalendarWebhook(lead, tenant) {
    const gcalWebhookUrl = process.env.GOOGLE_CALENDAR_WEBHOOK_URL;
    if (!gcalWebhookUrl) return;
    try {
      await fetch(gcalWebhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          calendar_id: tenant.calendar_id || process.env.GOOGLE_CALENDAR_ID,
          customer_name: `${lead.first_name} ${lead.last_name}`.trim(),
          phone: lead.phone,
          customer_email: lead.email,
          address: lead.street_address,
          service: lead.service_requested,
          start: lead.appointment_slot
        })
      });
    } catch (e) {
      console.error("[AIEmailAgent] Calendar sync error:", e);
    }
  }

  /**
   * Dual Alerting: Notify Operator (SMS + Email) & Active Contractor (Email)
   */
  static async notifyOperatorAndContractor({
    leadId, senderName, senderEmail, phone, address, subject, textBody, intent, escalationReason, replyText, tenant, alertOwner, alertContractor
  }) {
    const ownerEmail = process.env.OWNER_ALERT_EMAIL || "anthony.fuller.ink@gmail.com";
    const ownerPhone = process.env.OWNER_ALERT_PHONE || "+17325523896";
    const twilioSid = process.env.TWILIO_ACCOUNT_SID;
    const twilioToken = process.env.TWILIO_AUTH_TOKEN;
    const twilioPhone = process.env.TWILIO_PHONE_NUMBER || process.env.PRIMARY_PHONE || "+17326609121";

    // 1. Operator Instant SMS Alert via Twilio
    if (alertOwner && twilioSid && twilioToken && ownerPhone) {
      try {
        const smsMsg = `🚨 [${intent}] ${senderName} | ${phone || senderEmail}${address ? ` | ${address}` : ""} | "${subject}" -> Assigned: ${tenant.company_name}. Riley auto-replied.`;
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
        console.log(`[AIEmailAgent] Operator SMS dispatched to ${ownerPhone}`);
      } catch (err) {
        console.error("[AIEmailAgent] Operator SMS dispatch error:", err);
      }
    }

    // 2. Construct Rich Operator & Contractor Email Notification
    const alertRecipients = new Set();
    if (alertOwner && ownerEmail) alertRecipients.add(ownerEmail);
    if (alertContractor && tenant.email && tenant.email.includes("@")) alertRecipients.add(tenant.email);

    if (alertRecipients.size === 0) return;

    const alertHtml = `
      <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, monospace; background: #0f172a; color: #f8fafc; padding: 24px; border-radius: 12px; max-width: 650px; margin: 0 auto;">
        <h2 style="color: #38bdf8; margin-top: 0;">🚨 INBOUND EMAIL LEAD CAPTURED (${intent})</h2>
        <div style="background: #1e293b; padding: 16px; border-radius: 8px; margin-bottom: 16px;">
          <p style="margin: 4px 0;"><strong>Lead ID:</strong> ${leadId}</p>
          <p style="margin: 4px 0;"><strong>Assigned Contractor:</strong> ${tenant.company_name}</p>
          <p style="margin: 4px 0;"><strong>Homeowner:</strong> ${senderName} &lt;${senderEmail}&gt;</p>
          <p style="margin: 4px 0;"><strong>Phone:</strong> <a href="tel:${phone}" style="color: #38bdf8;">${phone || "Not extracted yet"}</a></p>
          <p style="margin: 4px 0;"><strong>Address:</strong> ${address || "Requested by Riley"}</p>
          <p style="margin: 4px 0;"><strong>Subject:</strong> ${subject}</p>
        </div>
        <p style="color: #94a3b8; font-weight: bold; margin-bottom: 6px;">Incoming Homeowner Email:</p>
        <blockquote style="background: #1e293b; padding: 14px; border-left: 4px solid #38bdf8; margin: 0 0 16px;">${(textBody || "(Empty body)").replace(/\n/g, "<br>")}</blockquote>
        <p style="color: #10b981; font-weight: bold; margin-bottom: 6px;">Riley's Autonomous Conversion Response Sent:</p>
        <blockquote style="background: #1e293b; padding: 14px; border-left: 4px solid #10b981; margin: 0;">${(replyText || "").replace(/\n/g, "<br>")}</blockquote>
      </div>
    `;

    for (const recipient of alertRecipients) {
      await EmailService.sendEmail({
        from: EmailService.getFromAddress(),
        to: [recipient],
        reply_to: senderEmail,
        subject: `🚨 [${intent}] ${senderName} - ${subject} (${tenant.company_name})`,
        html: alertHtml
      });
    }
  }

  /**
   * Lookup existing lead by email address in Supabase
   */
  static async lookupLeadByEmail(email) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;
    if (!supabaseUrl || !supabaseKey || !email) return null;

    try {
      const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/leads?email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=1`, {
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

  static extractEmailAddress(raw) {
    if (!raw) return "";
    const match = raw.match(/<([^>]+)>/);
    return match ? match[1].trim() : raw.trim();
  }

  static extractName(raw) {
    if (!raw) return "";
    if (raw.includes("<")) {
      return raw.split("<")[0].replace(/"/g, "").trim();
    }
    return "";
  }
}
