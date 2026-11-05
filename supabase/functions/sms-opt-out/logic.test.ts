import { assertEquals } from "jsr:@std/assert@1";
import { isOptOutReply, isValidPayload } from "./logic.ts";

Deno.test("isOptOutReply: a received STOP reply is an opt-out", () => {
  assertEquals(isOptOutReply({ status: "Received", message: "STOP" }), true);
});

Deno.test("isOptOutReply: case-insensitive and trims whitespace", () => {
  assertEquals(isOptOutReply({ status: "Received", message: "  stop  " }), true);
});

Deno.test("isOptOutReply: other opt-out keywords also count", () => {
  for (const word of ["UNSUBSCRIBE", "CANCEL", "QUIT", "END"]) {
    assertEquals(isOptOutReply({ status: "Received", message: word }), true, word);
  }
});

Deno.test("isOptOutReply: an ordinary received reply is not an opt-out", () => {
  assertEquals(isOptOutReply({ status: "Received", message: "ok thanks" }), false);
});

Deno.test("isOptOutReply: a delivery-report event (not Received) is never an opt-out, even if the message text happens to say STOP", () => {
  assertEquals(isOptOutReply({ status: "Delivered", message: "STOP" }), false);
});

Deno.test("isOptOutReply: a missing message is not an opt-out", () => {
  assertEquals(isOptOutReply({ status: "Received" }), false);
});

Deno.test("isValidPayload: rejects non-object payloads", () => {
  assertEquals(isValidPayload(null), false);
  assertEquals(isValidPayload("STOP"), false);
  assertEquals(isValidPayload(42), false);
});

Deno.test("isValidPayload: accepts an object", () => {
  assertEquals(isValidPayload({ status: "Received" }), true);
});
