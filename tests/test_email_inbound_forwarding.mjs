import test from "node:test";
import assert from "node:assert/strict";
import inboundHandler from "../netlify/functions/api-email-inbound.mjs";

test("direct alias anthony@oceancountyroofingpros.com bypasses AI and forwards to owner Gmail with Reply-To", async () => {
  const sentPayloads = [];
  const originalFetch = global.fetch;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.OWNER_ALERT_EMAIL = "anthony.fuller.ink@gmail.com";

  global.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com/emails") && !String(url).includes("/receiving")) {
      sentPayloads.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "email_test_123" })
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const req = new Request("https://oceancountyroofingpros.com/api/email/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "email.received",
        data: {
          from: "Supplier Partner <sales@certainteed-partner.com>",
          to: ["anthony@oceancountyroofingpros.com"],
          subject: "Shingle delivery ETA",
          text: "Your pallet arrives at 8am tomorrow."
        }
      })
    });

    const res = await inboundHandler(req, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "forwarded_to_owner");
    assert.equal(body.skipped_ai, true);
    assert.equal(sentPayloads.length, 1);
    assert.deepEqual(sentPayloads[0].to, ["anthony.fuller.ink@gmail.com"]);
    assert.equal(sentPayloads[0].reply_to, "sales@certainteed-partner.com");
    assert.match(sentPayloads[0].subject, /\[To: anthony\] Shingle delivery ETA/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("owner Gmail anthony.fuller.ink@gmail.com sending to info@ bypasses AI and forwards cleanly", async () => {
  const sentPayloads = [];
  const originalFetch = global.fetch;
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.OWNER_ALERT_EMAIL = "anthony.fuller.ink@gmail.com";

  global.fetch = async (url, opts) => {
    if (String(url).includes("api.resend.com/emails") && !String(url).includes("/receiving")) {
      sentPayloads.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: "email_test_456" })
      };
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  };

  try {
    const req = new Request("https://oceancountyroofingpros.com/api/email/inbound", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "email.received",
        data: {
          from: "Anthony Fuller <anthony.fuller.ink@gmail.com>",
          to: ["info@oceancountyroofingpros.com"],
          subject: "Quick test from Gmail",
          text: "Testing info@ forwarding"
        }
      })
    });

    const res = await inboundHandler(req, {});
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.status, "forwarded_to_owner");
    assert.equal(body.skipped_ai, true);
    assert.equal(sentPayloads.length, 1);
    assert.deepEqual(sentPayloads[0].to, ["anthony.fuller.ink@gmail.com"]);
    assert.equal(sentPayloads[0].reply_to, "anthony.fuller.ink@gmail.com");
    assert.match(sentPayloads[0].subject, /\[To: info\] Quick test from Gmail/);
  } finally {
    global.fetch = originalFetch;
  }
});
