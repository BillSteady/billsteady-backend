// Inbound Termii webhook: marks a user opted out of SMS when they reply
// STOP (or an equivalent keyword). See logic.ts and signature.ts for what's
// confirmed vs. assumed about Termii's payload shape and signing - both are
// the most specific thing this session could confirm from Termii's own
// docs without a live account, not independently verified against a real
// signed delivery.
import { isOptOutReply, isValidPayload, type TermiiWebhookPayload } from "./logic.ts";
import { verifyTermiiSignature } from "./signature.ts";

export interface Deps {
  optOutUserByPhone(phone: string): Promise<void>;
}

export async function handleRequest(req: Request, secret: string, deps: Deps): Promise<Response> {
  const rawBody = await req.text();
  const signature = req.headers.get("x-termii-signature");

  const verified = await verifyTermiiSignature(rawBody, signature, secret);
  if (!verified) {
    return new Response(JSON.stringify({ error: { message: "invalid signature" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: { message: "malformed JSON body" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  if (!isValidPayload(parsed)) {
    return new Response(JSON.stringify({ error: { message: "malformed payload" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const payload = parsed as TermiiWebhookPayload;

  // This webhook receives every event type Termii sends (DLR "Delivered",
  // "Message Failed", etc, not just inbound replies) - anything that isn't
  // an opt-out reply is a deliberate, silent no-op, not an error.
  if (isOptOutReply(payload) && payload.receiver) {
    await deps.optOutUserByPhone(payload.receiver);
  }

  return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

// Same situation as supabase/functions/reminders/index.ts: the real
// Supabase-backed `optOutUserByPhone` isn't wired up here, because doing so
// against an unverified live schema/client shape would be guessing, not
// building. The signature verification and opt-out-keyword logic above are
// fully tested; the DB write is not written yet - see README.md.
if (import.meta.main) {
  throw new Error(
    "sms-opt-out: no live Deps implementation wired up yet - needs a real Supabase project (see README.md). " +
      "Signature verification (signature.ts) and opt-out detection (logic.ts) are fully tested; the DB write is not.",
  );
}

export { requireEnv };
