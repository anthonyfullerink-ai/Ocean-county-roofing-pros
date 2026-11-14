import os
import json
import yaml
from pathlib import Path
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing import Optional, List, Dict, Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent

class Settings(BaseSettings):
    # App
    PORT: int = 8000
    HOST: str = "0.0.0.0"
    DEBUG: bool = True

    # Business Defaults (Overridden dynamically by brand.yaml)
    BUSINESS_NAME: str = "Ocean County Roofing Pros"
    PRIMARY_PHONE: str = "+17326609121"
    PRIMARY_CITY: str = "Toms River"
    PRIMARY_STATE: str = "NJ"
    SITE_BASE_URL: str = "https://oceancountyroofingpros.com"

    # Feature Flags
    ENABLE_OUTBOUND_CALLBACK: bool = True  # Can be toggled on/off per client
    ENABLE_SMS_CONFIRMATION: bool = True
    MOCK_MODE: bool = True  # Allows running smoothly during development without live credentials

    # Supabase Primary Database & Zero-Config Local Mirror
    SUPABASE_URL: Optional[str] = None
    SUPABASE_KEY: Optional[str] = None
    LOCAL_DB_PATH: str = "data/local_supabase_mirror.db"

    # Portals & GBP Automation
    ADMIN_PASSWORD: str = "732999"
    ADMIN_PIN: str = "732999"
    GBP_REVIEW_URL: str = "https://g.page/r/OceanCountyRoofingPros/review"
    GBP_WEBHOOK_URL: Optional[str] = None

    # Legacy Google Sheets CRM (Retired in favor of Supabase + Universal CRM I/O)
    GOOGLE_SERVICE_ACCOUNT_FILE: str = "google_credentials.json"
    GOOGLE_SHEET_ID: Optional[str] = None

    # Google Calendar
    GOOGLE_CALENDAR_ID: str = "primary"

    # Vapi
    VAPI_API_KEY: Optional[str] = None
    VAPI_PHONE_NUMBER_ID: Optional[str] = None
    VAPI_OUTBOUND_ASSISTANT_ID: Optional[str] = None
    VAPI_SERVER_SECRET: Optional[str] = None

    # Twilio
    TWILIO_ACCOUNT_SID: Optional[str] = None
    TWILIO_AUTH_TOKEN: Optional[str] = None
    TWILIO_PHONE_NUMBER: Optional[str] = None

    # Owner Alerts
    OWNER_ALERT_PHONE: Optional[str] = None
    OWNER_ALERT_EMAIL: Optional[str] = None

    # Remote Outputs (Google Drive / Cloud sync destination)
    OUTPUT_DIR: str = "./outputs"

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

settings = Settings()

# ------------------------------------------------------------------------------
# Data-Driven Config Loaders (Brand, Services, Geo-Silo Towns)
# ------------------------------------------------------------------------------

def format_phone(p: str) -> str:
    if not p:
        return ""
    digits = "".join(c for c in p if c.isdigit())
    if len(digits) == 11 and digits.startswith("1"):
        digits = digits[1:]
    if len(digits) == 10:
        return f"({digits[:3]}) {digits[3:6]}-{digits[6:]}"
    return p

def load_brand_config() -> Dict[str, Any]:
    brand_file = PROJECT_ROOT / "config" / "brand.yaml"
    if not brand_file.exists():
        brand_file = PROJECT_ROOT / "brand.yaml"
    data = {}
    if brand_file.exists():
        with open(brand_file, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
    else:
        data = {
            "brand_name": settings.BUSINESS_NAME,
            "primary_phone": settings.PRIMARY_PHONE,
            "base_city": settings.PRIMARY_CITY,
            "state": settings.PRIMARY_STATE
        }
    data["formatted_phone"] = format_phone(data.get("primary_phone", settings.PRIMARY_PHONE))
    return data

def load_services_data() -> List[Dict[str, Any]]:
    services_file = PROJECT_ROOT / "config" / "services.json"
    if services_file.exists():
        with open(services_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def load_towns_data() -> List[Dict[str, Any]]:
    towns_file = PROJECT_ROOT / "config" / "towns.json"
    if towns_file.exists():
        with open(towns_file, "r", encoding="utf-8") as f:
            return json.load(f)
    return []

def get_town_by_slug(slug: str) -> Optional[Dict[str, Any]]:
    towns = load_towns_data()
    for town in towns:
        if town.get("slug") == slug:
            return town
    return None

def get_town_by_name_or_slug(query: str) -> Dict[str, Any]:
    towns = load_towns_data()
    if not towns:
        return {
            "slug": "roofing-toms-river-nj",
            "town_name": "Toms River",
            "county": "Ocean County",
            "state": "NJ",
            "zip_codes": ["08753"],
            "neighborhoods": ["Silverton"],
            "lat": 39.9537,
            "lon": -74.1979
        }
    if not query:
        return towns[0]
    q = query.strip().lower()
    for town in towns:
        if town.get("slug", "").lower() == q or town.get("town_name", "").lower() == q:
            return town
        if town.get("town_name", "").lower() in q or q in town.get("town_name", "").lower():
            return town
    return towns[0]

def get_output_path(*subpaths: str) -> str:
    """
    Resolves and automatically creates directories under settings.OUTPUT_DIR.
    Ensures safe output routing to Google Drive or local ./outputs fallback.
    """
    base_dir = settings.OUTPUT_DIR
    try:
        target = os.path.join(base_dir, *subpaths)
        parent = os.path.dirname(target) if "." in os.path.basename(target) else target
        os.makedirs(parent, exist_ok=True)
        return target
    except Exception:
        fallback_dir = os.path.join(str(PROJECT_ROOT), "outputs")
        target = os.path.join(fallback_dir, *subpaths)
        parent = os.path.dirname(target) if "." in os.path.basename(target) else target
        os.makedirs(parent, exist_ok=True)
        return target
