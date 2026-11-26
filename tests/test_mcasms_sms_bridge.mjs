import test from "node:test";
import assert from "node:assert/strict";
import crypto from "crypto";
import {
  resolveSmsProvider,
  sendUnifiedSms,
  isOptedOut,
  normalizePhoneDigits
} from "../netlify/functions/services/sms-router.mjs";
import {
  verifyMcasmsAuth,
  parseMcasmsPayload,
  createMcasmsWebhookHandler
} from "../netlify/functions/api-mcasms-webhook.mjs";

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });
}

test("resolveSmsProvider picks mcasms in auto mode when key present and falls back cleanly", async () => {
  await withEnv(
    {
      MCASMS_LICENSE_KEY: "MCAS-PRO-DEMO-89F2",
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "tok123"
    },
    () => {
      assert.equal(resolveSmsProvider({}), "mcasms");
      assert.equal(resolveSmsProvider({ sms_provider: "auto" }), "mcasms");
      assert.equal(resolveSmsProvider({ sms_provider: "twilio" }), "twilio");
      assert.equal(resolveSmsProvider({ sms_provider: "mcasms" }), "mcasms");
    }
  );

  await withEnv(
    {
      MCASMS_LICENSE_KEY: undefined,
      TWILIO_ACCOUNT_SID: "AC123",
      TWILIO_AUTH_TOKEN: "tok123"
    },
    () => {
      assert.equal(resolveSmsProvider({ sms_provider: "auto" }), "twilio");
    }
  );
});

test("sendUnifiedSms dispatches exact payload & X-License-Key to MCASMS Cloud Relay", async () => {
  await withEnv(
    {
      MCASMS_LICENSE_KEY: "MCAS-PRO-DEMO-89F2",
      MCASMS_DEVICE_PHONE: "+17325523896",
      MCASMS_WEBHOOK_SECRET: "sec_test_123",
      MCASMS_SIM_SLOT: "1"
    },
    async () => {
      const captured = [];
      const mockFetch = async (url, opts) => {
        captured.push({ url, opts });
        return new Response(
          JSON.stringify({
            success: true,
            status: "DISPATCHED_TO_DEVICE",
            phone: "+17325551234",
            sim_slot: 1,
            fcm_message_id: "fcm_msg_999"
          }),
          { status: 200 }
        );
      };

      const res = await sendUnifiedSms({
        to: "(732) 555-1234",
        body: "Hi John, your roof inspection is confirmed!",
        purpose: "customer",
        sysSettings: { sms_provider: "auto", mcasms_device_mode: "personal", mcasms_sim_slot: "1" },
        fetchFn: mockFetch
      });

      assert.equal(res.sent, true);
      assert.equal(res.provider, "mcasms");
      assert.equal(res.fcm_message_id, "fcm_msg_999");
      assert.equal(captured.length, 1);
      assert.equal(captured[0].url, "https://missedcallautosms.com/api/dispatch-sms");
      assert.equal(captured[0].opts.headers["X-License-Key"], "MCAS-PRO-DEMO-89F2");

      const sentBody = JSON.parse(captured[0].opts.body);
      assert.equal(sentBody.to, "+17325551234");
      assert.equal(sentBody.message, "Hi John, your roof inspection is confirmed!");
      assert.equal(sentBody.sim_slot, 1);
      assert.equal(
        sentBody.callback_url,
        "https://oceancountyroofingpros.com/api/mcasms/webhook?kind=callback&token=sec_test_123"
      );
    }
  );
});

test("Personal Device guard skips owner_alert and self-addressed SMS, but allows dedicated owner alerts", async () => {
  await withEnv(
    {
      MCASMS_LICENSE_KEY: "MCAS-PRO-DEMO-89F2",
      MCASMS_DEVICE_PHONE: "+17325523896"
    },
    async () => {
      let calls = 0;
      const mockFetch = async () => {
        calls++;
        return new Response(JSON.stringify({ success: true, status: "DISPATCHED_TO_DEVICE" }), { status: 200 });
      };

      // 1. Personal mode owner_alert -> skipped without HTTP call
      const ownerRes = await sendUnifiedSms({
        to: "+17325523896",
        body: "Owner alert",
        purpose: "owner_alert",
        sysSettings: { sms_provider: "mcasms", mcasms_device_mode: "personal", mcasms_send_owner_alerts: "false" },
        fetchFn: mockFetch
      });
      assert.equal(ownerRes.sent, false);
      assert.equal(ownerRes.status, "skipped_personal_device");
      assert.equal(calls, 0);

      // 2. Customer message to self device phone -> still blocked by self-loop guard
      const selfCustomerRes = await sendUnifiedSms({
        to: "732-552-3896",
        body: "Test",
        purpose: "customer",
        sysSettings: { sms_provider: "mcasms", mcasms_device_mode: "personal" },
        fetchFn: mockFetch
      });
      assert.equal(selfCustomerRes.sent, false);
      assert.equal(selfCustomerRes.status, "skipped_personal_device");
      assert.equal(calls, 0);

      // 3. Dedicated business phone mode emailing/texting owner cell -> allowed when MCASMS_DEVICE_PHONE is new phone
      process.env.MCASMS_DEVICE_PHONE = "+17329990000";
      const dedicatedOwnerRes = await sendUnifiedSms({
        to: "+17325523896",
        body: "Owner alert on dedicated phone",
        purpose: "owner_alert",
        sysSettings: { sms_provider: "mcasms", mcasms_device_mode: "dedicated", mcasms_send_owner_alerts: "true" },
        fetchFn: mockFetch
      });
      assert.equal(dedicatedOwnerRes.sent, true);
      assert.equal(calls, 1);
    }
  );
});

test("STOP opt-out suppression blocks customer SMS for opted-out phones", async () => {
  await withEnv(
    {
      MCASMS_LICENSE_KEY: "MCAS-PRO-DEMO-89F2",
      MCASMS_DEVICE_PHONE: "+17325523896"
    },
    async () => {
      let called = false;
      const settings = { sms_opt_outs_json: JSON.stringify(["7325558899"]), sms_provider: "mcasms" };
      assert.equal(isOptedOut("+1 (732) 555-8899", settings), true);
      assert.equal(normalizePhoneDigits("+17325551111"), "7325551111");

      const res = await sendUnifiedSms({
        to: "+17325558899",
        body: "Follow up",
        purpose: "customer",
        sysSettings: settings,
        fetchFn: async () => {
          called = true;
          return new Response("{}", { status: 200 });
        }
      });
      assert.equal(res.sent, false);
      assert.equal(res.status, "opted_out");
      assert.equal(called, false);
    }
  );
});

test("verifyMcasmsAuth validates HMAC X-Signature and ?token= query secret", () => {
  const secret = "super_secret_key_2026";
  const body = JSON.stringify({ event: "sms.received", phone: "+17325551234" });
  const sig = crypto.createHmac("sha256", secret).update(body).digest("hex");

  assert.deepEqual(verifyMcasmsAuth({ rawText: body, signatureHeader: sig, secret }), { ok: true, mode: "hmac" });
  assert.deepEqual(verifyMcasmsAuth({ rawText: body, queryToken: secret, secret }), { ok: true, mode: "token" });
  assert.deepEqual(verifyMcasmsAuth({ rawText: body, signatureHeader: "bad", queryToken: "wrong", secret }), { ok: false });
});

test("parseMcasmsPayload recovers fields from malformed Kotlin delivery callback JSON", () => {
  const brokenCallback = `{
    "status": "SENT",
    "phoneNumber": "+17325551234",
    "message": "Hi Bob, quote "special"
next line",
    "error": "",
    "simSlot": 1,
    "timestamp": "1795714663810"
  }`;

  const parsed = parseMcasmsPayload(brokenCallback);
  assert.equal(parsed._parsed_fallback, true);
  assert.equal(parsed.kind, "delivery_callback");
  assert.equal(parsed.status, "SENT");
  assert.equal(parsed.phoneNumber, "+17325551234");
  assert.equal(parsed.simSlot, 1);
});

test("api-mcasms-webhook handles auth, TEST_PING, personal-device privacy filter, CRM lead reply & opt-out", async () => {
  await withEnv(
    {
      MCASMS_WEBHOOK_SECRET: "wh_secret_abc",
      SUPABASE_URL: "https://example.supabase.co",
      SUPABASE_KEY: "sb_key"
    },
    async () => {
      const patches = [];
      const emails = [];
      const buffers = [];
      const optOuts = [];

      const mockFetch = async (url, opts = {}) => {
        const u = String(url);
        if (u.includes("/rest/v1/leads?") && (!opts.method || opts.method === "GET")) {
          // Only +17325554444 is an OC Roofing Pros lead; +17325559999 is personal contact
          if (u.includes("5554444")) {
            return new Response(
              JSON.stringify([
                {
                  id: "LEAD-101",
                  first_name: "Sarah",
                  last_name: "Jenkins",
                  phone: "+17325554444",
                  email: "sarah@example.com",
                  notes: "Initial note"
                }
              ]),
              { status: 200 }
            );
          }
          return new Response(JSON.stringify([]), { status: 200 });
        }
        if (u.includes("/rest/v1/leads?id=eq.") && opts.method === "PATCH") {
          patches.push(JSON.parse(opts.body));
          return new Response(null, { status: 204 });
        }
        return new Response("{}", { status: 200 });
      };

      const handler = createMcasmsWebhookHandler({
        fetchFn: mockFetch,
        loadSettings: async () => ({ mcasms_device_mode: "personal", chief_buffer_mode: "true" }),
        sendEmail: async (args) => emails.push(args),
        getOwnerEmail: () => "owner@example.com",
        recordBuffer: async (args) => buffers.push(args),
        persistOptOut: async (phone) => {
          optOuts.push(phone);
          return { recorded: true };
        }
      });

      // 1. Unauthorized without token or HMAC -> 401
      const unauthRes = await handler(
        new Request("https://oceancountyroofingpros.com/api/mcasms/webhook", {
          method: "POST",
          body: JSON.stringify({ event: "TEST_PING" })
        })
      );
      assert.equal(unauthRes.status, 401);

      // 2. TEST_PING with ?token= -> 200 pong
      const pingRes = await handler(
        new Request("https://oceancountyroofingpros.com/api/mcasms/webhook?token=wh_secret_abc", {
          method: "POST",
          body: JSON.stringify({ event: "TEST_PING", phone: "+15551234567" })
        })
      );
      assert.equal(pingRes.status, 200);
      assert.equal((await pingRes.json()).pong, true);

      // 3. call.missed event -> clean 200 ignore
      const missedCallRes = await handler(
        new Request("https://oceancountyroofingpros.com/api/mcasms/webhook?token=wh_secret_abc", {
          method: "POST",
          body: JSON.stringify({ event: "call.missed", call: { caller_number: "+17325559999" } })
        })
      );
      assert.equal(missedCallRes.status, 200);
      assert.equal((await missedCallRes.json()).ignored, "call.missed");

      // 4. Personal non-lead inbound text -> discarded immediately, zero DB writes/emails
      const personalPayload = JSON.stringify({
        event: "sms.received",
        sim_slot: 1,
        call: { caller_number: "+17325559999" },
        sms: { body: "Hey pick up milk on your way home" }
      });
      const hmacSig = crypto.createHmac("sha256", "wh_secret_abc").update(personalPayload).digest("hex");
      const personalRes = await handler(
        new Request("https://oceancountyroofingpros.com/api/mcasms/webhook", {
          method: "POST",
          headers: { "x-signature": hmacSig },
          body: personalPayload
        })
      );
      assert.equal(personalRes.status, 200);
      assert.equal((await personalRes.json()).ignored, "personal_device_non_lead");
      assert.equal(patches.length, 0);
      assert.equal(emails.length, 0);

      // 5. Known OC Roofing Pros lead reply -> logs note to Supabase + Elena buffer + email
      const leadRes = await handler(
        new Request("https://oceancountyroofingpros.com/api/mcasms/webhook?token=wh_secret_abc", {
          method: "POST",
          body: JSON.stringify({
            event: "sms.received",
            sim_slot: 1,
            call: { caller_number: "+17325554444" },
            sms: { body: "Yes Thursday at 2pm works great!" }
          })
        })
      );
      assert.equal(leadRes.status, 200);
      const leadJson = await leadRes.json();
      assert.equal(leadJson.handled, "sms.received");
      assert.equal(leadJson.matched_lead_id, "LEAD-101");
      assert.equal(patches.length, 1);
      assert.ok(patches[0].notes.includes("Yes Thursday at 2pm works great!"));
      assert.equal(buffers.length, 1);
      assert.equal(emails.length, 1);
      assert.ok(emails[0].subject.includes("Sarah Jenkins"));

      // 6. Lead STOP opt-out -> persists opt-out + updates lead note
      const stopRes = await handler(
        new Request("https://oceancountyroofingpros.com/api/mcasms/webhook?token=wh_secret_abc", {
          method: "POST",
          body: JSON.stringify({
            event: "opt_out.received",
            call: { caller_number: "+17325554444" },
            sms: { body: "STOP" }
          })
        })
      );
      assert.equal(stopRes.status, 200);
      assert.deepEqual(optOuts, ["+17325554444"]);
      assert.equal(patches.length, 2);
      assert.ok(patches[1].notes.includes("SMS OPT-OUT via MCASMS"));
    }
  );
});
