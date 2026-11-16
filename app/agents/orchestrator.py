from typing import Dict, Any
from app.agents.media_ingestor import MediaIngestorAgent
from app.agents.gbp_seo_agent import LocalSeoGbpAgent
from app.agents.reputation_agent import ReputationReviewAgent
from app.agents.watchdog_agent import CroWatchdogAgent
from app.agents.briefing_agent import ChiefBriefingAgent
from app.agents.social_agent import SocialEngagementAgent

AGENT_REGISTRY = {
    "media_ingestor": MediaIngestorAgent,
    "gbp_seo": LocalSeoGbpAgent,
    "reputation": ReputationReviewAgent,
    "watchdog": CroWatchdogAgent,
    "briefing": ChiefBriefingAgent,
    "social": SocialEngagementAgent,
}


def run_single_agent(agent_key: str) -> Dict[str, Any]:
    key = (agent_key or "").strip().lower()
    agent_cls = AGENT_REGISTRY.get(key)
    if not agent_cls:
        return {"status": "error", "message": f"Unknown agent key '{agent_key}'. Valid keys: {list(AGENT_REGISTRY.keys())}"}
    return agent_cls.run()


def run_all_agents() -> Dict[str, Any]:
    """
    Executes the entire 5-Agent Autonomous Workforce in sequence and returns a consolidated report.
    """
    results = {}
    for key, agent_cls in AGENT_REGISTRY.items():
        results[key] = agent_cls.run()
    return {
        "status": "success",
        "agents_executed": len(results),
        "results": results,
    }
