// SEP-10 (Stellar Web Auth) challenge build/verify, wrapping
// @stellar/stellar-sdk's own `WebAuth` helpers rather than hand-rolling the
// XDR/signature logic - getting SEP-10 subtly wrong (sequence number,
// timebounds, which signature is checked against what) is a real security
// bug, not a style choice, so this defers the actual spec compliance to the
// SDK maintainers and only wires it up.
//
// Scope, stated explicitly: v1 supports single-key client accounts only
// (the overwhelming common case - Freighter/Lobstr/xBull default accounts).
// `WebAuth.verifyChallengeTxSigners` is called with the client's own public
// key as the sole expected signer; a multisig/weighted-threshold client
// account will fail verification here even if correctly signed by enough
// of its own signers. That's `WebAuth.verifyChallengeTxThreshold`'s job,
// not supported in this slice - not a bug, a documented non-goal.
//
// `client_domain` verification (SEP-10's optional extra step for
// wallet-to-dApp provenance) is also out of scope for the same reason:
// not needed for "a user's own wallet authenticates directly."
import { Keypair, WebAuth } from "npm:@stellar/stellar-sdk@13";

export interface Challenge {
  transaction: string;
  network_passphrase: string;
}

export function buildChallenge(opts: {
  serverSecret: string;
  clientAccountId: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  timeoutSeconds?: number;
}): Challenge {
  const serverKeypair = Keypair.fromSecret(opts.serverSecret);
  const transaction = WebAuth.buildChallengeTx(
    serverKeypair,
    opts.clientAccountId,
    opts.homeDomain,
    opts.timeoutSeconds ?? 300,
    opts.networkPassphrase,
    opts.webAuthDomain,
  );
  return { transaction, network_passphrase: opts.networkPassphrase };
}

export type VerifyChallengeResult =
  | { ok: true; clientAccountId: string }
  | { ok: false; reason: string };

export function verifyChallenge(opts: {
  signedChallengeXdr: string;
  serverAccountId: string;
  networkPassphrase: string;
  homeDomain: string;
  webAuthDomain: string;
}): VerifyChallengeResult {
  try {
    // readChallengeTx validates structure (server signature, sequence=0,
    // timebounds, first-operation shape, home-domain match) and tells us
    // who the client claims to be - but per its own docs, it does NOT
    // verify the client's signature. That's the separate call below.
    const { clientAccountID } = WebAuth.readChallengeTx(
      opts.signedChallengeXdr,
      opts.serverAccountId,
      opts.networkPassphrase,
      opts.homeDomain,
      opts.webAuthDomain,
    );

    // Confirms the transaction actually carries a valid signature from
    // the claimed account's own key - this is the step that makes it an
    // authentication proof rather than just a well-formed transaction.
    WebAuth.verifyChallengeTxSigners(
      opts.signedChallengeXdr,
      opts.serverAccountId,
      opts.networkPassphrase,
      [clientAccountID],
      opts.homeDomain,
      opts.webAuthDomain,
    );

    return { ok: true, clientAccountId: clientAccountID };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
