#!/usr/bin/env python3
"""
Automated SEO Blog + Google Flow Media Generator for Ocean County Roofing Pros.

Features:
- Generates contractor-agnostic, hyper-local Ocean County & Monmouth County roofing guides
  covering GAF, CertainTeed, Owens Corning, Standing Seam Metal, Flat/TPO, and VELUX systems.
- Integrates with Google Flow Connector CLI (`flow-auto`) for Nano Banana Pro hero imagery
  and Veo explainer videos (`app/static/blog/<slug>/`), with Pillow WebP + JPG optimization
  (JPG preserved for Meta Instagram/Facebook Graph API compatibility).
- Preflights `flow-auto status --site flow` so jobs never hang when the Flow Chrome tab is
  hidden or free-plan queue is paused.
- Upserts articles directly into Supabase `public.blog_posts` (+ local SQLite mirror) and
  rebuilds static HTML + sitemap via `build_static.py`.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from PIL import Image  # noqa: E402
from app.config import get_town_by_name_or_slug  # noqa: E402
from app.services.db import (  # noqa: E402
    get_blog_post,
    init_db,
    list_blog_posts,
    update_blog_post,
    upsert_blog_post,
)

STATIC_BLOG_DIR = PROJECT_ROOT / "app" / "static" / "blog"
FORBIDDEN_TERMS = ("319 webster", "webster avenue")

CURATED_TOPIC_BACKLOG: List[Dict[str, str]] = [
    {
        "slug": "lbi-barrier-island-standing-seam-metal-vs-class-4-shingle",
        "title": "LBI & Barrier Island Roofs: Standing Seam Metal vs. Class 4 Impact Shingles",
        "category": "Coastal Engineering",
        "towns": "Manahawkin, Barnegat, Point Pleasant",
        "keyword": "barrier island coastal roof metal vs shingle ocean county nj",
        "hero_prompt": (
            "Architectural editorial photograph of a coastal New Jersey Cape Cod home near Barnegat Bay "
            "with sleek matte charcoal standing seam metal roofing beside an architectural Class 4 shingle dormer, "
            "golden morning sunlight, blue ocean horizon, photorealistic DSLR lens, no text or logos"
        ),
        "video_prompt": (
            "Smooth aerial drone orbit showcasing coastal Ocean County NJ residential roof craftsmanship, "
            "interlocking ridge cap vents, copper and aluminum step flashing gleaming in ocean breeze, cinematic natural light"
        ),
    },
    {
        "slug": "ocean-county-attic-ventilation-ice-dam-heat-exhaust-guide",
        "title": "Ocean County Attic Ventilation Guide: Stopping Coastal Humidity, Mold & Ice Dams",
        "category": "Ventilation & Skylights",
        "towns": "Toms River, Brick, Jackson, Howell",
        "keyword": "attic ventilation ridge vent ocean county nj",
        "hero_prompt": (
            "Clean editorial cutaway architectural view of a New Jersey suburban roof showing balanced continuous "
            "soffit intake vents and baffled ridge exhaust airflow keeping roof decking cool and dry, crisp lighting, photorealistic, no text"
        ),
        "video_prompt": (
            "Gentle camera pan along a sunlit Ocean County architectural roof ridge line with continuous ridge vent "
            "and spotless cedar siding below, clear Atlantic sky, architectural showcase"
        ),
    },
    {
        "slug": "post-noreaster-roof-inspection-checklist-ocean-county-nj",
        "title": "Post-Nor'easter Roof Inspection Checklist for Ocean County Homeowners",
        "category": "Storm Recovery",
        "towns": "Toms River, Brick, Point Pleasant, Lacey, Barnegat",
        "keyword": "storm damage roof inspection checklist ocean county nj",
        "hero_prompt": (
            "Editorial wide-angle photograph of a certified roofing technician on a calm morning after a coastal storm "
            "inspecting chimney step flashing and architectural shingles with a digital tablet on an Ocean County home, no company logos, no text"
        ),
        "video_prompt": (
            "Calm sunrise drone flyover inspecting intact coastal NJ residential roof slopes, spotless gutters, and sealed chimney flashing after windstorm"
        ),
    },
    {
        "slug": "velux-solar-skylight-flashing-leak-prevention-nj-shore",
        "title": "Skylight Replacement & Curb Flashing along the Jersey Shore: Preventing Nor'easter Leaks",
        "category": "Ventilation & Skylights",
        "towns": "Point Pleasant, Brick, Toms River, Freehold",
        "keyword": "skylight replacement leak prevention ocean county nj",
        "hero_prompt": (
            "Modern New Jersey coastal home exterior featuring three flush-mounted tempered glass roof skylights "
            "with step-flashed charcoal architectural shingles and blue sky reflections, photorealistic architectural photography, no text"
        ),
        "video_prompt": (
            "Slow exterior dolly motion looking across flushed roof skylights installed neatly into laminated shingles on a coastal NJ home"
        ),
    },
    {
        "slug": "pine-barrens-oak-tree-debris-algae-roof-care-jackson-howell",
        "title": "Pine Needles, Shade Moss & Gutter Backups in Jackson, Howell & Lacey Township",
        "category": "Coastal Engineering",
        "towns": "Jackson, Howell, Lacey, Lakewood",
        "keyword": "roof moss algae pine needle damage jackson howell nj",
        "hero_prompt": (
            "Architectural photo of a residential New Jersey home surrounded by tall pitch pines with a clean "
            "copper-granule algae-resistant dimensional shingle roof and seamless leaf-free aluminum gutters, crisp afternoon light, no text"
        ),
        "video_prompt": (
            "Smooth low-altitude drone glide over a wooded Jackson NJ neighborhood showing clean algae-free shingle roofs framed by pine trees"
        ),
    },
]


def slugify(text: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return s or f"ocean-county-guide-{int(datetime.now().timestamp())}"


def resolve_flow_auto_bin() -> Optional[str]:
    return shutil.which("flow-auto") or shutil.which("flow-auto.cmd")


def check_flow_ready(timeout_sec: int = 12) -> Tuple[bool, str]:
    """
    Verify Google Flow bridge, extension connection, visible tab, and unpaused queue.
    Matches `flow-generate` skill requirements so we never stall on a hidden tab.
    """
    bin_path = resolve_flow_auto_bin()
    if not bin_path:
        return False, "flow-auto CLI not found on PATH"

    try:
        proc = subprocess.run(
            [bin_path, "status", "--site", "flow"],
            capture_output=True,
            text=True,
            timeout=timeout_sec,
            check=False,
        )
    except Exception as exc:
        return False, f"flow-auto status failed: {exc}"

    output = f"{proc.stdout}\n{proc.stderr}".strip()
    lower = output.lower()
    if proc.returncode != 0:
        return False, f"flow-auto status returned {proc.returncode}: {output}"
    if "extension (flow): connected" not in lower and "extension" not in lower:
        return False, f"Flow Chrome extension not connected:\n{output}"
    if "flow tab: hidden" in lower or "hidden" in lower and "bring it to the front" in lower:
        return False, "Flow Chrome tab is HIDDEN — bring flow.google.com window to front first."
    if "queue: paused" in lower:
        return False, "Flow queue is PAUSED — open the Flow Connector side panel in Chrome."
    return True, output


def _extract_media_path(stdout_text: str, extensions: Tuple[str, ...]) -> Optional[Path]:
    for line in reversed(stdout_text.splitlines()):
        stripped = line.strip()
        if stripped.startswith("{") and stripped.endswith("}"):
            try:
                data = json.loads(stripped)
                candidates = []
                for key in ("output_path", "outputPath", "path", "file", "localPath"):
                    if isinstance(data.get(key), str):
                        candidates.append(data[key])
                for list_key in ("files", "outputs", "artifacts"):
                    items = data.get(list_key)
                    if isinstance(items, list):
                        for item in items:
                            if isinstance(item, str):
                                candidates.append(item)
                            elif isinstance(item, dict) and isinstance(item.get("path"), str):
                                candidates.append(item["path"])
                for cand in candidates:
                    p = Path(cand)
                    if any(cand.lower().endswith(ext) for ext in extensions) and p.exists():
                        return p
            except Exception:
                pass

        unquoted = stripped.strip('"').strip("'")
        for ext in extensions:
            match = re.search(rf"([A-Za-z]:\\[^\r\n\"']+{re.escape(ext)}|/[^\r\n\"']+{re.escape(ext)})", unquoted, re.I)
            if match:
                candidate = Path(match.group(1))
                if candidate.exists():
                    return candidate
        if any(unquoted.lower().endswith(ext) for ext in extensions) and Path(unquoted).exists():
            return Path(unquoted)
    return None


def _clean_flow_watermark(bin_path: str, file_path: Path) -> Path:
    dest_ext = ".png" if file_path.suffix.lower() in {".webp", ".png", ".jpg", ".jpeg"} else file_path.suffix
    cleaned_dest = file_path.with_name(f"{file_path.stem}-clean{dest_ext}")
    try:
        proc = subprocess.run(
            [bin_path, "clean", str(file_path), "-o", str(cleaned_dest), "--mark", "flow", "--json"],
            capture_output=True,
            text=True,
            timeout=90,
            check=False,
        )
        if cleaned_dest.exists():
            return cleaned_dest
        cleaned = _extract_media_path(proc.stdout + "\n" + proc.stderr, (".png", file_path.suffix))
        if cleaned and cleaned.exists():
            return cleaned
    except Exception:
        pass
    return file_path


def run_flow_image(slug: str, prompt: str, model: str = "nano-banana-pro") -> Optional[Tuple[str, str]]:
    """
    Generate hero image via Google Flow (`flow-text-to-image`), clean Flow sparkle mark,
    and save WebP + JPG copies in `app/static/blog/<slug>/`.
    Returns `(webp_url, jpg_url)` or None.
    """
    bin_path = resolve_flow_auto_bin()
    if not bin_path:
        return None
    ready, reason = check_flow_ready()
    if not ready:
        print(f"[Flow Image Skipped] {reason}")
        return None

    proc = subprocess.run(
        [
            bin_path,
            "generate",
            "create",
            "flow-text-to-image",
            "--prompt",
            prompt,
            "--model",
            model,
            "--aspect-ratio",
            "16:9",
            "--wait",
            "--wait-timeout",
            "5",
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=340,
        check=False,
    )
    if proc.returncode != 0:
        print(f"[Flow Image Error] {proc.stdout}\n{proc.stderr}")
        return None

    raw_path = _extract_media_path(proc.stdout + "\n" + proc.stderr, (".png", ".jpg", ".jpeg", ".webp"))
    if not raw_path:
        print(f"[Flow Image Error] Could not parse output image path:\n{proc.stdout}")
        return None

    raw_path = _clean_flow_watermark(bin_path, raw_path)
    out_dir = STATIC_BLOG_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    webp_dest = out_dir / "hero.webp"
    jpg_dest = out_dir / "hero.jpg"

    with Image.open(raw_path) as img:
        rgb = img.convert("RGB")
        if rgb.width > 1400:
            new_h = int(rgb.height * (1400 / rgb.width))
            rgb = rgb.resize((1400, new_h), Image.Resampling.LANCZOS)
        rgb.save(webp_dest, "WEBP", quality=86, method=6)
        rgb.save(jpg_dest, "JPEG", quality=88, optimize=True)

    return f"/static/blog/{slug}/hero.webp", f"/static/blog/{slug}/hero.jpg"


def run_flow_video(slug: str, prompt: str, model: str = "omni-flash", duration: int = 6) -> Optional[str]:
    """
    Generate explainer MP4 via Google Flow (`flow-text-to-video`), clean sparkle mark,
    and save to `app/static/blog/<slug>/<slug>.mp4`.
    """
    bin_path = resolve_flow_auto_bin()
    if not bin_path:
        return None
    ready, reason = check_flow_ready()
    if not ready:
        print(f"[Flow Video Skipped] {reason}")
        return None

    proc = subprocess.run(
        [
            bin_path,
            "generate",
            "create",
            "flow-text-to-video",
            "--prompt",
            prompt,
            "--model",
            model,
            "--duration",
            str(duration),
            "--aspect-ratio",
            "16:9",
            "--resolution",
            "720p",
            "--wait",
            "--wait-timeout",
            "7",
            "--json",
        ],
        capture_output=True,
        text=True,
        timeout=460,
        check=False,
    )
    if proc.returncode != 0:
        print(f"[Flow Video Error] {proc.stdout}\n{proc.stderr}")
        return None

    raw_mp4 = _extract_media_path(proc.stdout + "\n" + proc.stderr, (".mp4",))
    if not raw_mp4:
        print(f"[Flow Video Error] Could not parse output MP4 path:\n{proc.stdout}")
        return None

    raw_mp4 = _clean_flow_watermark(bin_path, raw_mp4)
    out_dir = STATIC_BLOG_DIR / slug
    out_dir.mkdir(parents=True, exist_ok=True)
    mp4_dest = out_dir / f"{slug}.mp4"
    shutil.copy2(raw_mp4, mp4_dest)
    return f"/static/blog/{slug}/{slug}.mp4"


def _sanitize_forbidden(text: str) -> str:
    for term in FORBIDDEN_TERMS:
        if term in text.lower():
            raise ValueError(f"Blocked forbidden address reference in generated content: {term}")
    return text


def build_article_payload(
    title: str,
    towns: str = "Toms River, Brick, Point Pleasant",
    category: str = "Coastal Materials",
    keyword: str = "",
    slug: Optional[str] = None,
    status: str = "draft_auto_24h",
    hero_image_url: str = "/static/images/shingle-restored-after.webp",
    veo_video_url: str = "",
    veo_video_poster_url: str = "",
    post_id: Optional[str] = None,
) -> Dict[str, Any]:
    clean_slug = slug or slugify(title)
    now_dt = datetime.now(timezone.utc)
    now_iso = now_dt.isoformat()
    auto_pub_iso = (now_dt + timedelta(hours=24)).isoformat() if status == "draft_auto_24h" else ""
    town_names = [t.strip() for t in towns.split(",") if t.strip()] or ["Toms River", "Brick", "Point Pleasant"]
    town_str = ", ".join(town_names)

    target_towns: List[Dict[str, str]] = []
    for name in town_names:
        matched = get_town_by_name_or_slug(name)
        target_towns.append({
            "slug": matched["slug"] if matched else f"roofing-{slugify(name)}-nj",
            "label": matched["town_name"] if matched else name,
        })

    focus_label = keyword.strip() if keyword.strip() else title
    excerpt = (
        f"Contractor-agnostic field guidance for homeowners across {town_str} on {focus_label}: compare GAF, "
        f"CertainTeed, Owens Corning, Standing Seam Metal, Flat/TPO, and VELUX systems engineered for Ocean County coastal weather."
    )

    sections = [
        {
            "heading": f"Why {town_names[0]} & Ocean County Homes Require Coastal-Grade Specification",
            "paragraphs": [
                f"Across {town_str}, salt-laden Atlantic gusts, freeze-thaw winters, and nor'easter wind uplift punish builder-grade roof assemblies faster than inland New Jersey counties. When evaluating {focus_label} ({category}), independent inspections compare manufacturer-backed assemblies across GAF, CertainTeed, Owens Corning, Standing Seam Metal, Flat/TPO, and VELUX rather than locking homeowners into a single brand.",
                "In coastal wind-borne debris and salt-spray zones, fastening schedules, deck attachment, continuous ridge-and-soffit ventilation, and corrosion-resistant aluminum or copper flashing matter just as much as outer shingle or metal panel thickness. Many premature roof failures in Ocean County stem from reused step flashing, under-ventilated soffits, or 4-nail standard fastening instead of 6-nail coastal patterns.",
                f"Before scheduling repairs or a full tear-off in {town_str}, document existing decking conditions, attic moisture readings, and local municipal permit expectations so every contractor quote can be compared apples-to-apples."
            ],
            "bullets": [
                "Self-adhering ice-and-water membrane along eaves (minimum 24 inches inside the warm wall line), open/closed valleys, skylights, and chimney saddles.",
                "6-nail coastal fastening zones using corrosion-resistant ring-shank nails paired with factory starter strips at eaves and rakes.",
                "Balanced intake-to-exhaust attic airflow (1 sq ft of net free ventilation per 150-300 sq ft) engineered to prevent trapped coastal humidity and premature shingle blistering.",
                "Non-corrosive step, apron, and counter-flashing replacement around chimneys, dormers, sidewalls, and plumbing vent boots."
            ],
        },
        {
            "heading": f"Key Engineering Factors for {focus_label}",
            "paragraphs": [
                f"Homeowners researching {focus_label} in {town_str} encounter sharply different exposure risks depending on whether a property sits along open bayfront waterways, pine-canopy inland lots, or dense barrier-island blocks. Pine needles, oak debris, and salt crystals retain moisture along roof valleys and gutter aprons, accelerating granule loss and seam oxidation.",
                "A thorough 21-point diagnostic measures decking deflection, verifies plywood or OSB thickness (minimum 1/2-inch or 5/8-inch structural sheathing for coastal uplift), and inspects roof-to-wall intersections where wind-driven rain travels horizontally during nor'easters."
            ],
            "bullets": [
                "Underlayment upgrade: breathable synthetic underlayment resists tearing in high winds far better than 15 lb or 30 lb asphalt felt.",
                "Drip edge and gutter apron geometry: aluminum drip edge with a 1/2-inch kickout prevents capillary water wicking into fascia boards.",
                "Skylight and curb flashing: pairing roof replacement with VELUX No-Leak flashing kits avoids mismatched aftermarket seals."
            ],
        },
        {
            "heading": "Side-by-Side Manufacturer & Assembly Comparison",
            "paragraphs": [
                "Understanding how leading residential roofing systems perform in Ocean and Monmouth County micro-climates ensures you select the right assembly for your roofline pitch, wind exposure, and long-term budget."
            ],
            "table": {
                "headers": ["System / Manufacturer", "Primary Strength in Ocean County", "Best-Fit Home Profile"],
                "rows": [
                    ["GAF Timberline HDZ / ArmorShield II", "LayerLock wind uplift performance & Class 4 impact option", "Bayfront & inland pitched colonial/ranch homes"],
                    ["CertainTeed Landmark / ClimateFlex", "Heavyweight fiberglass mat & StreakFighter algae defense", "Tree-lined lots in Brick, Jackson & Toms River"],
                    ["Owens Corning Duration / Storm", "SureNail woven fabric fastening strip for storm gusts", "High-wind corridors along Route 37 & Route 70"],
                    ["Standing Seam Metal (Kynar 500)", "Concealed clips, 160+ MPH uplift tolerance, zero exposed screws", "Barrier islands, LBI & salt-spray exposures"],
                    ["Flat / TPO & EPDM", "Heat-welded seams for zero-slope coastal extensions & dormers", "Modern shore homes, porches & garage additions"],
                    ["VELUX Solar-Powered Skylights", "No-Leak flashing kits + 3 layers of water protection", "Dark halls & vaulted coastal living rooms"],
                ],
            },
            "callout": {
                "title": f"Local {town_names[0]} & Ocean County Evaluation Note",
                "body": (
                    f"Planning a project in {town_str}? Compare factory-certified options across manufacturers during a "
                    "zero-pressure, 100% free drone & attic diagnostic before signing any contract."
                ),
            },
        },
        {
            "heading": "Permits, Warranties & Post-Storm Documentation in Ocean County",
            "paragraphs": [
                f"Municipal construction offices across {town_str} enforce New Jersey Uniform Construction Code wind-uplift and ice-barrier rules. Always confirm whether your project requires a municipal roofing permit, framing/decking inspection, or HOA architectural approval for color and profile changes.",
                "When comparing extended manufacturer warranties from GAF, CertainTeed, Owens Corning, or coastal standing seam coil producers, verify that every system component — starter strip, underlayment, hip/ridge cap, and ventilation — qualifies under the warranty tier rather than mixing off-brand accessories."
            ],
            "bullets": [
                "Request itemized scope sheets separating base tear-off from per-sheet plywood decking replacement rates.",
                "Save pre-storm drone imagery and attic photos to substantiate future wind or hail insurance claims.",
                "Confirm annual valley and gutter cleanouts if your property sits beneath Lakewood, Jackson, or Lacey pine canopies."
            ],
        },
    ]

    faqs = [
        {
            "question": f"Which roofing brand lasts longest in {town_names[0]} and Ocean County?",
            "answer": "All major architectural lines — GAF, CertainTeed, and Owens Corning — achieve 30-to-50-year service life when paired with 6-nail coastal fastening and balanced ridge/soffit ventilation, while Standing Seam Metal leads on open barrier-island salt exposure.",
        },
        {
            "question": "Should roof valleys and flashing be replaced during a full tear-off?",
            "answer": "Yes. Reusing aged aluminum flashing or rusted nails beneath new shingles is a leading source of post-storm leaks around chimneys, dormers, and skylights in Ocean County.",
        },
        {
            "question": f"How does {focus_label} impact home insurance or coastal wind mitigation?",
            "answer": "Documenting 6-nail coastal fastening, sealed roof deck ice-and-water coverage, and Class 4 impact or 130+ MPH wind-rated assemblies helps homeowners verify storm-resilient construction standards with NJ carriers.",
        },
        {
            "question": "Can flat porch roofs and pitched main roofs be replaced together?",
            "answer": "Yes. Combining pitched GAF, CertainTeed, Owens Corning, or Standing Seam sections with heat-welded Flat/TPO membranes ensures watertight transition flashing where low-slope extensions meet the main wall or fascia.",
        },
    ]

    payload: Dict[str, Any] = {
        "id": post_id or f"BLOG-{clean_slug[:18].upper()}-{int(now_dt.timestamp()) % 10000}",
        "slug": clean_slug,
        "title": title,
        "meta_title": f"{title} | Ocean County Roofing Pros",
        "meta_description": excerpt[:160],
        "category": category,
        "excerpt": excerpt,
        "target_towns": target_towns,
        "sections": sections,
        "faqs": faqs,
        "hero_image_url": hero_image_url,
        "hero_image_alt": f"{title} — Ocean County, NJ Roofing Guide",
        "veo_video_url": veo_video_url,
        "veo_video_poster_url": veo_video_poster_url or hero_image_url,
        "reading_time_min": 6,
        "cta_service": "Free 21-Point Roof & Attic Inspection",
        "author_name": "Ocean County Roofing Pros Editorial Team",
        "status": status,
        "auto_publish_at": auto_pub_iso,
        "meta_shared": False,
        "published_at": now_iso if status == "published" else "",
        "created_at": now_iso,
        "updated_at": now_iso,
    }

    _sanitize_forbidden(json.dumps(payload))
    return payload


def run_generate_starter_media(with_video: bool = False) -> int:
    """Upgrade the 3 starter posts with Nano Banana hero images (+ optional Veo videos) via Google Flow."""
    starter_prompts = {
        "ocean-county-coastal-wind-ratings-110-vs-130-vs-160-mph": (
            "Architectural coastal New Jersey home near Barnegat Bay with wind-resistant charcoal architectural shingles "
            "and copper chimney flashing under dramatic clear blue sky, editorial photography, no text or watermarks"
        ),
        "salt-air-noreaster-flashing-damage-ocean-county": (
            "Close-up architectural detail of freshly installed step flashing, ice-and-water shield membrane, and "
            "dimensional roofing shingles on a coastal NJ shore roof in morning sunlight, photorealistic, no text"
        ),
        "ocean-county-nj-roof-replacement-cost-guide-2026": (
            "Clean aerial architectural photograph of two neighboring Ocean County NJ homes showcasing charcoal "
            "architectural shingles and a sleek standing seam metal porch accent roof, sunny crisp light, no text"
        ),
    }

    ready, reason = check_flow_ready()
    if not ready:
        print(f"Cannot run starter Flow generation right now: {reason}")
        return 1

    for slug, prompt in starter_prompts.items():
        post = get_blog_post(slug)
        if not post:
            continue
        imgs = run_flow_image(slug, prompt)
        updates: Dict[str, Any] = {}
        if imgs:
            updates["hero_image_url"] = imgs[0]
            updates["veo_video_poster_url"] = imgs[0]
        if with_video:
            vid = run_flow_video(slug, f"Smooth drone showcase of {post['title']} in Ocean County NJ, natural sunlight")
            if vid:
                updates["veo_video_url"] = vid
        if updates:
            update_blog_post(post["id"], updates)
            print(f"Updated starter guide {slug}: {updates}")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Ocean County Roofing Pros SEO Blog & Google Flow Generator")
    parser.add_argument("--topic", help="Article title / topic to generate")
    parser.add_argument("--towns", default="Toms River, Brick, Point Pleasant", help="Comma-separated Ocean County towns")
    parser.add_argument("--category", default="Coastal Engineering", help="Blog category")
    parser.add_argument("--keyword", default="", help="Primary SEO keyword")
    parser.add_argument("--slug", default="", help="Explicit URL slug")
    parser.add_argument("--status", default="draft_auto_24h", choices=["draft_auto_24h", "published", "archived"])
    parser.add_argument("--with-image", action="store_true", help="Generate Nano Banana hero image via flow-auto")
    parser.add_argument("--with-video", action="store_true", help="Generate Veo HTML5 MP4 video via flow-auto")
    parser.add_argument("--skip-flow", action="store_true", help="Skip Google Flow calls and use static fallback image")
    parser.add_argument("--auto-next", action="store_true", help="Pick the next unpublished backlog topic automatically")
    parser.add_argument("--list-backlog", action="store_true", help="List curated Ocean County SEO topic backlog")
    parser.add_argument("--generate-starter-media", action="store_true", help="Generate Flow media for starter posts")
    parser.add_argument("--no-build", action="store_true", help="Skip running build_static.py after saving")
    args = parser.parse_args(argv)

    init_db()

    if args.list_backlog:
        print(json.dumps(CURATED_TOPIC_BACKLOG, indent=2))
        return 0

    if args.generate_starter_media:
        code = run_generate_starter_media(with_video=args.with_video)
        if code == 0 and not args.no_build:
            import build_static
            build_static.main()
        return code

    selected: Optional[Dict[str, str]] = None
    if args.auto_next:
        existing_slugs = {p.get("slug") for p in list_blog_posts(sync_from_cloud=True)}
        selected = next((item for item in CURATED_TOPIC_BACKLOG if item["slug"] not in existing_slugs), CURATED_TOPIC_BACKLOG[0])

    title = args.topic or (selected["title"] if selected else "")
    if not title:
        parser.error("Provide --topic, --auto-next, --list-backlog, or --generate-starter-media")

    towns = args.towns if args.topic else (selected["towns"] if selected else args.towns)
    category = args.category if args.topic else (selected["category"] if selected else args.category)
    keyword = args.keyword or (selected["keyword"] if selected else "")
    slug = args.slug or (selected["slug"] if selected else slugify(title))

    hero_url = "/static/images/shingle-restored-after.webp"
    video_url = ""

    if not args.skip_flow and (args.with_image or args.with_video):
        hero_prompt = (selected["hero_prompt"] if selected else (
            f"Editorial architectural photograph illustrating {title} on an Ocean County New Jersey home, "
            "clean daylight, sharp roofing shingle and flashing craftsmanship, no text or logos"
        ))
        video_prompt = (selected["video_prompt"] if selected else (
            f"Smooth cinematic drone flyover of a coastal Ocean County New Jersey roof relevant to {title}, crisp natural light"
        ))
        if args.with_image:
            imgs = run_flow_image(slug, hero_prompt)
            if imgs:
                hero_url = imgs[0]
        if args.with_video:
            vid = run_flow_video(slug, video_prompt)
            if vid:
                video_url = vid

    payload = build_article_payload(
        title=title,
        towns=towns,
        category=category,
        keyword=keyword,
        slug=slug,
        status=args.status,
        hero_image_url=hero_url,
        veo_video_url=video_url,
        veo_video_poster_url=hero_url,
    )
    saved = upsert_blog_post(payload)
    print(f"Saved blog post: id={saved['id']} slug={saved['slug']} status={saved['status']}")

    if not args.no_build:
        import build_static
        build_static.main()

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
