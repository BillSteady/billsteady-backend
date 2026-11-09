// Self-issued, Supabase-compatible session JWT.
//
// Why self-issued: Supabase Auth (GoTrue) has no Stellar/SEP-10 provider
// (its web3 support is Solana/Ethereum only - checked supabase/config.toml's
// [auth.web3.*] blocks, no Stellar equivalent exists), so there's no
// built-in way to turn a verified SEP-10 challenge into a GoTrue session.
//
// The fix used here is Supabase's own documented pattern for arbitrary
// custom auth: PostgREST (and therefore every RLS policy) accepts ANY
// correctly HS256-signed JWT bearing the project's JWT secret, not only
// ones GoTrue issued - it only cares about the claims, not who signed them.
// Setting `sub` to the user's `public.users.id` means `auth.uid()` (which
// Supabase implements as `(request.jwt.claims->>'sub')::uuid`) resolves
// correctly, so every existing `auth.uid() = user_id` RLS policy in this
// schema keeps working completely unchanged - this is why `sub` is the
// user id and not the stellar address.
//
// What IS verified here: the JWT is correctly constructed, HS256-signed,
// and round-trips through verification (right secret accepts, wrong secret
// and expired/tampered tokens are rejected) - all real cryptographic tests,
// no live project needed. What is NOT verified: that Supabase's actual
// PostgREST deployment accepts a token it didn't issue via GoTrue. This is
// a well-documented, standard technique (often called "third-party auth" /
// "custom JWT" in Supabase's own docs), but "well-documented" isn't
// "confirmed by this session against a live project" - confirm against a
// real deployed project before trusting it, same bar as everything else
// unverified in this repo.

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(s: string): Uint8Array {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export interface SupabaseSessionClaims {
  sub: string; // public.users.id (uuid) - NOT the stellar address, see header comment
  role: "authenticated";
  aud: "authenticated";
  iss: string;
  stellar_address: string; // informational claim, not relied on by RLS
  iat: number;
  exp: number;
}

export async function issueSessionJwt(opts: {
  userId: string;
  stellarAddress: string;
  issuer: string;
  secret: string;
  ttlSeconds: number;
}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const claims: SupabaseSessionClaims = {
    sub: opts.userId,
    role: "authenticated",
    aud: "authenticated",
    iss: opts.issuer,
    stellar_address: opts.stellarAddress,
    iat: now,
    exp: now + opts.ttlSeconds,
  };
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const encodedPayload = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const key = await hmacKey(opts.secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signingInput));
  const encodedSig = base64UrlEncode(new Uint8Array(sig));

  return `${signingInput}.${encodedSig}`;
}

export type VerifyResult =
  | { ok: true; claims: SupabaseSessionClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

export async function verifySessionJwt(token: string, secret: string): Promise<VerifyResult> {
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [encodedHeader, encodedPayload, encodedSig] = parts;

  const key = await hmacKey(secret);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlDecode(encodedSig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const valid = await crypto.subtle.verify("HMAC", key, sigBytes as BufferSource, new TextEncoder().encode(signingInput));
  if (!valid) return { ok: false, reason: "bad_signature" };

  let claims: SupabaseSessionClaims;
  try {
    claims = JSON.parse(new TextDecoder().decode(base64UrlDecode(encodedPayload)));
  } catch {
    return { ok: false, reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp < now) {
    return { ok: false, reason: "expired" };
  }

  return { ok: true, claims };
}
