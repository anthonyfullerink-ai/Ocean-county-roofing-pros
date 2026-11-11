import os
import yaml
import logging
from pathlib import Path
from typing import Dict, Any, List, Optional
from pydantic import BaseModel

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent
TENANTS_DIR = PROJECT_ROOT / "config" / "tenants"
ACTIVE_TENANT_FILE = PROJECT_ROOT / "config" / "active_tenant.yaml"

class TenantConfig(BaseModel):
    tenant_id: str
    company_name: str
    contact_person: str
    assigned_estimator: str
    dispatch_phone: str
    notification_email: str
    google_calendar_id: str = "primary"
    service_license: str = "Fully Licensed & Insured NJ HIC"
    billing_type: str = "flat_monthly_retainer"
    monthly_rate: float = 1500.00
    lead_fee: float = 0.00
    status: str = "active"
    notes: Optional[str] = ""

class TenantManager:
    """
    Central Multi-Tenant Switching Engine for Rank-and-Rent Assets:
    Routes calendar events, SMS owner alerts, and Vapi bookings to the currently active roofer.
    Allows changing clients in 1 second with zero site rebuilding or downtime.
    """
    _cached_tenant: Optional[TenantConfig] = None
    _cached_id: Optional[str] = None

    @classmethod
    def get_active_tenant_id(cls) -> str:
        # 1. Check environment variable first (Ideal for Netlify / Cloud deployments)
        env_tenant = os.environ.get("ACTIVE_TENANT_ID")
        if env_tenant and env_tenant.strip():
            return env_tenant.strip()

        # 2. Check local active_tenant.yaml file
        if ACTIVE_TENANT_FILE.exists():
            try:
                with open(ACTIVE_TENANT_FILE, "r", encoding="utf-8") as f:
                    data = yaml.safe_load(f) or {}
                    return data.get("active_tenant_id", "client_joe_the_roofer")
            except Exception as e:
                logger.error(f"Error reading active tenant pointer: {e}")
        return "client_joe_the_roofer"

    @classmethod
    def get_active_tenant(cls) -> TenantConfig:
        current_id = cls.get_active_tenant_id()
        if cls._cached_tenant and cls._cached_id == current_id:
            return cls._cached_tenant

        tenant_file = TENANTS_DIR / f"{current_id}.yaml"
        if not tenant_file.exists():
            logger.warning(f"Tenant file {tenant_file} not found. Searching in {TENANTS_DIR}...")
            # Fallback to any yaml in directory
            all_files = list(TENANTS_DIR.glob("*.yaml"))
            if all_files:
                tenant_file = all_files[0]
            else:
                # Return default in-memory tenant
                return TenantConfig(
                    tenant_id="default_fallback",
                    company_name="Independent Licensed NJ Contractor",
                    contact_person="Lead Dispatcher",
                    assigned_estimator="Hannah",
                    dispatch_phone="+17326609121",
                    notification_email="dispatch@example.com",
                    google_calendar_id="primary"
                )

        try:
            with open(tenant_file, "r", encoding="utf-8") as f:
                raw_data = yaml.safe_load(f) or {}
                config = TenantConfig(**raw_data)
                cls._cached_tenant = config
                cls._cached_id = current_id
                logger.info(f"Loaded active tenant: {config.company_name} ({config.tenant_id})")
                return config
        except Exception as e:
            logger.error(f"Error parsing tenant config {tenant_file}: {e}")
            return TenantConfig(
                tenant_id="fallback_error",
                company_name="Licensed NJ Roofing Contractor",
                contact_person="Dispatcher",
                assigned_estimator="Hannah",
                dispatch_phone="+17326609121",
                notification_email="dispatch@example.com",
                google_calendar_id="primary"
            )

    @classmethod
    def list_all_tenants(cls) -> List[TenantConfig]:
        tenants = []
        if TENANTS_DIR.exists():
            for f in sorted(TENANTS_DIR.glob("*.yaml")):
                try:
                    with open(f, "r", encoding="utf-8") as tf:
                        data = yaml.safe_load(tf) or {}
                        tenants.append(TenantConfig(**data))
                except Exception as e:
                    logger.error(f"Failed loading tenant from {f}: {e}")
        return tenants

    @classmethod
    def switch_tenant(cls, new_tenant_id: str, switched_by: str = "admin") -> bool:
        target_file = TENANTS_DIR / f"{new_tenant_id}.yaml"
        if not target_file.exists():
            logger.error(f"Cannot switch to tenant '{new_tenant_id}': file {target_file} does not exist.")
            return False

        from datetime import datetime
        payload = {
            "active_tenant_id": new_tenant_id,
            "last_switched_at": datetime.now().isoformat(),
            "switched_by": switched_by
        }

        try:
            with open(ACTIVE_TENANT_FILE, "w", encoding="utf-8") as f:
                yaml.dump(payload, f, default_flow_style=False)
            
            # Invalidate cache
            cls._cached_tenant = None
            cls._cached_id = None
            logger.info(f"Successfully flipped active tenant to: {new_tenant_id}")
            return True
        except Exception as e:
            logger.error(f"Failed to update active tenant file: {e}")
            return False
