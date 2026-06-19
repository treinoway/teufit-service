import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const APPLE_ISSUER = 'https://appleid.apple.com';

// Apple publishes a rotating JWK set here. `jose` caches keys in-memory and only
// refetches on an unknown `kid` (with its own cooldown), so we get the ~24h
// JWKS caching the spec asks for without managing it by hand.
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

/**
 * Apple sends `email_verified` / `is_private_email` as either a real boolean or
 * the strings "true"/"false" depending on the flow. Normalize both.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function asBool(value) {
  return value === true || value === 'true';
}

/**
 * Parse the configured allowed audience(s). A single Railway env var
 * (`APPLE_BUNDLE_ID`) holds the bundle id for that environment; a comma-separated
 * list is supported so one deploy can accept more than one bundle (e.g. app +
 * Services ID) if ever needed.
 *
 * @param {string|undefined} raw
 * @returns {string[]}
 */
function parseAudience(raw) {
  if (!raw || typeof raw !== 'string') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Verify a Sign in with Apple identity token from native mobile sign-in.
 *
 * Validates: RS256 signature against Apple's JWKS, `iss`, `aud` (bundle id),
 * `exp` (handled by jose), and — when a raw nonce is supplied — that
 * SHA256(rawNonce) matches the token's `nonce` claim (replay protection).
 *
 * Contract:
 * - Input:  { identityToken, audience, nonce? }
 * - Output: { subject, email, emailVerified, isPrivateEmail }
 *
 * Throws Error with `.code`:
 * - APPLE_IDENTITY_TOKEN_REQUIRED (400) — missing/invalid input token
 * - APPLE_AUDIENCE_REQUIRED (500)       — server misconfig: no APPLE_BUNDLE_ID
 * - APPLE_NONCE_MISMATCH (401)          — supplied nonce fails replay check
 * - INVALID_APPLE_ISSUER (401)          — `iss` is not Apple
 * - plus jose codes: ERR_JWT_EXPIRED, ERR_JWS_INVALID,
 *   ERR_JWT_CLAIM_VALIDATION_FAILED, ERR_JWKS_NO_MATCHING_KEY (all → 401)
 */
export async function verifyAppleIdToken({ identityToken, audience, nonce }) {
  if (!identityToken || typeof identityToken !== 'string') {
    const err = new Error('Missing Apple identity token');
    err.code = 'APPLE_IDENTITY_TOKEN_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  const audiences = parseAudience(audience);
  if (audiences.length === 0) {
    const err = new Error('Missing Apple audience (bundle id)');
    err.code = 'APPLE_AUDIENCE_REQUIRED';
    err.statusCode = 500;
    throw err;
  }

  const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
    issuer: APPLE_ISSUER,
    audience: audiences,
  });

  // jose already checks `iss` via the `issuer` option above; assert defensively.
  if (payload?.iss !== APPLE_ISSUER) {
    const err = new Error('Invalid token issuer');
    err.code = 'INVALID_APPLE_ISSUER';
    err.statusCode = 401;
    throw err;
  }

  // `sub` is the stable Apple user id and the account key. A token without it is
  // unusable — reject as invalid rather than letting `undefined` reach Prisma.
  if (!payload.sub || typeof payload.sub !== 'string') {
    const err = new Error('Apple token missing subject');
    err.code = 'APPLE_SUBJECT_MISSING';
    err.statusCode = 401;
    throw err;
  }

  // Replay protection: when the client passes the raw nonce it used at sign-in,
  // it must hash to the token's `nonce` claim (Apple echoes SHA256(rawNonce)).
  if (nonce) {
    const expected = createHash('sha256').update(nonce).digest('hex');
    if (payload.nonce !== expected) {
      const err = new Error('Apple nonce mismatch');
      err.code = 'APPLE_NONCE_MISMATCH';
      err.statusCode = 401;
      throw err;
    }
  }

  return {
    subject: payload.sub,
    // `email` only arrives on the FIRST authorization for a given Apple ID.
    email: typeof payload.email === 'string' ? payload.email : null,
    emailVerified: asBool(payload.email_verified),
    isPrivateEmail: asBool(payload.is_private_email),
  };
}
