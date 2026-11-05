import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { handleRequest, type Env } from "./index.ts";
import type { TermiiClient, TermiiSendResult } from "./termii.ts";

const RAW_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"; // test-only, not a real secret
const ENV: Env = {
  sendSmsHookSecret: `v1,${RAW_SECRET}`,
  termiiApiKey: "test-termii-key",
  termiiSenderId: "BillSteady",
  termiiBaseUrl: "https://termii.invalid",
};

function signedRequest(bodyObj: unknown): Request {
  const wh = new Webhook(RAW_SECRET);
  const body = JSON.stringify(bodyObj);
  const id = crypto.randomUUID();
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = wh.sign(id, new Date(Number(timestamp) * 1000), body);
  return new Request("https://example.test/send-otp-sms", {
    method: "POST",
    headers: {
      "webhook-id": id,
      "webhook-timestamp": timestamp,
      "webhook-signature": signature,
    },
    body,
  });
}

function fakeTermii(result: TermiiSendResult): { client: TermiiClient; calls: Array<[string, string]> } {
  const calls: Array<[string, string]> = [];
  return {
    calls,
    client: {
      async send(to: string, message: string) {
        calls.push([to, message]);
        return result;
      },
    },
  };
}

Deno.test("valid signed request with a real OTP sends through Termii and returns 200", async () => {
  const { client, calls } = fakeTermii({ ok: true, messageId: "abc123" });
  const req = signedRequest({ user: { phone: "+2348012345678" }, sms: { otp: "561166" } });

  const res = await handleRequest(req, ENV, client);

  assertEquals(res.status, 200);
  assertEquals(calls.length, 1);
  assertEquals(calls[0][0], "+2348012345678");
  assertStringIncludes(calls[0][1], "561166");
});

Deno.test("a request with an invalid signature is rejected before Termii is ever called", async () => {
  const { client, calls } = fakeTermii({ ok: true, messageId: "should-not-be-used" });
  const body = JSON.stringify({ user: { phone: "+2348012345678" }, sms: { otp: "561166" } });
  const req = new Request("https://example.test/send-otp-sms", {
    method: "POST",
    headers: {
      "webhook-id": crypto.randomUUID(),
      "webhook-timestamp": Math.floor(Date.now() / 1000).toString(),
      "webhook-signature": "v1,bm90YXJlYWxzaWduYXR1cmU=", // garbage, won't verify
    },
    body,
  });

  const res = await handleRequest(req, ENV, client);

  assertEquals(res.status, 401);
  assertEquals(calls.length, 0, "Termii must not be called when the signature doesn't verify");
});

Deno.test("a malformed but validly-signed payload (missing otp) is rejected with 400", async () => {
  const { client, calls } = fakeTermii({ ok: true, messageId: "should-not-be-used" });
  const req = signedRequest({ user: { phone: "+2348012345678" }, sms: {} });

  const res = await handleRequest(req, ENV, client);

  assertEquals(res.status, 400);
  assertEquals(calls.length, 0);
});

Deno.test("when Termii fails, the function returns 500 and never leaks the api key", async () => {
  const { client } = fakeTermii({ ok: false, error: "insufficient balance" });
  const req = signedRequest({ user: { phone: "+2348012345678" }, sms: { otp: "561166" } });

  const res = await handleRequest(req, ENV, client);
  const text = await res.text();

  assertEquals(res.status, 500);
  assertEquals(text.includes(ENV.termiiApiKey), false, "response body must never contain the Termii api key");
});
