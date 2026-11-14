import logging
from datetime import datetime, timedelta
from typing import Dict, Any, List, Optional

from app.services.db import (
    list_leads,
    get_lead,
    update_lead,
    list_reviews,
    update_review,
    get_bool_setting,
    log_agent_run,
)
from app.services.comms import send_review_invitation_sms

logger = logging.getLogger(__name__)


def draft_seo_review_reply(review: Dict[str, Any]) -> str:
    """
    Generates a localized, SEO-rich owner response that naturally mentions
    the homeowner's name, Ocean County town, and roofing service performed.
    """
    reviewer = review.get("reviewer_name") or "Neighbor"
    town = review.get("town_name") or "Toms River"
    service = review.get("service_performed") or "roof installation"
    rating = int(review.get("rating") or 5)

    if rating >= 4:
        return (
            f"Thank you so much for the {rating}-star review, {reviewer}! "
            f"Our certified crew loves serving homeowners in {town}, NJ, and we are thrilled "
            f"that your {service.lower()} and 21-point inspection exceeded expectations. "
            f"Rest easy knowing your home is protected against Jersey Shore nor'easters with our 50-year CertainTeed warranty!"
        )
    return (
        f"Thank you for sharing your feedback, {reviewer}. Customer satisfaction across {town} and Ocean County "
        f"is our highest priority. Our management team has reviewed your note regarding your {service.lower()} "
        f"and is reaching out directly today to ensure everything is resolved to your 100% satisfaction."
    )


def trigger_completed_lead_review_request(lead_id: str, force: bool = False) -> Dict[str, Any]:
    """
    Immediately sends the Google-compliant /feedback/{lead_id} review invitation SMS
    when a lead is marked 'Completed' (from /portal or /admin).
    """
    lead = get_lead(lead_id)
    if not lead:
        return {"status": "error", "sent": False, "reason": "Lead not found"}

    if lead.get("review_request_sent") and not force:
        return {"status": "skipped", "sent": False, "reason": "Review request already sent"}

    if not get_bool_setting("enable_review_sms", True):
        return {"status": "paused", "sent": False, "reason": "Review SMS kill-switch is disabled"}

    sent = send_review_invitation_sms(lead)
    if sent:
        now_iso = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        updated = update_lead(
            lead["id"],
            {
                "review_request_sent": True,
                "review_request_sent_at": now_iso,
            },
        )
        return {
            "status": "sent",
            "sent": True,
            "lead_id": lead["id"],
            "feedback_url": f"/feedback/{lead['id']}",
            "lead": updated,
        }
    return {"status": "failed", "sent": False, "reason": "SMS dispatch returned False"}


class ReputationReviewAgent:
    """
    Agent 3: Review & Reputation Engine (`app/agents/reputation_agent.py`)
    - Scans leads with status == 'Completed' and sends A2P-compliant /feedback/{lead_id} SMS
    - Drafts localized SEO owner responses for all customer reviews
    """

    AGENT_NAME = "Agent 3: Review & Reputation Engine"

    @classmethod
    def run(cls) -> Dict[str, Any]:
        start_time = datetime.now()
        sms_sent_count = 0
        replies_drafted = 0

        # 1. Scan completed leads that haven't received their review link yet
        completed_leads = list_leads(status="Completed")
        for lead in completed_leads:
            if not lead.get("review_request_sent"):
                res = trigger_completed_lead_review_request(lead["id"])
                if res.get("sent"):
                    sms_sent_count += 1

        # 2. Draft SEO-rich replies for any reviews missing an AI draft
        reviews = list_reviews()
        replies_auto_published = 0
        cutoff_24h = (datetime.now() - timedelta(hours=24)).strftime("%Y-%m-%d %H:%M:%S")
        auto_publish_enabled = get_bool_setting("auto_publish_24h", True)

        for rev in reviews:
            if not (rev.get("ai_reply_draft") or "").strip():
                draft = draft_seo_review_reply(rev)
                update_review(rev["id"], {"ai_reply_draft": draft, "reply_status": "pending"})
                replies_drafted += 1
            elif (
                auto_publish_enabled
                and rev.get("is_public")
                and rev.get("reply_status") == "pending"
                and (rev.get("created_at") or "") <= cutoff_24h
            ):
                update_review(rev["id"], {"reply_status": "published"})
                replies_auto_published += 1

        duration_ms = int((datetime.now() - start_time).total_seconds() * 1000)
        summary = (
            f"Audited {len(completed_leads)} completed job(s): dispatched {sms_sent_count} new compliant review SMS invite(s). "
            f"Audited {len(reviews)} review(s): drafted {replies_drafted} localized SEO owner response(s), "
            f"auto-published {replies_auto_published} queued 24h response(s)."
        )
        metrics = {
            "completed_leads_checked": len(completed_leads),
            "review_sms_sent": sms_sent_count,
            "reviews_audited": len(reviews),
            "replies_drafted": replies_drafted,
            "replies_auto_published": replies_auto_published,
        }
        run_record = log_agent_run(cls.AGENT_NAME, "success", summary, metrics=metrics, duration_ms=duration_ms)
        return {"status": "success", "agent": cls.AGENT_NAME, "summary": summary, "metrics": metrics, "run": run_record}
