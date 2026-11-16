import logging
from datetime import datetime, timezone
from typing import Dict, Any

from app.services.db import (
    list_social_interactions,
    update_social_interaction,
    list_social_queue,
    update_social_queue_item,
    get_bool_setting,
    log_agent_run,
)

logger = logging.getLogger(__name__)


class SocialEngagementAgent:
    """
    Agent 6: Autonomous Social & Engagement Engine (`app/agents/social_agent.py`)
    - Promotes expired 24h 4-5 star social review replies (`auto_24h` -> `published`)
    - Never auto-publishes 1-3 star negative reviews (`pending_approval` guardrail)
    - Tracks scheduled posts in `social_queue`
    """

    AGENT_NAME = "Agent 6: Social & Engagement Engine"

    @classmethod
    def run(cls) -> Dict[str, Any]:
        start_time = datetime.now(timezone.utc)
        auto_publish_enabled = get_bool_setting("auto_publish_24h", True)

        interactions = list_social_interactions(limit=200)
        promoted_replies = 0
        held_negative = 0

        for item in interactions:
            status = item.get("reply_status")
            rating = int(item.get("rating") or 0)
            intent = item.get("intent") or ""
            if status == "pending_approval" and (intent == "NEGATIVE_REVIEW" or (rating > 0 and rating <= 3)):
                held_negative += 1
                continue

            if auto_publish_enabled and status == "auto_24h":
                if rating > 0 and rating <= 3:
                    held_negative += 1
                    continue
                ap_at = item.get("auto_publish_at") or ""
                is_due = True
                if ap_at:
                    try:
                        due_dt = datetime.fromisoformat(ap_at.replace("Z", "+00:00"))
                        if due_dt.tzinfo is None:
                            due_dt = due_dt.replace(tzinfo=timezone.utc)
                        is_due = due_dt <= start_time
                    except Exception:
                        is_due = True
                if is_due:
                    update_social_interaction(item["id"], {"reply_status": "published"})
                    promoted_replies += 1

        scheduled_posts = list_social_queue(status="scheduled", limit=50)
        due_posts = 0
        for post in scheduled_posts:
            sched_raw = post.get("scheduled_for") or ""
            try:
                sched_dt = datetime.fromisoformat(sched_raw.replace("Z", "+00:00"))
                if sched_dt.tzinfo is None:
                    sched_dt = sched_dt.replace(tzinfo=timezone.utc)
                if sched_dt <= start_time:
                    due_posts += 1
            except Exception:
                due_posts += 1

        duration_ms = int((datetime.now(timezone.utc) - start_time).total_seconds() * 1000)
        summary = (
            f"Promoted {promoted_replies} expired 24h positive social replies; "
            f"{held_negative} negative/urgent item(s) held for owner approval; "
            f"{len(scheduled_posts)} scheduled post(s) ({due_posts} due)."
        )
        metrics = {
            "promoted_replies": promoted_replies,
            "held_negative": held_negative,
            "scheduled_posts": len(scheduled_posts),
            "due_posts": due_posts,
        }
        log_agent_run(cls.AGENT_NAME, status="success", summary=summary, metrics=metrics, duration_ms=duration_ms)
        return {"status": "success", "agent": cls.AGENT_NAME, "summary": summary, "metrics": metrics}
