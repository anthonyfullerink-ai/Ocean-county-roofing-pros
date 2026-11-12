/**
 * Netlify Serverless Function: Feedback Resolution Handler
 * Routes: POST /api/feedback/resolution
 */
export default async (req, context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body = await req.json();
    const concern = (body.message || body.concern || "").trim();
    if (!concern) {
      return new Response(JSON.stringify({ detail: "Please enter a message for management." }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const leadId = body.lead_id || "";
    const name = (body.name || "Homeowner").trim();
    const phone = (body.phone || "").trim();
    const town = (body.town || "Toms River").trim();

    const supabaseUrl = process.env.SUPABASE_URL || "";
    const supabaseKey = process.env.SUPABASE_KEY || "";

    const reviewId = `REV-${Date.now() % 100000000}`;
    if (supabaseUrl && supabaseKey) {
      try {
        await fetch(`${supabaseUrl.replace(/\/$/, "")}/rest/v1/reviews`, {
          method: "POST",
          headers: {
            "apikey": supabaseKey,
            "Authorization": `Bearer ${supabaseKey}`,
            "Content-Type": "application/json",
            "Prefer": "return=minimal"
          },
          body: JSON.stringify({
            id: reviewId,
            lead_id: leadId,
            reviewer_name: phone ? `${name} (${phone})` : name,
            town_name: town,
            rating: 3,
            feedback_text: concern,
            is_public: false,
            created_at: new Date().toISOString()
          })
        });
      } catch (err) {
        console.error("Error logging feedback to Supabase:", err);
      }
    }

    return new Response(JSON.stringify({
      status: "success",
      message: "Your message has been directly dispatched to ownership. Our senior client manager will contact you today.",
      resolution_ticket: reviewId
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
