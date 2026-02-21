import { createRemoteJWKSet, jwtVerify } from 'jose';

const FIREBASE_JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
);

/**
 * Verify a Firebase ID token (from signInWithPopup or mobile Firebase Auth).
 *
 * Firebase ID tokens are standard JWTs signed by Google, verifiable via
 * Firebase's public JWK set — no firebase-admin SDK required.
 *
 * Contract:
 * - Input:  { idToken, projectId }
 * - Output: { subject, email, name, picture, emailVerified }
 */
export async function verifyFirebaseIdToken({ idToken, projectId }) {
  if (!idToken || typeof idToken !== 'string') {
    const err = new Error('Missing idToken');
    err.code = 'ID_TOKEN_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  if (!projectId) {
    const err = new Error('Missing Firebase project ID');
    err.code = 'FIREBASE_PROJECT_ID_REQUIRED';
    err.statusCode = 500;
    throw err;
  }

  const expectedIssuer = `https://securetoken.google.com/${projectId}`;

  const { payload } = await jwtVerify(idToken, FIREBASE_JWKS, {
    audience: projectId,
    issuer: expectedIssuer,
  });

  if (!payload.sub) {
    const err = new Error('Token missing subject');
    err.code = 'INVALID_FIREBASE_TOKEN';
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
