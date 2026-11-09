// VTpass merchant-verify client: confirms a meter/smartcard/customer
// reference is real before a payment order is created, and (for services
// that return one) the amount due.
//
// Endpoint shape here follows VTpass's publicly documented API
// (`POST {baseUrl}/merchant-verify` with `api-key`/`secret-key` headers and
// a `{billersCode, serviceID}` body, response `{code, content: {...}}`) -
// this is the commonly-documented pattern, but exactly like TERMII_BASE_URL
// elsewhere in this repo, it has NOT been confirmed against a real VTpass
// sandbox account (none exists yet - see billsteady-backend issue #4).
// Treat every field name here as provisional until checked against a real
// response.
export interface VtpassVerifyResult {
  customerName: string;
  /** Null for services (e.g. prepaid electricity) where VTpass doesn't
   * return a fixed amount from verification alone - the caller provides
   * the amount to pay in that case. Non-null for fixed-amount services
   * (e.g. postpaid electricity, some cable bundles). */
  amountDue: number | null;
  raw: unknown;
}

export interface VtpassClient {
  verifyMerchant(opts: { serviceID: string; billersCode: string }): Promise<VtpassVerifyResult>;
}

export class VtpassError extends Error {
  constructor(message: string, public readonly raw: unknown) {
    super(message);
    this.name = "VtpassError";
  }
}

export function createVtpassClient(opts: {
  baseUrl: string;
  apiKey: string;
  secretKey: string;
  fetchImpl?: typeof fetch;
}): VtpassClient {
  const doFetch = opts.fetchImpl ?? fetch;

  return {
    async verifyMerchant({ serviceID, billersCode }) {
      const res = await doFetch(`${opts.baseUrl}/merchant-verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": opts.apiKey,
          "secret-key": opts.secretKey,
        },
        body: JSON.stringify({ billersCode, serviceID }),
      });

      const body = await res.json().catch(() => null);

      if (!res.ok || !body || typeof body !== "object") {
        throw new VtpassError(`VTpass verify failed with status ${res.status}`, body);
      }

      const content = (body as Record<string, unknown>).content;
      if (!content || typeof content !== "object") {
        throw new VtpassError("VTpass verify response missing content", body);
      }

      const customerName = (content as Record<string, unknown>).Customer_Name;
      if (typeof customerName !== "string" || customerName.length === 0) {
        throw new VtpassError("VTpass verify response missing Customer_Name", body);
      }

      const rawAmount = (content as Record<string, unknown>).Current_Bill_Amount;
      const amountDue = typeof rawAmount === "string" || typeof rawAmount === "number" ? Number(rawAmount) : null;

      return {
        customerName,
        amountDue: amountDue !== null && Number.isFinite(amountDue) ? amountDue : null,
        raw: body,
      };
    },
  };
}
