/**
 * Google Search Console API Client (Zero-Dependency JWT RS256)
 * Uses GOOGLE_SERVICE_ACCOUNT_JSON (or GSC_SERVICE_ACCOUNT_JSON) + GSC_SITE_URL.
 */
import crypto from "crypto";

const GSC_SCOPE = "https://www.googleapis.com/auth/webmasters.readonly";

function base64Url(input) {
  return Buffer.from(input).toString("base64url");
}

export class GscService {
  static parseCredentials(rawJson = "") {
    const raw = (rawJson || process.env.GOOGLE_SERVICE_ACCOUNT_JSON || process.env.GSC_SERVICE_ACCOUNT_JSON || "").trim();
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed.client_email && parsed.private_key) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  static async getAccessToken(creds) {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = base64Url(
      JSON.stringify({
        iss: creds.client_email,
        scope: GSC_SCOPE,
        aud: "https://oauth2.googleapis.com/token",
        exp: nowSec + 3600,
        iat: nowSec
      })
    );
    const signingInput = `${header}.${payload}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(creds.private_key, "base64url");
    const jwt = `${signingInput}.${signature}`;

    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || `OAuth token failed (${res.status})`);
    }
    return data.access_token;
  }

  static async querySearchAnalytics({ siteUrl = "", days = 28, rowLimit = 250, credentialsJson = "" } = {}) {
    const creds = this.parseCredentials(credentialsJson);
    if (!creds) {
      return {
        status: "skipped",
        reason: "GOOGLE_SERVICE_ACCOUNT_JSON not configured",
        rows: []
      };
    }

    const targetSite = (siteUrl || process.env.GSC_SITE_URL || "https://oceancountyroofingpros.com/").trim();
    const endDate = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10); // GSC data lags ~2 days
    const startDate = new Date(Date.now() - (days + 2) * 86400000).toISOString().slice(0, 10);

    const token = await this.getAccessToken(creds);
    const endpoint = `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(targetSite)}/searchAnalytics/query`;
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        startDate,
        endDate,
        dimensions: ["page", "query"],
        rowLimit
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return {
        status: "error",
        code: res.status,
        error: data?.error?.message || JSON.stringify(data),
        rows: []
      };
    }

    const rawRows = Array.isArray(data.rows) ? data.rows : [];
    const normalized = rawRows.map(r => {
      const pageUrl = String(r.keys?.[0] || "https://oceancountyroofingpros.com/");
      let pagePath = "/";
      try {
        pagePath = new URL(pageUrl).pathname || "/";
      } catch {
        pagePath = "/";
      }
      return {
        page_url: pageUrl,
        page_path: pagePath,
        query: String(r.keys?.[1] || ""),
        clicks: Number(r.clicks || 0),
        impressions: Number(r.impressions || 0),
        ctr: Math.round(Number(r.ctr || 0) * 10000) / 10000,
        position: Math.round(Number(r.position || 0) * 10) / 10
      };
    });

    return {
      status: "success",
      site_url: targetSite,
      start_date: startDate,
      end_date: endDate,
      rows: normalized
    };
  }
}
