// Supabase Auth "Send SMS Hook": Auth POSTs { user, sms: { otp } } here
// instead of using a built-in SMS provider (Termii isn't one of the
// built-ins - see supabase/config.toml's [auth.hook.send_sms] comment).
// The payload is signed per the Standard Webhooks spec; verification is
// mandatory before we trust anything in the body or send an SMS on its
// behalf. Shape and the standardwebhooks usage are taken directly from
// Supabase's own documented example for this hook.
import { Webhook } from "https://esm.sh/standardwebhooks@1.0.0";
import { createTermiiClient, type TermiiClient } from "./termii.ts";

interface SendSmsHookPayload {
  user: { phone: string };
  sms: { otp: string };
}

export async function handleRequest(
  req: Request,
  env: Env = defaultEnv(),
  termii: TermiiClient = createTermiiClient({
    apiKey: env.termiiApiKey,
    senderId: env.termiiSenderId,
    baseUrl: env.termiiBaseUrl,
  }),
): Promise<Response> {
  const payload = await req.text();
  const headers = Object.fromEntries(req.headers);

  const secret = env.sendSmsHookSecret.replace("v1,whsec_", "");
  const wh = new Webhook(secret);

  let verified: SendSmsHookPayload;
  try {
    verified = wh.verify(payload, headers) as SendSmsHookPayload;
  } catch {
    // Don't echo the verification error or the raw payload back - it's
    // either a forged request or a misconfigured secret, neither of which
    // the caller needs details about.
    return new Response(JSON.stringify({ error: { message: "invalid signature" } }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  const { user, sms } = verified;
  if (!user?.phone || !sms?.otp) {
    return new Response(JSON.stringify({ error: { message: "malformed hook payload" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const result = await termii.send(user.phone, `Your BillSteady code is ${sms.otp}`);

  if (!result.ok) {
    // Log only that it failed, never the api_key-bearing request body.
    console.error("send-otp-sms: Termii send failed", { error: result.error });
    return new Response(JSON.stringify({ error: { message: "failed to send SMS" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({}), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export interface Env {
  sendSmsHookSecret: string;
  termiiApiKey: string;
  termiiSenderId: string;
  termiiBaseUrl: string;
}

function defaultEnv(): Env {
  return {
    sendSmsHookSecret: requireEnv("SUPABASE_AUTH_SEND_SMS_HOOK_SECRET"),
    termiiApiKey: requireEnv("TERMII_API_KEY"),
    termiiSenderId: requireEnv("TERMII_SENDER_ID"),
    termiiBaseUrl: requireEnv("TERMII_BASE_URL"),
  };
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`missing required env var ${name}`);
  return value;
}

if (import.meta.main) {
  Deno.serve((req) => handleRequest(req));
}
