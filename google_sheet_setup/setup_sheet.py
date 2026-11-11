import sys
import os
import gspread
from google.oauth2.service_account import Credentials

SCOPES = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive"
]

def setup_roofing_crm(sheet_id: str, credentials_path: str = "google_credentials.json"):
    """
    Automates the creation and structure of all 4 CRM tabs in Google Sheets:
    - Leads_Inbox
    - Calendar_Bookings
    - Services_&_Pricing
    - Business_Config
    """
    if not os.path.exists(credentials_path):
        print(f"Error: Credentials file '{credentials_path}' not found.")
        print("Please place your Google Cloud Service Account JSON file in the project root.")
        return False

    print(f"Authenticating with Google Cloud...")
    creds = Credentials.from_service_account_file(credentials_path, scopes=SCOPES)
    gc = gspread.authorize(creds)

    print(f"Opening spreadsheet: {sheet_id}...")
    sh = gc.open_by_key(sheet_id)

    # ----------------------------------------------------
    # TAB 1: Leads_Inbox
    # ----------------------------------------------------
    print("Setting up 'Leads_Inbox' tab...")
    try:
        ws_leads = sh.worksheet("Leads_Inbox")
    except gspread.WorksheetNotFound:
        ws_leads = sh.add_worksheet(title="Leads_Inbox", rows=1000, cols=20)

    leads_headers = [
        "lead_id", "timestamp", "lead_source", "first_name", "last_name",
        "phone_number", "email", "street_address", "city", "service_requested",
        "urgency", "status", "appointment_slot", "notes_or_summary",
        "recording_url", "call_duration_sec", "crm_sync_status"
    ]
    ws_leads.update(range_name="A1:Q1", values=[leads_headers])
    ws_leads.format("A1:Q1", {
        "backgroundColor": {"red": 0.04, "green": 0.11, "blue": 0.23},
        "textFormat": {"foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0}, "bold": True}
    })

    # ----------------------------------------------------
    # TAB 2: Calendar_Bookings
    # ----------------------------------------------------
    print("Setting up 'Calendar_Bookings' tab...")
    try:
        ws_cal = sh.worksheet("Calendar_Bookings")
    except gspread.WorksheetNotFound:
        ws_cal = sh.add_worksheet(title="Calendar_Bookings", rows=500, cols=12)

    cal_headers = [
        "booking_id", "lead_id", "customer_name", "phone_number", "service_type",
        "assigned_estimator", "date", "start_time", "end_time", "calendar_event_id", "status"
    ]
    ws_cal.update(range_name="A1:K1", values=[cal_headers])
    ws_cal.format("A1:K1", {
        "backgroundColor": {"red": 0.12, "green": 0.25, "blue": 0.69},
        "textFormat": {"foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0}, "bold": True}
    })

    # ----------------------------------------------------
    # TAB 3: Services_&_Pricing (AI Knowledge Base)
    # ----------------------------------------------------
    print("Setting up 'Services_&_Pricing' tab...")
    try:
        ws_pricing = sh.worksheet("Services_&_Pricing")
    except gspread.WorksheetNotFound:
        ws_pricing = sh.add_worksheet(title="Services_&_Pricing", rows=50, cols=6)

    pricing_headers = ["System_Tier", "Warranty_Coverage", "Wind_Rating", "Pricing_Model", "Incidental_Rate", "Notes"]
    pricing_data = [
        ["CertainTeed Patriot XL Roof", "10-Year Workmanship / Lifetime SureStart", "110 MPH", "Custom Estimate (By Square Footage)", "N/A", "Class 3 Impact Resistant Shingles"],
        ["CertainTeed Landmark Integrity System", "CertainTeed 4-Star 50-Yr Non-Prorated / Lifetime Workmanship", "160 MPH", "Custom Estimate (Most Popular)", "N/A", "WinterGuard Ice & Water + SwiftStart 160 MPH"],
        ["CertainTeed Landmark PRO Upgrade", "CertainTeed 4-Star 50-Yr / 30-Yr Algae StreakFighter", "160 MPH", "Custom Estimate (Premium)", "N/A", "Heaviest Architectural Shingle with Max Def Color"],
        ["Clad Rake Boards with Aluminum", "White PVC/Smooth Aluminum Fascia Cladding", "N/A", "Add-On", "$1,224.00", "Custom fabricated on site"],
        ["1/2 Inch CDX Plywood Replacement", "Per 4x8 sheet (rotted wood discovered)", "N/A", "Incidental T&M", "$75.00 / sheet", "Billed only if rotted wood discovered on tear-off"],
        ["3/4 Inch CDX Plywood Replacement", "Per 4x8 sheet (rotted wood discovered)", "N/A", "Incidental T&M", "$85.00 / sheet", "Billed only if rotted wood discovered on tear-off"],
        ["Fascia Wood Replacement", "Per linear foot", "N/A", "Incidental T&M", "$12.00 / lin. ft.", "Replaced as needed during install"]
    ]
    ws_pricing.update(range_name="A1:F1", values=[pricing_headers])
    ws_pricing.update(range_name="A2:F7", values=pricing_data)
    ws_pricing.format("A1:F1", {
        "backgroundColor": {"red": 0.05, "green": 0.45, "blue": 0.27},
        "textFormat": {"foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0}, "bold": True}
    })

    # ----------------------------------------------------
    # TAB 4: Business_Config
    # ----------------------------------------------------
    print("Setting up 'Business_Config' tab...")
    try:
        ws_config = sh.worksheet("Business_Config")
    except gspread.WorksheetNotFound:
        ws_config = sh.add_worksheet(title="Business_Config", rows=50, cols=3)

    config_headers = ["Setting_Key", "Setting_Value", "Description"]
    config_data = [
        ["BUSINESS_NAME", "Ocean County Roofing Pros", "Public facing brand name in SMS and AI greetings"],
        ["PRIMARY_PHONE", "(732) 555-0199", "Inbound Vapi tracking number"],
        ["ENABLE_OUTBOUND_CALLBACK", "TRUE", "Toggle speed-to-lead 30-sec callback (TRUE/FALSE)"],
        ["ESTIMATOR_NAME", "Hannah Valdes / Joe The Roofer", "Lead estimator assigned to 21-point inspections"],
        ["ESTIMATOR_PHONE", "(732) 861-2749", "Receives calendar and dispatch notifications"],
        ["PRIMARY_MARKET", "Toms River & Ocean County, NJ", "Primary geographical focus"]
    ]
    ws_config.update(range_name="A1:C1", values=[config_headers])
    ws_config.update(range_name="A2:C7", values=config_data)
    ws_config.format("A1:C1", {
        "backgroundColor": {"red": 0.55, "green": 0.35, "blue": 0.05},
        "textFormat": {"foregroundColor": {"red": 1.0, "green": 1.0, "blue": 1.0}, "bold": True}
    })

    # Remove default 'Sheet1' if it exists and is empty
    try:
        default_sheet = sh.worksheet("Sheet1")
        if default_sheet:
            sh.del_worksheet(default_sheet)
    except Exception:
        pass

    print(f"\n✓ SUCCESS: Roofing CRM Google Sheet is 100% configured!")
    print(f"URL: https://docs.google.com/spreadsheets/d/{sheet_id}")
    return True

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python google_sheet_setup/setup_sheet.py <GOOGLE_SHEET_ID>")
    else:
        setup_roofing_crm(sys.argv[1])
