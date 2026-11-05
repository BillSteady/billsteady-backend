// Minimal client for Termii's "Send Message" API, kept separate from the
// HTTP handler so it's mockable in tests without faking a whole fetch stack.
//
// Field names and the example response shape are taken from Termii's own
// Messaging API docs (POST {baseUrl}/api/sms/send). The base URL itself is
// NOT hardcoded: Termii's docs reference a per-account "BASE_URL" without
// stating the literal default, so this takes it as a parameter (env
// TERMII_BASE_URL) rather than guess - confirm the real value on the
// Termii dashboard before this is used for real sends.

export interface TermiiClient {
  send(to: string, message: string): Promise<TermiiSendResult>;
}

export type TermiiSendResult =
  | { ok: true; messageId: string }
  | { ok: false; error: string };

export interface TermiiClientOptions {
  apiKey: string;
  senderId: string;
  baseUrl: string;
  fetchImpl?: typeof fetch;
}

export function createTermiiClient(opts: TermiiClientOptions): TermiiClient {
  const fetchImpl = opts.fetchImpl ?? fetch;

  return {
    async send(to: string, message: string): Promise<TermiiSendResult> {
      let response: Response;
      try {
        response = await fetchImpl(`${opts.baseUrl}/api/sms/send`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            api_key: opts.apiKey,
            to,
            from: opts.senderId,
            sms: message,
            type: "plain",
            channel: "generic",
          }),
        });
      } catch {
        // Never interpolate the caught error into the message: it can echo
        // back request internals (which include api_key) on some runtimes.
        return { ok: false, error: "network error calling Termii" };
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: `Termii returned a non-JSON response (status ${response.status})` };
      }

      if (!response.ok || !isSuccessBody(body)) {
        const message = isErrorBody(body) ? body.message : `Termii request failed (status ${response.status})`;
        return { ok: false, error: message };
      }

      return { ok: true, messageId: body.message_id };
    },
  };
}

interface TermiiSuccessBody {
  code: string;
  message_id: string;
  message: string;
}

interface TermiiErrorBody {
  message: string;
}

function isSuccessBody(body: unknown): body is TermiiSuccessBody {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.code === "ok" && typeof record.message_id === "string";
}

function isErrorBody(body: unknown): body is TermiiErrorBody {
  if (typeof body !== "object" || body === null) return false;
  return typeof (body as Record<string, unknown>).message === "string";
}
