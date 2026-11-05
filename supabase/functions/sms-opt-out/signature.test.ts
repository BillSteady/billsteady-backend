import { assertEquals } from "jsr:@std/assert@1";
import { verifyTermiiSignature } from "./signature.ts";

async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(mac)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("a correctly signed body verifies", async () => {
  const body = '{"status":"Received","message":"STOP","receiver":"2348012345678"}';
  const secret = "test-secret";
  const signature = await sign(body, secret);

  assertEquals(await verifyTermiiSignature(body, signature, secret), true);
});

Deno.test("a tampered body fails verification even with a validly-formed signature present", async () => {
  const body = '{"status":"Received","message":"STOP","receiver":"2348012345678"}';
  const secret = "test-secret";
  const signatureForDifferentBody = await sign('{"status":"Received","message":"HELLO"}', secret);

  assertEquals(await verifyTermiiSignature(body, signatureForDifferentBody, secret), false);
});

Deno.test("the wrong secret fails verification", async () => {
  const body = '{"status":"Received","message":"STOP"}';
  const signature = await sign(body, "right-secret");

  assertEquals(await verifyTermiiSignature(body, signature, "wrong-secret"), false);
});

Deno.test("a missing signature header fails verification", async () => {
  assertEquals(await verifyTermiiSignature("{}", null, "any-secret"), false);
});
