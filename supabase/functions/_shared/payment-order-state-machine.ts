// Idempotent payment-order state machine (PRD Prompt 2.1). Pure: no DB, no
// network, no Deno-specific APIs - fully unit-testable, same house style as
// reminders/logic.ts. The future Edge Function that actually writes
// payment_orders rows (Prompt 2.2, VTpass integration - not built yet)
// calls transition() before issuing an UPDATE, and refuses to write at all
// when the result is a rejection, rather than writing whatever status it
// was told to.
//
// PRD-specified legal path: quote -> funded -> paying -> (paid | failed),
// failed -> refunded. Notably NOT modeled: paid -> refunded. The PRD's own
// Prompt 2.1 only names the five transitions below; a post-payment refund
// path isn't specified anywhere in the PRD, so it isn't invented here -
// if that turns out to be needed, it's a new decision (and a new
// migration/test), not something to guess at now.
export type PaymentOrderStatus = "quote" | "funded" | "paying" | "paid" | "failed" | "refunded";

const LEGAL_TRANSITIONS: Record<PaymentOrderStatus, readonly PaymentOrderStatus[]> = {
  quote: ["funded"],
  funded: ["paying"],
  paying: ["paid", "failed"],
  paid: [],
  failed: ["refunded"],
  refunded: [],
};

export interface TransitionAccepted {
  ok: true;
  from: PaymentOrderStatus;
  to: PaymentOrderStatus;
}

export interface TransitionRejected {
  ok: false;
  from: PaymentOrderStatus;
  attempted: PaymentOrderStatus;
  reason: string;
}

export type TransitionResult = TransitionAccepted | TransitionRejected;

/**
 * Pure function of (current status, requested status). Returns a typed
 * rejection rather than throwing: an illegal transition is an expected,
 * recoverable outcome here (a retried webhook, two workers racing on the
 * same order, a stale client), not a bug to crash the caller over. The
 * caller decides what to do with a rejection (log it, no-op, alert) - this
 * function only classifies.
 */
export function transition(from: PaymentOrderStatus, to: PaymentOrderStatus): TransitionResult {
  const allowed = LEGAL_TRANSITIONS[from];
  if (allowed.includes(to)) {
    return { ok: true, from, to };
  }
  return {
    ok: false,
    from,
    attempted: to,
    reason: `illegal transition: ${from} -> ${to} (legal from ${from}: ${
      allowed.length ? allowed.join(", ") : "none, this is a terminal state"
    })`,
  };
}

/** A status with no legal outgoing transition - currently "paid" and "refunded". */
export function isTerminal(status: PaymentOrderStatus): boolean {
  return LEGAL_TRANSITIONS[status].length === 0;
}
