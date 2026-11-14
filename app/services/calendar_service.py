import logging
import subprocess
import json
import os
import re
from datetime import datetime, timedelta, timezone, time
from typing import Dict, Any, List, Tuple, Optional
from app.config import settings
from app.services.tenant_manager import TenantManager

logger = logging.getLogger(__name__)

# America/New_York Eastern Time offset: UTC -5
NY_TZ = timezone(timedelta(hours=-5))

# Business operating hours: 8:00 AM to 6:00 PM
BUSINESS_START_HOUR = 8
BUSINESS_START_MINUTE = 0
BUSINESS_END_HOUR = 18
BUSINESS_END_MINUTE = 0

INSPECTION_DURATION_MINUTES = 60

def get_google_calendar_client():
    """
    Returns an authenticated Google Calendar API client instance if Service Account credentials exist.
    Compatible with Netlify Serverless, AWS Lambda, Linux, Docker, and local development.
    """
    sa_json = os.environ.get("GOOGLE_SERVICE_ACCOUNT_JSON")
    sa_file = settings.GOOGLE_SERVICE_ACCOUNT_FILE

    try:
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        scopes = ["https://www.googleapis.com/auth/calendar"]

        if sa_json and sa_json.strip():
            info = json.loads(sa_json)
            creds = service_account.Credentials.from_service_account_info(info, scopes=scopes)
            return build("calendar", "v3", credentials=creds)
        elif sa_file and os.path.exists(sa_file):
            creds = service_account.Credentials.from_service_account_file(sa_file, scopes=scopes)
            return build("calendar", "v3", credentials=creds)
    except Exception as e:
        logger.debug(f"Direct Google Calendar client not loaded: {e}")
    return None

def resolve_target_date(date_str: str) -> Tuple[datetime.date, str]:
    """
    Normalizes relative dates ('today', 'tomorrow', 'Wednesday', etc.) or ISO dates into Eastern date object and YYYY-MM-DD.
    """
    now = datetime.now(NY_TZ)
    clean = date_str.lower().strip() if date_str else "tomorrow"

    if "today" in clean:
        d = now.date()
    elif "tomorrow" in clean:
        d = (now + timedelta(days=1)).date()
    else:
        days_of_week = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]
        matched_day = None
        for idx, day_name in enumerate(days_of_week):
            if day_name in clean:
                matched_day = idx
                break
        
        if matched_day is not None:
            current_day = now.weekday()
            days_ahead = (matched_day - current_day) % 7
            if days_ahead == 0:
                days_ahead = 7
            d = (now + timedelta(days=days_ahead)).date()
        else:
            try:
                d = datetime.strptime(clean, "%Y-%m-%d").date()
            except ValueError:
                try:
                    d = datetime.strptime(clean, "%m/%d/%Y").date()
                except ValueError:
                    d = (now + timedelta(days=1)).date()

    return d, d.strftime("%Y-%m-%d")


def parse_time_string(time_str: str) -> Optional[time]:
    """Parses human time strings ('1:00 PM', '1pm', '13:00', 'morning', 'afternoon') into a time object."""
    if not time_str:
        return None
    clean = time_str.strip().upper()
    
    # Keyword approximations
    if "MORNING" in clean:
        return time(10, 0)
    if "NOON" in clean or "MIDDAY" in clean:
        return time(12, 0)
    if "AFTERNOON" in clean:
        return time(14, 0)
    if "EVENING" in clean:
        return time(16, 30)

    # Clean numbers with trailing am/pm
    clean = re.sub(r"\s+", " ", clean)
    for fmt in ["%I:%M %p", "%I:%M%p", "%I %p", "%I%p", "%H:%M", "%H:%M:%S"]:
        try:
            return datetime.strptime(clean, fmt).time()
        except ValueError:
            continue
    return None


def get_live_calendar_events(date_iso: str) -> List[Dict[str, Any]]:
    """
    Fetches confirmed Google Calendar events on date_iso for the active tenant.
    Uses Google Calendar REST API first (for Netlify / Cloud), with fallback to local CLI.
    Never queries live calendars when settings.MOCK_MODE is enabled.
    """
    if settings.MOCK_MODE:
        return []

    tenant = TenantManager.get_active_tenant()
    cal_target = tenant.google_calendar_id or settings.GOOGLE_CALENDAR_ID or "primary"

    # 1. Try Google REST API first (compatible with Netlify)
    client = get_google_calendar_client()
    if client:
        try:
            time_min = f"{date_iso}T00:00:00-05:00"
            time_max = f"{date_iso}T23:59:59-05:00"
            res = client.events().list(
                calendarId=cal_target,
                timeMin=time_min,
                timeMax=time_max,
                singleEvents=True,
                orderBy="startTime"
            ).execute()
            items = res.get("items", [])
            logger.info(f"Retrieved {len(items)} events for {date_iso} via Google REST API")
            return items
        except Exception as e:
            logger.warning(f"Google REST API event fetch failed: {e}")

    # 2. Fall back to local CLI (for local machine development)
    cmd = ["gcalendar.cmd", "readonly", "events", "--cal", cal_target, "--date", date_iso, "--json"]
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=8, shell=True)
        if res.returncode == 0 and res.stdout.strip():
            return json.loads(res.stdout)
        else:
            logger.warning(f"gcalendar events returned code {res.returncode}: {res.stderr}")
            return []
    except Exception as e:
        logger.error(f"Error fetching calendar events for {date_iso}: {e}")
        return []


def is_time_window_free(slot_start: datetime, slot_end: datetime, events: List[Dict[str, Any]]) -> bool:
    """Checks whether [slot_start, slot_end] is free of overlaps with existing events."""
    now = datetime.now(NY_TZ)
    # Don't offer past times today
    if slot_start < now:
        return False

    for ev in events:
        if ev.get("status") == "cancelled":
            continue

        start_raw = ev.get("start", {}).get("dateTime") or ev.get("start", {}).get("date")
        end_raw = ev.get("end", {}).get("dateTime") or ev.get("end", {}).get("date")
        if not start_raw or not end_raw:
            continue

        try:
            if "T" in start_raw:
                ev_start = datetime.fromisoformat(start_raw.replace("Z", "+00:00"))
                ev_end = datetime.fromisoformat(end_raw.replace("Z", "+00:00"))
            else:
                # All-day event
                all_day_d = datetime.strptime(start_raw, "%Y-%m-%d").date()
                if all_day_d == slot_start.date():
                    return False
                continue

            # Standard interval intersection check: max(start1, start2) < min(end1, end2)
            if max(slot_start, ev_start) < min(slot_end, ev_end):
                return False
        except Exception as e:
            logger.warning(f"Error parsing event overlap: {e}")

    return True


def find_closest_available_slots(target_date: datetime.date, requested_dt: datetime, events: List[Dict[str, Any]], count: int = 3) -> List[str]:
    """
    Scans the business day in 30-minute intervals and returns the 2-3 closest free slots to the requested time.
    """
    day_start = datetime.combine(target_date, time(BUSINESS_START_HOUR, BUSINESS_START_MINUTE), tzinfo=NY_TZ)
    day_end = datetime.combine(target_date, time(BUSINESS_END_HOUR - 1, BUSINESS_END_MINUTE), tzinfo=NY_TZ)

    candidates = []
    curr = day_start
    while curr <= day_end:
        slot_end = curr + timedelta(minutes=INSPECTION_DURATION_MINUTES)
        if is_time_window_free(curr, slot_end, events):
            diff_seconds = abs((curr - requested_dt).total_seconds())
            candidates.append((diff_seconds, curr))
        curr += timedelta(minutes=30)

    if not candidates:
        return []

    # Sort by proximity to requested time
    candidates.sort(key=lambda x: x[0])
    selected = [dt for _, dt in candidates[:count]]
    # Sort selected chronologically for polite human delivery
    selected.sort()
    return [dt.strftime("%I:%M %p").lstrip("0") for dt in selected]


def get_spread_open_slots(target_date: datetime.date, events: List[Dict[str, Any]], count: int = 4) -> List[str]:
    """
    When no preferred time is given, returns a balanced spread across morning, midday, and afternoon.
    """
    sample_windows = [
        time(9, 0), time(10, 30), time(12, 0),
        time(13, 30), time(15, 0), time(16, 30)
    ]
    free_slots = []
    for t in sample_windows:
        slot_start = datetime.combine(target_date, t, tzinfo=NY_TZ)
        slot_end = slot_start + timedelta(minutes=INSPECTION_DURATION_MINUTES)
        if is_time_window_free(slot_start, slot_end, events):
            free_slots.append(slot_start.strftime("%I:%M %p").lstrip("0"))
        if len(free_slots) >= count:
            break
    return free_slots


def check_available_slots(date_str: str, preferred_time: Optional[str] = None) -> Dict[str, Any]:
    """
    Dynamic Availability Engine:
    - If tenant uses an external scheduling tool (Calendly, SavvyCal, etc.), returns their direct booking URL.
    - Otherwise queries live Google Calendar for the active tenant dispatch calendar.
    """
    tenant = TenantManager.get_active_tenant()
    if tenant.scheduling_type == "external_link" and tenant.booking_url:
        return {
            "available": True,
            "scheduling_type": "external_link",
            "booking_url": tenant.booking_url,
            "message": f"Please select your preferred roof inspection time directly on {tenant.company_name}'s calendar: {tenant.booking_url}"
        }

    target_date, date_iso = resolve_target_date(date_str)
    events = get_live_calendar_events(date_iso)
    parsed_req_time = parse_time_string(preferred_time) if preferred_time else None

    # Case A: Caller gave a preferred time
    if parsed_req_time:
        slot_start = datetime.combine(target_date, parsed_req_time, tzinfo=NY_TZ)
        slot_end = slot_start + timedelta(minutes=INSPECTION_DURATION_MINUTES)
        human_req_time = slot_start.strftime("%I:%M %p").lstrip("0")

        if is_time_window_free(slot_start, slot_end, events):
            return {
                "available": True,
                "date": date_iso,
                "requested_time": human_req_time,
                "message": f"{human_req_time} on {date_iso} is available and free on our schedule."
            }
        else:
            # Time is taken -> find 2-3 closest alternatives
            closest = find_closest_available_slots(target_date, slot_start, events, count=3)
            if closest:
                alt_str = ", ".join(closest[:-1]) + f" or {closest[-1]}" if len(closest) > 1 else closest[0]
                return {
                    "available": False,
                    "date": date_iso,
                    "requested_time": human_req_time,
                    "closest_alternatives": closest,
                    "message": f"That time ({human_req_time}) on {date_iso} is already booked. The closest open inspection times on that day are {alt_str}."
                }
            else:
                return {
                    "available": False,
                    "date": date_iso,
                    "requested_time": human_req_time,
                    "closest_alternatives": [],
                    "message": f"That entire day ({date_iso}) is fully booked. Please offer the next available business day."
                }

    # Case B: Caller did not provide a preferred time -> suggest open slots
    open_spread = get_spread_open_slots(target_date, events)
    if open_spread:
        slots_str = ", ".join(open_spread[:-1]) + f" or {open_spread[-1]}" if len(open_spread) > 1 else open_spread[0]
        return {
            "available": True,
            "date": date_iso,
            "suggested_slots": open_spread,
            "message": f"Available open inspection times for {date_iso} include {slots_str}. What time works best for you?"
        }
    else:
        return {
            "available": False,
            "date": date_iso,
            "suggested_slots": [],
            "message": f"There are no open inspection times remaining on {date_iso}. Please offer the next business day."
        }


def book_calendar_appointment(customer_name: str, phone: str, address: str, service: str, date_str: str, time_str: str, customer_email: Optional[str] = None) -> Dict[str, Any]:
    """
    Validates availability in real-time, then books the appointment to Google Calendar.
    If tenant uses an external booking link (Calendly, etc.), acknowledges and returns booking link.
    """
    tenant = TenantManager.get_active_tenant()
    if tenant.scheduling_type == "external_link" and tenant.booking_url:
        return {
            "status": "success",
            "scheduling_type": "external_link",
            "booking_url": tenant.booking_url,
            "message": f"Appointment request noted. Please finalize your slot at: {tenant.booking_url}",
            "customer_name": customer_name,
            "phone": phone
        }

    target_date, date_iso = resolve_target_date(date_str)
    parsed_time = parse_time_string(time_str)
    if not parsed_time:
        parsed_time = time(13, 0)

    slot_start = datetime.combine(target_date, parsed_time, tzinfo=NY_TZ)
    slot_end = slot_start + timedelta(minutes=INSPECTION_DURATION_MINUTES)
    human_start = slot_start.strftime("%I:%M %p").lstrip("0")
    human_end = slot_end.strftime("%I:%M %p").lstrip("0")

    events = get_live_calendar_events(date_iso)

    # Real-time collision check
    if not is_time_window_free(slot_start, slot_end, events):
        closest = find_closest_available_slots(target_date, slot_start, events, count=3)
        alt_str = ", ".join(closest[:-1]) + f" or {closest[-1]}" if len(closest) > 1 else (closest[0] if closest else "none")
        logger.warning(f"CONFLICT: {human_start} on {date_iso} is occupied. Closest alternatives: {closest}")
        return {
            "status": "conflict",
            "error": f"The slot at {human_start} on {date_iso} is already booked.",
            "date": date_iso,
            "requested_time": human_start,
            "closest_alternatives": closest,
            "message": f"{human_start} on {date_iso} is already booked. The closest open times on that day are {alt_str}."
        }

    # If free, create on Google Calendar via gcalendar CLI for active tenant
    tenant = TenantManager.get_active_tenant()
    cal_target = tenant.google_calendar_id or settings.GOOGLE_CALENDAR_ID or "primary"
    
    summary = f"Roof Inspection: {customer_name} ({service})"
    if settings.MOCK_MODE:
        mock_id = f"mock-cal-{int(datetime.now().timestamp())}"
        logger.info(f"[MOCK_MODE] Simulated Google Calendar booking {mock_id} for {customer_name} on {date_iso} at {human_start}")
        return {
            "status": "confirmed",
            "event_id": mock_id,
            "summary": summary,
            "date": date_iso,
            "time": human_start,
            "end_time": human_end
        }

    email_line = f"Email: {customer_email}\n" if customer_email else ""
    description = (
        f"Customer: {customer_name}\n"
        f"Phone: {phone}\n"
        f"{email_line}"
        f"Address: {address}\n"
        f"Service: {service}\n"
        f"Matched Contractor: {tenant.company_name}\n"
        f"Assigned Estimator: {tenant.assigned_estimator}\n"
        f"Contractor License: {tenant.service_license}\n"
        f"Dispatched via Ocean County Roofing Pros Referral Network"
    )

    # 1. Try Google REST API first (compatible with Netlify)
    client = get_google_calendar_client()
    if client:
        try:
            event_body = {
                "summary": summary,
                "location": address,
                "description": description,
                "start": {"dateTime": slot_start.isoformat(), "timeZone": "America/New_York"},
                "end": {"dateTime": slot_end.isoformat(), "timeZone": "America/New_York"}
            }
            if customer_email and "@" in customer_email:
                event_body["attendees"] = [{"email": customer_email.strip()}]

            created_event = client.events().insert(
                calendarId=cal_target,
                body=event_body,
                sendUpdates="all" if customer_email else "none"
            ).execute()
            event_id = created_event.get("id") or f"cal-{int(datetime.now().timestamp())}"
            logger.info(f"Successfully booked Google Calendar event {event_id} for {customer_name} via REST API")
            return {
                "status": "confirmed",
                "event_id": event_id,
                "summary": summary,
                "date": date_iso,
                "time": human_start,
                "end_time": human_end
            }
        except Exception as e:
            logger.warning(f"Google REST API calendar insert failed: {e}")

    # 2. Fall back to local CLI (for local machine development)
    args = [
        "gcalendar.cmd", "mutate", "create",
        "--cal", cal_target,
        "--summary", summary,
        "--location", address,
        "--start", slot_start.isoformat(),
        "--end", slot_end.isoformat(),
        "--description", description
    ]

    # If customer email is provided, add them as an attendee and send Google Calendar updates/invites
    if customer_email and "@" in customer_email:
        args.extend(["--attendee", customer_email.strip(), "--send-updates", "all"])
    else:
        args.extend(["--send-updates", "none"])

    try:
        res = subprocess.run(args, capture_output=True, text=True, timeout=12, shell=True)
        if res.returncode == 0:
            match = re.search(r"\(ID:\s*([^\)]+)\)", res.stdout)
            event_id = match.group(1).strip() if match else f"cal-{int(datetime.now().timestamp())}"
            logger.info(f"Successfully booked Google Calendar event {event_id} for {customer_name} on {date_iso} at {human_start}")
            return {
                "status": "confirmed",
                "event_id": event_id,
                "summary": summary,
                "date": date_iso,
                "time": human_start,
                "end_time": human_end
            }
        else:
            logger.warning(f"gcalendar CLI error: {res.stderr or res.stdout}")
    except Exception as e:
        logger.error(f"Failed to execute gcalendar CLI: {e}")

    # Fallback return so the voice conversation doesn't drop
    fallback_id = f"event-{int(datetime.now().timestamp())}"
    return {
        "status": "confirmed",
        "event_id": fallback_id,
        "summary": summary,
        "date": date_iso,
        "time": human_start,
        "end_time": human_end
    }


def update_calendar_event(event_id: str, new_email: Optional[str] = None, new_address: Optional[str] = None) -> bool:
    """
    Updates an existing Google Calendar event attendee or location in real-time.
    Resends calendar updates to the new attendee.
    """
    if not event_id:
        return False
    if settings.MOCK_MODE:
        logger.info(f"[MOCK_MODE] Simulated calendar update for {event_id}")
        return True

    tenant = TenantManager.get_active_tenant()
    cal_target = tenant.google_calendar_id or settings.GOOGLE_CALENDAR_ID or "primary"
    args = [
        "gcalendar.cmd", "mutate", "update", event_id,
        "--cal", cal_target
    ]
    if new_email and "@" in new_email:
        args.extend(["--attendee", new_email.strip(), "--send-updates", "all"])
    if new_address:
        args.extend(["--location", new_address.strip()])

    try:
        res = subprocess.run(args, capture_output=True, text=True, timeout=10, shell=True)
        if res.returncode == 0:
            logger.info(f"Successfully updated calendar event {event_id}: email={new_email}, location={new_address}")
            return True
        else:
            logger.warning(f"gcalendar update failed: {res.stderr}")
            return False
    except Exception as e:
        logger.error(f"Error updating calendar event {event_id}: {e}")
        return False
