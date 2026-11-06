// Written first, against a module that doesn't exist yet - run `deno test`
// now and every case below should fail with a module-not-found error, not
// a real assertion failure, before payment-order-state-machine.ts exists.
import { assertEquals } from "jsr:@std/assert@1";
import { isTerminal, transition, type PaymentOrderStatus } from "./payment-order-state-machine.ts";

const ALL_STATUSES: PaymentOrderStatus[] = ["quote", "funded", "paying", "paid", "failed", "refunded"];

Deno.test("legal transitions are accepted", () => {
  const legal: [PaymentOrderStatus, PaymentOrderStatus][] = [
    ["quote", "funded"],
    ["funded", "paying"],
    ["paying", "paid"],
    ["paying", "failed"],
    ["failed", "refunded"],
  ];
  for (const [from, to] of legal) {
    const result = transition(from, to);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.from, from);
      assertEquals(result.to, to);
    }
  }
});

Deno.test("quote cannot jump straight to paid, skipping funded/paying", () => {
  const result = transition("quote", "paid");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.from, "quote");
    assertEquals(result.attempted, "paid");
  }
});

Deno.test("funded cannot skip paying and go straight to paid", () => {
  const result = transition("funded", "paid");
  assertEquals(result.ok, false);
});

Deno.test("funded cannot skip paying and go straight to failed", () => {
  const result = transition("funded", "failed");
  assertEquals(result.ok, false);
});

Deno.test("funded cannot be refunded directly, skipping paying/failed", () => {
  const result = transition("funded", "refunded");
  assertEquals(result.ok, false);
});

Deno.test("paid is terminal: no transition out of it is legal", () => {
  for (const to of ALL_STATUSES) {
    if (to === "paid") continue;
    const result = transition("paid", to);
    assertEquals(result.ok, false, `paid -> ${to} should be illegal`);
  }
});

Deno.test("paid cannot go directly to refunded - only failed can, per the PRD's stated transitions", () => {
  const result = transition("paid", "refunded");
  assertEquals(result.ok, false);
});

Deno.test("refunded is terminal: no transition out of it is legal", () => {
  for (const to of ALL_STATUSES) {
    if (to === "refunded") continue;
    const result = transition("refunded", to);
    assertEquals(result.ok, false, `refunded -> ${to} should be illegal`);
  }
});

Deno.test("a status cannot transition to itself (no-op is not a legal transition)", () => {
  for (const status of ALL_STATUSES) {
    const result = transition(status, status);
    assertEquals(result.ok, false, `${status} -> ${status} should be illegal`);
  }
});

Deno.test("transitions never go backward (e.g. paying cannot return to funded)", () => {
  assertEquals(transition("paying", "funded").ok, false);
  assertEquals(transition("paying", "quote").ok, false);
  assertEquals(transition("funded", "quote").ok, false);
});

Deno.test("a rejected transition carries a human-readable reason, not just ok:false", () => {
  const result = transition("quote", "paid");
  if (result.ok) throw new Error("expected rejection");
  if (typeof result.reason !== "string" || result.reason.length === 0) {
    throw new Error("expected a non-empty reason string explaining the rejection");
  }
});

Deno.test("isTerminal: paid and refunded are terminal, everything else is not", () => {
  assertEquals(isTerminal("paid"), true);
  assertEquals(isTerminal("refunded"), true);
  assertEquals(isTerminal("quote"), false);
  assertEquals(isTerminal("funded"), false);
  assertEquals(isTerminal("paying"), false);
  assertEquals(isTerminal("failed"), false);
});

Deno.test("transition is a pure function: calling it twice with the same inputs gives the same result, no hidden state", () => {
  const a = transition("quote", "funded");
  const b = transition("quote", "funded");
  assertEquals(a, b);
});
