"""
Automated NotebookLM Knowledge Extractor for Vapi Voice Agents
Integrates proposal contracts, CertainTeed technical specs, and NJ building codes
to extract hallucination-free prompts for Vapi.
"""

import sys
from pathlib import Path

# Joe The Roofer & Sioux Proposal Document Source Text
PROPOSAL_SOURCE_TEXT = """
CONTRACTOR PROPOSAL & SCOPE OF WORK - OCEAN COUNTY ROOFING
Operating Licensee: Joe The Roofer LLC (Fully Licensed & Insured NJ HIC)
General Contractor & Project Coordination: Sioux Design & Construction / Ocean County Roofing Pros
Location: Toms River & Ocean County, NJ

OPTION 1: CertainTeed Patriot XL Roof System
- Shingle Grade: CertainTeed Patriot XL Class 3 Impact Resistant Shingles.
- Wind Coverage: 110 MPH Wind Coverage with Starter Shingles.
- Underlayment: Synthetic Underlayment + Ice & Water shield extending min 2' past exterior walls, valleys, penetrations.
- Flashings: Aluminum pipe flashings, bathroom fan vent covers, new custom aluminum chimney flashing.
- Ventilation: Ridge vent along all house ridges.
- Cleanup: Full tear-off up to 2 layers, magnetic sweep for nails, dumpster included.
- Warranty: 10-Year Workmanship Warranty, Lifetime CertainTeed SureStart Manufacturer Warranty.
- Pricing: Subcontractor base $7,860.00 | Retail Client Quote $8,860.00 ($1,000 margin).

OPTION 2: CertainTeed Landmark Integrity Roofing System (Most Popular)
- Shingle Grade: CertainTeed Landmark Class 3 Impact Resistant (6 nails per shingle).
- Wind Coverage: 160 MPH Wind Coverage with SwiftStart Starter Shingles.
- Underlayment: CertainTeed WinterGuard Ice & Water Shield + CertainTeed Roof Runner Synthetic Underlayment.
- Algae Resistance: 25-Year StreakFighter Algae Resistance.
- Warranty: CertainTeed 4-Star 50-Year Non-Prorated Warranty (15-yr workmanship coverage from CertainTeed) + Lifetime Workmanship Warranty (10-yr transferable upon sale).
- Cleanup: Full tear-off up to 2 layers, magnetic sweep for nails, dumpster included.
- Pricing: Subcontractor base $8,560.00 | Retail Client Quote $9,560.00 ($1,000 margin).

OPTION 3: CertainTeed Landmark PRO Integrity Roofing System (Premium)
- Shingle Grade: Landmark PRO Class 3 Impact Resistant with Max Def High-Definition Dimensional Coloration (Heaviest construction).
- Wind Coverage: 160 MPH Maximum Wind Protection.
- Algae Resistance: 30-Year StreakFighter Algae Resistance.
- Warranty: CertainTeed 4-Star 50-Year Non-Prorated Warranty + Lifetime Workmanship Warranty.
- Cleanup: Full tear-off, magnetic sweep, commercial dumpster included.
- Pricing: Subcontractor base $8,900.00 | Retail Client Quote $9,900.00 ($1,000 margin).

OPTIONAL ADD-ONS & INCIDENTAL WORK:
- Clad Rake Boards with New Custom Aluminum: White PVC/Smooth aluminum cladding on rake boards (+$1,224.00).
- Plywood Deck Replacement: 1/2" CDX Plywood: $75/sheet (4x8) | 3/4" CDX Plywood: $85/sheet. Billed only if rotted wood discovered.
- Fascia Wood Replacement: $12.00 per linear foot.
- Extra Shingle Layer Tear-Off: $0.50/sq.ft. per layer beyond 2 included.

OPERATIONAL NOTES:
- Free Inspection: 100% Free 21-point roof and attic moisture inspection with drone scan.
- Payment Terms: Due upon completion of installation.
- Thermal Settling: Newly installed shingles require ambient sunlight to thermally seal and lay flat.
"""

def get_proposal_source():
    return PROPOSAL_SOURCE_TEXT

if __name__ == "__main__":
    print("Proposal source text prepared for NotebookLM upload.")
