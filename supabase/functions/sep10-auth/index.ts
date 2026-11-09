// SEP-10 (Stellar Web Auth) HTTP handler: GET issues a challenge, POST
// verifies a signed challenge and issues a BillSteady session JWT. This is
// the primary login path (see supabase-jwt.ts's header comment for why a
// self-issued JWT instead of a GoTrue session).
import { Keypair } from "npm:@stellar/stellar-sdk@13";
import { buildChallenge, verifyChallenge } from "../_shared/stellar-webauth.ts";
import { issueSessionJwt } from "../_shared/supabase-jwt.ts";

export interface Deps {
  serverSecret: string;
  homeDomain: string;
  webAuthDomain: string;
  networkPassphrase: string;
  jwtSecret: string;
  jwtIssuer: string;
  jwtTtlSeconds: number;
  /** Looks up (or creates, on first login) the public.users row for this
   * stellar address, returning its id - the value issueSessionJwt puts in
   * the token's `sub` claim. */
  findOrCreateUserByStellarAddress: (stellarAddress: string) => Promise<{ id: string }>;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

export async function handleRequest(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET") {
    const account = url.searchParams.get("account");
    if (!account) return json({ error: "missing required query param: account" }, 400);

    const challenge = buildChallenge({
      serverSecret: deps.serverSecret,
      clientAccountId: account,
      homeDomain: deps.homeDomain,
      webAuthDomain: deps.webAuthDomain,
      networkPassphrase: deps.networkPassphrase,
    });
    return json(challenge, 200);
  }

  if (req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (typeof body !== "object" || body === null || typeof (body as Record<string, unknown>).transaction !== "string") {
      return json({ error: "missing required field: transaction" }, 400);
    }
    const signedChallengeXdr = (body as { transaction: string }).transaction;

    const serverAccountId = Keypair.fromSecret(deps.serverSecret).publicKey();
    const result = verifyChallenge({
      signedChallengeXdr,
      serverAccountId,
      networkPassphrase: deps.networkPassphrase,
      homeDomain: deps.homeDomain,
      webAuthDomain: deps.webAuthDomain,
    });

    if (!result.ok) return json({ error: `challenge verification failed: ${result.reason}` }, 401);

    const user = await deps.findOrCreateUserByStellarAddress(result.clientAccountId);
    const token = await issueSessionJwt({
      userId: user.id,
      stellarAddress: result.clientAccountId,
      issuer: deps.jwtIssuer,
      secret: deps.jwtSecret,
      ttlSeconds: deps.jwtTtlSeconds,
    });

    return json({ token }, 200);
  }

  return json({ error: "method not allowed" }, 405);
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

// Same situation as reminders/index.ts and sms-opt-out/index.ts: the real
// Supabase-backed findOrCreateUserByStellarAddress isn't wired up here,
// because doing so against an unverified live schema/client shape would be
// guessing, not building. The challenge build/verify (stellar-webauth.ts)
// and JWT issuance (supabase-jwt.ts) are fully, cryptographically tested;
// the DB lookup/insert is not written yet - see README.md.
if (import.meta.main) {
  throw new Error(
    "sep10-auth: no live Deps implementation wired up yet - needs a real Supabase project (see README.md). " +
      "Challenge build/verify and JWT issuance are fully tested; the user lookup/creation DB write is not.",
  );
}

export { requireEnv };
