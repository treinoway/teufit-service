import { prisma } from '../db.js';
import { findOrCreateUserFromOAuth } from '../helpers/auth.js';
import { findUserIdByEmailCaseInsensitive } from '../helpers/email-lookup.js';
import { Roles } from '../constants/roles.js';
import crypto from 'node:crypto';
import { issueAccessToken, issueRefreshToken, revokeAllUserRefreshTokens } from './token-service.js';
import emailHandler from '../config/email-handler.js';
import { markEmailVerifiedFromInboxProof } from './email-verification-service.js';
import config from '../../config/index.js';
import { AppError, ValidationAppError } from '../errors/app-error.js';
import {
  NIL_UUID,
  PASSWORD_RESET_CODE_LENGTH,
  PASSWORD_RESET_ISSUE_WINDOW_MS,
  PASSWORD_RESET_MAX_ATTEMPTS,
  PASSWORD_RESET_MIN_PASSWORD_LENGTH,
  PASSWORD_RESET_TTL_MS,
  PasswordResetErrorCode,
  PasswordResetMessageCode,
} from '../constants/password-reset.js';
import { hashPassword, verifyPassword, verifyAgainstDummyHash } from '../helpers/password.js';

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
  // Google web flow: new users start with no roles (can become trainer via /become-trainer)
  const roles = [];

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
    emailVerified: googleUser.verified_email === true,
  });

  return { user, token, googleUser };
}

/**
 * Ensure a user has an associated profile row.
 * NOTE: This does not attempt to "decide" which one; it's driven by the caller.
 * Pass `tx` to run inside a caller's interactive transaction.
 */
export async function ensureProfileForUser({ userId, role, tx }) {
  const db = tx ?? prisma;
  if (role === Roles.TRAINER) {
    const existing = await db.trainer.findFirst({ where: { userId } });
    if (existing) return { created: false, role };
    const trainer = await db.trainer.create({
      data: {
        userId,
      },
    });
    return { created: true, role, trainerId: trainer.id };
  }

  if (role === Roles.NUTRITIONIST) {
    const existing = await db.nutritionist.findFirst({ where: { userId } });
    if (existing) return { created: false, role };
    await db.nutritionist.create({ data: { userId } });
    return { created: true, role };
  }

  const err = new Error('Invalid profile type');
  err.code = 'INVALID_PROFILE_TYPE';
  err.statusCode = 400;
  throw err;
}

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function safeUser(user) {
  if (!user) return user;
  const { passwordHash, ...rest } = user;
  return rest;
}

/**
 * Email/password login.
 * Contract:
 * - Validates email+password
 * - Unknown email, OAuth-only account (no passwordHash) and wrong password are
 *   all INVALID_CREDENTIALS, with the same scrypt cost
 * - Rejects soft-deleted users (only after the password matched)
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

  const userId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;

  // Every rejection below costs one scrypt and answers the same 401, so neither
  // latency nor status tells an unknown email from an OAuth-only account or a
  // wrong password. USER_DELETED is only revealed to whoever knows the password.
  const passwordMatches = user?.passwordHash
    ? verifyPassword(password, user.passwordHash)
    : verifyAgainstDummyHash(password);
  if (!passwordMatches) {
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

  return safeUser(user);
}

function throwPasswordResetValidation({ field, error, messageCode, message }) {
  throw new ValidationAppError({ message, messageCode, details: [{ field, reason: error }] });
}

function throwInvalidResetCode() {
  throw new AppError({
    httpStatus: 400,
    error: PasswordResetErrorCode.INVALID_CODE,
    messageCode: PasswordResetMessageCode.INVALID_CODE,
    message: 'Invalid or expired code. Request a new one.',
  });
}

/**
 * Whether a new code may be issued for this user right now. Enforces the
 * per-email cooldown and hourly cap. Evaluated silently: the caller still
 * answers the uniform 200, so a throttle never reveals the account exists.
 * Each issue resets the attempts counter, so the cap bounds total guesses.
 */
async function isPasswordResetIssueAllowed(userId) {
  const { passwordResetCooldownMs, passwordResetMaxPerHour } = config.auth;
  const recentTokens = await prisma.passwordResetToken.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - PASSWORD_RESET_ISSUE_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: passwordResetMaxPerHour,
    select: { createdAt: true },
  });

  if (recentTokens.length >= passwordResetMaxPerHour) return false;
  const latest = recentTokens[0];
  return !latest || Date.now() - latest.createdAt.getTime() >= passwordResetCooldownMs;
}

/**
 * Request a password reset for the given email.
 *
 * Contract:
 * - Always succeeds (to avoid email enumeration) if email format is valid.
 * - Creates a PasswordResetToken row when a matching user exists, is not
 *   deleted and is not throttled (cooldown / hourly cap, silent).
 * - Returns the plain resetToken; the route only exposes it in the response
 *   when config.auth.exposeResetTokenInResponse is on (development/test).
 */
export async function requestPasswordReset({ email }) {
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    throwPasswordResetValidation({
      field: 'email',
      error: PasswordResetErrorCode.EMAIL_REQUIRED,
      messageCode: PasswordResetMessageCode.EMAIL_REQUIRED,
      message: 'Email is required',
    });
  }

  const userId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
  const user = userId ? await prisma.user.findUnique({ where: { id: userId } }) : null;

  // To avoid user enumeration, do not reveal whether the user exists.
  if (!user || user.deletedAt) {
    return { resetToken: null, deliveryEmail: null };
  }

  if (!(await isPasswordResetIssueAllowed(user.id))) {
    return { resetToken: null, deliveryEmail: null };
  }

  const token = crypto.randomInt(0, 10 ** PASSWORD_RESET_CODE_LENGTH).toString().padStart(PASSWORD_RESET_CODE_LENGTH, '0');
  const now = Date.now();

  // Only the latest request is valid: close prior unused codes, and purge rows
  // older than the throttle window (long expired) so the table does not grow.
  await prisma.$transaction([
    prisma.passwordResetToken.deleteMany({
      where: { userId: user.id, createdAt: { lt: new Date(now - PASSWORD_RESET_ISSUE_WINDOW_MS) } },
    }),
    prisma.passwordResetToken.updateMany({
      where: { userId: user.id, used: false },
      data: { used: true },
    }),
    prisma.passwordResetToken.create({
      data: {
        tokenHash: hashToken(token),
        userId: user.id,
        expiresAt: new Date(now + PASSWORD_RESET_TTL_MS),
      },
    }),
  ]);

  return { resetToken: token, deliveryEmail: user.email };
}

function assertResetInputValid({ email, code, password, passwordConfirmation }) {
  if (!normalizeEmail(email)) {
    throwPasswordResetValidation({
      field: 'email',
      error: PasswordResetErrorCode.EMAIL_REQUIRED,
      messageCode: PasswordResetMessageCode.EMAIL_REQUIRED,
      message: 'Email is required',
    });
  }

  if (typeof code !== 'string' || code.trim() === '') {
    throwPasswordResetValidation({
      field: 'code',
      error: PasswordResetErrorCode.CODE_REQUIRED,
      messageCode: PasswordResetMessageCode.CODE_REQUIRED,
      message: 'Reset code is required',
    });
  }

  if (typeof password !== 'string' || password.length < PASSWORD_RESET_MIN_PASSWORD_LENGTH) {
    throwPasswordResetValidation({
      field: 'password',
      error: PasswordResetErrorCode.WEAK_PASSWORD,
      messageCode: PasswordResetMessageCode.WEAK_PASSWORD,
      message: `Password must be at least ${PASSWORD_RESET_MIN_PASSWORD_LENGTH} characters`,
    });
  }

  if (typeof passwordConfirmation !== 'string' || password !== passwordConfirmation) {
    throwPasswordResetValidation({
      field: 'passwordConfirmation',
      error: PasswordResetErrorCode.PASSWORD_MISMATCH,
      messageCode: PasswordResetMessageCode.PASSWORD_MISMATCH,
      message: 'Passwords do not match',
    });
  }
}

/**
 * Runs the same queries whether or not the email has an account (a nil user
 * id yields no token), so every failure path costs the same.
 */
async function findActiveResetToken(userId) {
  return prisma.passwordResetToken.findFirst({
    where: { userId: userId ?? NIL_UUID, used: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Atomically consumes one attempt (conditional increment, so the cap holds under
 * concurrent guesses). Returns false when the token is dead or absent.
 */
async function consumeResetAttempt(token) {
  const { count } = await prisma.passwordResetToken.updateMany({
    where: {
      id: token?.id ?? NIL_UUID,
      used: false,
      attempts: { lt: PASSWORD_RESET_MAX_ATTEMPTS },
      expiresAt: { gt: new Date() },
    },
    data: { attempts: { increment: 1 } },
  });
  return count > 0;
}

function resetCodeMatches(code, token) {
  const candidate = Buffer.from(hashToken(code.trim()));
  const stored = Buffer.from(token?.tokenHash ?? hashToken(NIL_UUID));
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored) && Boolean(token);
}

/**
 * Reset password using the emailed code, bound to the email it was sent to.
 *
 * Contract:
 * - Validates input (400 VALIDATION_ERROR), then the code for that email.
 * - Unknown email, deleted user, no/used/expired token, wrong code and too many
 *   attempts (cap 5 per token) all throw the SAME AppError (passwordReset.invalidCode).
 * - No scrypt work happens before the code is proven correct.
 * - Updates passwordHash, consumes the token, revokes every refresh token and
 *   marks the email verified (the code proves inbox ownership).
 * - Returns the safe user (without passwordHash)
 */
export async function resetPasswordWithCode({ email, code, password, passwordConfirmation }) {
  assertResetInputValid({ email, code, password, passwordConfirmation });

  const userId = await findUserIdByEmailCaseInsensitive(prisma, normalizeEmail(email));
  const user = userId ? await prisma.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } }) : null;
  const token = await findActiveResetToken(user?.id);
  const attemptConsumed = await consumeResetAttempt(token);
  const codeMatches = resetCodeMatches(code, token);

  if (!user || user.deletedAt || !token || !attemptConsumed || !codeMatches) throwInvalidResetCode();

  const passwordHash = hashPassword(password);

  // Revoking every session is what makes the reset a recovery: a legacy
  // account pre-registered by someone else with this email (unverified) would
  // otherwise keep the squatter's refresh tokens alive, and the reset below
  // marks the email verified, so the OAuth-time neutralization never runs.
  const updatedUser = await prisma.$transaction(async (tx) => {
    // Guards two concurrent requests with the same correct code.
    const { count } = await tx.passwordResetToken.updateMany({
      where: { id: token.id, used: false },
      data: { used: true },
    });
    if (count === 0) throwInvalidResetCode();

    await tx.refreshToken.updateMany({
      where: { userId: user.id, revoked: false },
      data: { revoked: true, revokedAt: new Date() },
    });
    return tx.user.update({ where: { id: user.id }, data: { passwordHash } });
  });

  // The reset code was delivered to the inbox: it proves email ownership.
  // Not a gate on the reset itself; never throws.
  await markEmailVerifiedFromInboxProof(prisma, updatedUser);

  return safeUser(updatedUser);
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

/**
 * Add an email to the waitlist.
 */
export async function addEmailToWaitlist({ email }) {
  if (!email || typeof email !== 'string') {
    const error = new Error('Valid email is required');
    error.code = 'EMAIL_REQUIRED';
    throw error;
  }

  // Check if email already exists in waitlist
  const existingEntry = await prisma.userWaitlist.findUnique({
    where: { email: email.toLowerCase() },
  });

  if (existingEntry) {
    const error = new Error('Email already on waitlist');
    error.code = 'EMAIL_ALREADY_ON_WAITLIST';
    throw error;
  }

  // Create waitlist entry
  const waitlistEntry = await prisma.userWaitlist.create({
    data: {
      email: email.toLowerCase(),
      status: 'pending',
    },
  });

  // Send confirmation email
  try {
    await emailHandler.sendWaitlistConfirmationEmail({
      to: waitlistEntry.email,
    });
  } catch (emailError) {
    // Log error but don't fail the waitlist signup
    console.error('Failed to send waitlist confirmation email:', emailError);
  }

  return {
    id: waitlistEntry.id,
    email: waitlistEntry.email,
    status: waitlistEntry.status,
    createdAt: waitlistEntry.createdAt,
  };
}

/**
 * Change password for an authenticated user.
 *
 * Contract:
 * - Validates current password using the same verifyPassword logic
 * - Validates new password strength and confirmation match
 * - Updates user's passwordHash using the same hashPassword logic (scrypt)
 * - Only works for users with password authentication (not OAuth-only)
 */
export async function changePassword({ userId, currentPassword, newPassword, newPasswordConfirmation }) {
  if (!userId) {
    const err = new Error('User ID is required');
    err.code = 'USER_ID_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  if (typeof currentPassword !== 'string' || currentPassword.length === 0) {
    const err = new Error('Current password is required');
    err.code = 'CURRENT_PASSWORD_REQUIRED';
    err.statusCode = 400;
    throw err;
  }

  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    const err = new Error('New password must be at least 8 characters');
    err.code = 'WEAK_PASSWORD';
    err.statusCode = 400;
    throw err;
  }

  if (typeof newPasswordConfirmation !== 'string' || newPassword !== newPasswordConfirmation) {
    const err = new Error('New passwords do not match');
    err.code = 'PASSWORD_MISMATCH';
    err.statusCode = 400;
    throw err;
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    const err = new Error('User not found');
    err.code = 'USER_NOT_FOUND';
    err.statusCode = 404;
    throw err;
  }

  if (user.deletedAt) {
    const err = new Error('User account is deactivated');
    err.code = 'USER_DELETED';
    err.statusCode = 403;
    throw err;
  }

  if (!user.passwordHash) {
    const err = new Error('Password change not available for OAuth-only accounts');
    err.code = 'PASSWORD_NOT_SET';
    err.statusCode = 409;
    throw err;
  }

  // Use the same verifyPassword function used in loginWithEmailPassword
  const isCurrentPasswordValid = verifyPassword(currentPassword, user.passwordHash);
  if (!isCurrentPasswordValid) {
    const err = new Error('Current password is incorrect');
    err.code = 'INVALID_CURRENT_PASSWORD';
    err.statusCode = 401;
    throw err;
  }

  // Ensure new password is different from current password
  if (currentPassword === newPassword) {
    const err = new Error('New password must be different from current password');
    err.code = 'PASSWORD_SAME_AS_CURRENT';
    err.statusCode = 400;
    throw err;
  }

  // Same scrypt hashing as reset-password and signup verification
  const newPasswordHash = hashPassword(newPassword);

  // Update password and revoke all existing refresh tokens for security
  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: newPasswordHash },
  });

  // Revoke all existing refresh tokens to force re-authentication
  await revokeAllUserRefreshTokens(userId);

  return { success: true, user: safeUser(user) };
}

