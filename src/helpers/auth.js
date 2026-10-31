/**
 * Helper functions for managing social authentication accounts
 */

import { prisma } from '../../src/db.js';
import { roleValues } from '../constants/roles.js';
import { UserStatus } from '../constants/user-status.js';
import { findUserIdByEmailCaseInsensitive } from './email-lookup.js';
import { acceptPendingInvitesForUser } from '../services/student-invite-service.js';
import { AppError } from '../errors/app-error.js';
import { EMAIL_PROVIDER } from '../constants/email-verification.js';
import { OAuthErrorCode, OAuthMessageCode, SecurityEvent } from '../constants/oauth-security.js';

/** Structured security log line. Never pass secrets (tokens, codes, hashes). */
function logSecurityEvent(event, fields) {
  console.warn('[security]', { event, ...fields });
}

function throwOAuthEmailNotVerified() {
  throw new AppError({
    httpStatus: 403,
    error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
    messageCode: OAuthMessageCode.EMAIL_NOT_VERIFIED,
    message: 'The email of this sign-in provider is not verified.',
  });
}

/**
 * Rejects any OAuth sign-in whose provider does not attest the email.
 *
 * Runs BEFORE any user/account lookup so the response is identical (same
 * status, code and DB work) whether or not an account exists for the email:
 * a differing answer would be an account-enumeration oracle.
 *
 * `emailVerified` must be the boolean `true` (Apple's boolean-or-string
 * `email_verified` is normalized upstream by `asBool`).
 *
 * Carve-out: a token that carries NO email claim at all (Apple omits the email
 * on returning sign-ins) asserts nothing about an address, so it cannot probe
 * one. It may only authenticate an already-linked Account; the caller enforces
 * that (no linked account + no email is rejected the same way).
 */
export function assertOAuthEmailVerified({ provider, email, emailVerified }) {
  if (emailVerified === true) return;
  if (!email) return;
  logSecurityEvent(SecurityEvent.UNVERIFIED_EMAIL_REJECTED, { provider });
  throwOAuthEmailNotVerified();
}

// Marks the user active (email proven by the provider) and syncs the caller's row so tokens carry the new status.
async function activateUser(user) {
  if (user.status === UserStatus.ACTIVE) return user;
  await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.ACTIVE } });
  if ('status' in user) user.status = UserStatus.ACTIVE;
  return user;
}

/**
 * Pre-account-hijack defence. A password set while the email Account was still
 * unverified may belong to whoever typed the address at signup (not the
 * owner). When a verified OAuth identity proves ownership, that credential is
 * treated as attacker-controlled: the password is cleared, every refresh token
 * is revoked and unused reset/verification codes are closed, atomically.
 *
 * The unverified email Account row is intentionally KEPT: it records "email
 * credential never proven", and forgot-password does not depend on it (it only
 * needs the User row), so the real owner can still set a password later; the
 * reset flow then marks this row verified.
 *
 * @returns {Promise<boolean>} true when the credential was neutralized
 */
async function neutralizeUnverifiedPasswordCredential(user, provider) {
  if (!user.passwordHash) return false;

  const unverifiedEmailAccount = await prisma.account.findFirst({
    where: { userId: user.id, provider: EMAIL_PROVIDER, verifiedAt: null },
    select: { id: true },
  });
  if (!unverifiedEmailAccount) return false;

  const now = new Date();
  await prisma.$transaction([
    prisma.user.update({ where: { id: user.id }, data: { passwordHash: null } }),
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true, revokedAt: now },
    }),
    prisma.device.deleteMany({ where: { userId: user.id } }),
    prisma.passwordResetToken.updateMany({ where: { userId: user.id, used: false }, data: { used: true } }),
    prisma.emailVerificationToken.updateMany({ where: { userId: user.id, used: false }, data: { used: true } }),
  ]);

  logSecurityEvent(SecurityEvent.PRE_ACCOUNT_TAKEOVER_MITIGATED, { userId: user.id, provider });
  return true;
}

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
 * @param {boolean} [providerData.emailVerified] - Provider attests the email is verified (ID token email_verified)
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
    emailVerified = false,
  } = providerData;

  // First thing, before any lookup: unverified tokens are rejected uniformly.
  assertOAuthEmailVerified({ provider, email, emailVerified });

  // Normalize roles to array (empty array is allowed for new users)
  const rolesArray = Array.isArray(roles) ? roles : (roles ? [roles] : []);

  if (rolesArray.length > 0 && !rolesArray.every(r => roleValues.includes(r))) {
    const err = new Error('Invalid roles');
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

  // Normalize email at write-time so subsequent lookups (login, password reset)
  // can match without case-sensitivity surprises.
  const normalizedEmail = typeof email === 'string' ? email.trim().toLowerCase() : email;

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
  // Only reachable verified (assertOAuthEmailVerified), except the email-less
  // token carve-out, which never reaches the create/attach branch below.
  const verifiedAt = emailVerified === true ? new Date() : null;
  // True when this call is the one that proves the user owns the email (new
  // verified account, or an existing account that just became verified).
  let becameVerified = false;
  let shouldActivate = false;

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
        ...(verifiedAt && !account.verifiedAt ? { verifiedAt } : {}),
      },
    });
    becameVerified = Boolean(verifiedAt && !account.verifiedAt);
    shouldActivate = becameVerified;
  } else {
    if (!normalizedEmail) {
      // No linked account and no email to prove: same rejection as unverified.
      logSecurityEvent(SecurityEvent.UNVERIFIED_EMAIL_REJECTED, { provider });
      throwOAuthEmailNotVerified();
    }

    // Case-insensitive lookup: legacy users may have mixed-case email saved.
    const existingUserId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
    user = existingUserId ? await prisma.user.findUnique({ where: { id: existingUserId } }) : null;

    if (user?.deletedAt) {
      const err = new Error('User account is deactivated');
      err.code = 'USER_DELETED';
      throw err;
    }

    if (user) {
      const neutralized = await neutralizeUnverifiedPasswordCredential(user, provider);
      // why: a password kept after neutralization belongs to an already verified email account, so the user is already active.
      shouldActivate = Boolean(verifiedAt) && (neutralized || !user.passwordHash);
    } else {
      // Create new user with personal data populated from OAuth profile
      const rawName = typeof name === 'string' ? name.trim() : '';
      const parts = rawName ? rawName.split(/\s+/).filter(Boolean) : [];
      const inferredFirst = parts[0] || null;
      const inferredLast = parts.length > 1 ? parts.slice(1).join(' ') : null;

      user = await prisma.user.create({
        data: {
          email: normalizedEmail,
          username: rawName || normalizedEmail.split('@')[0],
          firstName: inferredFirst,
          lastName: inferredLast,
          avatarUrl: avatar,
          roles: rolesArray,
          status: verifiedAt ? UserStatus.ACTIVE : UserStatus.PENDING,
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
        verifiedAt,
      },
    });
    becameVerified = Boolean(verifiedAt);
  }

  // Invites are bound to a verified email: accept them whenever this login
  // proves ownership — including an existing (e.g. unverified email/password)
  // user who now signs in with a verifying provider. Otherwise their pending
  // invites would be stranded: /auth/verify-email then returns alreadyVerified.
  // Never throws.
  if (becameVerified) {
    await acceptPendingInvitesForUser(prisma, user);
  }

  return shouldActivate ? activateUser(user) : user;
}

/**
 * Look up a linked social account by provider + provider-side user id.
 * Used by Apple Sign-In to distinguish login (account exists) from first-time
 * sign-up before delegating to findOrCreateUserFromOAuth.
 *
 * @param {string} provider - e.g. 'apple', 'google'
 * @param {string} providerId - the provider's stable user id (Apple `sub`)
 * @returns {Promise<Object|null>} account row or null
 */
export async function findAccountByProvider(provider, providerId) {
  if (!provider || !providerId) return null;
  return prisma.account.findUnique({
    where: { provider_providerId: { provider, providerId } },
  });
}

/**
 * Case-insensitive lookup of a user by email. Mirrors the matching used inside
 * findOrCreateUserFromOAuth so callers can predict whether a new user will be
 * created (e.g. to return 201 vs 200).
 *
 * @param {string|null} email
 * @returns {Promise<Object|null>} user row or null
 */
export async function findUserByEmailInsensitive(email) {
  const userId = await findUserIdByEmailCaseInsensitive(prisma, email);
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
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
