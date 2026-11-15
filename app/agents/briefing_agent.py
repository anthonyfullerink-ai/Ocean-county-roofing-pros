import os
import logging
from pathlib import Path
from datetime import datetime
from typing import Dict, Any

from app.config import PROJECT_ROOT, settings, get_output_path
from app.services.db import (
    get_dashboard_kpis,
    list_leads,
    list_tenants,
    save_daily_report,
    log_agent_run,
    get_analytics_summary,
)
from app.services.comms import send_daily_briefing_alert

logger = logging.getLogger(__name__)


class ChiefBriefingAgent:
    """
    Agent 5: Chief Analytics & Briefing (`app/agents/briefing_agent.py`)
    - Compiles the 7:30 AM Daily Executive Briefing + Contractor ROI Scoreboard
    - Saves to Dashboard (`daily_reports` table), `outputs/reports/daily_briefing_YYYY-MM-DD.md`, and SMS alert
    """

    AGENT_NAME = "Agent 5: Chief Analytics & Briefing"

    @classmethod
    def run(cls) -> Dict[str, Any]:
        start_time = datetime.now()
        today_str = start_time.strftime("%Y-%m-%d")
        kpis = get_dashboard_kpis()
        analytics_24h = get_analytics_summary("24h").get("kpis", {})
        analytics_7d = get_analytics_summary("7d")
        analytics_7d_kpis = analytics_7d.get("kpis", {})
        top_page_7d = (analytics_7d.get("top_pages") or [{}])[0].get("page_path", "/")
        leads = list_leads()[:8]
        tenants = list_tenants()

        active_tenant = kpis["active_tenant"]
        headline = (
            f"{today_str} | {kpis['total_leads']} Leads (${kpis['active_pipeline_value']:,.0f} Pipeline) • "
            f"{kpis['roi_multiple']}x Retainer ROI for {active_tenant.get('company_name')}"
        )

        lead_rows_md = []
        for l in leads[:6]:
            lead_rows_md.append(
                f"| `{l.get('id')}` | {l.get('first_name')} {l.get('last_name')} | {l.get('city')} | "
                f"{l.get('service_requested')} | **{l.get('status')}** | ${float(l.get('estimated_value') or 0):,.0f} |"
            )
        lead_table = "\n".join(lead_rows_md) if lead_rows_md else "| None | - | - | - | - | $0 |"

        tenant_rows_md = []
        for t in tenants:
            t_kpis = get_dashboard_kpis(tenant_id=t["tenant_id"])
            status_badge = "🟢 ACTIVE" if t.get("is_active") else "⚪ STANDBY"
            tenant_rows_md.append(
                f"| **{t.get('company_name')}** | {status_badge} | ${float(t.get('monthly_retainer') or 0):,.0f}/mo | "
                f"{t_kpis['total_leads']} | ${t_kpis['active_pipeline_value']:,.0f} | **{t_kpis['roi_multiple']}x ROI** |"
            )
        tenant_table = "\n".join(tenant_rows_md)

        md_content = f"""# 📊 7:30 AM Daily Executive Briefing — {settings.BUSINESS_NAME}
**Date:** {today_str}  
**Active Partner:** {active_tenant.get('company_name')} (Estimator: {active_tenant.get('estimator_name')} • `{active_tenant.get('dispatch_phone')}`)  
**Headline:** {headline}

---

## 1. Executive Pipeline & Retainer ROI Scoreboard
| Metric | Value |
| :--- | :--- |
| **Total Dispatched Leads** | **{kpis['total_leads']}** |
| **Inspections Booked / Completed** | **{kpis['booked_count']} Booked / {kpis['completed_count']} Completed** |
| **Active Pipeline Value** | **${kpis['active_pipeline_value']:,.2f}** |
| **Closed / Won Job Value** | **${kpis['won_revenue_value']:,.2f}** |
| **Active Partner Monthly Retainer** | **${kpis['monthly_retainer']:,.2f}/mo** |
| **Partner Pipeline ROI Multiple** | **{kpis['roi_multiple']}x ROI** ({kpis['won_roi_multiple']}x Closed ROI) |

---

## 2. Contractor Partner ROI Breakdown
| Partner Company | Status | Monthly Retainer | Assigned Leads | Pipeline Value | ROI Multiple |
| :--- | :--- | :--- | :--- | :--- | :--- |
{tenant_table}

---

## 3. Local SEO & GBP Flywheel Velocity
* **Verified Geo-Tagged Projects Live:** `{kpis['approved_projects_count']}` across 10 Ocean & Monmouth County town pages
* **24h Hybrid Queue Pending Review:** `{kpis['pending_approval_total']}` item(s) (`{kpis['pending_projects_count']}` photos, `{kpis['pending_gbp_count']}` GBP posts, `{kpis['pending_replies_count']}` review replies)
* **Verified Reputation Score:** `★ {kpis['avg_rating']} / 5.0` (`{kpis['total_reviews_count']}` tracked reviews in DB)

---

## 4. First-Party Website Traffic & Conversion Pulse
* **Last 24h Traffic:** `{analytics_24h.get('unique_visitors', 0)}` unique visitors (`{analytics_24h.get('pageviews', 0)}` pageviews)
* **Last 7d Traffic:** `{analytics_7d_kpis.get('unique_visitors', 0)}` visitors • `{analytics_7d_kpis.get('mobile_pct', 0)}%` mobile • `{analytics_7d_kpis.get('call_clicks', 0)}` calls / `{analytics_7d_kpis.get('sms_clicks', 0)}` texts
* **Top 7d Landing Page:** `{top_page_7d}`

---

## 5. Recent Lead Dispatch Log
| Lead ID | Homeowner | Town | Service | Status | Est. Value |
| :--- | :--- | :--- | :--- | :--- | :--- |
{lead_table}
"""

        filename = f"daily_briefing_{today_str}.md"
        file_path = ""
        try:
            out_path = get_output_path("reports", filename)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(md_content)
            file_path = out_path

            # Also ensure local ./outputs/reports/ copy exists in project root
            local_reports_dir = PROJECT_ROOT / "outputs" / "reports"
            local_reports_dir.mkdir(parents=True, exist_ok=True)
            local_file = local_reports_dir / filename
            if str(local_file.resolve()) != str(Path(out_path).resolve()):
                local_file.write_text(md_content, encoding="utf-8")
                file_path = str(local_file)
        except Exception as e:
            logger.warning(f"Could not write daily briefing markdown file: {e}")

        report_record = save_daily_report(
            report_date=today_str,
            headline=headline,
            markdown_content=md_content,
            metrics=kpis,
            file_path=file_path,
        )

        send_daily_briefing_alert(headline)

        duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
        summary = f"Generated 7:30 AM Daily Briefing ({headline}) and saved to {filename}."
        run_record = log_agent_run(cls.AGENT_NAME, "success", summary, metrics=kpis, duration_ms=duration_ms)
        return {
            "status": "success",
            "agent": cls.AGENT_NAME,
            "summary": summary,
            "report": report_record,
            "run": run_record,
        }
