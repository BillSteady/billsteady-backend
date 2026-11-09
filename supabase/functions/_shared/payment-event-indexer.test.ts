import { assertEquals } from "jsr:@std/assert@1";
import { orderRefFromHex, orderRefToHex, parseBillPaidEvent, type RpcEventLike } from "./payment-event-indexer.ts";

function validOrderRef(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

Deno.test("parseBillPaidEvent: parses a well-formed bill_paid event (payer/biller_id in topics, matching the real deployed contract)", () => {
  const orderRef = validOrderRef();
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid", "GABCDEXAMPLE", "ikeja-electric"],
    value: [orderRef, 1850000000n],
  };

  const parsed = parseBillPaidEvent(event);
  assertEquals(parsed?.payer, "GABCDEXAMPLE");
  assertEquals(parsed?.billerId, "ikeja-electric");
  assertEquals(parsed?.orderRef, orderRef);
  assertEquals(parsed?.amountStroops, 1850000000n);
});

Deno.test("parseBillPaidEvent: rejects a non-contract event", () => {
  const event: RpcEventLike = {
    type: "system",
    topic: ["bill_paid", "G...", "x"],
    value: [validOrderRef(), 1n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects an event with the wrong name topic", () => {
  const event: RpcEventLike = {
    type: "contract",
    topic: ["something_else", "G...", "x"],
    value: [validOrderRef(), 1n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects a topic array of the wrong length (the original bug this guards against)", () => {
  // The contract's real event has 3 topics (name, payer, biller_id), not 1.
  // A parser expecting only ["bill_paid"] would reject every real event.
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid"],
    value: [validOrderRef(), 1n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects a malformed order_ref (not 32 bytes)", () => {
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid", "G...", "x"],
    value: [new Uint8Array(16), 1n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects a zero/negative amount", () => {
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid", "G...", "x"],
    value: [validOrderRef(), 0n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("orderRefToHex / orderRefFromHex round-trip", () => {
  const ref = validOrderRef();
  assertEquals(orderRefFromHex(orderRefToHex(ref)), ref);
});
