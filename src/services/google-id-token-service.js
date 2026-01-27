import { createRemoteJWKSet, jwtVerify } from 'jose';

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// Google publishes a rotating JWK set here.
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

/**
 * Verify a Google ID token from native mobile sign-in.
 *
 * Contract:
 * - Input: { idToken, audience }
 * - Output: { subject, email, name, picture, emailVerified }
 */
export async function verifyGoogleIdToken({ idToken, audience }) {
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Missing idToken');
    err.code = 'ID_TOKEN_REQUIRED';
    err.statusCode = 400;
    throw err;
  }
  if (!audience) {
    const err = new Error('Missing Google audience (client id)');
    err.code = 'GOOGLE_AUDIENCE_REQUIRED';
    err.statusCode = 500;
    throw err;
  }

  const { payload } = await jwtVerify(idToken, GOOGLE_JWKS, {
    audience,
  });

  if (!payload?.iss || !GOOGLE_ISSUERS.has(payload.iss)) {
    const err = new Error('Invalid token issuer');
    err.code = 'INVALID_GOOGLE_ISSUER';
    err.statusCode = 401;
    throw err;
  }

  return {
    subject: payload.sub,
    email: payload.email ?? null,
    name: payload.name ?? null,
    picture: payload.picture ?? null,
    emailVerified: payload.email_verified === true,
  };
}
