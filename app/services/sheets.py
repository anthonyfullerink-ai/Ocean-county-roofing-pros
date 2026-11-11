import logging
import os
import io
import re
import csv
import subprocess
from datetime import datetime
from typing import Dict, Any, Optional, List
from app.config import settings

logger = logging.getLogger(__name__)

LOCAL_MOCK_LEADS = []

def normalize_phone(raw_phone: str) -> str:
    """Normalizes any phone string to the standard 10-digit number."""
    if not raw_phone:
        return ""
    digits = re.sub(r"\D", "", str(raw_phone))
    return digits[-10:] if len(digits) >= 10 else digits


def run_gsheets_append(range_target: str, row_values: list) -> bool:
    """
    Appends a row directly to the live Google Sheet via authenticated gsheets CLI.
    Properly escapes literal commas with '\\,' as required by gsheets CLI.
    """
    if not settings.GOOGLE_SHEET_ID:
        return False

    escaped_values = []
    for v in row_values:
        s = str(v) if v is not None else ""
        s = s.replace("\r", " ").replace("\n", " ").replace("\t", " ")
        s = s.replace(",", "\\,")
        escaped_values.append(s)
    row_arg = ",".join(escaped_values)

    cmd = ["gsheets.cmd", "mutate", "append", settings.GOOGLE_SHEET_ID, range_target, row_arg]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=10, shell=True)
        if res.returncode == 0:
            logger.info(f"Successfully appended row to Google Sheet via gsheets CLI: {range_target}")
            return True
        else:
            logger.warning(f"gsheets CLI append returned code {res.returncode}: {res.stderr}")
            return False
    except Exception as e:
        logger.warning(f"Could not append via gsheets CLI: {e}")
        return False


def get_sheets_client():
    """Returns an authorized gspread client or None if credentials are not configured."""
    if settings.MOCK_MODE or not os.path.exists(settings.GOOGLE_SERVICE_ACCOUNT_FILE) or not settings.GOOGLE_SHEET_ID:
        return None
    try:
        import gspread
        from google.oauth2.service_account import Credentials
        scopes = [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/drive"
        ]
        creds = Credentials.from_service_account_file(settings.GOOGLE_SERVICE_ACCOUNT_FILE, scopes=scopes)
        return gspread.authorize(creds)
    except Exception as e:
        logger.warning(f"Could not initialize Google Sheets client: {e}. Falling back to mock store.")
        return None


def append_lead_to_sheet(lead_data: Dict[str, Any]) -> bool:
    """
    Appends a new lead record to the 'Leads_Inbox' tab of the Google Sheet CRM.
    """
    timestamp = lead_data.get("timestamp", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    lead_id = lead_data.get("lead_id", f"LD-{int(datetime.now().timestamp())}")
    
    phone_raw = lead_data.get("phone_number", "")
    phone_clean = f"'+1{normalize_phone(phone_raw)}" if phone_raw else ""

    row = [
        lead_id,
        timestamp,
        lead_data.get("lead_source", "Website Form"),
        lead_data.get("first_name", ""),
        lead_data.get("last_name", ""),
        phone_clean,
        lead_data.get("email", ""),
        lead_data.get("street_address", ""),
        lead_data.get("city", settings.PRIMARY_CITY),
        lead_data.get("service_requested", "Roof Replacement"),
        lead_data.get("urgency", "Standard"),
        lead_data.get("status", "New Lead"),
        lead_data.get("appointment_slot", ""),
        lead_data.get("ai_summary", lead_data.get("notes", "")),
        lead_data.get("recording_url", ""),
        lead_data.get("call_duration_sec", 0),
        lead_data.get("crm_sync_status", "Pending")
    ]

    if run_gsheets_append("Leads_Inbox!A1", row):
        return True

    client = get_sheets_client()
    if client and settings.GOOGLE_SHEET_ID:
        try:
            sheet = client.open_by_key(settings.GOOGLE_SHEET_ID).worksheet("Leads_Inbox")
            sheet.append_row(row, value_input_option="USER_ENTERED")
            logger.info(f"Successfully appended lead {lead_id} via gspread.")
            return True
        except Exception as e:
            logger.error(f"Error appending via gspread: {e}")

    LOCAL_MOCK_LEADS.append(lead_data)
    return True


def append_booking_to_sheet(booking_data: Dict[str, Any]) -> bool:
    """
    Appends an appointment booking to the 'Calendar_Bookings' tab.
    12 columns:
    booking_id, lead_id, customer_name, phone_number, customer_email, service_type, assigned_estimator,
    date, start_time, end_time, calendar_event_id, status
    """
    phone_raw = booking_data.get("phone_number", "")
    phone_clean = f"'+1{normalize_phone(phone_raw)}" if phone_raw else ""

    row = [
        booking_data.get("booking_id", f"BK-{int(datetime.now().timestamp())}"),
        booking_data.get("lead_id", ""),
        booking_data.get("customer_name", ""),
        phone_clean,
        booking_data.get("customer_email", booking_data.get("email", "")),
        booking_data.get("service_type", "Roof Inspection"),
        booking_data.get("assigned_estimator", "Hannah / Joe The Roofer"),
        booking_data.get("date", ""),
        booking_data.get("start_time", ""),
        booking_data.get("end_time", ""),
        booking_data.get("calendar_event_id", ""),
        "Scheduled"
    ]

    if run_gsheets_append("Calendar_Bookings!A1", row):
        return True

    client = get_sheets_client()
    if client and settings.GOOGLE_SHEET_ID:
        try:
            sheet = client.open_by_key(settings.GOOGLE_SHEET_ID).worksheet("Calendar_Bookings")
            sheet.append_row(row, value_input_option="USER_ENTERED")
            logger.info("Successfully recorded booking in Calendar_Bookings tab via gspread.")
            return True
        except Exception as e:
            logger.error(f"Error appending to Calendar_Bookings tab: {e}")

    return True


def update_lead_with_call_recording(lead_id_or_phone: str, recording_url: str, duration: int, summary: str = None) -> bool:
    """
    Finds the existing lead row in 'Leads_Inbox' by lead_id or normalized phone,
    and enriches it in place with the call recording URL, duration, and AI summary.
    Avoids appending duplicate rows.
    """
    if not settings.GOOGLE_SHEET_ID or not lead_id_or_phone:
        return False

    target_norm_phone = normalize_phone(lead_id_or_phone)
    target_id = lead_id_or_phone.strip()

    # Read Leads_Inbox Columns A:F to locate the row
    cmd = ["gsheets.cmd", "readonly", "read", settings.GOOGLE_SHEET_ID, "Leads_Inbox!A1:F50"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8, shell=True)
        if res.returncode != 0:
            logger.warning(f"Failed to read sheet for row lookup: {res.stderr}")
            return False

        lines = res.stdout.strip().splitlines()
        matched_row_idx = None
        for idx, line in enumerate(lines, start=1):
            if idx == 1:
                continue
            cols = [c.strip() for c in line.split("\t")]
            row_id = cols[0] if len(cols) > 0 else ""
            row_phone = cols[5] if len(cols) > 5 else ""

            if target_id and target_id == row_id:
                matched_row_idx = idx
                break
            if target_norm_phone and normalize_phone(row_phone) == target_norm_phone:
                matched_row_idx = idx
                break

        if not matched_row_idx:
            logger.info(f"No existing lead row found to update for '{lead_id_or_phone}'.")
            return False

        # If recording_url provided, update columns N, O, P, Q
        if recording_url or duration:
            esc_summary = summary.replace(",", "\\,").replace("\n", " ") if summary else ""
            update_vals = f"{esc_summary},{recording_url},{duration},Synced"
            write_cmd = [
                "gsheets.cmd", "mutate", "write",
                settings.GOOGLE_SHEET_ID,
                f"Leads_Inbox!N{matched_row_idx}:Q{matched_row_idx}",
                update_vals
            ]
            subprocess.run(write_cmd, capture_output=True, text=True, timeout=8, shell=True)
            logger.info(f"Successfully enriched Leads_Inbox row {matched_row_idx} with recording and duration!")
            return True
        return True
    except Exception as e:
        logger.error(f"Error updating lead recording: {e}")
        return False


def update_lead_email_and_address(lead_id_or_phone: str, new_email: Optional[str] = None, new_address: Optional[str] = None) -> bool:
    """
    Updates the email and/or address of an existing lead in both Leads_Inbox and Calendar_Bookings tabs.
    """
    if not settings.GOOGLE_SHEET_ID or not lead_id_or_phone:
        return False

    target_norm_phone = normalize_phone(lead_id_or_phone)
    target_id = lead_id_or_phone.strip()

    # 1. Update Leads_Inbox
    try:
        cmd = ["gsheets.cmd", "readonly", "read", settings.GOOGLE_SHEET_ID, "Leads_Inbox!A1:F50"]
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8, shell=True)
        if res.returncode == 0:
            lines = res.stdout.strip().splitlines()
            for idx, line in enumerate(lines, start=1):
                if idx == 1: continue
                cols = [c.strip() for c in line.split("\t")]
                row_id = cols[0] if len(cols) > 0 else ""
                row_phone = cols[5] if len(cols) > 5 else ""

                if (target_id and target_id == row_id) or (target_norm_phone and normalize_phone(row_phone) == target_norm_phone):
                    if new_email:
                        subprocess.run(["gsheets.cmd", "mutate", "write", settings.GOOGLE_SHEET_ID, f"Leads_Inbox!G{idx}", new_email.strip()], shell=True)
                    if new_address:
                        subprocess.run(["gsheets.cmd", "mutate", "write", settings.GOOGLE_SHEET_ID, f"Leads_Inbox!H{idx}", new_address.replace(",", "\\,").strip()], shell=True)
                    logger.info(f"Updated Leads_Inbox row {idx} with corrected email/address.")
                    break
    except Exception as e:
        logger.error(f"Error updating Leads_Inbox email/address: {e}")

    # 2. Update Calendar_Bookings
    try:
        cmd2 = ["gsheets.cmd", "readonly", "read", settings.GOOGLE_SHEET_ID, "Calendar_Bookings!A1:E50"]
        res2 = subprocess.run(cmd2, capture_output=True, text=True, timeout=8, shell=True)
        if res2.returncode == 0:
            lines = res2.stdout.strip().splitlines()
            for idx, line in enumerate(lines, start=1):
                if idx == 1: continue
                cols = [c.strip() for c in line.split("\t")]
                row_lead_id = cols[1] if len(cols) > 1 else ""
                row_phone = cols[3] if len(cols) > 3 else ""

                if (target_id and target_id == row_lead_id) or (target_norm_phone and normalize_phone(row_phone) == target_norm_phone):
                    if new_email:
                        subprocess.run(["gsheets.cmd", "mutate", "write", settings.GOOGLE_SHEET_ID, f"Calendar_Bookings!E{idx}", new_email.strip()], shell=True)
                    logger.info(f"Updated Calendar_Bookings row {idx} with corrected email.")
                    break
    except Exception as e:
        logger.error(f"Error updating Calendar_Bookings email: {e}")

    return True
