/**
 * Netlify Serverless Function: Twilio 800/866 Voice Call Forwarder
 * Routes: POST|GET /api/twilio/voice-forward
 *
 * Keeps the 800/866 number dedicated to SMS conversations while seamlessly
 * forwarding any inbound voice calls on that number to the local Vapi AI
 * dispatch number (+17326609121) with caller ID preserved.
 */
export default async (req, context) => {
  const forwardTarget = process.env.PRIMARY_PHONE || "+17326609121";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Dial timeout="30">${forwardTarget}</Dial>
</Response>`;

  return new Response(twiml, {
    status: 200,
    headers: {
      "Content-Type": "text/xml; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
};
