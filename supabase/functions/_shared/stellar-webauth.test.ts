import { assert, assertEquals } from "jsr:@std/assert@1";
import { Account, Keypair, Networks, Operation, TransactionBuilder } from "npm:@stellar/stellar-sdk@13";
import { buildChallenge, verifyChallenge } from "./stellar-webauth.ts";

const HOME_DOMAIN = "billsteady.app";
const WEB_AUTH_DOMAIN = "billsteady.app";
const NETWORK = Networks.TESTNET;

function signWith(xdr: string, keypair: InstanceType<typeof Keypair>): string {
  const tx = TransactionBuilder.fromXDR(xdr, NETWORK);
  tx.sign(keypair);
  return tx.toEnvelope().toXDR("base64").toString();
}

Deno.test("buildChallenge + verifyChallenge: a real client signature round-trips", () => {
  const server = Keypair.random();
  const client = Keypair.random();

  const challenge = buildChallenge({
    serverSecret: server.secret(),
    clientAccountId: client.publicKey(),
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK,
  });

  const signed = signWith(challenge.transaction, client);

  const result = verifyChallenge({
    signedChallengeXdr: signed,
    serverAccountId: server.publicKey(),
    networkPassphrase: NETWORK,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
  });

  assert(result.ok, `expected verification to succeed, got: ${JSON.stringify(result)}`);
  if (result.ok) assertEquals(result.clientAccountId, client.publicKey());
});

Deno.test("verifyChallenge: rejects a challenge signed by the wrong account (impersonation attempt)", () => {
  const server = Keypair.random();
  const client = Keypair.random();
  const attacker = Keypair.random();

  const challenge = buildChallenge({
    serverSecret: server.secret(),
    clientAccountId: client.publicKey(), // challenge issued FOR client...
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK,
  });

  // ...but signed by someone else entirely, trying to authenticate as client.
  const signedByAttacker = signWith(challenge.transaction, attacker);

  const result = verifyChallenge({
    signedChallengeXdr: signedByAttacker,
    serverAccountId: server.publicKey(),
    networkPassphrase: NETWORK,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
  });

  assertEquals(result.ok, false);
});

Deno.test("verifyChallenge: rejects an unsigned challenge", () => {
  const server = Keypair.random();
  const client = Keypair.random();

  const challenge = buildChallenge({
    serverSecret: server.secret(),
    clientAccountId: client.publicKey(),
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK,
  });

  // Never signed by the client - only the server's own signature (from
  // buildChallengeTx) is present.
  const result = verifyChallenge({
    signedChallengeXdr: challenge.transaction,
    serverAccountId: server.publicKey(),
    networkPassphrase: NETWORK,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
  });

  assertEquals(result.ok, false);
});

Deno.test("verifyChallenge: rejects a wrong home domain", () => {
  const server = Keypair.random();
  const client = Keypair.random();

  const challenge = buildChallenge({
    serverSecret: server.secret(),
    clientAccountId: client.publicKey(),
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
    networkPassphrase: NETWORK,
  });
  const signed = signWith(challenge.transaction, client);

  const result = verifyChallenge({
    signedChallengeXdr: signed,
    serverAccountId: server.publicKey(),
    networkPassphrase: NETWORK,
    homeDomain: "a-different-domain.example",
    webAuthDomain: WEB_AUTH_DOMAIN,
  });

  assertEquals(result.ok, false);
});

Deno.test("verifyChallenge: rejects a genuinely expired challenge", () => {
  // The SDK's own readChallengeTx (via Utils.validateTimebounds) grants a
  // 5-minute grace period PAST a challenge's own maxTime before treating it
  // as expired - confirmed by reading @stellar/stellar-sdk 13.3.0's compiled
  // source (webauth/utils.js: `Utils.validateTimebounds(transaction, 60*5)`),
  // not assumed from the spec text. A first version of this test waited
  // ~1.3s past a 1s timeout and wrongly expected rejection - it passed as
  // "still valid" because of that grace window, which is real SDK behavior
  // worth knowing, not a bug in this wrapper. Waiting 5+ real minutes in a
  // test suite isn't practical, so this builds a challenge with timebounds
  // already ~10 minutes in the past by hand (mirroring buildChallengeTx's
  // own shape) instead of waiting for one to age past the grace window.
  const server = Keypair.random();
  const client = Keypair.random();

  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.getRandomValues(new Uint8Array(48));
  const nonceBase64 = btoa(String.fromCharCode(...nonce));

  const serverAccount = new Account(server.publicKey(), "-1");
  const tx = new TransactionBuilder(serverAccount, {
    fee: "100",
    networkPassphrase: NETWORK,
    timebounds: { minTime: String(now - 900), maxTime: String(now - 600) }, // expired 10 min ago, grace only covers 5
  })
    .addOperation(
      Operation.manageData({
        source: client.publicKey(),
        name: `${HOME_DOMAIN} auth`,
        value: nonceBase64,
      }),
    )
    .addOperation(
      Operation.manageData({
        source: server.publicKey(),
        name: "web_auth_domain",
        value: WEB_AUTH_DOMAIN,
      }),
    )
    .build();
  tx.sign(server, client);
  const signed = tx.toEnvelope().toXDR("base64").toString();

  const result = verifyChallenge({
    signedChallengeXdr: signed,
    serverAccountId: server.publicKey(),
    networkPassphrase: NETWORK,
    homeDomain: HOME_DOMAIN,
    webAuthDomain: WEB_AUTH_DOMAIN,
  });

  assertEquals(result.ok, false);
});
