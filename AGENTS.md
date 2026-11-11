# Agent Guidelines: Ocean County Roofing Pros

## 1. Project Overview & Tech Stack
- **Project:** Autonomous Rank & Rent / Lead Generation engine for a local roofing contractor in Ocean & Monmouth County, NJ.
- **Backend:** Python 3.11+, FastAPI, Uvicorn, Pydantic v2 Settings.
- **Frontend:** Server-rendered Jinja2 templates (`app/templates/index.html`) with Tailwind CSS via CDN and vanilla JavaScript for asynchronous form submission and click-to-call tracking.
- **Integrations:**
  - **Vapi:** Inbound and 30-second outbound speed-to-lead voice AI agents.
  - **Google Sheets CRM:** Multi-tab lead logging (`Leads_Inbox`, `Estimates`, `Calls`).
  - **Google Calendar:** Inspection slot booking tool calls.
  - **Twilio:** A2P 10DLC compliant SMS notifications and immediate contractor dispatch alerts.
- **Dependency Management:** `pip` with `requirements.txt`.

---

## 2. Architecture & File Structure

```text
ocean-county-roofing-pros/
├── app/
│   ├── routes/              # FastAPI route controllers (leads, vapi webhooks)
│   ├── services/            # Business logic (Google Sheets, Calendar, Twilio, Vapi)
│   ├── static/              # CSS, client JS, images, icons
│   ├── templates/           # Jinja2 HTML templates (mobile-first landing page)
│   ├── config.py            # Central Pydantic application settings
│   └── main.py              # Application entrypoint & middleware
├── google_sheet_setup/      # Setup scripts for Google Sheets CRM
├── vapi/                    # Assistant prompts & tool schemas
├── .env                     # Local secrets (NEVER COMMIT)
├── .env.example             # Clean template of all environment variables
├── requirements.txt         # Pinned production dependencies
├── BRAND.md                 # Brand identity, tone, and visual guidelines
├── brand.yaml               # Machine-readable brand configuration
└── AGENTS.md                # This operational guide
```

---

## 3. Remote Assets & Output Policy (Google Drive)
- **Local Compute vs. Cloud Deliverables:** Code, virtual environments, and temporary caches remain strictly on the local SSD.
- **Deliverables Route (`OUTPUT_DIR`):** All user-facing outputs that need to be reviewed while away from the PC (PDF estimates, 21-point roof inspection checklists, exported lead CSVs, call recordings) **must route through `OUTPUT_DIR`**.
- **Configuration:** Defined in `.env`:
  ```env
  OUTPUT_DIR="G:/My Drive/Antigravity-Outputs/ocean-county-roofing-pros"
  ```
- **Fallback:** If `OUTPUT_DIR` is not set or Google Drive is unavailable, default gracefully to `./outputs` in the repository root (gitignored).
- **Subdirectories:**
  - `OUTPUT_DIR/inspections/` — Roof inspection summaries and photo checklists.
  - `OUTPUT_DIR/estimates/` — Customer quotes and proposals.
  - `OUTPUT_DIR/leads/` — End-of-week CSV lead reports for the contractor.

---

## 4. Brand Guidelines & Guardrails (Local Roofing)
- **Identity:** Authoritative, community-trusted, responsive local contractor serving Ocean and Monmouth County, NJ (Toms River, Brick, Lakewood, Jackson, Point Pleasant, Barnegat, Manahawkin).
- **Primary Value Propositions:**
  - Emergency Storm & Tarp Response (24/7 dispatched).
  - Free 21-Point Roof & Attic Moisture Inspection.
  - Licensed & Fully Insured (NJ HIC compliant).
  - GAF Certified Shingles with 50-year warranty options.
  - Insurance Claim Guidance (helping homeowners handle storm/wind claims).
- **Banned Copy & Anti-Patterns:**
  - **NEVER** advertise "Cheapest roofer in New Jersey" or compete on race-to-the-bottom pricing. Focus on quality, warranties, and avoiding costly leaks.
  - **NEVER** promise exact arrival times without checking availability via `calendar_service.py`.
  - **NEVER** write generic stock roofing copy; always weave in coastal storm resilience, wind-rated shingles, and local town references.
  - Full brand specs are maintained in `BRAND.md` and `brand.yaml`.

---

## 5. Development & Testing Commands
- **Run Local Dev Server:**
  ```powershell
  uvicorn app.main:app --reload --port 8000
  ```
- **Mock Mode Testing (No API Keys Required):**
  - Keep `MOCK_MODE=True` in `.env`.
  - Submitting the web form will simulate Twilio SMS and Google Sheet appends to stdout without network calls.
- **Health Check:**
  - Verify endpoints: `http://localhost:8000/health`.

---

## 6. Pre-Push Production Checklist (Prevents Live Breakages)
Before committing or pushing to GitHub / live deployment (Render, Railway, or VPS):

1. **Environment Variables Completeness:**
   - Every variable referenced in `app/config.py` must exist in `.env.example`.
2. **Deterministic Dependencies:**
   - Ensure all imported packages are recorded in `requirements.txt`.
3. **Cross-Platform Path Hygiene:**
   - Use `pathlib.Path` or forward slashes (`/`). Never use hardcoded Windows backslashes (`\`) in file paths or route URLs.
4. **Case Sensitivity:**
   - Verify all template references, static assets, and Python module imports match exact case (e.g., `app.services.comms`, not `app.services.Comms`).
5. **Host & Port Binding:**
   - Ensure the server binds to `HOST=0.0.0.0` and respects dynamic `$PORT` for production containers.

---

## 7. Safety & Autonomy Guardrails
- **DO NOT** commit `.env`, `google_credentials.json`, or OAuth tokens.
- **DO NOT** disable `MOCK_MODE` in automated test scripts unless explicitly configured with sandbox credentials.
- **DO NOT** modify Google Sheet column headers without updating `app/services/sheets.py` schema mappings simultaneously.
- When generating new pages or tools, always preserve A2P 10DLC compliance text (SMS opt-in consent checkboxes and privacy disclosures).
