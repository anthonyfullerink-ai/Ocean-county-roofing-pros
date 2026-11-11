# Ocean County Roofing Pros - Google Sheet CRM Setup Guide

This Google Sheet acts as the **central database and dispatch dashboard** for Ocean County Roofing Pros.

---

## The 4 Tabs to Create

### Tab 1: `Leads_Inbox`
Create the following column headers in Row 1:
1. `lead_id` (Text, e.g. `WEB-171829` or `CALL-171830`)
2. `timestamp` (ISO datetime: `YYYY-MM-DD HH:MM:SS`)
3. `lead_source` (Dropdown: `Website Form`, `Vapi Inbound Call`, `Google Business Profile`)
4. `first_name` (Text)
5. `last_name` (Text)
6. `phone_number` (Text formatted with `'` prefix so leading zeros are preserved)
7. `email` (Text)
8. `street_address` (Text)
9. `city` (Default: `Toms River`)
10. `service_requested` (Dropdown: `Complete Roof Replacement`, `Emergency Leak Repair`, `Storm / Wind Damage Inspection`, `Rake Boards & Aluminum Fascia`)
11. `urgency` (Dropdown: `Standard`, `High`, `Emergency`)
12. `status` (Dropdown: `New Lead`, `Inspection Scheduled`, `Proposal Sent`, `Contract Signed`, `Completed`, `Lost`)
13. `appointment_slot` (Text)
14. `notes_or_summary` (AI Call Transcript Summary or Web Notes)
15. `recording_url` (Link to Vapi call recording audio)
16. `call_duration_sec` (Number)
17. `crm_sync_status` (Dropdown: `Pending`, `Synced`, `Manual`)

---

### Tab 2: `Calendar_Bookings`
Tracks booked on-site 21-point roof inspections:
1. `booking_id` (Text)
2. `lead_id` (Text)
3. `customer_name` (Text)
4. `phone_number` (Text)
5. `service_type` (Text)
6. `assigned_estimator` (Default: `Hannah / Joe The Roofer`)
7. `date` (Date: `YYYY-MM-DD`)
8. `start_time` (Time: `10:00 AM`)
9. `end_time` (Time: `11:30 AM`)
10. `calendar_event_id` (Text)
11. `status` (Dropdown: `Scheduled`, `Completed`, `Rescheduled`, `Cancelled`)

---

### Tab 3: `Services_&_Pricing` (AI Knowledge Base)
Used dynamically by the backend and Vapi agent:
| Service_Name | Warranty_Level | Wind_Rating | Estimated_Base_Price |
| :--- | :--- | :--- | :--- |
| Patriot XL Roof System | 10-Yr Workmanship | 110 MPH | $7,860 - $8,860 |
| Landmark Integrity System | 50-Yr 4-Star / Lifetime | 160 MPH | $8,560 - $9,560 |
| Landmark PRO Upgrade | 50-Yr 4-Star / Lifetime | 160 MPH | $8,900 - $9,900 |
| Rake Boards Cladding | Custom Aluminum | N/A | +$1,224.00 |

---

### Tab 4: `Business_Config`
| Setting_Key | Setting_Value | Description |
| :--- | :--- | :--- |
| `BUSINESS_NAME` | Ocean County Roofing Pros | Brand name used in SMS & Voice |
| `PRIMARY_PHONE` | (732) 555-0199 | Main tracking number |
| `ENABLE_OUTBOUND_CALLBACK` | TRUE | Can be toggled to FALSE anytime |
| `ESTIMATOR_NAME` | Hannah Valdes | On-call estimator |
| `ESTIMATOR_PHONE` | (732) 861-2749 | Notified when bookings are made |

---

## Google Cloud Service Account Setup
1. Go to [Google Cloud Console](https://console.cloud.google.com).
2. Create a project named `OceanCountyRoofingCRM`.
3. Enable **Google Sheets API** and **Google Drive API**.
4. Create a **Service Account**, generate a JSON key, and save it as `google_credentials.json` in your project folder.
5. Open your Google Sheet, click **Share**, and paste the Service Account email with **Editor** access.
