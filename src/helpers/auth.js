/**
 * Helper functions for managing social authentication accounts
 */

import { prisma } from '../../src/db.js';

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
  } = providerData;

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

    await prisma.account.update({
      where: { id: account.id },
      data: {
        accessToken,
        refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt * 1000) : null,
      },
    });
  } else {
    // Check if user exists by email
    user = await prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Create new user
      user = await prisma.user.create({
        data: {
          email,
          username: name || email.split('@')[0],
          avatar,
          role: 'user', // default role
          status: 'active',
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
        expiresAt: expiresAt ? new Date(expiresAt * 1000) : null,
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
