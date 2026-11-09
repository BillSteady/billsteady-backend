// Parses a BillPaymentRouter `pay()` success event from Stellar RPC's
// getEvents response shape.
//
// PROVISIONAL: billsteady-contracts' router/ contract is being built in a
// parallel session and its README (the source of truth for the exact event
// shape) didn't exist yet when this was written. This implements the shape
// specified in the coordinating session's own directive to that contracts
// session: topic `("bill_paid",)`, data `(payer, biller_id, order_ref,
// amount)`. Deliberately isolated in this one small function, exactly so
// it's a one-file fix: once billsteady-contracts/router/README.md exists,
// diff its real event shape against this function and fix on sight if it
// differs - don't trust this comment over that README.
export interface BillPaidEvent {
  payer: string; // G... address
  billerId: string;
  orderRef: Uint8Array; // 32 bytes, must match payment_orders.order_ref byte-for-byte
  amountStroops: bigint;
}

/** Minimal shape of one entry from Stellar RPC's getEvents response - only
 * the fields this parser actually reads, not the full RPC type. */
export interface RpcEventLike {
  type: string;
  topic: unknown[]; // decoded ScVal-native topic segments
  value: unknown; // decoded ScVal-native event data
}

export function parseBillPaidEvent(event: RpcEventLike): BillPaidEvent | null {
  if (event.type !== "contract") return null;
  if (!Array.isArray(event.topic) || event.topic.length !== 1) return null;
  if (event.topic[0] !== "bill_paid") return null;

  const data = event.value;
  if (!Array.isArray(data) || data.length !== 4) return null;
  const [payer, billerId, orderRef, amount] = data;

  if (typeof payer !== "string" || !payer.startsWith("G")) return null;
  if (typeof billerId !== "string") return null;
  if (!(orderRef instanceof Uint8Array) || orderRef.length !== 32) return null;
  if (typeof amount !== "bigint" && typeof amount !== "number" && typeof amount !== "string") return null;

  let amountStroops: bigint;
  try {
    amountStroops = BigInt(amount as bigint | number | string);
  } catch {
    return null;
  }
  if (amountStroops <= 0n) return null;

  return { payer, billerId, orderRef, amountStroops };
}

export function orderRefToHex(orderRef: Uint8Array): string {
  return Array.from(orderRef).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function orderRefFromHex(hex: string): Uint8Array {
  if (hex.length !== 64) throw new Error(`order_ref hex must be 64 chars (32 bytes), got ${hex.length}`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}
