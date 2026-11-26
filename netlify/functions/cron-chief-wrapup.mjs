/**
 * Netlify Scheduled Function: Elena Conditional Weekday Evening Wrap-Up
 * Schedule: Monday–Friday at 5:30 PM EST (22:30 UTC)
 */
import { ChiefOfStaffService } from "./services/chief-of-staff-service.mjs";

export const config = {
  schedule: "30 22 * * 1-5"
};

export default async (req, context) => {
  try {
    const result = await ChiefOfStaffService.generateAndSendBriefing({
      mode: "wrapup",
      forceSend: false
    });
    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    console.error("[cron-chief-wrapup] Error:", err);
    return new Response(JSON.stringify({ status: "error", error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
