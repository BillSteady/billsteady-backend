// HMAC-SHA512 verification of Termii's X-Termii-Signature header. Termii's
// docs state webhook events are signed this way but don't show a worked
// example (algorithm name + header name are the only confirmed facts) -
// this implements the standard HMAC-over-the-raw-body pattern, which is
// the near-universal convention for this kind of header, but it has not
// been confirmed against a real signed request from Termii. Confirm
// against a live webhook delivery before trusting this in production -
// see README.md.

export async function verifyTermiiSignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expectedHex = toHex(new Uint8Array(mac));

  return timingSafeEqual(expectedHex, signatureHeader.trim().toLowerCase());
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
