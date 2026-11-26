/**
 * Netlify Scheduled Function: Elena Morning Executive Briefing
 * Schedule: Daily at 7:30 AM EST (12:30 UTC)
 */
import { ChiefOfStaffService } from "./services/chief-of-staff-service.mjs";

export const config = {
  schedule: "30 12 * * *"
};

export default async (req, context) => {
  try {
    const result = await ChiefOfStaffService.generateAndSendBriefing({
      mode: "morning",
      forceSend: false
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[cron-chief-briefing] Error:", err);
    return new Response(JSON.stringify({ status: "error", error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
