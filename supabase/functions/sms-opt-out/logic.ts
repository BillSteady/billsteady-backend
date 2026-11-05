// Pure, testable pieces of the inbound SMS opt-out handler. Termii's own
// docs (developers.termii.com/events-and-reports, fetched directly while
// building this) do NOT define a separate "incoming message" webhook shape
// - inbound replies arrive on the same delivery-report webhook, distinguished
// by `status: "Received"`, with the reply text in `message` and the sender's
// number in `receiver`. That status string and this payload shape are the
// most specific thing Termii's docs state; they are not independently
// confirmed against a live webhook delivery (no Termii account exists to
// test against) - see README.md.

export interface TermiiWebhookPayload {
  type?: string;
  id?: string;
  message_id?: string;
  receiver?: string;
  sender?: string;
  message?: string;
  sent_at?: string;
  cost?: string;
  status?: string;
  channel?: string;
}

// Only STOP is in the PRD's own spec ("honour opt-out (reply STOP)"), but
// the usual SMS opt-out keyword set is included too since real users will
// type all of these - the cost of over-honouring an opt-out is near zero.
const OPT_OUT_KEYWORDS = new Set(["STOP", "UNSUBSCRIBE", "CANCEL", "QUIT", "END"]);

/** True when this webhook delivery is an inbound reply that should opt the sender out of SMS. */
export function isOptOutReply(payload: TermiiWebhookPayload): boolean {
  if (payload.status !== "Received") return false;
  if (!payload.message) return false;
  return OPT_OUT_KEYWORDS.has(payload.message.trim().toUpperCase());
}

export function isValidPayload(payload: unknown): payload is TermiiWebhookPayload {
  return typeof payload === "object" && payload !== null;
}
