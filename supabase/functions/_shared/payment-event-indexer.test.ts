import { assertEquals } from "jsr:@std/assert@1";
import { orderRefFromHex, orderRefToHex, parseBillPaidEvent, type RpcEventLike } from "./payment-event-indexer.ts";

function validOrderRef(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

Deno.test("parseBillPaidEvent: parses a well-formed bill_paid event", () => {
  const orderRef = validOrderRef();
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid"],
    value: ["GABCDEXAMPLE", "ikeja-electric", orderRef, 1850000000n],
  };

  const parsed = parseBillPaidEvent(event);
  assertEquals(parsed?.payer, "GABCDEXAMPLE");
  assertEquals(parsed?.billerId, "ikeja-electric");
  assertEquals(parsed?.orderRef, orderRef);
  assertEquals(parsed?.amountStroops, 1850000000n);
});

Deno.test("parseBillPaidEvent: rejects a non-contract event", () => {
  const event: RpcEventLike = { type: "system", topic: ["bill_paid"], value: [] };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects an event with the wrong topic", () => {
  const event: RpcEventLike = {
    type: "contract",
    topic: ["something_else"],
    value: ["G...", "x", validOrderRef(), 1n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects a malformed order_ref (not 32 bytes)", () => {
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid"],
    value: ["G...", "x", new Uint8Array(16), 1n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("parseBillPaidEvent: rejects a zero/negative amount", () => {
  const event: RpcEventLike = {
    type: "contract",
    topic: ["bill_paid"],
    value: ["G...", "x", validOrderRef(), 0n],
  };
  assertEquals(parseBillPaidEvent(event), null);
});

Deno.test("orderRefToHex / orderRefFromHex round-trip", () => {
  const ref = validOrderRef();
  assertEquals(orderRefFromHex(orderRefToHex(ref)), ref);
});
