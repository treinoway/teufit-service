/**
 * Helper functions for managing social authentication accounts
 */

import { prisma } from '../../src/db.js';
import { roleValues } from '../constants/roles.js';

/**
 * Find or create a user from OAuth provider data
 * @param {Object} providerData - Data from OAuth provider
 * @param {string} providerData.provider - Provider name (e.g., 'google', 'github', 'facebook')
 * @param {string} providerData.providerId - User ID from the provider
 * @param {string} providerData.email - User's email
 * @param {string} providerData.name - User's display name
 * @param {string} providerData.avatar - User's avatar URL
 * @param {string} providerData.accessToken - OAuth access token
 * @param {string} [providerData.refreshToken] - OAuth refresh token
 * @param {number} [providerData.expiresAt] - Token expiration timestamp
 * @returns {Promise<Object>} User object
 */
export async function findOrCreateUserFromOAuth(providerData) {
  const {
    provider,
    providerId,
    email,
    name,
    avatar,
    accessToken,
    refreshToken = null,
    expiresAt = null,
    roles,
  } = providerData;

  // Normalize roles to array
  const rolesArray = Array.isArray(roles) ? roles : (roles ? [roles] : []);
  
  if (rolesArray.length === 0 || !rolesArray.every(r => roleValues.includes(r))) {
    const err = new Error('Missing or invalid roles');
    err.code = 'ROLE_REQUIRED';
    throw err;
  }

  // Convert various "expires" formats into a safe JS Date or null.
  // Different OAuth providers / libs may return:
  // - expiresAt as unix seconds (number)
  // - expires_at as unix seconds
  // - expires_in as seconds from now
  // - an ISO string
  // Prisma requires a valid Date object within supported range.
  const toSafeExpiresDate = (raw) => {
    if (raw == null) return null;

    let date;

    // unix seconds (number)
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      date = new Date(raw * 1000);
    }

    // unix seconds / millis (string)
    if (!date && typeof raw === 'string') {
      const trimmed = raw.trim();
      if (/^\d+$/.test(trimmed)) {
        const n = Number(trimmed);
        if (Number.isFinite(n)) {
          // If it looks like millis, keep it; otherwise assume seconds.
          date = new Date(n > 1e12 ? n : n * 1000);
        }
      } else {
        const parsed = new Date(trimmed);
        if (!Number.isNaN(parsed.getTime())) date = parsed;
      }
    }

    // provider might pass a Date already
    if (!date && raw instanceof Date) {
      if (!Number.isNaN(raw.getTime())) date = raw;
    }

    // Some token objects may contain other fields
    if (!date && typeof raw === 'object') {
      // fastify/oauth2 token sometimes carries expires_in
      if (typeof raw.expires_at === 'number') date = new Date(raw.expires_at * 1000);
      else if (typeof raw.expiresAt === 'number') date = new Date(raw.expiresAt * 1000);
      else if (typeof raw.expires_in === 'number') date = new Date(Date.now() + raw.expires_in * 1000);
    }

    if (!date || Number.isNaN(date.getTime())) return null;

    // Guard against bizarre far-future dates (can happen when format is misread).
    // Prisma/Postgres timestamptz can't store extremely large years.
    const year = date.getUTCFullYear();
    if (year < 1970 || year > 9999) return null;

    return date;
  };

  const expiresAtDate = toSafeExpiresDate(expiresAt);

  // Find account by provider and providerId
  let account = await prisma.account.findUnique({
    where: {
      provider_providerId: {
        provider,
        providerId,
      },
    },
    include: {
      user: true,
    },
  });

  let user;

  if (account) {
    // User already exists, update tokens
    user = account.user;

    // Soft-delete enforcement: don't allow login for deleted users
    if (user.deletedAt) {
      const err = new Error('User account is deactivated');
      err.code = 'USER_DELETED';
      throw err;
    }

    await prisma.account.update({
      where: { id: account.id },
      data: {
        accessToken,
        refreshToken,
        expiresAt: expiresAtDate,
      },
    });
  } else {
    // Check if user exists by email
    user = await prisma.user.findUnique({
      where: { email },
    });

    if (user?.deletedAt) {
      const err = new Error('User account is deactivated');
      err.code = 'USER_DELETED';
      throw err;
    }

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          email,
          username: name || email.split('@')[0],
          avatar,
          roles: rolesArray,
          status: 'pending',
        },
      });
    }

    // Create account linking
    await prisma.account.create({
      data: {
        userId: user.id,
        provider,
        providerId,
        accessToken,
        refreshToken,
        expiresAt: expiresAtDate,
      },
    });
  }

  return user;
}

/**
 * Get all accounts for a user
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of account objects
 */
export async function getUserAccounts(userId) {
  return await prisma.account.findMany({
    where: { userId },
    select: {
      id: true,
      provider: true,
      createdAt: true,
    },
  });
}

/**
 * Unlink a provider from a user's account
 * @param {string} userId - User ID
 * @param {string} provider - Provider name
 * @returns {Promise<void>}
 */
export async function unlinkProvider(userId, provider) {
  const account = await prisma.account.findFirst({
    where: {
      userId,
      provider,
    },
  });

  if (account) {
    await prisma.account.delete({
      where: { id: account.id },
    });
  }
}
