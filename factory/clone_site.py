import os
import shutil
import argparse
import yaml
import json
from pathlib import Path

FACTORY_DIR = Path(__file__).resolve().parent
PROJECT_TEMPLATE = FACTORY_DIR.parent

def clone_new_asset(niche: str, brand: str, city: str, state: str, phone: str, target_dir: str):
    """
    Clones the core Rank & Rent template and customizes brand.yaml, towns.json,
    and configurations for the new niche and location.
    """
    dest = Path(target_dir).resolve()
    print(f"Creating new Rank & Rent asset: '{brand}' in {city}, {state}...")
    print(f"Destination: {dest}")

    if dest.exists():
        print(f"[ERROR] Target directory already exists: {dest}")
        return False

    os.makedirs(dest, exist_ok=True)

    # 1. Copy core application directories
    dirs_to_copy = ["app", "google_sheet_setup", "vapi"]
    for d in dirs_to_copy:
        src_path = PROJECT_TEMPLATE / d
        if src_path.exists():
            shutil.copytree(src_path, dest / d)

    # 2. Copy root files
    files_to_copy = ["requirements.txt", "README.md", "BRAND.md", "AGENTS.md"]
    for f in files_to_copy:
        src_file = PROJECT_TEMPLATE / f
        if src_file.exists():
            shutil.copy2(src_file, dest / f)

    # 3. Create config directory
    config_dir = dest / "config"
    os.makedirs(config_dir, exist_ok=True)

    # 4. Generate new customized brand.yaml
    brand_slug = brand.lower().replace(" ", "-")
    brand_data = {
        "brand_id": brand_slug,
        "brand_name": brand,
        "tagline": f"{city}'s Trusted {niche.title()} & Emergency Service",
        "primary_phone": phone,
        "base_city": city,
        "state": state,
        "visual": {
            "palette": {
                "primary": "#0F1E36",
                "secondary": "#1E40AF",
                "accent": "#F97316",
                "surface": "#F8FAFC",
                "text_primary": "#0F172A",
                "trust_green": "#15803D"
            },
            "typography": {
                "headline_font": "Plus Jakarta Sans",
                "body_font": "Plus Jakarta Sans"
            }
        },
        "trust_signals": {
            "license": f"Licensed & Insured {state} Contractor",
            "insurance": "$2,000,000 General Liability",
            "offer": "Free On-Site 21-Point Inspection & Estimate",
            "response_time": "24/7 Rapid Dispatch"
        }
    }

    with open(config_dir / "brand.yaml", "w", encoding="utf-8") as f:
        yaml.dump(brand_data, f, sort_keys=False)

    # 5. Generate boilerplate towns.json
    towns_data = [
        {
            "slug": f"{niche}-{city.lower().replace(' ', '-')}-{state.lower()}",
            "town_name": city,
            "county": f"{city} Metro",
            "state": state,
            "zip_codes": ["00000"],
            "neighborhoods": ["Downtown", "North Side", "West Suburbs", "East Suburbs"],
            "coastal_risk": f"Local seasonal weather risks and rapid emergency dispatch across {city}.",
            "meta_title": f"Top-Rated {niche.title()} in {city}, {state} | {brand}",
            "meta_description": f"Licensed & insured {niche} in {city}, {state}. Free 21-point inspection and fast emergency dispatch.",
            "lat": 40.0,
            "lon": -74.0
        }
    ]

    with open(config_dir / "towns.json", "w", encoding="utf-8") as f:
        json.dump(towns_data, f, indent=2)

    # 6. Copy services.json
    shutil.copy2(PROJECT_TEMPLATE / "config" / "services.json", config_dir / "services.json")

    # 7. Generate clean .env file
    env_content = (
        f'PORT=8000\n'
        f'HOST=0.0.0.0\n'
        f'DEBUG=True\n'
        f'BUSINESS_NAME="{brand}"\n'
        f'PRIMARY_PHONE="{phone}"\n'
        f'PRIMARY_CITY="{city}"\n'
        f'PRIMARY_STATE="{state}"\n'
        f'ENABLE_OUTBOUND_CALLBACK=True\n'
        f'ENABLE_SMS_CONFIRMATION=True\n'
        f'MOCK_MODE=True\n'
        f'OUTPUT_DIR="./outputs"\n'
    )
    with open(dest / ".env", "w", encoding="utf-8") as f:
        f.write(env_content)

    print(f"\n[SUCCESS] New Rank & Rent asset created in: {dest}")
    print(f"To run it:")
    print(f"  Set-Location \"{dest}\"")
    print(f"  uvicorn app.main:app --reload --port 8000")
    return True

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Rank & Rent Asset Cloning Factory")
    parser.add_argument("--niche", required=True, help="Trade niche (e.g. 'tree-service', 'epoxy-flooring')")
    parser.add_argument("--brand", required=True, help="Brand name (e.g. 'Denver Tree Pros')")
    parser.add_argument("--city", required=True, help="Primary city (e.g. 'Denver')")
    parser.add_argument("--state", required=True, help="State abbreviation (e.g. 'CO')")
    parser.add_argument("--phone", default="+15550001122", help="Primary tracking phone number")
    parser.add_argument("--dest", required=True, help="Destination directory path")

    args = parser.parse_args()
    clone_new_asset(args.niche, args.brand, args.city, args.state, args.phone, args.dest)
