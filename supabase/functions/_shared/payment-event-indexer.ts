// Parses a BillPaymentRouter `pay()` success event from Stellar RPC's
// getEvents response shape.
//
// Corrected against the real deployed contract, not the coordinating
// session's original (wrong) directive this was first written against.
// `stellar contract info interface` on the live testnet deployment
// (CA5VHLWTG7UXT6MKYWRMAVXSQ3J4SQFBG2RQVBYUKBAPHUTO7XEPQMOA) shows `payer`
// and `biller_id` are `#[topic]` fields, not data fields - soroban-sdk's
// `#[contractevent]` macro puts the event name plus every `#[topic]` field
// into topics, in declaration order, and everything else into data. So the
// real shape is topic = ["bill_paid", payer, biller_id] (3 elements, not
// 1), data = (order_ref, amount) (2 elements, not 4). The original
// 1-topic/4-data assumption would have silently rejected every real event
// forever - caught by independently re-verifying the deployed interface
// rather than trusting the directive that was correct about everything
// else in this contract.
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
  topic: unknown[]; // decoded ScVal-native topic segments: [name, payer, biller_id]
  value: unknown; // decoded ScVal-native event data: [order_ref, amount]
}

export function parseBillPaidEvent(event: RpcEventLike): BillPaidEvent | null {
  if (event.type !== "contract") return null;
  if (!Array.isArray(event.topic) || event.topic.length !== 3) return null;
  const [eventName, payer, billerId] = event.topic;
  if (eventName !== "bill_paid") return null;
  if (typeof payer !== "string" || !payer.startsWith("G")) return null;
  if (typeof billerId !== "string") return null;

  const data = event.value;
  if (!Array.isArray(data) || data.length !== 2) return null;
  const [orderRef, amount] = data;

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
