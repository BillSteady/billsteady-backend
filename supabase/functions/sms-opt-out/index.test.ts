import { assertEquals } from "jsr:@std/assert@1";
import { handleRequest, type Deps } from "./index.ts";

const SECRET = "test-webhook-secret";

async function sign(body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(bodyObj: unknown): Promise<Request> {
  const body = JSON.stringify(bodyObj);
  const signature = await sign(body);
  return new Request("https://example.test/sms-opt-out", {
    method: "POST",
    headers: { "x-termii-signature": signature },
    body,
  });
}

function fakeDeps(): { deps: Deps; optOuts: string[] } {
  const optOuts: string[] = [];
  return { optOuts, deps: { async optOutUserByPhone(phone: string) { optOuts.push(phone); } } };
}

Deno.test("a signed STOP reply opts the sender out", async () => {
  const { deps, optOuts } = fakeDeps();
  const req = await signedRequest({ status: "Received", message: "STOP", receiver: "2348012345678" });

  const res = await handleRequest(req, SECRET, deps);

  assertEquals(res.status, 200);
  assertEquals(optOuts, ["2348012345678"]);
});

Deno.test("an unsigned request is rejected and never triggers an opt-out", async () => {
  const { deps, optOuts } = fakeDeps();
  const req = new Request("https://example.test/sms-opt-out", {
    method: "POST",
    body: JSON.stringify({ status: "Received", message: "STOP", receiver: "2348012345678" }),
  });

  const res = await handleRequest(req, SECRET, deps);

  assertEquals(res.status, 401);
  assertEquals(optOuts, []);
});

Deno.test("an ordinary delivery-report event (not an opt-out) is accepted but does nothing", async () => {
  const { deps, optOuts } = fakeDeps();
  const req = await signedRequest({ status: "Delivered", message: "Your BillSteady code is 123456" });

  const res = await handleRequest(req, SECRET, deps);

  assertEquals(res.status, 200);
  assertEquals(optOuts, []);
});

Deno.test("a validly-signed but malformed JSON body is rejected with 400", async () => {
  const body = "not json";
  const signature = await sign(body);
  const req = new Request("https://example.test/sms-opt-out", {
    method: "POST",
    headers: { "x-termii-signature": signature },
    body,
  });

  const { deps, optOuts } = fakeDeps();
  const res = await handleRequest(req, SECRET, deps);

  assertEquals(res.status, 400);
  assertEquals(optOuts, []);
});
