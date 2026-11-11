# Netlify Deployment Guide & Configuration
**Project:** Ocean County Roofing Pros (`oceancountyroofingpros.com`)  
**Architecture:** Serverless FastAPI + Mangum ASGI on Netlify Functions + Global Edge CDN

---

## 1. What Has Been Prepared in Your Codebase

Your project is now 100% configured for direct Netlify deployment:

1. **[`netlify.toml`](file:///C:/Users/AnthonyFuller/.gemini/antigravity/scratch/ocean-county-roofing-pros/netlify.toml):**
   - Automatically builds Python dependencies.
   - Configures the serverless function timeout (26 seconds) for Vapi voice AI tool calling.
   - Serves all images, logos, and favicons from **Netlify's Global Edge CDN** directly (`/static/*`) for maximum page speed.
   - Proxies all HTML routes, SEO geo-silos, sitemaps, and `/api/*` endpoints to the serverless function handler.
2. **[`netlify/functions/api.py`](file:///C:/Users/AnthonyFuller/.gemini/antigravity/scratch/ocean-county-roofing-pros/netlify/functions/api.py):**
   - Uses `Mangum` to wrap your FastAPI application into an AWS Lambda / Netlify Serverless handler.
3. **Universal Google Calendar & Sheets Integration:**
   - [`calendar_service.py`](file:///C:/Users/AnthonyFuller/.gemini/antigravity/scratch/ocean-county-roofing-pros/app/services/calendar_service.py) supports direct **Google REST API** calls via `GOOGLE_SERVICE_ACCOUNT_JSON` environment variable, eliminating the need for local desktop CLI tools.
4. **Environment-Variable Tenant Switching:**
   - [`tenant_manager.py`](file:///C:/Users/AnthonyFuller/.gemini/antigravity/scratch/ocean-county-roofing-pros/app/services/tenant_manager.py) reads `ACTIVE_TENANT_ID` directly from Netlify's environment variables. You can flip active contractors in the Netlify web dashboard in 5 seconds.

---

## 2. Step-by-Step Netlify Deployment Instructions

### Step 1: Push Code to Your Git Repository
Push your project directory to GitHub, GitLab, or Bitbucket:
```bash
git init
git add .
git commit -m "Configure Ocean County Roofing Pros for Netlify deployment"
git remote add origin https://github.com/YOUR_USERNAME/ocean-county-roofing-pros.git
git push -u origin main
```

---

### Step 2: Connect to Netlify
1. Log in to your [Netlify Dashboard](https://app.netlify.com/).
2. Click **"Add new site"** > **"Import an existing project"**.
3. Select your Git provider and choose the `ocean-county-roofing-pros` repository.
4. Netlify will automatically detect `netlify.toml` and configure the build settings.

---

### Step 3: Add Environment Variables in Netlify
Before clicking Deploy, navigate to **Site configuration > Environment variables** in Netlify and add the following keys:

| Environment Variable | Value / Description | Example |
| :--- | :--- | :--- |
| `ACTIVE_TENANT_ID` | Active roofer profile from `config/tenants/` | `client_joe_the_roofer` |
| `GOOGLE_SHEET_ID` | Your Google Sheet CRM ID | `1chgunu0AKsVm5VEX8qFEiown_7GMEIxpjVBAkedzRB8` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Raw JSON string of your Google Service Account key | `{"type": "service_account", ...}` |
| `VAPI_API_KEY` | Your Vapi Private API Key | `your-vapi-key` |
| `VAPI_PHONE_NUMBER_ID` | Phone ID assigned to your number | `b16ab805-d29b-4635-8740-338abeda3abf` |
| `TWILIO_ACCOUNT_SID` | (Optional) Twilio Account SID | `AC...` |
| `TWILIO_AUTH_TOKEN` | (Optional) Twilio Auth Token | `your-token` |
| `TWILIO_PHONE_NUMBER` | (Optional) Twilio Sending Number | `+17326609121` |

---

### Step 4: Deploy & Verify
1. Click **Deploy Site**.
2. Once deployed, Netlify will assign a live URL (e.g. `https://ocean-county-roofing.netlify.app` or your custom domain `https://oceancountyroofingpros.com`).
3. Visit the URL:
   - Homepage loads with the official logo and town links.
   - Sitemap is live at `https://your-site.netlify.app/sitemap.xml`.
   - Robots file is live at `https://your-site.netlify.app/robots.txt`.

---

### Step 5: Connect Vapi to Your Permanent Netlify URL
Once Netlify is live, you can disconnect local Cloudflare tunnels forever:
1. In your Vapi Dashboard (or via API):
   - Set **Hannah Assistant Tools Server URL** to:
     `https://your-site.netlify.app/api/vapi/tools`
   - Set **Assistant / Phone Server URL** to:
     `https://your-site.netlify.app/api/vapi/end-of-call`
2. All phone calls to `+1 (732) 660-9121` will now communicate directly with your Netlify serverless functions 24/7/365 with zero downtime.

---

### How to Switch Clients on Netlify (Rank and Rent)
When you rent the site to another contractor:
1. Go to your **Netlify Dashboard > Site configuration > Environment variables**.
2. Edit `ACTIVE_TENANT_ID` to `client_apex_roofing` (or any other tenant YAML name in `config/tenants/`).
3. Click **Save**.
4. Netlify updates the live function instantly. All new calendar appointments and lead alerts immediately route to the new contractor!
