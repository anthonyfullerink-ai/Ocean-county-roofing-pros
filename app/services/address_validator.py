import logging
import httpx
import re
from typing import Dict, Any, Optional, Tuple

logger = logging.getLogger(__name__)

def extract_numerical_component(raw: str) -> Tuple[Optional[str], str]:
    """
    Extracts the numerical house or unit number (e.g. '15 b', '15B', '1918', '45-A').
    Returns: (house_number_str, remaining_street_str)
    """
    clean = raw.strip()
    # Match patterns like '15 b', '15B', '1918', '45A', '100-B'
    m = re.match(r"^(\d+\s*[-/]?[a-zA-Z]?|\d+\s+[a-zA-Z])\s+(.+)$", clean, re.IGNORECASE)
    if m:
        num = re.sub(r"\s+", "", m.group(1)).upper()
        rest = m.group(2).strip()
        return num, rest
    m2 = re.match(r"^(\d+)\s+(.+)$", clean)
    if m2:
        return m2.group(1), m2.group(2).strip()
    return None, clean


def verify_address_online(raw_address: str) -> Dict[str, Any]:
    """
    Validates a residential or commercial address in Ocean & Monmouth County, NJ.
    MANDATORY REQUIREMENT: A numerical house/building number must be present.
    Uses official US Census Bureau Geocoder API first, with fallback to OpenStreetMap Nominatim.
    Preserves and highlights the exact numerical house and unit number.
    """
    if not raw_address or len(raw_address.strip()) < 3:
        return {
            "valid": False,
            "has_number": False,
            "message": "The address provided is incomplete. Please ask the caller: 'What is your house number, street name, and town?'"
        }

    clean = raw_address.strip()
    house_num, street_remainder = extract_numerical_component(clean)

    # 1. Enforce numerical house number requirement
    if not house_num:
        logger.warning(f"Address '{raw_address}' is missing a house/unit number.")
        return {
            "valid": False,
            "has_number": False,
            "message": (
                f"Missing house number for '{raw_address}'. A numerical house or building number is strictly mandatory for our estimator. "
                f"Please ask the caller: 'Could you please give me the house or building number on {street_remainder}?'"
            )
        }

    search_query = clean
    if "NJ" not in search_query.upper() and "NEW JERSEY" not in search_query.upper():
        search_query += ", NJ"

    # 2. Try US Census Bureau Geocoding API
    try:
        url = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress"
        params = {
            "address": search_query,
            "benchmark": "Public_AR_Current",
            "format": "json"
        }
        res = httpx.get(url, params=params, timeout=4.0)
        if res.status_code == 200:
            data = res.json()
            matches = data.get("result", {}).get("addressMatches", [])
            if matches:
                top = matches[0]
                matched_str = top.get("matchedAddress", "")
                parts = [p.strip().title() for p in matched_str.split(",")]
                
                # Census matchedAddress might have only the street number (e.g. 15 SOUTHBROOK DR)
                # Ensure the caller's specific unit letter (e.g. 15B) is retained
                census_street = parts[0] if parts else street_remainder
                if not census_street.upper().startswith(house_num.upper()):
                    census_street = f"{house_num} {re.sub(r'^\d+\s*', '', census_street)}"
                
                city = parts[1] if len(parts) > 1 else "Toms River"
                zip_code = parts[3] if len(parts) > 3 else "08753"

                formatted = f"{census_street}, {city}, NJ {zip_code}".strip()
                logger.info(f"[ADDRESS VALIDATED via US Census] '{raw_address}' -> '{formatted}'")
                return {
                    "valid": True,
                    "has_number": True,
                    "formatted_address": formatted,
                    "street": census_street,
                    "city": city,
                    "zip": zip_code,
                    "county": "Ocean/Monmouth",
                    "source": "US Census Bureau",
                    "message": f"Address verified: {formatted}."
                }
    except Exception as e:
        logger.warning(f"Census geocoder error: {e}")

    # 3. Try OpenStreetMap Nominatim Geocoder
    try:
        url = "https://nominatim.openstreetmap.org/search"
        headers = {"User-Agent": "OceanCountyRoofingPros/1.0 (anthony.fuller.ink@gmail.com)"}
        params = {
            "q": search_query,
            "format": "json",
            "addressdetails": 1,
            "countrycodes": "us"
        }
        res = httpx.get(url, params=params, headers=headers, timeout=4.0)
        if res.status_code == 200:
            data = res.json()
            if data:
                top = data[0]
                addr = top.get("address", {})
                road = addr.get("road") or street_remainder
                city = addr.get("city") or addr.get("town") or addr.get("village") or addr.get("suburb", "Toms River")
                county = addr.get("county", "Ocean/Monmouth County")
                zip_code = addr.get("postcode", "")

                # CRITICAL: Always prepend the spoken house/unit number if Nominatim only returns the street
                street_str = f"{house_num} {road}".strip()
                formatted = f"{street_str}, {city}, NJ {zip_code}".strip(", ")
                logger.info(f"[ADDRESS VALIDATED via Nominatim] '{raw_address}' -> '{formatted}'")
                return {
                    "valid": True,
                    "has_number": True,
                    "formatted_address": formatted,
                    "street": street_str,
                    "city": city,
                    "zip": zip_code,
                    "county": county,
                    "source": "OpenStreetMap",
                    "message": f"Address verified: {formatted}."
                }
    except Exception as e:
        logger.warning(f"Nominatim geocoder error: {e}")

    # 4. Fallback if geocoders were unreachable but caller gave a clean number and street
    if house_num and len(street_remainder) > 3:
        formatted = f"{house_num} {street_remainder.title()}, NJ".strip()
        logger.info(f"[ADDRESS HEURISTIC] Using structured address: '{formatted}'")
        return {
            "valid": True,
            "has_number": True,
            "formatted_address": formatted,
            "street": f"{house_num} {street_remainder.title()}",
            "city": "Ocean/Monmouth",
            "zip": "",
            "source": "Heuristic Parser",
            "message": f"Address recognized: {formatted}."
        }

    return {
        "valid": False,
        "has_number": False,
        "formatted_address": raw_address,
        "message": (
            f"Could not verify '{raw_address}' on the map. "
            f"Please ask the caller to confirm their house number, street name, and town in Ocean or Monmouth County."
        )
    }
