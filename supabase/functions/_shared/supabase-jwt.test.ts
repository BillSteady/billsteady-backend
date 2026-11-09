import { assert, assertEquals } from "jsr:@std/assert@1";
import { issueSessionJwt, verifySessionJwt } from "./supabase-jwt.ts";

const SECRET = "test-jwt-secret-at-least-32-bytes-long-for-hs256";
const USER_ID = "11111111-1111-1111-1111-111111111111";
const ADDRESS = "GABCDEXAMPLESTELLARADDRESS000000000000000000000000000000";

Deno.test("issueSessionJwt + verifySessionJwt: round-trips with the right secret", async () => {
  const token = await issueSessionJwt({
    userId: USER_ID,
    stellarAddress: ADDRESS,
    issuer: "billsteady-backend",
    secret: SECRET,
    ttlSeconds: 3600,
  });

  const result = await verifySessionJwt(token, SECRET);
  assert(result.ok, "expected verification to succeed");
  if (result.ok) {
    assertEquals(result.claims.sub, USER_ID);
    assertEquals(result.claims.role, "authenticated");
    assertEquals(result.claims.aud, "authenticated");
    assertEquals(result.claims.stellar_address, ADDRESS);
  }
});

Deno.test("verifySessionJwt: rejects a token signed with the wrong secret", async () => {
  const token = await issueSessionJwt({
    userId: USER_ID,
    stellarAddress: ADDRESS,
    issuer: "billsteady-backend",
    secret: SECRET,
    ttlSeconds: 3600,
  });

  const result = await verifySessionJwt(token, "a-completely-different-secret");
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "bad_signature");
});

Deno.test("verifySessionJwt: rejects a tampered payload even with a validly-shaped signature", async () => {
  const token = await issueSessionJwt({
    userId: USER_ID,
    stellarAddress: ADDRESS,
    issuer: "billsteady-backend",
    secret: SECRET,
    ttlSeconds: 3600,
  });

  const [header, payload, sig] = token.split(".");
  // Flip the role claim to something privileged-sounding without re-signing -
  // this must be rejected, not silently accepted.
  const tamperedPayloadJson = JSON.stringify({
    ...JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)))),
    role: "service_role",
  });
  const tamperedPayload = btoa(tamperedPayloadJson).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  const result = await verifySessionJwt(`${header}.${tamperedPayload}.${sig}`, SECRET);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "bad_signature");
});

Deno.test("verifySessionJwt: rejects an expired token", async () => {
  const token = await issueSessionJwt({
    userId: USER_ID,
    stellarAddress: ADDRESS,
    issuer: "billsteady-backend",
    secret: SECRET,
    ttlSeconds: -1, // already expired the moment it's issued
  });

  const result = await verifySessionJwt(token, SECRET);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "expired");
});

Deno.test("verifySessionJwt: rejects a malformed token", async () => {
  const result = await verifySessionJwt("not-a-jwt", SECRET);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.reason, "malformed");
});
