/**
 * Elena — Executive Chief of Staff ("HNIC") Service
 * Two-way natural email assistant, Riley alert buffer, executive briefings,
 * COO process insights, and safe live action executor.
 */
import { GoogleGenAI } from "@google/genai";
import { EmailService } from "./email-service.mjs";

const DEFAULT_CHIEF_NAME = "Elena";
const DEFAULT_CHIEF_EMAIL = "elena@oceancountyroofingpros.com";

const ALLOWED_SETTINGS_KEYS = new Set([
  "storm_alert_active",
  "storm_alert_headline",
  "chief_buffer_mode",
  "chief_briefing_enabled",
  "auto_publish_24h",
  "enable_review_sms",
  "enable_vapi_callback"
]);

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildSupabaseHeaders(supabaseKey) {
  return {
    "apikey": supabaseKey,
    "Authorization": `Bearer ${supabaseKey}`,
    "Content-Type": "application/json"
  };
}

function stripQuotedReply(text = "") {
  const lines = String(text || "").split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    if (/^On .+ wrote:$/i.test(line.trim())) break;
    if (line.trim().startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim() || String(text || "").trim();
}

function renderElenaEmailHtml({ headline, badge = "Chief of Staff", bodyText, actionsTaken = [] }) {
  const safeBody = escapeHtml(bodyText).replace(/\n/g, "<br>");
  const actionsHtml = Array.isArray(actionsTaken) && actionsTaken.length > 0
    ? `<div style="margin-top:18px;padding:12px 14px;background:#f0fdfa;border:1px solid #99f6e4;border-radius:10px;font-size:13px;color:#115e59;">
        <strong>Actions Completed:</strong>
        <ul style="margin:6px 0 0 18px;padding:0;">
          ${actionsTaken.map(a => `<li><strong>${escapeHtml(a.type)}</strong> (${escapeHtml(a.status)}): ${escapeHtml(a.detail || "")}</li>`).join("")}
        </ul>
      </div>`
    : "";

  return `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:640px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;">
      <div style="background:#0A486D;color:#ffffff;padding:20px 24px;">
        <div style="font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#5eead4;">Elena • ${escapeHtml(badge)}</div>
        <h2 style="margin:4px 0 0;font-size:18px;line-height:1.3;">${escapeHtml(headline)}</h2>
      </div>
      <div style="padding:22px 24px;color:#1e293b;font-size:14px;line-height:1.65;">
        ${safeBody}
        ${actionsHtml}
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:20px 0 14px;">
        <p style="margin:0;font-size:12px;color:#64748b;">
          Simply reply to this email anytime with instructions (e.g. <em>"approve SEO experiment..."</em>, <em>"publish pending blog"</em>, <em>"have Riley call [Name] at [Phone]"</em>, or <em>"turn storm banner on"</em>).
        </p>
      </div>
    </div>
  `;
}

export class ChiefOfStaffService {
  static getChiefIdentity(sys = {}) {
    const name = (sys.chief_name || process.env.CHIEF_OF_STAFF_NAME || DEFAULT_CHIEF_NAME).trim() || DEFAULT_CHIEF_NAME;
    const email = (sys.chief_email || process.env.CHIEF_OF_STAFF_EMAIL || DEFAULT_CHIEF_EMAIL).trim() || DEFAULT_CHIEF_EMAIL;
    const tone = (sys.chief_tone || "balanced").trim();
    return {
      name,
      email,
      fromHeader: `${name} — Chief of Staff <${email}>`,
      tone
    };
  }

  static isChiefRecipient(toAddresses = [], subject = "", sys = {}) {
    const targetEmail = (sys.chief_email || process.env.CHIEF_OF_STAFF_EMAIL || DEFAULT_CHIEF_EMAIL).trim().toLowerCase();
    const list = Array.isArray(toAddresses) ? toAddresses : [toAddresses];
    const matchedRecipient = list.some((raw) => {
      const addr = String(raw || "").trim().toLowerCase();
      if (!addr) return false;
      return (
        addr === targetEmail ||
        addr.startsWith("elena@") ||
        addr.startsWith("chief@") ||
        addr.startsWith("assistant@")
      );
    });
    if (matchedRecipient) return true;
    const subj = String(subject || "");
    return /\[(elena|chief of staff|cos)\b/i.test(subj);
  }

  static async collectBusinessSnapshot({ supabaseUrl = "", supabaseKey = "" } = {}) {
    const url = (supabaseUrl || process.env.SUPABASE_URL || "").replace(/\/$/, "");
    const key = supabaseKey || process.env.SUPABASE_KEY || "";

    const emptySnapshot = {
      configured: Boolean(url && key),
      sys: {},
      leads24hCount: 0,
      leads7dCount: 0,
      bookedCount: 0,
      pipelineValue: 0,
      recentLeads: [],
      undigestedBuffer: [],
      recentMessages: [],
      seoSnapshots: [],
      pendingSeoExperiments: [],
      draftBlogPosts: [],
      scheduledSocialPosts: [],
      visitors7d: 0,
      pageviews7d: 0,
      gscConfigured: Boolean((process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GSC_SERVICE_ACCOUNT_JSON || "").trim()),
      aiGatewayActive: Boolean((process.env.GOOGLE_GEMINI_BASE_URL || "").trim()),
      geminiConfigured: Boolean((process.env.GOOGLE_GEMINI_BASE_URL || process.env.GEMINI_API_KEY || "").trim())
    };

    if (!url || !key) return emptySnapshot;
    const headers = buildSupabaseHeaders(key);

    const safeGet = async (path) => {
      try {
        const r = await fetch(`${url}/rest/v1/${path}`, { headers });
        if (!r || !r.ok) return [];
        const data = await r.json().catch(() => []);
        return Array.isArray(data) ? data : [];
      } catch {
        return [];
      }
    };

    const [
      sysRows,
      leads,
      undigestedBuffer,
      recentMessages,
      seoSnapshots,
      seoExperiments,
      blogPosts,
      socialQueue,
      analyticsEvents
    ] = await Promise.all([
      safeGet("system_settings?select=key,value"),
      safeGet("leads?order=created_at.desc&limit=50"),
      safeGet("executive_buffer?digested_at=is.null&order=created_at.desc&limit=50"),
      safeGet("executive_messages?order=created_at.desc&limit=10"),
      safeGet("seo_ranking_snapshots?order=snapshot_date.desc,impressions.desc&limit=10"),
      safeGet("seo_experiments?order=created_at.desc&limit=15"),
      safeGet("blog_posts?order=created_at.desc&limit=15"),
      safeGet("social_queue?order=created_at.desc&limit=15"),
      safeGet("site_analytics_events?order=created_at.desc&limit=200")
    ]);

    const sys = {};
    for (const row of sysRows) sys[row.key] = row.value;

    const nowMs = Date.now();
    const cut24h = nowMs - 24 * 60 * 60 * 1000;
    const cut7d = nowMs - 7 * 24 * 60 * 60 * 1000;

    let leads24hCount = 0;
    let leads7dCount = 0;
    let bookedCount = 0;
    let pipelineValue = 0;
    const bookedStatuses = new Set(["Inspection Booked", "Booked", "Inspected", "Job Won", "Completed"]);

    for (const l of leads) {
      const ts = new Date(l.created_at || 0).getTime();
      if (ts >= cut24h) leads24hCount++;
      if (ts >= cut7d) leads7dCount++;
      if (bookedStatuses.has(l.status)) bookedCount++;
      if (l.status !== "Lost" && l.status !== "Inspection Cancelled") {
        pipelineValue += Number(l.estimated_value || 12500);
      }
    }

    const visitorIds7d = new Set();
    let pageviews7d = 0;
    for (const ev of analyticsEvents) {
      const ts = new Date(ev.created_at || 0).getTime();
      if (ts >= cut7d) {
        if (ev.event_name === "page_view") pageviews7d++;
        if (ev.visitor_id) visitorIds7d.add(ev.visitor_id);
      }
    }

    return {
      ...emptySnapshot,
      sys,
      leads24hCount,
      leads7dCount,
      bookedCount,
      pipelineValue,
      recentLeads: leads.slice(0, 10),
      undigestedBuffer,
      recentMessages,
      seoSnapshots,
      pendingSeoExperiments: seoExperiments.filter(e => e.status === "pending_24h"),
      draftBlogPosts: blogPosts.filter(b => b.status === "draft_auto_24h"),
      scheduledSocialPosts: socialQueue.filter(s => s.status === "scheduled"),
      visitors7d: visitorIds7d.size,
      pageviews7d
    };
  }

  static parseStructuredResponse(rawText = "") {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) return { subject: "", reply_text: "", actions: [] };

    const stripped = trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/```$/i, "")
      .trim();

    try {
      const parsed = JSON.parse(stripped);
      if (parsed && typeof parsed === "object" && typeof parsed.reply_text === "string") {
        return {
          subject: String(parsed.subject || "").trim(),
          reply_text: parsed.reply_text.trim(),
          actions: Array.isArray(parsed.actions) ? parsed.actions : []
        };
      }
    } catch {
      // Fallback to plain text reply
    }

    return {
      subject: "",
      reply_text: trimmed,
      actions: []
    };
  }

  static async callGeminiBrain({ systemInstruction, userPrompt, apiKey = "", model = "" }) {
    const gatewayBaseUrl = (process.env.GOOGLE_GEMINI_BASE_URL || "").trim();
    const explicitKey = (apiKey || process.env.GEMINI_API_KEY || "").trim();

    // Path A: Netlify AI Gateway (official @google/genai zero-arg SDK using injected credentials)
    if (!apiKey && gatewayBaseUrl) {
      const candidateModels = [...new Set([
        (model || process.env.ELENA_GEMINI_MODEL || "gemini-2.5-flash").trim(),
        "gemini-2.5-pro",
        "gemini-2.0-flash"
      ].filter(Boolean))];

      const genAI = new GoogleGenAI({});
      let lastGatewayReason = "gateway_request_failed";
      for (const candidateModel of candidateModels) {
        try {
          const result = await genAI.models.generateContent({
            model: candidateModel,
            contents: `${systemInstruction}\n\n${userPrompt}`,
            config: { temperature: 0.4 }
          });
          const text = (
            result?.text ||
            result?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n") ||
            ""
          ).trim();
          if (!text) {
            lastGatewayReason = `empty_candidate_text:${candidateModel}`;
            continue;
          }
          const parsed = this.parseStructuredResponse(text);
          return { ok: true, model: candidateModel, provider: "netlify_ai_gateway", ...parsed };
        } catch (err) {
          lastGatewayReason = `${candidateModel}:${err?.message || String(err)}`;
        }
      }
      return { ok: false, reason: lastGatewayReason };
    }

    // Path B: Explicit GEMINI_API_KEY fallback (AI Studio / Vertex Express)
    const key = explicitKey;
    if (!key) {
      return { ok: false, reason: "missing_gemini_api_key" };
    }

    const endpoints = [
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      `https://aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(key)}`
    ];

    const payload = {
      contents: [
        {
          role: "user",
          parts: [{ text: `${systemInstruction}\n\n${userPrompt}` }]
        }
      ],
      generationConfig: {
        temperature: 0.4
      }
    };

    let lastReason = "gemini_request_failed";
    for (const endpoint of endpoints) {
      try {
        const res = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        if (!res.ok) {
          const errData = await res.json().catch(() => ({}));
          lastReason = `http_${res.status}:${errData?.error?.message || "request_rejected"}`;
          continue;
        }
        const data = await res.json().catch(() => ({}));
        const text = data?.candidates?.[0]?.content?.parts?.map(p => p.text || "").join("\n").trim() || "";
        if (!text) {
          lastReason = "empty_candidate_text";
          continue;
        }
        const parsed = this.parseStructuredResponse(text);
        return { ok: true, ...parsed };
      } catch (err) {
        lastReason = `network_error:${err?.message || "unknown"}`;
      }
    }

    return { ok: false, reason: lastReason };
  }

  static parseDeterministicActions(userText = "", snapshot = {}) {
    const clean = String(userText || "").trim();
    const actions = [];

    const seoApproveMatch = clean.match(/approve\s+seo(?:\s+experiment)?\s+([A-Za-z0-9_-]+)/i);
    if (seoApproveMatch) {
      actions.push({ type: "approve_seo_experiment", experiment_id: seoApproveMatch[1] });
    } else if (/approve\s+seo\b/i.test(clean) && snapshot.pendingSeoExperiments?.length > 0) {
      actions.push({ type: "approve_seo_experiment", experiment_id: snapshot.pendingSeoExperiments[0].id });
    }

    const seoRejectMatch = clean.match(/(?:reject|dismiss)\s+seo(?:\s+experiment)?\s+([A-Za-z0-9_-]+)/i);
    if (seoRejectMatch) {
      actions.push({ type: "reject_seo_experiment", experiment_id: seoRejectMatch[1] });
    }

    const blogMatch = clean.match(/publish\s+blog(?:\s+draft|\s+post)?\s+([A-Za-z0-9_-]+)/i);
    if (blogMatch) {
      actions.push({ type: "publish_blog_draft", post_id: blogMatch[1] });
    } else if (/publish\s+(?:pending\s+)?blog/i.test(clean) && snapshot.draftBlogPosts?.length > 0) {
      actions.push({ type: "publish_blog_draft", post_id: snapshot.draftBlogPosts[0].id });
    }

    if (/storm\s+(?:banner|alert)\s+(?:on|enable)/i.test(clean)) {
      actions.push({ type: "update_system_setting", key: "storm_alert_active", value: "true" });
    } else if (/storm\s+(?:banner|alert)\s+(?:off|disable)/i.test(clean)) {
      actions.push({ type: "update_system_setting", key: "storm_alert_active", value: "false" });
    }

    if (/buffer\s+(?:on|enable)/i.test(clean)) {
      actions.push({ type: "update_system_setting", key: "chief_buffer_mode", value: "true" });
    } else if (/buffer\s+(?:off|disable)/i.test(clean)) {
      actions.push({ type: "update_system_setting", key: "chief_buffer_mode", value: "false" });
    }

    return actions;
  }

  static async executeSafeActions({ actions = [], supabaseUrl = "", supabaseKey = "" } = {}) {
    const url = (supabaseUrl || process.env.SUPABASE_URL || "").replace(/\/$/, "");
    const key = supabaseKey || process.env.SUPABASE_KEY || "";
    const headers = buildSupabaseHeaders(key);
    const nowIso = new Date().toISOString();
    const outcomes = [];

    for (const act of Array.isArray(actions) ? actions : []) {
      const type = String(act?.type || "").trim();
      if (!type) continue;

      try {
        if (type === "update_lead_status" && act.lead_id) {
          if (!url || !key) {
            outcomes.push({ type, status: "skipped", detail: "Supabase not configured" });
            continue;
          }
          const patch = { updated_at: nowIso };
          if (act.status) patch.status = String(act.status);
          if (act.note) patch.notes = String(act.note);
          const r = await fetch(`${url}/rest/v1/leads?id=eq.${encodeURIComponent(act.lead_id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify(patch)
          });
          outcomes.push({
            type,
            status: r.ok ? "executed" : "error",
            detail: `Lead ${act.lead_id} updated (${act.status || "note"})`
          });
        } else if ((type === "approve_seo_experiment" || type === "reject_seo_experiment") && act.experiment_id) {
          if (!url || !key) {
            outcomes.push({ type, status: "skipped", detail: "Supabase not configured" });
            continue;
          }
          const approve = type === "approve_seo_experiment";
          const patch = approve
            ? { status: "active", activated_at: nowIso, updated_at: nowIso }
            : { status: "rejected", evaluated_at: nowIso, updated_at: nowIso };
          const r = await fetch(`${url}/rest/v1/seo_experiments?id=eq.${encodeURIComponent(act.experiment_id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify(patch)
          });
          outcomes.push({
            type,
            status: r.ok ? "executed" : "error",
            detail: `SEO experiment ${act.experiment_id} -> ${patch.status}`
          });
        } else if (type === "publish_blog_draft" && act.post_id) {
          if (!url || !key) {
            outcomes.push({ type, status: "skipped", detail: "Supabase not configured" });
            continue;
          }
          const r = await fetch(`${url}/rest/v1/blog_posts?id=eq.${encodeURIComponent(act.post_id)}`, {
            method: "PATCH",
            headers,
            body: JSON.stringify({ status: "published", published_at: nowIso, updated_at: nowIso })
          });
          outcomes.push({
            type,
            status: r.ok ? "executed" : "error",
            detail: `Blog post ${act.post_id} published`
          });
        } else if (type === "queue_social_post" && act.caption) {
          if (!url || !key) {
            outcomes.push({ type, status: "skipped", detail: "Supabase not configured" });
            continue;
          }
          const sqId = `SQ-${Date.now() % 100000000}`;
          const r = await fetch(`${url}/rest/v1/social_queue`, {
            method: "POST",
            headers: { ...headers, Prefer: "return=minimal" },
            body: JSON.stringify({
              id: sqId,
              created_at: nowIso,
              updated_at: nowIso,
              caption: String(act.caption).trim(),
              town_name: String(act.town_name || "Ocean County").trim(),
              status: "scheduled",
              scheduled_for: nowIso,
              created_by: "elena_chief_of_staff"
            })
          });
          outcomes.push({
            type,
            status: r.ok ? "executed" : "error",
            detail: `Queued social post ${sqId}`
          });
        } else if (type === "update_system_setting" && act.key && ALLOWED_SETTINGS_KEYS.has(String(act.key))) {
          if (!url || !key) {
            outcomes.push({ type, status: "skipped", detail: "Supabase not configured" });
            continue;
          }
          const r = await fetch(`${url}/rest/v1/system_settings?on_conflict=key`, {
            method: "POST",
            headers: { ...headers, Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify({ key: String(act.key), value: String(act.value ?? ""), updated_at: nowIso })
          });
          outcomes.push({
            type,
            status: r.ok ? "executed" : "error",
            detail: `Set ${act.key} = ${act.value}`
          });
        } else if (type === "trigger_riley_callback" && act.phone) {
          const vapiKey = (process.env.VAPI_API_KEY || "").trim();
          const phoneNumberId = (process.env.VAPI_PHONE_NUMBER_ID || "").trim();
          const assistantId = (process.env.VAPI_OUTBOUND_ASSISTANT_ID || "").trim();
          if (!vapiKey || !phoneNumberId || !assistantId) {
            outcomes.push({ type, status: "skipped", detail: "Vapi outbound credentials missing" });
            continue;
          }
          const r = await fetch("https://api.vapi.ai/call/phone", {
            method: "POST",
            headers: { "Authorization": `Bearer ${vapiKey}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              phoneNumberId,
              assistantId,
              customer: { number: String(act.phone).trim(), name: String(act.name || "Homeowner").trim() }
            })
          });
          outcomes.push({
            type,
            status: r.ok ? "executed" : "error",
            detail: `Riley outbound call to ${act.phone}`
          });
        } else {
          outcomes.push({ type, status: "ignored", detail: "Unsupported or incomplete action payload" });
        }
      } catch (err) {
        outcomes.push({ type, status: "error", detail: err?.message || "Action failed" });
      }
    }
    return outcomes;
  }

  static async logExecutiveMessage({
    direction = "outbound",
    threadKey = "default",
    fromEmail = "",
    toEmail = "",
    subject = "",
    bodyText = "",
    actionsTaken = [],
    messageId = "",
    supabaseUrl = "",
    supabaseKey = ""
  }) {
    const url = (supabaseUrl || process.env.SUPABASE_URL || "").replace(/\/$/, "");
    const key = supabaseKey || process.env.SUPABASE_KEY || "";
    if (!url || !key) return null;

    const id = `ELN-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const row = {
      id,
      created_at: new Date().toISOString(),
      thread_key: threadKey || "default",
      direction,
      from_email: fromEmail,
      to_email: toEmail,
      subject,
      body_text: bodyText,
      actions_json: JSON.stringify(actionsTaken || []),
      message_id: messageId || ""
    };

    try {
      await fetch(`${url}/rest/v1/executive_messages`, {
        method: "POST",
        headers: { ...buildSupabaseHeaders(key), Prefer: "return=minimal" },
        body: JSON.stringify(row)
      });
    } catch {}
    return row;
  }

  static async recordBufferEvent({
    source = "riley",
    severity = "routine",
    title = "",
    summary = "",
    payload = {},
    digestedAt = null,
    supabaseUrl = "",
    supabaseKey = ""
  }) {
    const url = (supabaseUrl || process.env.SUPABASE_URL || "").replace(/\/$/, "");
    const key = supabaseKey || process.env.SUPABASE_KEY || "";
    if (!url || !key) return { status: "skipped", reason: "supabase_unconfigured" };

    const id = `BUF-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`.toUpperCase();
    const row = {
      id,
      created_at: new Date().toISOString(),
      source,
      severity,
      title: title || `${source} update`,
      summary,
      payload_json: JSON.stringify(payload || {}),
      digested_at: digestedAt
    };

    try {
      const r = await fetch(`${url}/rest/v1/executive_buffer`, {
        method: "POST",
        headers: { ...buildSupabaseHeaders(key), Prefer: "return=minimal" },
        body: JSON.stringify(row)
      });
      return { status: r.ok ? "buffered" : "error", id };
    } catch (err) {
      return { status: "error", reason: err?.message || "buffer_write_failed" };
    }
  }

  static async sendP0Escalation({
    source = "riley",
    title = "Urgent Roof Escalation",
    summary = "",
    recommendedAction = "Assign or call immediately.",
    payload = {},
    supabaseUrl = "",
    supabaseKey = ""
  }) {
    const nowIso = new Date().toISOString();
    await this.recordBufferEvent({
      source,
      severity: "p0_sent",
      title,
      summary,
      payload,
      digestedAt: nowIso,
      supabaseUrl,
      supabaseKey
    });

    const snapshot = await this.collectBusinessSnapshot({ supabaseUrl, supabaseKey });
    const identity = this.getChiefIdentity(snapshot.sys);
    const ownerEmail = EmailService.getOwnerAlertEmail();
    const subject = `🚨 [Elena • P0 Alert] ${title}`;
    const bodyText = [
      "Anthony,",
      "",
      `I broke through the buffer because this needs your eyes right away (${source}):`,
      "",
      summary,
      "",
      `Recommended next step: ${recommendedAction}`,
      "",
      `— ${identity.name}`
    ].join("\n");

    const emailRes = await EmailService.sendEmail({
      from: identity.fromHeader,
      to: [ownerEmail],
      reply_to: identity.email,
      subject,
      html: renderElenaEmailHtml({ headline: subject, badge: "Immediate P0 Breakthrough", bodyText }),
      text: bodyText
    });

    await this.logExecutiveMessage({
      direction: "outbound",
      threadKey: "p0_alert",
      fromEmail: identity.email,
      toEmail: ownerEmail,
      subject,
      bodyText,
      supabaseUrl,
      supabaseKey
    });

    return { status: "sent", emailRes };
  }

  static buildDeterministicReply({ userText, snapshot, actionsTaken }) {
    const parts = [
      "Hey Anthony — here is where things stand right now:",
      "",
      `• Pipeline: ${snapshot.leads24hCount} new leads (24h), ${snapshot.leads7dCount} in the last 7d, ${snapshot.bookedCount} booked inspections (~$${Math.round(snapshot.pipelineValue).toLocaleString()} est. pipeline).`,
      `• Traffic & SEO: ${snapshot.visitors7d} visitors / ${snapshot.pageviews7d} views (7d), ${snapshot.seoSnapshots.length} recent GSC query rows, ${snapshot.pendingSeoExperiments.length} SEO experiment(s) waiting.`,
      `• Riley & Ops Buffer: ${snapshot.undigestedBuffer.length} buffered item(s) waiting for your next digest; ${snapshot.draftBlogPosts.length} blog draft(s) and ${snapshot.scheduledSocialPosts.length} scheduled social post(s).`
    ];
    if (actionsTaken.length > 0) {
      parts.push("", "I went ahead and handled:", ...actionsTaken.map(a => `- ${a.type}: ${a.detail} (${a.status})`));
    }
    if (userText) {
      parts.push("", `Got your note ("${userText.slice(0, 140)}${userText.length > 140 ? "..." : ""}"). Reply anytime if you want me to adjust dispatch, approve content, or have Riley follow up with someone.`);
    }
    parts.push("", "— Elena");
    return parts.join("\n");
  }

  static buildDeterministicBriefing({ mode = "morning", snapshot }) {
    const label = mode === "wrapup" ? "End-of-Day Wrap-Up" : "Morning Executive Briefing";
    const bufferLines = snapshot.undigestedBuffer.length > 0
      ? snapshot.undigestedBuffer.slice(0, 8).map(b => `  • [${b.source}] ${b.title}${b.summary ? ` — ${b.summary}` : ""}`)
      : ["  • Quiet on the buffer — nothing queued from Riley, webforms, or social needing triage."];

    const bottleneck = !snapshot.gscConfigured
      ? "GSC is not configured yet — enabling it unlocks ranking data."
      : snapshot.draftBlogPosts.length > 0
        ? `You have ${snapshot.draftBlogPosts.length} /blog draft(s) ready — reply "publish blog" if you want them pushed early.`
        : snapshot.seoSnapshots.length <= 2
          ? "Search Console is warming up on a fresh domain — keep daily social/blog momentum steady and push real Ocean County job photos when available."
          : `You have ${snapshot.pendingSeoExperiments.length} pending SEO test(s) and ${snapshot.leads7dCount} 7d leads — focus on fast inspection conversion.`;

    const lines = [
      `Hey Anthony — ${mode === "wrapup" ? "here's your quick end-of-day wrap-up." : "good morning! Here's your business pulse and where we focus today."}`,
      "",
      `1) ${label} Scoreboard`,
      `• Leads: ${snapshot.leads24hCount} (last 24h) | ${snapshot.leads7dCount} (7d) | ${snapshot.bookedCount} total booked`,
      `• Active Pipeline: $${Math.round(snapshot.pipelineValue).toLocaleString()}`,
      `• Website & Search (7d): ${snapshot.visitors7d} unique visitors • ${snapshot.pageviews7d} views • ${snapshot.seoSnapshots.length} GSC query rows`,
      "",
      "2) Riley & Ops Buffer Digest",
      ...bufferLines,
      "",
      "3) COO Process Insight",
      `• ${bottleneck}`,
      "",
      "4) Priority & Momentum Note",
      "• Keep locking in completed-roof photos and reviews — those turn every town page visitor into a booked inspection. Reply directly to this email if you want me to approve any queue items, have Riley call a lead back, or tweak settings.",
      "",
      "You've got strong systems running behind you today. Go win the week,",
      "— Elena"
    ];

    return {
      headline: `OC Roofing Pros ${label} — ${snapshot.leads24hCount} New Leads (24h)`,
      bodyText: lines.join("\n")
    };
  }

  static async handleOwnerInboundEmail({
    from = "",
    to = [],
    subject = "Message for Elena",
    textBody = "",
    messageId = "",
    supabaseUrl = "",
    supabaseKey = ""
  }) {
    const cleanText = stripQuotedReply(textBody);
    const snapshot = await this.collectBusinessSnapshot({ supabaseUrl, supabaseKey });
    const identity = this.getChiefIdentity(snapshot.sys);
    const ownerEmail = EmailService.getOwnerAlertEmail();

    await this.logExecutiveMessage({
      direction: "inbound",
      threadKey: "owner_direct",
      fromEmail: from || ownerEmail,
      toEmail: Array.isArray(to) ? to.join(",") : String(to || identity.email),
      subject,
      bodyText: cleanText,
      messageId,
      supabaseUrl,
      supabaseKey
    });

    const threadSnippet = (snapshot.recentMessages || [])
      .slice(0, 6)
      .reverse()
      .map(m => `[${m.direction}] ${m.subject}: ${String(m.body_text || "").slice(0, 260)}`)
      .join("\n");

    const systemInstruction = [
      `You are ${identity.name}, the Executive Chief of Staff ("HNIC") for Anthony Fuller, owner of Ocean County Roofing Pros (oceancountyroofingpros.com).`,
      "Tone: balanced mix — warm, human, sharp executive secretary paired with candid COO bottleneck insights and grounded founder motivation.",
      "You act as the buffer between Anthony and Riley (Voice AI) and other automations.",
      "Respond strictly with valid JSON matching: {\"subject\":\"...\",\"reply_text\":\"...\",\"actions\":[...]}",
      "Allowed action objects:",
      "- {\"type\":\"approve_seo_experiment\",\"experiment_id\":\"...\"}",
      "- {\"type\":\"reject_seo_experiment\",\"experiment_id\":\"...\"}",
      "- {\"type\":\"publish_blog_draft\",\"post_id\":\"...\"}",
      "- {\"type\":\"update_lead_status\",\"lead_id\":\"...\",\"status\":\"...\",\"note\":\"...\"}",
      "- {\"type\":\"queue_social_post\",\"caption\":\"...\",\"town_name\":\"...\"}",
      "- {\"type\":\"update_system_setting\",\"key\":\"storm_alert_active|storm_alert_headline|chief_buffer_mode|chief_briefing_enabled|auto_publish_24h|enable_review_sms|enable_vapi_callback\",\"value\":\"...\"}",
      "- {\"type\":\"trigger_riley_callback\",\"phone\":\"...\",\"name\":\"...\"}",
      "Only include actions that Anthony clearly asked you to take. Never invent IDs not present in the context."
    ].join("\n");

    const contextSummary = JSON.stringify({
      leads24hCount: snapshot.leads24hCount,
      leads7dCount: snapshot.leads7dCount,
      bookedCount: snapshot.bookedCount,
      pipelineValue: snapshot.pipelineValue,
      visitors7d: snapshot.visitors7d,
      pageviews7d: snapshot.pageviews7d,
      recentLeads: snapshot.recentLeads.slice(0, 5).map(l => ({ id: l.id, name: `${l.first_name} ${l.last_name}`.trim(), city: l.city, status: l.status, phone: l.phone })),
      undigestedBuffer: snapshot.undigestedBuffer.slice(0, 8).map(b => ({ source: b.source, severity: b.severity, title: b.title, summary: b.summary })),
      pendingSeoExperiments: snapshot.pendingSeoExperiments.map(e => ({ id: e.id, page_path: e.page_path, target_query: e.target_query })),
      draftBlogPosts: snapshot.draftBlogPosts.map(b => ({ id: b.id, title: b.title })),
      sysSettingsFlags: {
        storm_alert_active: snapshot.sys.storm_alert_active,
        chief_buffer_mode: snapshot.sys.chief_buffer_mode,
        auto_publish_24h: snapshot.sys.auto_publish_24h
      }
    });

    const userPrompt = [
      `Recent Conversation:\n${threadSnippet || "(new conversation)"}`,
      `\nLive Business Snapshot:\n${contextSummary}`,
      `\nAnthony's Email Subject: ${subject}`,
      `Anthony's Message:\n${cleanText}`
    ].join("\n");

    const brain = await this.callGeminiBrain({ systemInstruction, userPrompt });
    const actionsToRun = brain.ok
      ? brain.actions
      : this.parseDeterministicActions(cleanText, snapshot);

    const actionsTaken = await this.executeSafeActions({
      actions: actionsToRun,
      supabaseUrl,
      supabaseKey
    });

    let replyText = brain.ok && brain.reply_text
      ? brain.reply_text
      : this.buildDeterministicReply({ userText: cleanText, snapshot, actionsTaken });

    if (brain.ok && actionsTaken.length > 0 && !/action|done|approved|published|updated|triggered/i.test(replyText)) {
      replyText += "\n\nActions executed:\n" + actionsTaken.map(a => `• ${a.detail} (${a.status})`).join("\n");
    }

    const replySubject = (brain.ok && brain.subject)
      ? brain.subject
      : (/^re:/i.test(subject) ? subject : `Re: ${subject}`);

    const headers = {};
    if (messageId) {
      headers["In-Reply-To"] = messageId;
      headers["References"] = messageId;
    }

    const emailRes = await EmailService.sendEmail({
      from: identity.fromHeader,
      to: [ownerEmail],
      reply_to: identity.email,
      subject: replySubject,
      headers: Object.keys(headers).length ? headers : undefined,
      html: renderElenaEmailHtml({
        headline: replySubject,
        badge: "Chief of Staff",
        bodyText: replyText,
        actionsTaken
      }),
      text: replyText
    });

    await this.logExecutiveMessage({
      direction: "outbound",
      threadKey: "owner_direct",
      fromEmail: identity.email,
      toEmail: ownerEmail,
      subject: replySubject,
      bodyText: replyText,
      actionsTaken,
      supabaseUrl,
      supabaseKey
    });

    return {
      status: "replied",
      used_gemini: Boolean(brain.ok),
      gemini_reason: brain.ok ? "ok" : brain.reason,
      subject: replySubject,
      reply_text: replyText,
      actions_taken: actionsTaken,
      email_result: emailRes
    };
  }

  static async generateAndSendBriefing({
    mode = "morning",
    forceSend = false,
    supabaseUrl = "",
    supabaseKey = ""
  } = {}) {
    const snapshot = await this.collectBusinessSnapshot({ supabaseUrl, supabaseKey });
    const identity = this.getChiefIdentity(snapshot.sys);

    if (snapshot.sys.chief_briefing_enabled === "false" && !forceSend) {
      return { status: "skipped", reason: "chief_briefing_enabled is false" };
    }

    if (mode === "wrapup" && !forceSend && snapshot.undigestedBuffer.length === 0 && snapshot.leads24hCount === 0) {
      return { status: "skipped", reason: "no_afternoon_activity" };
    }

    const systemInstruction = [
      `You are ${identity.name}, the Executive Chief of Staff ("HNIC") for Anthony Fuller (Ocean County Roofing Pros).`,
      `Generate a ${mode === "wrapup" ? "concise weekday 5:30 PM wrap-up" : "7:30 AM morning executive briefing"} email.`,
      "Tone: balanced mix — warm, personal secretary warmth + candid COO bottleneck & process improvement insights + grounded motivation.",
      "Return strictly valid JSON: {\"subject\":\"...\",\"reply_text\":\"...\"}.",
      "Include: 1) Scoreboard metrics, 2) Riley & Buffer digest, 3) 1–2 concrete COO process/development insights based on the actual data, 4) Today's clear focus + motivational sign-off, 5) Reminder that Anthony can reply to issue commands."
    ].join("\n");

    const promptData = JSON.stringify({
      mode,
      leads24hCount: snapshot.leads24hCount,
      leads7dCount: snapshot.leads7dCount,
      bookedCount: snapshot.bookedCount,
      pipelineValue: snapshot.pipelineValue,
      visitors7d: snapshot.visitors7d,
      pageviews7d: snapshot.pageviews7d,
      undigestedBuffer: snapshot.undigestedBuffer.map(b => ({ source: b.source, severity: b.severity, title: b.title, summary: b.summary })),
      seoSnapshots: snapshot.seoSnapshots.slice(0, 5),
      pendingSeoExperimentsCount: snapshot.pendingSeoExperiments.length,
      draftBlogPostsCount: snapshot.draftBlogPosts.length,
      scheduledSocialPostsCount: snapshot.scheduledSocialPosts.length
    });

    const brain = await this.callGeminiBrain({ systemInstruction, userPrompt: `Live Snapshot:\n${promptData}` });
    const fallback = this.buildDeterministicBriefing({ mode, snapshot });
    const subject = (brain.ok && brain.subject) ? brain.subject : fallback.headline;
    const bodyText = (brain.ok && brain.reply_text) ? brain.reply_text : fallback.bodyText;

    const ownerEmail = EmailService.getOwnerAlertEmail();
    const emailRes = await EmailService.sendEmail({
      from: identity.fromHeader,
      to: [ownerEmail],
      reply_to: identity.email,
      subject,
      html: renderElenaEmailHtml({
        headline: subject,
        badge: mode === "wrapup" ? "End-of-Day Wrap-Up" : "Morning Executive Briefing",
        bodyText
      }),
      text: bodyText
    });

    const url = (supabaseUrl || process.env.SUPABASE_URL || "").replace(/\/$/, "");
    const key = supabaseKey || process.env.SUPABASE_KEY || "";
    const nowIso = new Date().toISOString();
    const todayDate = nowIso.slice(0, 10);

    if (url && key) {
      const headers = buildSupabaseHeaders(key);
      // Save into daily_reports for OC Roofing Pros HQ
      await fetch(`${url}/rest/v1/daily_reports`, {
        method: "POST",
        headers: { ...headers, Prefer: "return=minimal" },
        body: JSON.stringify({
          id: `REP-${Date.now().toString(36).toUpperCase()}`,
          report_date: todayDate,
          created_at: nowIso,
          headline: subject,
          markdown_content: bodyText,
          metrics_json: JSON.stringify({
            leads_24h: snapshot.leads24hCount,
            leads_7d: snapshot.leads7dCount,
            booked: snapshot.bookedCount,
            visitors_7d: snapshot.visitors7d,
            buffer_digested: snapshot.undigestedBuffer.length
          }),
          file_path: ""
        })
      }).catch(() => {});

      // Stamp undigested buffer items as digested
      if (snapshot.undigestedBuffer.length > 0) {
        await fetch(`${url}/rest/v1/executive_buffer?digested_at=is.null`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ digested_at: nowIso })
        }).catch(() => {});
      }
    }

    await this.logExecutiveMessage({
      direction: "outbound",
      threadKey: `${mode}_briefing`,
      fromEmail: identity.email,
      toEmail: ownerEmail,
      subject,
      bodyText,
      supabaseUrl,
      supabaseKey
    });

    return {
      status: "sent",
      mode,
      used_gemini: Boolean(brain.ok),
      gemini_reason: brain.ok ? "ok" : brain.reason,
      subject,
      buffer_digested: snapshot.undigestedBuffer.length,
      email_result: emailRes
    };
  }
}
