import { assert, assertEquals } from "jsr:@std/assert@1";
import { handleConfirmedOnchainPayment, type OrchestrationDeps, type PaymentOrderRow } from "./payment-orchestration.ts";
import type { BillPaidEvent } from "./payment-event-indexer.ts";

function makeEvent(orderRef: Uint8Array): BillPaidEvent {
  return { payer: "GPAYER", billerId: "ikeja-electric", orderRef, amountStroops: 246000000n };
}

function quoteOrder(overrides: Partial<PaymentOrderRow> = {}): PaymentOrderRow {
  return { id: "order-1", status: "quote", userId: "user-1", billerId: "ikeja-electric", amountKobo: 1850000, ...overrides };
}

Deno.test("handleConfirmedOnchainPayment: marks funded BEFORE calling VTpass, in that order, every time", async () => {
  const order = quoteOrder();
  const orderRef = crypto.getRandomValues(new Uint8Array(32));
  const callLog: string[] = [];

  const deps: OrchestrationDeps = {
    getOrderByOrderRefHex: async () => order,
    markOrderFunded: async (id, tx) => {
      callLog.push(`markOrderFunded(${id}, ${tx})`);
      order.status = "funded";
    },
    markOrderPaying: async (id) => {
      callLog.push(`markOrderPaying(${id})`);
      order.status = "paying";
    },
    payViaVtpass: async (o) => {
      callLog.push(`payViaVtpass(${o.id})`);
      return { providerRef: "vtpass-ref-1", receipt: { ok: true } };
    },
    markOrderPaid: async (id) => {
      callLog.push(`markOrderPaid(${id})`);
    },
    markOrderFailed: async () => {
      callLog.push("markOrderFailed");
    },
  };

  const result = await handleConfirmedOnchainPayment(makeEvent(orderRef), "tx-hash-abc", deps);

  assert(result.ok, `expected success, got: ${JSON.stringify(result)}`);
  assertEquals(callLog, [
    "markOrderFunded(order-1, tx-hash-abc)",
    "markOrderPaying(order-1)",
    "payViaVtpass(order-1)",
    "markOrderPaid(order-1)",
  ]);
  // The specific, load-bearing assertion: funded strictly precedes VTpass.
  assert(callLog.indexOf("markOrderFunded(order-1, tx-hash-abc)") < callLog.indexOf("payViaVtpass(order-1)"));
});

Deno.test("handleConfirmedOnchainPayment: no matching order means VTpass is never called", async () => {
  let vtpassCalled = false;
  const deps: OrchestrationDeps = {
    getOrderByOrderRefHex: async () => null,
    markOrderFunded: async () => {},
    markOrderPaying: async () => {},
    payViaVtpass: async () => {
      vtpassCalled = true;
      return { providerRef: "x", receipt: {} };
    },
    markOrderPaid: async () => {},
    markOrderFailed: async () => {},
  };

  const result = await handleConfirmedOnchainPayment(makeEvent(crypto.getRandomValues(new Uint8Array(32))), "tx", deps);
  assertEquals(result.ok, false);
  assertEquals(vtpassCalled, false);
});

Deno.test("handleConfirmedOnchainPayment: a duplicate/redelivered event (order already funded) never calls VTpass again", async () => {
  const order = quoteOrder({ status: "funded" }); // already processed once
  let vtpassCalled = false;
  let markFundedCalled = false;

  const deps: OrchestrationDeps = {
    getOrderByOrderRefHex: async () => order,
    markOrderFunded: async () => {
      markFundedCalled = true;
    },
    markOrderPaying: async () => {},
    payViaVtpass: async () => {
      vtpassCalled = true;
      return { providerRef: "x", receipt: {} };
    },
    markOrderPaid: async () => {},
    markOrderFailed: async () => {},
  };

  const result = await handleConfirmedOnchainPayment(makeEvent(crypto.getRandomValues(new Uint8Array(32))), "tx", deps);
  assertEquals(result.ok, false);
  assertEquals(vtpassCalled, false, "a duplicate event must never trigger a second VTpass payment");
  assertEquals(markFundedCalled, false, "quote->funded is the only legal entry; funded->funded is rejected before any write");
});

Deno.test("handleConfirmedOnchainPayment: a VTpass failure marks the order failed, not paid", async () => {
  const order = quoteOrder();
  const deps: OrchestrationDeps = {
    getOrderByOrderRefHex: async () => order,
    markOrderFunded: async () => {
      order.status = "funded";
    },
    markOrderPaying: async () => {
      order.status = "paying";
    },
    payViaVtpass: async () => ({ error: "biller rejected the customer reference" }),
    markOrderPaid: async () => {
      throw new Error("must not be called on failure");
    },
    markOrderFailed: async (id, reason) => {
      assertEquals(id, order.id);
      assertEquals(reason, "biller rejected the customer reference");
    },
  };

  const result = await handleConfirmedOnchainPayment(makeEvent(crypto.getRandomValues(new Uint8Array(32))), "tx", deps);
  assertEquals(result.ok, false);
});
