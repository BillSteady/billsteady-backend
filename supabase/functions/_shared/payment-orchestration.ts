// Orchestrates what happens once an on-chain BillPaymentRouter.pay() is
// confirmed: mark the matching payment_order funded, THEN - and only then -
// call VTpass to actually settle with the biller.
//
// This ordering is the one thing in this file that must never be reordered
// or made "fire and forget": calling VTpass before the on-chain payment is
// durably recorded as funded would mean fronting the biller payment on the
// hope the chain payment lands, which is exactly the custodial-style risk
// the whole non-custodial pivot exists to avoid. handleConfirmedOnchainPayment
// has no code path that reaches payViaVtpass without markOrderFunded having
// already resolved - see payment-orchestration.test.ts's ordering assertion.
import { type PaymentOrderStatus, transition } from "./payment-order-state-machine.ts";
import type { BillPaidEvent } from "./payment-event-indexer.ts";
import { orderRefToHex } from "./payment-event-indexer.ts";

export interface PaymentOrderRow {
  id: string;
  status: PaymentOrderStatus;
  userId: string;
  billerId: string;
  amountKobo: number;
}

export interface VtpassPayResult {
  providerRef: string;
  receipt: unknown;
}

export interface OrchestrationDeps {
  getOrderByOrderRefHex: (orderRefHex: string) => Promise<PaymentOrderRow | null>;
  markOrderFunded: (orderId: string, onchainTxHash: string) => Promise<void>;
  markOrderPaying: (orderId: string) => Promise<void>;
  payViaVtpass: (order: PaymentOrderRow) => Promise<VtpassPayResult | { error: string }>;
  markOrderPaid: (orderId: string, result: VtpassPayResult) => Promise<void>;
  markOrderFailed: (orderId: string, reason: string) => Promise<void>;
}

export type OrchestrationResult =
  | { ok: true; orderId: string }
  | { ok: false; reason: string; orderId?: string };

export async function handleConfirmedOnchainPayment(
  event: BillPaidEvent,
  onchainTxHash: string,
  deps: OrchestrationDeps,
): Promise<OrchestrationResult> {
  const orderRefHex = orderRefToHex(event.orderRef);
  const order = await deps.getOrderByOrderRefHex(orderRefHex);
  if (!order) {
    return { ok: false, reason: `no payment_order matches order_ref ${orderRefHex}` };
  }

  const toFunded = transition(order.status, "funded");
  if (!toFunded.ok) {
    // Most commonly: the order is already "funded" or past it, because
    // this is a redelivered/duplicate event (RPC getEvents re-polled past
    // an already-processed ledger range, or the caller retried). Rejecting
    // the transition here - not calling VTpass again - is what makes
    // double-paying a biller on a duplicate event impossible, the same
    // idempotency principle as the UNIQUE constraint on order_ref itself.
    return { ok: false, reason: toFunded.reason, orderId: order.id };
  }

  // The on-chain payment is now durably recorded as funded. Only after
  // this await resolves does VTpass ever get called.
  await deps.markOrderFunded(order.id, onchainTxHash);

  const toPaying = transition("funded", "paying");
  if (!toPaying.ok) {
    // Unreachable given LEGAL_TRANSITIONS (funded -> paying is always
    // legal), but handled explicitly rather than assumed, matching how
    // every other transition in this file is checked.
    return { ok: false, reason: toPaying.reason, orderId: order.id };
  }
  await deps.markOrderPaying(order.id);

  const result = await deps.payViaVtpass(order);
  if ("error" in result) {
    await deps.markOrderFailed(order.id, result.error);
    return { ok: false, reason: result.error, orderId: order.id };
  }

  await deps.markOrderPaid(order.id, result);
  return { ok: true, orderId: order.id };
}
