import crypto from 'node:crypto';

// 15 minutes by default
const DEFAULT_ACCESS_TTL_SECONDS = 60 * 15;

/**
 * Create the JWT payload we want clients to receive.
 * Keep it minimal; everything else can be fetched from /auth/me if needed.
 */
function buildAccessTokenPayload(user) {
  return {
    sub: user.id,
    email: user.email ?? null,
    role: user.role,
    status: user.status,
  };
}

/**
 * Issue a signed access token.
 *
 * Contract:
 * - Input: fastify instance w/ fastify.jwt, and a user object that contains id/role/status
 * - Output: { accessToken, tokenType, expiresIn }
 */
export function issueAccessToken({ fastify, user, expiresInSeconds = DEFAULT_ACCESS_TTL_SECONDS }) {
  if (!fastify?.jwt) {
    const err = new Error('JWT support not registered');
    err.code = 'JWT_NOT_CONFIGURED';
    err.statusCode = 500;
    throw err;
  }
  if (!user?.id || !user?.role || !user?.status) {
    const err = new Error('Missing user fields for token issuance');
    err.code = 'INVALID_TOKEN_SUBJECT';
    err.statusCode = 500;
    throw err;
  }

  const payload = buildAccessTokenPayload(user);
  const accessToken = fastify.jwt.sign(payload, {
    expiresIn: expiresInSeconds,
    jti: crypto.randomUUID(),
  });

  return {
    accessToken,
    tokenType: 'Bearer',
    expiresIn: expiresInSeconds,
  };
}
