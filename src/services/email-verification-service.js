import crypto from 'node:crypto';
import emailHandler from '../config/email-handler.js';
import { AppError, ConflictAppError, NotFoundAppError } from '../errors/app-error.js';
import {
  EmailVerificationErrorCode,
  EmailVerificationMessageCode,
  EMAIL_PROVIDER,
  EMAIL_VERIFICATION_CODE_LENGTH,
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_DAILY_MAX_CODES,
  EMAIL_VERIFICATION_DAILY_WINDOW_MS,
} from '../constants/email-verification.js';
import { acceptPendingInvitesForUser } from './student-invite-service.js';

const MS_PER_SECOND = 1000;
const CODE_UPPER_BOUND = 10 ** EMAIL_VERIFICATION_CODE_LENGTH;

export function hashCode(code) {
  return crypto.createHash('sha256').update(code).digest('hex');
}

export function generateCode() {
  return crypto.randomInt(0, CODE_UPPER_BOUND).toString().padStart(EMAIL_VERIFICATION_CODE_LENGTH, '0');
}

export function hashesMatch(candidateHash, storedHash) {
  const candidate = Buffer.from(candidateHash);
  const stored = Buffer.from(storedHash);
  return candidate.length === stored.length && crypto.timingSafeEqual(candidate, stored);
}

function buildVerificationError({ httpStatus, error, messageCode, message, details }) {
  return new AppError({ httpStatus, error, messageCode, message, details });
}

/** True when ANY of the user's accounts has a verifiedAt. */
export async function isUserEmailVerified(prisma, userId) {
  const account = await prisma.account.findFirst({
    where: { userId, verifiedAt: { not: null } },
    select: { id: true },
  });
  return Boolean(account);
}

async function requireActiveUser(prisma, userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deletedAt: true },
  });

  if (!user || user.deletedAt) {
    throw new NotFoundAppError({
      error: EmailVerificationErrorCode.USER_NOT_FOUND,
      messageCode: EmailVerificationMessageCode.USER_NOT_FOUND,
      message: 'User not found.',
    });
  }
  return user;
}

async function assertNotVerified(prisma, userId) {
  if (await isUserEmailVerified(prisma, userId)) {
    throw new ConflictAppError({
      error: EmailVerificationErrorCode.ALREADY_VERIFIED,
      messageCode: EmailVerificationMessageCode.ALREADY_VERIFIED,
      message: 'Email is already verified.',
    });
  }
}

/**
 * Per-user cap on issued codes over a rolling window (1 indexed query on
 * user_id). Without it, each resend would grant a fresh attempts counter and
 * the 6-digit code space could be brute-forced within the TTL.
 */
async function assertDailyCodeLimitNotReached(prisma, userId) {
  const now = Date.now();
  const recentTokens = await prisma.emailVerificationToken.findMany({
    where: {
      userId,
      sendFailedAt: null,
      createdAt: { gte: new Date(now - EMAIL_VERIFICATION_DAILY_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: EMAIL_VERIFICATION_DAILY_MAX_CODES,
    select: { createdAt: true },
  });
  if (recentTokens.length < EMAIL_VERIFICATION_DAILY_MAX_CODES) return;

  // The cap-th newest code leaves the window first, freeing one slot.
  const oldestCountedAt = recentTokens[recentTokens.length - 1].createdAt.getTime();
  const remainingMs = oldestCountedAt + EMAIL_VERIFICATION_DAILY_WINDOW_MS - now;
  throw buildVerificationError({
    httpStatus: 429,
    error: EmailVerificationErrorCode.DAILY_LIMIT,
    messageCode: EmailVerificationMessageCode.DAILY_LIMIT,
    message: 'Too many verification codes requested. Try again later.',
    details: { retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / MS_PER_SECOND)) },
  });
}

/**
 * Enforces the daily cap and creates a fresh 6-digit code row (stored hashed).
 * Previous unused codes are NOT closed here: they stay valid until the new
 * code's email is confirmed delivered (see confirmVerificationCodeDelivered),
 * so a failed send never leaves the user without a working code. Shared by
 * signup, resend and the existing-user invite email, so all count toward the cap.
 *
 * @returns {Promise<{ code: string, tokenId: string, userId: string, createdAt: Date }>}
 */
async function issueCode(prisma, userId) {
  await assertDailyCodeLimitNotReached(prisma, userId);

  const code = generateCode();
  const token = await prisma.emailVerificationToken.create({
    data: {
      tokenHash: hashCode(code),
      userId,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    },
    select: { id: true, createdAt: true },
  });
  return { code, tokenId: token.id, userId, createdAt: token.createdAt };
}

/**
 * Issues a code for callers that are not the signup path: applies the resend
 * cooldown and the daily cap (throws AppError 429 when either blocks).
 */
export async function issueCodeRespectingLimits(prisma, userId) {
  await assertResendCooldownElapsed(prisma, userId);
  return issueCode(prisma, userId);
}

/**
 * Closes the codes superseded by a newly DELIVERED one, leaving exactly one
 * active deliverable code (the brute-force bound relies on it). Only strictly
 * older rows are closed, so two concurrent issues cannot close each other.
 * Never throws: if it fails, verification still checks only the newest code.
 *
 * @param {{ tokenId: string, userId: string, createdAt: Date }} issued
 */
export async function confirmVerificationCodeDelivered(prisma, issued) {
  try {
    await prisma.emailVerificationToken.updateMany({
      where: {
        userId: issued.userId,
        used: false,
        sendFailedAt: null,
        id: { not: issued.tokenId },
        createdAt: { lt: issued.createdAt },
      },
      data: { used: true },
    });
  } catch (closeError) {
    console.error('Failed to close superseded email verification codes', closeError);
  }
}

/**
 * Marks a code whose email was not delivered. The row is closed (used=true) so
 * it can never be the active token: nobody received it, hence nobody can guess
 * against it, and the brute-force bound (cap x attempts) only needs to cover
 * delivered codes. The previously delivered code is left untouched (still valid). `sendFailedAt` excludes the row from the cooldown and the
 * daily cap, so a provider outage does not lock the user out. Never throws.
 */
export async function markVerificationSendFailed(prisma, tokenId) {
  try {
    await prisma.emailVerificationToken.updateMany({
      where: { id: tokenId },
      data: { used: true, sendFailedAt: new Date() },
    });
  } catch (markError) {
    console.error('Failed to mark email verification code as undelivered', markError);
  }
}

/**
 * Sends the code email and reports whether it was delivered. The Resend SDK
 * returns `{ error }` instead of throwing, so both cases are failures; a failed
 * send marks the code row as undelivered. Never throws.
 */
async function deliverCode(prisma, { issued, to, emailSender }) {
  try {
    const response = await emailSender.sendEmailVerificationEmail({ to, code: issued.code });
    if (!response?.error) {
      await confirmVerificationCodeDelivered(prisma, issued);
      return true;
    }
    console.error('Failed to send email verification code', response.error);
  } catch (error) {
    console.error('Failed to send email verification code', error);
  }
  await markVerificationSendFailed(prisma, issued.tokenId);
  return false;
}

/**
 * Issues a code and emails it. Never throws (including when the daily cap is
 * hit): called right after signup, which must not fail because of email
 * delivery. A failed delivery is logged and does not consume the cooldown or
 * the cap. The user can request a resend.
 */
export async function sendVerificationCodeSafely(prisma, { userId, email }, { emailSender = emailHandler } = {}) {
  try {
    const issued = await issueCode(prisma, userId);
    await deliverCode(prisma, { issued, to: email, emailSender });
  } catch (error) {
    console.error('Failed to send email verification code', error);
  }
}

/**
 * Atomically consumes one attempt. The conditional increment enforces the
 * attempts cap even under concurrent guesses (no read-then-write window).
 */
async function consumeAttempt(prisma, token) {
  const { count } = await prisma.emailVerificationToken.updateMany({
    where: { id: token.id, used: false, attempts: { lt: EMAIL_VERIFICATION_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });

  if (count === 0) {
    throw buildVerificationError({
      httpStatus: 429,
      error: EmailVerificationErrorCode.TOO_MANY_ATTEMPTS,
      messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
      message: 'Too many incorrect attempts. Request a new code.',
    });
  }
}

function throwInvalidCode() {
  throw buildVerificationError({
    httpStatus: 400,
    error: EmailVerificationErrorCode.INVALID_CODE,
    messageCode: EmailVerificationMessageCode.INVALID_CODE,
    message: 'Invalid verification code.',
  });
}

async function findActiveToken(prisma, userId) {
  const token = await prisma.emailVerificationToken.findFirst({
    where: { userId, used: false, sendFailedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!token) throwInvalidCode();

  if (token.expiresAt < new Date()) {
    throw buildVerificationError({
      httpStatus: 400,
      error: EmailVerificationErrorCode.CODE_EXPIRED,
      messageCode: EmailVerificationMessageCode.CODE_EXPIRED,
      message: 'The verification code has expired.',
    });
  }
  return token;
}

/**
 * Verifies the code, marks the email Account verified, then accepts pending
 * student invites for the user's email.
 *
 * @returns {Promise<{ verified: true, linkedTrainers: number }>}
 */
export async function verifyEmailCode(prisma, { userId, code }) {
  const user = await requireActiveUser(prisma, userId);
  await assertNotVerified(prisma, userId);

  const token = await findActiveToken(prisma, userId);
  await consumeAttempt(prisma, token);

  if (!hashesMatch(hashCode(String(code).trim()), token.tokenHash)) throwInvalidCode();

  const now = new Date();
  const { count } = await prisma.emailVerificationToken.updateMany({
    where: { id: token.id, used: false },
    data: { used: true },
  });
  if (count === 0) throwInvalidCode();

  await prisma.account.updateMany({
    where: { userId, provider: EMAIL_PROVIDER, verifiedAt: null },
    data: { verifiedAt: now },
  });

  const linkedTrainers = await acceptPendingInvitesForUser(prisma, user);
  return { verified: true, linkedTrainers };
}

async function assertResendCooldownElapsed(prisma, userId) {
  const latest = await prisma.emailVerificationToken.findFirst({
    where: { userId, sendFailedAt: null },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  if (!latest) return;

  const remainingMs = latest.createdAt.getTime() + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - Date.now();
  if (remainingMs > 0) {
    throw buildVerificationError({
      httpStatus: 429,
      error: EmailVerificationErrorCode.RESEND_COOLDOWN,
      messageCode: EmailVerificationMessageCode.RESEND_COOLDOWN,
      message: 'Please wait before requesting a new code.',
      details: { retryAfterSeconds: Math.ceil(remainingMs / MS_PER_SECOND) },
    });
  }
}

function throwSendFailed() {
  throw buildVerificationError({
    httpStatus: 502,
    error: EmailVerificationErrorCode.SEND_FAILED,
    messageCode: EmailVerificationMessageCode.SEND_FAILED,
    message: 'Could not send the verification email. Try again shortly.',
  });
}

/**
 * Sends a new code (60s cooldown, daily cap). The previous code stays valid until this one is delivered. The user explicitly asked for
 * this email, so a delivery failure (Resend `{ error }` or a thrown error) is
 * reported as 502 instead of a false `sent: true`. The failed code row is
 * marked undelivered, so it does not burn the cooldown or the daily cap.
 */
export async function resendVerificationCode(prisma, { userId }, { emailSender = emailHandler } = {}) {
  const user = await requireActiveUser(prisma, userId);
  await assertNotVerified(prisma, userId);

  const issued = await issueCodeRespectingLimits(prisma, userId);
  const delivered = await deliverCode(prisma, { issued, to: user.email, emailSender });
  if (!delivered) throwSendFailed();

  return { sent: true };
}

/**
 * The user proved inbox ownership by other means than the verification code
 * (a password-reset token or a trainer-invite code, both delivered by email).
 * Marks the provider='email' Account verified and, on that transition, accepts
 * pending student invites. When the user has NO email Account (OAuth-only user
 * resetting a password) one is created already verified, since the reset gives
 * the user an email/password credential and Accounts track auth methods.
 * Already-verified email Accounts are left alone. Never throws: the primary
 * operation (reset / redeem) already succeeded.
 *
 * @param {{ id: string, email: string }} user
 * @returns {Promise<boolean>} true when the email Account became verified now
 */
export async function markEmailVerifiedFromInboxProof(prisma, user) {
  try {
    const { count } = await prisma.account.updateMany({
      where: { userId: user.id, provider: EMAIL_PROVIDER, verifiedAt: null },
      data: { verifiedAt: new Date() },
    });
    let becameVerified = count > 0;

    if (!becameVerified) {
      const existing = await prisma.account.findFirst({
        where: { userId: user.id, provider: EMAIL_PROVIDER },
        select: { id: true },
      });
      if (!existing) {
        await prisma.account.create({
          data: {
            userId: user.id,
            provider: EMAIL_PROVIDER,
            providerId: String(user.email).trim().toLowerCase(),
            verifiedAt: new Date(),
          },
        });
        becameVerified = true;
      }
    }

    if (becameVerified) await acceptPendingInvitesForUser(prisma, user);
    return becameVerified;
  } catch (error) {
    console.error('Failed to mark email verified from inbox proof', error);
    return false;
  }
}
