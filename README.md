# Ocean County Roofing Pros — Autonomous Rank & Rent Engine

A high-converting, mobile-first local service landing page and voice AI lead generation system engineered for Ocean & Monmouth County, NJ.

---

## Architecture Overview

```
                      +------------------------------------+
                      |    Ocean County Roofing Pros       |
                      |   (Toms River / Ocean County, NJ)  |
                      +-----------------+------------------+
                                        |
         +------------------------------+------------------------------+
         |                                                             |
         v                                                             v
+------------------------+                                   +-------------------+
|  Inbound Voice (Vapi)  |                                   | High-Converting   |
|  - Toll-Free or Local  |                                   | Web Form (AJAX)   |
|  - 24/7 Availability   |                                   +---------+---------+
+-----------+------------+                                             |
            |                                                          |
            v                                                          v
+--------------------------------------------------------------------------------+
|                     FastAPI Webhook & Lead Engine                              |
|   1. Appends Lead to Google Sheet CRM (Leads_Inbox)                            |
|   2. Fires A2P Compliant SMS Confirmation to Customer                          |
|   3. Sends Instant SMS Alert to Business Owner / Estimator                     |
|   4. (Optional) Triggers 30-sec Vapi Outbound AI Callback for Speed-to-Lead     |
|   5. Executes Live Calendar Tool Calls (check_availability, book_inspection)   |
+--------------------------------------------------------------------------------+
                                        |
                   +--------------------+--------------------+
                   v                                         v
         +--------------------+                    +-------------------+
         | Google Sheets CRM  |                    |  Google Calendar  |
         | (Multi-Tab Core)   |                    | (Estimator Slots) |
         +--------------------+                    +-------------------+
```

---

## Quick Start Guide

### 1. Run Locally
```powershell
Set-Location "C:\Users\AnthonyFuller\.gemini\antigravity\scratch\ocean-county-roofing-pros"
uvicorn app.main:app --reload --port 8000
```
Open your browser at `http://localhost:8000`.

### 2. Available Routes
- `GET /` — Master high-converting landing page (optimized for mobile conversions).
- `GET /privacy-policy` — A2P 10DLC compliant Privacy Policy (includes mandatory mobile sharing disclaimer).
- `GET /terms` — Terms of Service with automated voice and SMS disclosures.
- `POST /api/leads/webform` — Web form submission webhook.
- `POST /api/vapi/tools` — Vapi live tool-calling endpoint (`check_availability`, `book_inspection`).
- `POST /api/vapi/end-of-call` — Post-call analysis and recording sync to Google Sheets.
- `GET /health` — System status and feature flag inspection.

### 3. Key Feature Flags (in `.env` or `app/config.py`)
- `ENABLE_OUTBOUND_CALLBACK`: Set to `True` for 30-sec instant AI callback; `False` for standard SMS confirmation only.
- `MOCK_MODE`: Set to `True` to test the entire site and API locally without requiring live API keys.
