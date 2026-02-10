import crypto from 'node:crypto';
import { prisma } from '../db.js';
import config from '../../config/index.js';

/**
 * Create the JWT payload we want clients to receive.
 * Keep it minimal; everything else can be fetched from /auth/me if needed.
 */
function buildAccessTokenPayload(user) {
  return {
    sub: user.id,
    email: user.email ?? null,
    roles: user.roles || (user.role ? [user.role] : []),
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
export function issueAccessToken({ fastify, user, expiresInSeconds = config.auth.accessTokenTtlSeconds }) {
  if (!fastify?.jwt) {
    const err = new Error('JWT support not registered');
    err.code = 'JWT_NOT_CONFIGURED';
    err.statusCode = 500;
    throw err;
  }
  if (!user?.id || !user?.status) {
    const err = new Error('Missing user fields for token issuance');
    err.code = 'INVALID_TOKEN_SUBJECT';
    err.statusCode = 500;
    throw err;
  }
  
  // Ensure roles is an array
  if (!user?.roles && !user?.role) {
    const err = new Error('Missing user roles for token issuance');
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
export async function issueRefreshToken({ user, expiresInSeconds = config.auth.refreshTokenTtlSeconds }) {
  const token = crypto.randomBytes(40).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + expiresInSeconds * 1000);

  const refreshToken = await prisma.refreshToken.create({
    data: {
      tokenHash, // Store the hash
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
    where: { tokenHash },
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
    where: { tokenHash },
    data: { revoked: true, revokedAt: new Date() },
  });
}

/**
 * Revoke all refresh tokens for a given user.
 * Used for security actions like password changes.
 */
export async function revokeAllUserRefreshTokens(userId) {
  await prisma.refreshToken.updateMany({
    where: {
      userId,
      revoked: false,
    },
    data: {
      revoked: true,
      revokedAt: new Date(),
    },
  });
}
