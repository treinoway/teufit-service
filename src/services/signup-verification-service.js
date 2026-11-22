import emailHandler from '../config/email-handler.js';
import { AppError } from '../errors/app-error.js';
import {
  EmailVerificationErrorCode,
  EmailVerificationMessageCode,
  EMAIL_PROVIDER,
  EMAIL_VERIFICATION_TTL_MS,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_DAILY_MAX_CODES,
  EMAIL_VERIFICATION_DAILY_WINDOW_MS,
} from '../constants/email-verification.js';
import {
  PENDING_SIGNUP_STALE_MS,
  EXISTING_ACCOUNT_NOTICE_THROTTLE_MS,
  SignupErrorCode,
  SignupMessageCode,
} from '../constants/signup-verification.js';
import { SignupSource } from '../constants/signup-source.js';
import { findUserIdByEmailCaseInsensitive } from '../helpers/email-lookup.js';
import { UserStatus } from '../constants/user-status.js';
import { hashPassword } from '../helpers/password.js';
import { generateCode, hashCode, hashesMatch, sendVerificationCodeSafely } from './email-verification-service.js';
import { acceptPendingInvitesForUser } from './student-invite-service.js';

const UNIQUE_VIOLATION_CODE = 'P2002';

// Signup / resend run after the HTTP response (see the auth routes), so the
// outcome of each branch is only visible in logs. Never log the email, the
// code or the password here.
function logSignupEvent(event, fields = {}) {
  console.warn('[signup]', { event, ...fields });
}

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function isUniqueViolation(error) {
  return error?.code === UNIQUE_VIOLATION_CODE;
}

function throwInvalidCode() {
  throw new AppError({
    httpStatus: 400,
    error: EmailVerificationErrorCode.INVALID_CODE,
    messageCode: EmailVerificationMessageCode.INVALID_CODE,
    message: 'Invalid verification code.',
  });
}

/** The User that owns this email (case-insensitive), including soft-deleted ones. */
async function findEmailOwner(prisma, normalizedEmail) {
  const userId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
  if (!userId) return null;
  return prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, deletedAt: true },
  });
}

async function discardPendingSignup(prisma, normalizedEmail) {
  await prisma.pendingSignup.deleteMany({ where: { email: normalizedEmail } });
}

/**
 * Creates the pending signup or refreshes its `updatedAt`. Retried once on a
 * unique violation: two concurrent upserts for a new email both try the INSERT.
 */
async function touchPendingSignup(prisma, normalizedEmail) {
  const upsert = () =>
    prisma.pendingSignup.upsert({
      where: { email: normalizedEmail },
      create: { email: normalizedEmail },
      update: { updatedAt: new Date() },
      select: { id: true },
    });
  try {
    return await upsert();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return upsert();
  }
}

/** Atomically claims the 15-minute slot for the "you already have an account" email. */
async function claimExistingAccountNoticeSlot(prisma, normalizedEmail) {
  const now = new Date();
  const { count } = await prisma.existingAccountNotice.updateMany({
    where: { email: normalizedEmail, lastSentAt: { lt: new Date(now.getTime() - EXISTING_ACCOUNT_NOTICE_THROTTLE_MS) } },
    data: { lastSentAt: now },
  });
  if (count > 0) return true;

  try {
    await prisma.existingAccountNotice.create({ data: { email: normalizedEmail, lastSentAt: now } });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}

async function sendExistingAccountNotice(prisma, { owner, normalizedEmail, emailSender }) {
  if (!(await claimExistingAccountNoticeSlot(prisma, normalizedEmail))) {
    logSignupEvent('existing_account_notice_throttled', { userId: owner.id });
    return;
  }
  try {
    const response = await emailSender.sendExistingAccountSignupEmail({ to: owner.email });
    if (response?.error) logSignupEvent('existing_account_notice_send_failed', { userId: owner.id, reason: response.error?.name });
  } catch (error) {
    logSignupEvent('existing_account_notice_send_failed', { userId: owner.id, reason: error?.message });
  }
}

/** Why a code cannot be issued now (cooldown / daily cap), or null when it can. */
async function findIssueBlocker(prisma, pendingSignupId) {
  const now = Date.now();
  const recentCodes = await prisma.pendingSignupCode.findMany({
    where: {
      pendingSignupId,
      sendFailedAt: null,
      createdAt: { gte: new Date(now - EMAIL_VERIFICATION_DAILY_WINDOW_MS) },
    },
    orderBy: { createdAt: 'desc' },
    take: EMAIL_VERIFICATION_DAILY_MAX_CODES,
    select: { createdAt: true },
  });
  if (recentCodes.length >= EMAIL_VERIFICATION_DAILY_MAX_CODES) return 'daily_limit';
  const latest = recentCodes[0];
  if (latest && latest.createdAt.getTime() + EMAIL_VERIFICATION_RESEND_COOLDOWN_MS > now) return 'cooldown';
  return null;
}

/**
 * Issues and emails a code, applying the cooldown and the daily cap SILENTLY:
 * a 429 / 502 here would tell the caller a pending signup exists. A delivered
 * code closes the older ones; an undelivered one is closed and excluded from
 * the limits (same lifecycle as email-verification-service). Delivery
 * failures are logged, not thrown.
 *
 * `decoy: true` (email already owned by a User) runs the exact same row
 * lifecycle but never emails the code, so nobody can know it. That keeps
 * /auth/signup/verify behaving identically for owned and free emails
 * (attempts cap -> 429, TTL -> codeExpired); without it, "pending exists" would
 * mean "no account" and the verify errors would be an enumeration oracle.
 */
async function issueAndDeliverCode(prisma, { pendingSignupId, to, emailSender, decoy = false }) {
  const blocker = await findIssueBlocker(prisma, pendingSignupId);
  if (blocker) {
    logSignupEvent('code_not_issued', { pendingSignupId, reason: blocker });
    return;
  }

  const code = generateCode();
  const issued = await prisma.pendingSignupCode.create({
    data: { pendingSignupId, tokenHash: hashCode(code), expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS) },
    select: { id: true, createdAt: true },
  });

  let delivered = false;
  if (decoy) {
    delivered = true;
  } else {
    try {
      const response = await emailSender.sendEmailVerificationEmail({ to, code });
      delivered = !response?.error;
      if (!delivered) logSignupEvent('code_send_failed', { pendingSignupId, reason: response.error?.name });
    } catch (error) {
      logSignupEvent('code_send_failed', { pendingSignupId, reason: error?.message });
    }
  }

  if (delivered) {
    await prisma.pendingSignupCode.updateMany({
      where: { pendingSignupId, used: false, sendFailedAt: null, id: { not: issued.id }, createdAt: { lt: issued.createdAt } },
      data: { used: true },
    });
  } else {
    await prisma.pendingSignupCode.updateMany({
      where: { id: issued.id },
      data: { used: true, sendFailedAt: new Date() },
    });
  }
}

/**
 * "You already have an account" email for an active owner (throttled);
 * nothing for a soft-deleted one. The account is never touched.
 */
async function notifyExistingOwner(prisma, { owner, normalizedEmail, emailSender }) {
  if (owner.deletedAt) return;
  await sendExistingAccountNotice(prisma, { owner, normalizedEmail, emailSender });
}

/** Removes pending signups idle for longer than PENDING_SIGNUP_STALE_MS. */
export async function purgeStalePendingSignups(prisma) {
  const { count } = await prisma.pendingSignup.deleteMany({
    where: { updatedAt: { lt: new Date(Date.now() - PENDING_SIGNUP_STALE_MS) } },
  });
  return count;
}

/**
 * Background half of POST /auth/signup (the route already answered 202):
 * - no User for the email -> create/refresh the pending signup, email a code;
 * - active User -> "you already have an account" email (throttled), account
 *   untouched, plus a decoy (never emailed) code on the pending signup;
 * - soft-deleted User -> decoy code only.
 * The pending signup + code rows are written in every branch so the public
 * verify endpoint cannot tell the branches apart (see issueAndDeliverCode).
 */
export async function processSignupRequest(prisma, { email }, { emailSender = emailHandler } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  const owner = await findEmailOwner(prisma, normalizedEmail);
  const pending = await touchPendingSignup(prisma, normalizedEmail);
  if (owner) await notifyExistingOwner(prisma, { owner, normalizedEmail, emailSender });

  await issueAndDeliverCode(prisma, {
    pendingSignupId: pending.id,
    to: normalizedEmail,
    emailSender,
    decoy: Boolean(owner),
  });
}

/**
 * Background half of POST /auth/signup/resend (the route already answered 202):
 * same branches as processSignupRequest, but never creates a pending signup.
 */
export async function processSignupResendRequest(prisma, { email }, { emailSender = emailHandler } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return;

  const owner = await findEmailOwner(prisma, normalizedEmail);
  if (owner) await notifyExistingOwner(prisma, { owner, normalizedEmail, emailSender });

  const { count } = await prisma.pendingSignup.updateMany({
    where: { email: normalizedEmail },
    data: { updatedAt: new Date() },
  });
  if (count === 0) return;

  const pending = await prisma.pendingSignup.findUnique({ where: { email: normalizedEmail }, select: { id: true } });
  if (!pending) return;
  await issueAndDeliverCode(prisma, {
    pendingSignupId: pending.id,
    to: normalizedEmail,
    emailSender,
    decoy: Boolean(owner),
  });
}

async function findActiveCode(prisma, pendingSignupId) {
  const code = await prisma.pendingSignupCode.findFirst({
    where: { pendingSignupId, used: false, sendFailedAt: null },
    orderBy: { createdAt: 'desc' },
  });
  if (!code) throwInvalidCode();

  if (code.expiresAt < new Date()) {
    throw new AppError({
      httpStatus: 400,
      error: EmailVerificationErrorCode.CODE_EXPIRED,
      messageCode: EmailVerificationMessageCode.CODE_EXPIRED,
      message: 'The verification code has expired.',
    });
  }
  return code;
}

/**
 * Conditional increment: enforces the attempts cap under concurrent guesses.
 * Matching nothing means either the cap was hit or a concurrent request just
 * consumed the code (verified it, or a newer code closed it); the latter is
 * invalidCode, not tooManyAttempts.
 */
async function consumeAttempt(prisma, codeId) {
  const { count } = await prisma.pendingSignupCode.updateMany({
    where: { id: codeId, used: false, attempts: { lt: EMAIL_VERIFICATION_MAX_ATTEMPTS } },
    data: { attempts: { increment: 1 } },
  });
  if (count === 0) {
    const current = await prisma.pendingSignupCode.findUnique({ where: { id: codeId }, select: { used: true } });
    if (!current || current.used) throwInvalidCode();
    throw new AppError({
      httpStatus: 429,
      error: EmailVerificationErrorCode.TOO_MANY_ATTEMPTS,
      messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
      message: 'Too many incorrect attempts. Request a new code.',
    });
  }
}

/**
 * Consumes the code and creates the User + verified email Account in one
 * transaction. The conditional `used: false → true` update is the race guard:
 * a concurrent verify of the same code blocks on the row and then matches
 * nothing, so exactly one request creates the account.
 */
async function createVerifiedUser(prisma, { pendingSignupId, codeId, normalizedEmail, passwordHash }) {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.pendingSignupCode.updateMany({
      where: { id: codeId, used: false },
      data: { used: true },
    });
    if (count === 0) throwInvalidCode();

    const user = await tx.user.create({
      data: { email: normalizedEmail, passwordHash, roles: [], status: UserStatus.ACTIVE },
    });
    await tx.account.create({
      data: { userId: user.id, provider: EMAIL_PROVIDER, providerId: normalizedEmail, verifiedAt: new Date() },
    });
    await tx.pendingSignup.deleteMany({ where: { id: pendingSignupId } });
    return user;
  });
}

/**
 * POST /auth/signup/verify. Every "this cannot become an account" outcome —
 * no pending signup, wrong code, email taken by a User in the meantime (e.g.
 * the owner signed in with Google first) — is the same 400 invalidCode.
 * codeExpired / tooManyAttempts only reveal that someone called /auth/signup
 * for the email: owned emails get a decoy pending signup + code too.
 *
 * The password comes with the code (not from the signup request) so the
 * person who proves the inbox is the one who picks the password.
 *
 * @returns {Promise<{ user: object, linkedTrainers: number }>}
 */
export async function verifySignupCode(prisma, { email, code, password }) {
  const normalizedEmail = normalizeEmail(email);
  const pending = normalizedEmail
    ? await prisma.pendingSignup.findUnique({ where: { email: normalizedEmail }, select: { id: true } })
    : null;
  if (!pending) throwInvalidCode();

  const activeCode = await findActiveCode(prisma, pending.id);
  await consumeAttempt(prisma, activeCode.id);
  if (!hashesMatch(hashCode(String(code).trim()), activeCode.tokenHash)) throwInvalidCode();

  if (await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail)) {
    await discardPendingSignup(prisma, normalizedEmail);
    throwInvalidCode();
  }

  const passwordHash = hashPassword(password);
  let user;
  try {
    user = await createVerifiedUser(prisma, {
      pendingSignupId: pending.id,
      codeId: activeCode.id,
      normalizedEmail,
      passwordHash,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost a race against an OAuth sign-in creating the same email.
    await discardPendingSignup(prisma, normalizedEmail);
    throwInvalidCode();
  }

  const linkedTrainers = await acceptPendingInvitesForUser(prisma, user);
  return { user, linkedTrainers };
}

// Builds the 409 answered when a direct signup targets an email that already has an account.
function createEmailInUseError() {
  return new AppError({
    httpStatus: 409,
    error: SignupErrorCode.EMAIL_IN_USE,
    messageCode: SignupMessageCode.EMAIL_IN_USE,
    message: 'This email already has an account.',
  });
}

// Trims a name; blank or missing becomes null.
function normalizeName(name) {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  return trimmed || null;
}

// Creates the role-less User and its UNVERIFIED email Account atomically; a unique violation means the email was taken meanwhile.
async function createUnverifiedUser(prisma, { normalizedEmail, passwordHash, firstName, lastName }) {
  try {
    return await prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          email: normalizedEmail,
          passwordHash,
          firstName: normalizeName(firstName),
          lastName: normalizeName(lastName),
          roles: [],
          status: UserStatus.PENDING,
          signupSource: SignupSource.WEB_DIRECT,
        },
      });
      await tx.account.create({ data: { userId: user.id, provider: EMAIL_PROVIDER, providerId: normalizedEmail } });
      return user;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw createEmailInUseError();
    throw error;
  }
}

/**
 * POST /auth/signup/direct: creates the account with an UNVERIFIED email, emails the code and accepts no student invite.
 *
 * @returns {Promise<{ user: object, linkedTrainers: number }>}
 */
export async function signupDirect(prisma, { email, password, firstName, lastName }, { emailSender = emailHandler } = {}) {
  const normalizedEmail = normalizeEmail(email);
  if (await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail)) throw createEmailInUseError();

  const passwordHash = hashPassword(password);
  const user = await createUnverifiedUser(prisma, { normalizedEmail, passwordHash, firstName, lastName });

  await sendVerificationCodeSafely(prisma, { userId: user.id, email: normalizedEmail }, { emailSender });
  return { user, linkedTrainers: 0 };
}
