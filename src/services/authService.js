import { prisma } from '../db.js';
import { findOrCreateUserFromOAuth } from '../helpers/auth.js';
import { Roles } from '../constants/roles.js';
import crypto from 'node:crypto';
import { issueAccessToken, issueRefreshToken } from './tokenService.js';

export async function getCurrentUserWithAccounts(userId) {
  return prisma.user.findUnique({
    where: { id: userId },
    include: {
      accounts: {
        select: {
          provider: true,
          createdAt: true,
        },
      },
    },
  });
}

async function fetchGoogleUserProfile(accessToken) {
  const res = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Failed to fetch Google user profile (${res.status})`);
    err.code = 'GOOGLE_PROFILE_FETCH_FAILED';
    err.statusCode = 502;
    err.details = body;
    throw err;
  }

  return res.json();
}

/**
 * Complete Google OAuth callback flow:
 * - exchange code for token
 * - fetch Google user profile
 * - upsert User/Account
 * - return the persisted user
 */
export async function authenticateWithGoogle({ fastify, request }) {
  const { token } = await fastify.googleOAuth2.getAccessTokenFromAuthorizationCodeFlow(request);

  const googleUser = await fetchGoogleUserProfile(token.access_token);
  // Google web flow: always create/login users as students.
  const roles = [Roles.STUDENT];

  const user = await findOrCreateUserFromOAuth({
    provider: 'google',
    providerId: googleUser.id,
    email: googleUser.email,
    name: googleUser.name,
    avatar: googleUser.picture,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: token,
    roles,
  });

  return { user, token, googleUser };
}

/**
 * Ensure a user has an associated profile row.
 * NOTE: This does not attempt to "decide" which one; it's driven by the caller.
 */
export async function ensureProfileForUser({ userId, role }) {
  if (role === Roles.TRAINER) {
    const existing = await prisma.trainer.findFirst({ where: { userId } });
    if (existing) return { created: false, role };
    await prisma.trainer.create({
      data: {
        userId,
      },
    });
    return { created: true, role };
  }

  if (role === Roles.STUDENT) {
    const existing = await prisma.student.findFirst({ where: { userId } });
    if (existing) return { created: false, role };

    await prisma.student.create({
      data: {
        userId,
      },
    });

    return { created: true, role };
  }

  const err = new Error('Invalid profile type');
  err.code = 'INVALID_PROFILE_TYPE';
  err.statusCode = 400;
  throw err;
}

export async function createGoogleUser({ email, password }) {
    return signupWithEmailPassword({ email, password, roles: [Roles.STUDENT] });
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function hashPassword(password) {
  // scrypt params tuned for web auth (can be revisited later)
  const salt = crypto.randomBytes(16);
  const keylen = 64;
  const N = 16384;
  const r = 8;
  const p = 1;

  const derivedKey = crypto.scryptSync(password, salt, keylen, { N, r, p });
  // Compact, self-contained format
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;

  // Format: scrypt$N=...,r=...,p=...$<saltB64>$<hashB64>
  const parts = stored.split('$');
  if (parts.length !== 4) return false;

  const paramsPart = parts[1];
  const saltB64 = parts[2];
  const hashB64 = parts[3];

  const params = Object.fromEntries(
    paramsPart
      .split(',')
      .map((kv) => kv.split('='))
      .filter((kv) => kv.length === 2)
      .map(([k, v]) => [k, Number(v)]),
  );

  const N = params.N;
  const r = params.r;
  const p = params.p;

  if (![N, r, p].every((n) => Number.isFinite(n) && n > 0)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(saltB64, 'base64');
    expected = Buffer.from(hashB64, 'base64');
  } catch {
    return false;
  }

  const derived = crypto.scryptSync(password, salt, expected.length, { N, r, p });
  return crypto.timingSafeEqual(derived, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeUser(user) {
  if (!user) return user;
  // eslint-disable-next-line no-unused-vars
  const { passwordHash, ...rest } = user;
  return rest;
}

/**
 * Email/password signup.
 * Contract:
 * - Creates a new user with passwordHash
 * - Does NOT create an OAuth Account row
 * - Sets default roles [trainer] unless provided
 * - Returns user without the password hash
 */
export async function signupWithEmailPassword({ email, password, roles }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    const err = new Error('Email is required');
    err.code = 'EMAIL_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    err.statusCode = 400;
    throw err;
  }

  // Normalize roles to array, default to [STUDENT]
  const rolesArray = Array.isArray(roles) ? roles : (roles ? [roles] : [Roles.STUDENT]);
  
  // Prevent signup with unsupported roles
  if (!rolesArray.every(r => [Roles.TRAINER, Roles.STUDENT].includes(r))) {
    const err = new Error('Invalid role');
    err.code = 'INVALID_ROLE';
    err.statusCode = 400;
    throw err;
  }

  const existing = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (existing && !existing.deletedAt) {
    const err = new Error('Email already in use');
    err.code = 'EMAIL_IN_USE';
    err.statusCode = 409;
    throw err;
  }

  if (existing?.deletedAt) {
    const err = new Error('User account is deactivated');
    err.code = 'USER_DELETED';
    err.statusCode = 403;
    throw err;
  }

  const passwordHash = hashPassword(password);
  const created = await prisma.user.create({
    data: {
      email: normalizedEmail,
      passwordHash,
      roles: rolesArray,
      status: 'pending',
    },
  });

  return safeUser(created);
}

/**
 * Email/password login.
 * Contract:
 * - Validates email+password
 * - Requires the user to have a passwordHash (not OAuth-only)
 * - Rejects soft-deleted users
 * - Returns user without passwordHash
 */
export async function loginWithEmailPassword({ email, password }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    const err = new Error('Email is required');
    err.code = 'EMAIL_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  if (typeof password !== 'string' || password.length === 0) {
    const err = new Error('Password is required');
    err.code = 'PASSWORD_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });
  if (!user) {
    const err = new Error('Invalid credentials');
    err.code = 'INVALID_CREDENTIALS';
    err.statusCode = 401;
    throw err;
  }

  if (user.deletedAt) {
    const err = new Error('User account is deactivated');
    err.code = 'USER_DELETED';
    err.statusCode = 403;
    throw err;
  }

  if (!user.passwordHash) {
    const err = new Error('Password login not available for this account');
    err.code = 'PASSWORD_NOT_SET';
    err.statusCode = 409;
    throw err;
  }

  const ok = verifyPassword(password, user.passwordHash);
  if (!ok) {
    const err = new Error('Invalid credentials');
    err.code = 'INVALID_CREDENTIALS';
    err.statusCode = 401;
    throw err;
  }

  return safeUser(user);
}

/**
 * Request a password reset for the given email.
 *
 * Contract:
 * - Always succeeds (to avoid email enumeration) if email format is valid.
 * - Creates a PasswordResetToken row when a matching user exists and is not deleted.
 * - Returns the plain resetToken (for local/dev usage only).
 */
export async function requestPasswordReset({ email }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    const err = new Error('Email is required');
    err.code = 'EMAIL_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { email: normalizedEmail } });

  // To avoid user enumeration, do not reveal whether the user exists.
  if (!user || user.deletedAt) {
    return { resetToken: null };
  }

  const token = crypto.randomBytes(40).toString('hex');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

  await prisma.passwordResetToken.create({
    data: {
      tokenHash,
      userId: user.id,
      expiresAt,
    },
  });

  return { resetToken: token };
}

/**
 * Reset password using a one-time token.
 *
 * Contract:
 * - Validates token and expiry
 * - Updates user's passwordHash
 * - Marks the reset token as used
 * - Returns the safe user (without passwordHash)
 */
export async function resetPasswordWithToken({ token, password }) {
  if (typeof token !== 'string' || token.trim() === '') {
    const err = new Error('Reset token is required');
    err.code = 'RESET_TOKEN_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  if (typeof password !== 'string' || password.length < 8) {
    const err = new Error('Password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    err.statusCode = 400;
    throw err;
  }

  const tokenHash = hashToken(token);
  const resetToken = await prisma.passwordResetToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!resetToken || resetToken.used) {
    const err = new Error('Invalid or used reset token');
    err.code = 'INVALID_RESET_TOKEN';
    err.statusCode = 400;
    throw err;
  }

  if (resetToken.expiresAt < new Date()) {
    const err = new Error('Reset token expired');
    err.code = 'RESET_TOKEN_EXPIRED';
    err.statusCode = 400;
    throw err;
  }

  if (!resetToken.user || resetToken.user.deletedAt) {
    const err = new Error('User account is deactivated');
    err.code = 'USER_DELETED';
    err.statusCode = 403;
    throw err;
  }

  const passwordHash = hashPassword(password);

  const [updatedUser] = await prisma.$transaction([
    prisma.user.update({
      where: { id: resetToken.userId },
      data: { passwordHash },
    }),
    prisma.passwordResetToken.update({
      where: { tokenHash },
      data: { used: true },
    }),
  ]);

  return safeUser(updatedUser);
}

/**
 * Stateless email/password signup: creates user, ensures profile, issues tokens.
 * Returns minimal payload so routes can stay thin.
 */
export async function signupWithEmailPasswordStateless({ fastify, email, password, roles }) {
  const user = await signupWithEmailPassword({ email, password, roles });

  const access = issueAccessToken({ fastify, user });
  const refresh = await issueRefreshToken({ user });

  return {
    userId: user.id,
    accessToken: access.accessToken,
    refreshToken: refresh.refreshToken,
  };
}

/**
 * Stateless email/password login: validates credentials and issues tokens.
 */
export async function loginWithEmailPasswordStateless({ fastify, email, password }) {
  const user = await loginWithEmailPassword({ email, password });

  const access = issueAccessToken({ fastify, user });
  const refresh = await issueRefreshToken({ user });

  return {
    userId: user.id,
    accessToken: access.accessToken,
    refreshToken: refresh.refreshToken,
  };
}
