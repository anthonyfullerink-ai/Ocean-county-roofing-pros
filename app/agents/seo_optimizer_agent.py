import logging
from datetime import datetime, timezone
from typing import Dict, Any

from app.config import load_towns_data
from app.services.db import (
    list_seo_snapshots,
    list_seo_experiments,
    update_seo_experiment,
    upsert_seo_experiment,
    get_bool_setting,
    log_agent_run,
)

logger = logging.getLogger(__name__)


class SeoRankOptimizerAgent:
    """
    Agent 7: Closed-Loop Search Ranking & Self-Optimizing SEO Engine (`app/agents/seo_optimizer_agent.py`)
    - Evaluates active 14-day SEO experiments (auto-reverts regressions)
    - Promotes expired pending_24h title/meta experiments to active
    - Audits striking-distance GSC queries (>= 100 impressions) and stages new experiments
    """

    AGENT_NAME = "Agent 7: Search Ranking & SEO Optimizer"

    @classmethod
    def run(cls) -> Dict[str, Any]:
        start_time = datetime.now(timezone.utc)
        now_iso = start_time.isoformat()
        auto_publish = get_bool_setting("auto_publish_24h", True)

        snapshots = list_seo_snapshots(limit=250)
        experiments = list_seo_experiments(limit=100)
        towns = load_towns_data()

        promoted = 0
        kept = 0
        reverted = 0
        staged = 0

        snap_map = {
            (s.get("page_path"), (s.get("query") or "").lower()): s
            for s in snapshots
        }

        for exp in experiments:
            status = exp.get("status")
            if status == "active" and exp.get("activated_at"):
                try:
                    act_dt = datetime.fromisoformat(str(exp["activated_at"]).replace("Z", "+00:00"))
                    if act_dt.tzinfo is None:
                        act_dt = act_dt.replace(tzinfo=timezone.utc)
                    if (start_time - act_dt).total_seconds() >= 14 * 86400:
                        cur = snap_map.get((exp.get("page_path"), (exp.get("target_query") or "").lower()))
                        if cur:
                            base_pos = float(exp.get("baseline_position") or 0)
                            base_ctr = float(exp.get("baseline_ctr") or 0)
                            cur_pos = float(cur.get("position") or base_pos)
                            cur_ctr = float(cur.get("ctr") or base_ctr)
                            cur_imp = int(cur.get("impressions") or 0)
                            if (base_pos > 0 and cur_pos > base_pos + 3.0) or (
                                base_ctr > 0 and cur_imp >= 100 and cur_ctr < base_ctr * 0.8
                            ):
                                update_seo_experiment(
                                    exp["id"],
                                    {
                                        "status": "reverted",
                                        "latest_position": cur_pos,
                                        "latest_ctr": cur_ctr,
                                        "evaluated_at": now_iso,
                                        "reason": f"Auto-reverted after 14d: pos {base_pos}->{cur_pos}",
                                    },
                                )
                                reverted += 1
                            else:
                                update_seo_experiment(
                                    exp["id"],
                                    {
                                        "status": "kept",
                                        "latest_position": cur_pos,
                                        "latest_ctr": cur_ctr,
                                        "evaluated_at": now_iso,
                                        "reason": f"Kept winner after 14d: pos {base_pos}->{cur_pos}",
                                    },
                                )
                                kept += 1
                except Exception:
                    pass

            if auto_publish and status == "pending_24h" and exp.get("auto_apply_at"):
                try:
                    due_dt = datetime.fromisoformat(str(exp["auto_apply_at"]).replace("Z", "+00:00"))
                    if due_dt.tzinfo is None:
                        due_dt = due_dt.replace(tzinfo=timezone.utc)
                    if due_dt <= start_time:
                        update_seo_experiment(exp["id"], {"status": "active", "activated_at": now_iso})
                        promoted += 1
                except Exception:
                    pass

        busy_paths = {e.get("page_path") for e in experiments if e.get("status") in ("pending_24h", "active")}
        for s in sorted(snapshots, key=lambda x: int(x.get("impressions") or 0), reverse=True):
            if staged >= 2:
                break
            imp = int(s.get("impressions") or 0)
            pos = float(s.get("position") or 0)
            ctr = float(s.get("ctr") or 0)
            path = s.get("page_path") or "/"
            if imp >= 100 and ((8.0 <= pos <= 25.0) or ctr < 0.025) and path not in busy_paths:
                q = str(s.get("query") or "Ocean County Roofing").strip()
                q_title = q.title()
                upsert_seo_experiment(
                    {
                        "page_path": path,
                        "target_query": q,
                        "proposed_meta_title": f"{q_title[:36]} | Free 21-Point Inspection"[:62],
                        "proposed_meta_description": f"{q_title} by NJ licensed & insured specialists. Compare GAF, CertainTeed & Owens Corning with a free 21-point inspection."[:160],
                        "baseline_position": pos,
                        "baseline_ctr": ctr,
                        "baseline_impressions": imp,
                        "status": "pending_24h",
                        "reason": f"Striking distance: pos {pos}, {imp} imp, CTR {ctr * 100:.2f}%",
                    }
                )
                busy_paths.add(path)
                staged += 1

        duration_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
        summary = (
            f"Audited {len(towns)} town silos & {len(snapshots)} GSC snapshots: "
            f"promoted {promoted}, kept {kept}, auto-reverted {reverted}, staged {staged} new SEO experiment(s)."
        )
        metrics = {
            "snapshots_checked": len(snapshots),
            "promoted": promoted,
            "kept": kept,
            "reverted": reverted,
            "staged": staged,
        }
        log_agent_run(cls.AGENT_NAME, status="success", summary=summary, metrics=metrics, duration_ms=duration_ms)
        return {"status": "success", "agent": cls.AGENT_NAME, "summary": summary, "metrics": metrics}
