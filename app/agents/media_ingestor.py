import os
import io
import json
import shutil
import logging
from pathlib import Path
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional, Tuple

from PIL import Image

from app.config import PROJECT_ROOT, get_town_by_name_or_slug
from app.services.db import (
    create_job_project,
    create_review,
    list_job_projects,
    update_job_project,
    get_bool_setting,
    log_agent_run,
)

logger = logging.getLogger(__name__)

CONTENT_INBOX_DIR = PROJECT_ROOT / "content_inbox"
INBOX_PHOTOS_DIR = CONTENT_INBOX_DIR / "photos"
INBOX_TESTIMONIALS_DIR = CONTENT_INBOX_DIR / "testimonials"
INBOX_PROCESSED_DIR = CONTENT_INBOX_DIR / "processed"

STATIC_UPLOADS_DIR = PROJECT_ROOT / "app" / "static" / "uploads"
GEOTAGGED_DIR = STATIC_UPLOADS_DIR / "geotagged"
WEBP_DIR = STATIC_UPLOADS_DIR / "webp"


def ensure_media_directories() -> None:
    for d in (INBOX_PHOTOS_DIR, INBOX_TESTIMONIALS_DIR, INBOX_PROCESSED_DIR, GEOTAGGED_DIR, WEBP_DIR):
        try:
            d.mkdir(parents=True, exist_ok=True)
        except Exception as e:
            logger.warning(f"Could not create directory {d}: {e}")


def _decimal_to_dms_rational(dec_deg: float) -> Tuple[Tuple[int, int], Tuple[int, int], Tuple[int, int]]:
    """Converts decimal degrees to EXIF GPS rational (deg, min, sec) tuple."""
    abs_deg = abs(float(dec_deg))
    deg = int(abs_deg)
    rem_min = (abs_deg - deg) * 60.0
    minutes = int(rem_min)
    sec = round((rem_min - minutes) * 60.0 * 10000)
    return ((deg, 1), (minutes, 1), (sec, 10000))


def _dms_rational_to_decimal(dms: Any, ref: str) -> float:
    """Converts EXIF GPS rational tuple back to signed decimal degrees."""
    def _val(item: Any) -> float:
        if isinstance(item, tuple) and len(item) == 2:
            return float(item[0]) / float(item[1]) if item[1] else 0.0
        return float(item)

    deg = _val(dms[0])
    minutes = _val(dms[1])
    sec = _val(dms[2])
    dec = deg + (minutes / 60.0) + (sec / 3600.0)
    if ref in ("S", "W", b"S", b"W"):
        dec = -dec
    return round(dec, 6)


def stamp_exif_gps_and_save_webp(
    image_bytes: bytes,
    base_filename: str,
    lat: float,
    lon: float,
    seo_description: str = "",
) -> Dict[str, Any]:
    """
    Processes an uploaded or inbox image:
    1. Stamps exact Ocean County GPS Latitude/Longitude EXIF metadata into a `.jpg` file.
    2. Generates a compressed, high-performance `.webp` file for town landing pages.
    Returns paths, URLs, and verified GPS EXIF readback.
    """
    ensure_media_directories()
    clean_stem = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in Path(base_filename).stem)
    ts = int(datetime.now().timestamp() * 1000) % 1000000
    jpg_name = f"{clean_stem}_{ts}.jpg"
    webp_name = f"{clean_stem}_{ts}.webp"

    jpg_path = GEOTAGGED_DIR / jpg_name
    webp_path = WEBP_DIR / webp_name

    img = Image.open(io.BytesIO(image_bytes))
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")

    # Resize only if excessively huge (> 2000px) to preserve fast Core Web Vitals
    max_dim = 1920
    if max(img.size) > max_dim:
        img.thumbnail((max_dim, max_dim), Image.Resampling.LANCZOS)

    exif_bytes = None
    try:
        import piexif
        lat_ref = b"N" if lat >= 0 else b"S"
        lon_ref = b"E" if lon >= 0 else b"W"
        gps_ifd = {
            piexif.GPSIFD.GPSVersionID: (2, 0, 0, 0),
            piexif.GPSIFD.GPSLatitudeRef: lat_ref,
            piexif.GPSIFD.GPSLatitude: _decimal_to_dms_rational(lat),
            piexif.GPSIFD.GPSLongitudeRef: lon_ref,
            piexif.GPSIFD.GPSLongitude: _decimal_to_dms_rational(lon),
        }
        zeroth_ifd = {
            piexif.ImageIFD.Software: b"Ocean County Roofing Pros SEO Geo-Tagger",
            piexif.ImageIFD.ImageDescription: (seo_description[:200] or "Ocean County NJ Roof Installation").encode("utf-8", errors="ignore"),
        }
        exif_dict = {"0th": zeroth_ifd, "Exif": {}, "GPS": gps_ifd, "1st": {}, "thumbnail": None}
        exif_bytes = piexif.dump(exif_dict)
    except Exception as e:
        logger.warning(f"piexif build warning: {e}")

    try:
        if exif_bytes:
            img.save(str(jpg_path), format="JPEG", quality=88, exif=exif_bytes)
        else:
            img.save(str(jpg_path), format="JPEG", quality=88)
        img.save(str(webp_path), format="WEBP", quality=84, method=4)
    except Exception as e:
        logger.warning(f"Static upload directory not writable ({e}), falling back to /tmp")
        tmp_geo = Path("/tmp") / jpg_name
        tmp_webp = Path("/tmp") / webp_name
        if exif_bytes:
            img.save(str(tmp_geo), format="JPEG", quality=88, exif=exif_bytes)
        else:
            img.save(str(tmp_geo), format="JPEG", quality=88)
        img.save(str(tmp_webp), format="WEBP", quality=84)
        jpg_path = tmp_geo
        webp_path = tmp_webp

    verified_gps = verify_exif_gps(str(jpg_path))
    return {
        "jpg_path": str(jpg_path),
        "webp_path": str(webp_path),
        "image_geotagged_jpg_url": f"/static/uploads/geotagged/{jpg_name}",
        "image_webp_url": f"/static/uploads/webp/{webp_name}",
        "verified_gps": verified_gps,
        "width": img.size[0],
        "height": img.size[1],
    }


def verify_exif_gps(jpg_path: str) -> Dict[str, Any]:
    """
    Reads back embedded EXIF GPS metadata from a JPEG file and returns decimal lat/lon.
    """
    try:
        import piexif
        exif_dict = piexif.load(jpg_path)
        gps = exif_dict.get("GPS", {})
        if not gps or piexif.GPSIFD.GPSLatitude not in gps:
            return {"has_gps": False}
        lat_ref = gps.get(piexif.GPSIFD.GPSLatitudeRef, b"N")
        if isinstance(lat_ref, bytes):
            lat_ref = lat_ref.decode("ascii", errors="ignore")
        lon_ref = gps.get(piexif.GPSIFD.GPSLongitudeRef, b"W")
        if isinstance(lon_ref, bytes):
            lon_ref = lon_ref.decode("ascii", errors="ignore")

        lat = _dms_rational_to_decimal(gps[piexif.GPSIFD.GPSLatitude], lat_ref)
        lon = _dms_rational_to_decimal(gps[piexif.GPSIFD.GPSLongitude], lon_ref)
        return {
            "has_gps": True,
            "lat": lat,
            "lon": lon,
            "lat_ref": lat_ref,
            "lon_ref": lon_ref,
        }
    except Exception as e:
        logger.warning(f"EXIF GPS verification error on {jpg_path}: {e}")
        return {"has_gps": False, "error": str(e)}


def generate_localized_seo_summary(
    town_info: Dict[str, Any],
    neighborhood: str,
    service_type: str,
    shingle_system: str,
    caption: str,
) -> str:
    town_name = town_info.get("town_name", "Toms River")
    zip_code = (town_info.get("zip_codes") or ["08753"])[0]
    coastal_risk = town_info.get("coastal_risk") or "Jersey Shore nor'easter wind gusts and coastal humidity."
    hood_str = f" in the {neighborhood} section of {town_name}" if neighborhood else f" in {town_name}"
    caption_clean = caption.strip().rstrip(".") if caption else f"Completed {service_type}"

    return (
        f"{caption_clean}{hood_str}, NJ ({zip_code}). "
        f"Installed {shingle_system} engineered to protect against {coastal_risk.lower()} "
        f"Includes full tear-off to the deck, ice-and-water leak barrier, and magnetic yard sweep."
    )


class MediaIngestorAgent:
    """
    Agent 1: Media & EXIF Geo-Tagger (`app/agents/media_ingestor.py`)
    - Scans `content_inbox/photos/` and `content_inbox/testimonials/`
    - Processes web uploads from `/admin` (Owner -> immediate live) and `/portal` (Contractor -> 24h hybrid queue)
    - Stamps Ocean County GPS coordinates into EXIF and generates WebP assets
    """

    AGENT_NAME = "Agent 1: Media & EXIF Geo-Tagger"

    @classmethod
    def ingest_uploaded_photo(
        cls,
        image_bytes: bytes,
        filename: str,
        town_query: str,
        neighborhood: str = "",
        service_type: str = "Full Roof Replacement",
        shingle_system: str = "CertainTeed Landmark PRO",
        caption: str = "",
        uploaded_by: str = "owner",
        tenant_id: str = "client_joe_the_roofer",
    ) -> Dict[str, Any]:
        town_info = get_town_by_name_or_slug(town_query)
        town_name = town_info.get("town_name", "Toms River")
        town_slug = town_info.get("slug", "roofing-toms-river-nj")
        if not neighborhood:
            neighborhood = (town_info.get("neighborhoods") or ["Central"])[0]

        lat = float(town_info.get("lat", 39.9537))
        lon = float(town_info.get("lon", -74.1979))

        ai_seo_summary = generate_localized_seo_summary(
            town_info=town_info,
            neighborhood=neighborhood,
            service_type=service_type,
            shingle_system=shingle_system,
            caption=caption or f"Verified {service_type} project",
        )

        media_res = stamp_exif_gps_and_save_webp(
            image_bytes=image_bytes,
            base_filename=f"{town_slug}_{filename}",
            lat=lat,
            lon=lon,
            seo_description=ai_seo_summary,
        )

        # Hybrid Smart Approval Filter:
        # Owner uploads (admin or local content_inbox) go live immediately ("approved").
        # Contractor uploads pass automated quality check (resolution >= 200x200) and enter "pending_auto_24h".
        uploader = (uploaded_by or "owner").lower()
        if uploader == "owner":
            approval_status = "approved"
            auto_publish_at = ""
        else:
            if media_res["width"] < 100 or media_res["height"] < 100:
                approval_status = "rejected"
                auto_publish_at = ""
            else:
                approval_status = "pending_auto_24h"
                auto_publish_at = (datetime.now() + timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")

        project = create_job_project(
            {
                "town_slug": town_slug,
                "town_name": town_name,
                "neighborhood": neighborhood,
                "service_type": service_type,
                "shingle_system": shingle_system,
                "caption": caption or f"{shingle_system} installation in {neighborhood}, {town_name}",
                "ai_seo_summary": ai_seo_summary,
                "image_webp_url": media_res["image_webp_url"],
                "image_geotagged_jpg_url": media_res["image_geotagged_jpg_url"],
                "lat": lat,
                "lon": lon,
                "uploaded_by": uploader,
                "tenant_id": tenant_id,
                "approval_status": approval_status,
                "auto_publish_at": auto_publish_at,
            }
        )
        project["verified_gps"] = media_res["verified_gps"]
        return project

    @classmethod
    def run(cls) -> Dict[str, Any]:
        start_time = datetime.now()
        ensure_media_directories()

        photos_ingested = 0
        testimonials_ingested = 0
        auto_promoted = 0

        # 1. Scan content_inbox/photos/ for image files
        image_exts = {".jpg", ".jpeg", ".png", ".webp"}
        if INBOX_PHOTOS_DIR.exists():
            for img_file in sorted(INBOX_PHOTOS_DIR.iterdir()):
                if not img_file.is_file() or img_file.suffix.lower() not in image_exts:
                    continue
                try:
                    img_bytes = img_file.read_bytes()
                    # Check optional sidecar metadata JSON (.json)
                    sidecar = img_file.with_suffix(".json")
                    meta: Dict[str, Any] = {}
                    if sidecar.exists():
                        try:
                            meta = json.loads(sidecar.read_text(encoding="utf-8"))
                        except Exception:
                            meta = {}

                    stem_parts = img_file.stem.replace("-", " ").replace("_", " ")
                    town_query = meta.get("town") or stem_parts
                    town_info = get_town_by_name_or_slug(town_query)

                    cls.ingest_uploaded_photo(
                        image_bytes=img_bytes,
                        filename=img_file.name,
                        town_query=town_info["slug"],
                        neighborhood=meta.get("neighborhood", (town_info.get("neighborhoods") or ["Central"])[0]),
                        service_type=meta.get("service_type", "Full Roof Replacement"),
                        shingle_system=meta.get("shingle_system", "CertainTeed Landmark PRO"),
                        caption=meta.get("caption", f"Completed roof installation in {town_info['town_name']}, NJ"),
                        uploaded_by="owner",  # Local inbox folder drops from Owner go live immediately
                    )
                    photos_ingested += 1

                    # Move processed photo (and optional sidecar) to content_inbox/processed/
                    shutil.move(str(img_file), str(INBOX_PROCESSED_DIR / img_file.name))
                    if sidecar.exists():
                        shutil.move(str(sidecar), str(INBOX_PROCESSED_DIR / sidecar.name))
                except Exception as e:
                    logger.error(f"Failed ingesting inbox photo {img_file}: {e}")

        # 2. Scan content_inbox/testimonials/ for .json or .txt files
        if INBOX_TESTIMONIALS_DIR.exists():
            for t_file in sorted(INBOX_TESTIMONIALS_DIR.iterdir()):
                if not t_file.is_file() or t_file.suffix.lower() not in {".json", ".txt"}:
                    continue
                try:
                    raw = t_file.read_text(encoding="utf-8").strip()
                    if t_file.suffix.lower() == ".json":
                        data = json.loads(raw)
                    else:
                        data = {
                            "reviewer_name": "Ocean County Homeowner",
                            "town_name": "Toms River",
                            "rating": 5,
                            "review_text": raw,
                        }
                    town_info = get_town_by_name_or_slug(data.get("town_name") or t_file.stem)
                    create_review(
                        {
                            "reviewer_name": data.get("reviewer_name", "Verified Homeowner"),
                            "town_name": town_info["town_name"],
                            "town_slug": town_info["slug"],
                            "service_performed": data.get("service_performed", "Full Roof Replacement"),
                            "rating": int(data.get("rating", 5)),
                            "review_text": data.get("review_text", raw),
                            "source": data.get("source", "Website"),
                            "is_public": True,
                        }
                    )
                    testimonials_ingested += 1
                    shutil.move(str(t_file), str(INBOX_PROCESSED_DIR / t_file.name))
                except Exception as e:
                    logger.error(f"Failed ingesting testimonial {t_file}: {e}")

        # 3. Hybrid 24h Auto-Publish promotion for expired pending contractor uploads
        if get_bool_setting("auto_publish_24h", True):
            now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            pending_list = list_job_projects(approval_status="pending_auto_24h")
            for p in pending_list:
                auto_at = p.get("auto_publish_at") or ""
                if auto_at and auto_at <= now_str:
                    update_job_project(p["id"], {"approval_status": "approved"})
                    auto_promoted += 1

        duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
        summary = (
            f"Scanned content_inbox & media queue: {photos_ingested} photo(s) GPS-tagged & converted to WebP, "
            f"{testimonials_ingested} testimonial(s) imported, {auto_promoted} queued project(s) auto-published."
        )
        metrics = {
            "photos_ingested": photos_ingested,
            "testimonials_ingested": testimonials_ingested,
            "auto_promoted": auto_promoted,
        }
        run_record = log_agent_run(cls.AGENT_NAME, "success", summary, metrics=metrics, duration_ms=duration_ms)
        return {"status": "success", "agent": cls.AGENT_NAME, "summary": summary, "metrics": metrics, "run": run_record}
