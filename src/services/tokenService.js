import crypto from 'node:crypto';
import { prisma } from '../db.js';

// 15 minutes by default
const DEFAULT_ACCESS_TTL_SECONDS = 60 * 15;
// 7 days by default
const DEFAULT_REFRESH_TTL_SECONDS = 60 * 60 * 24 * 7;

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

/**
 * Helper to hash a token (SHA256).
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Issue a refresh token.
 * Saves the HASH of the token to the database.
 */
export async function issueRefreshToken({ user, expiresInSeconds = DEFAULT_REFRESH_TTL_SECONDS }) {
  const token = crypto.randomBytes(40).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  const refreshToken = await prisma.refreshToken.create({
    data: {
      token: tokenHash, // Store the hash
      userId: user.id,
      expiresAt,
    },
  });

  return {
    refreshToken: token, // Return the plain token to the user
    expiresAt: refreshToken.expiresAt,
  };
}

/**
 * Verify a refresh token.
 * Hashes the input token and looks it up in DB.
 * Returns the associated User if valid.
 */
export async function verifyRefreshToken(token) {
  const tokenHash = hashToken(token);
  const storedToken = await prisma.refreshToken.findUnique({
    where: { token: tokenHash },
    include: { user: true },
  });

  if (!storedToken) {
    throw new Error('Invalid refresh token');
  }

  if (storedToken.revoked) {
    throw new Error('Refresh token revoked');
  }

  if (storedToken.expiresAt < new Date()) {
    throw new Error('Refresh token expired');
  }

  return storedToken.user;
}

/**
 * Revoke a refresh token.
 */
export async function revokeRefreshToken(token) {
  const tokenHash = hashToken(token);
  await prisma.refreshToken.update({
    where: { token: tokenHash },
    data: { revoked: true },
  });
}
