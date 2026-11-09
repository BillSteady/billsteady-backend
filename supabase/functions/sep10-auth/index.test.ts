import { assert, assertEquals } from "jsr:@std/assert@1";
import { Keypair, Networks, TransactionBuilder } from "npm:@stellar/stellar-sdk@13";
import { handleRequest, type Deps } from "./index.ts";
import { verifySessionJwt } from "../_shared/supabase-jwt.ts";

const SERVER = Keypair.random();
const HOME_DOMAIN = "billsteady.app";

function baseDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    serverSecret: SERVER.secret(),
    homeDomain: HOME_DOMAIN,
    webAuthDomain: HOME_DOMAIN,
    networkPassphrase: Networks.TESTNET,
    jwtSecret: "test-secret-at-least-32-bytes-long-for-hs256",
    jwtIssuer: "billsteady-backend",
    jwtTtlSeconds: 3600,
    findOrCreateUserByStellarAddress: async (address) => ({ id: `user-for-${address}` }),
    ...overrides,
  };
}

Deno.test("GET without ?account returns 400", async () => {
  const res = await handleRequest(new Request("https://x/sep10-auth"), baseDeps());
  assertEquals(res.status, 400);
});

Deno.test("GET with ?account returns a challenge transaction", async () => {
  const client = Keypair.random();
  const res = await handleRequest(
    new Request(`https://x/sep10-auth?account=${client.publicKey()}`),
    baseDeps(),
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assert(typeof body.transaction === "string" && body.transaction.length > 0);
  assertEquals(body.network_passphrase, Networks.TESTNET);
});

Deno.test("POST with a valid signed challenge issues a session JWT for the right user", async () => {
  const client = Keypair.random();
  const deps = baseDeps();

  const challengeRes = await handleRequest(
    new Request(`https://x/sep10-auth?account=${client.publicKey()}`),
    deps,
  );
  const { transaction } = await challengeRes.json();

  const tx = TransactionBuilder.fromXDR(transaction, Networks.TESTNET);
  tx.sign(client);
  const signed = tx.toEnvelope().toXDR("base64").toString();

  const verifyRes = await handleRequest(
    new Request("https://x/sep10-auth", { method: "POST", body: JSON.stringify({ transaction: signed }) }),
    deps,
  );
  assertEquals(verifyRes.status, 200);
  const { token } = await verifyRes.json();

  const verified = await verifySessionJwt(token, deps.jwtSecret);
  assert(verified.ok);
  if (verified.ok) {
    assertEquals(verified.claims.sub, `user-for-${client.publicKey()}`);
    assertEquals(verified.claims.stellar_address, client.publicKey());
  }
});

Deno.test("POST with an unsigned challenge is rejected with 401, and never calls findOrCreateUser", async () => {
  const client = Keypair.random();
  let userLookupCalled = false;
  const deps = baseDeps({
    findOrCreateUserByStellarAddress: async (address) => {
      userLookupCalled = true;
      return { id: `user-for-${address}` };
    },
  });

  const challengeRes = await handleRequest(
    new Request(`https://x/sep10-auth?account=${client.publicKey()}`),
    deps,
  );
  const { transaction } = await challengeRes.json();

  // Never signed by the client.
  const verifyRes = await handleRequest(
    new Request("https://x/sep10-auth", { method: "POST", body: JSON.stringify({ transaction }) }),
    deps,
  );
  assertEquals(verifyRes.status, 401);
  assertEquals(userLookupCalled, false, "an unverified challenge must never reach the user-creation step");
});

Deno.test("POST with a missing transaction field returns 400", async () => {
  const res = await handleRequest(
    new Request("https://x/sep10-auth", { method: "POST", body: JSON.stringify({}) }),
    baseDeps(),
  );
  assertEquals(res.status, 400);
});

Deno.test("unsupported method returns 405", async () => {
  const res = await handleRequest(new Request("https://x/sep10-auth", { method: "DELETE" }), baseDeps());
  assertEquals(res.status, 405);
});
