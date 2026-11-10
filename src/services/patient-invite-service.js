import emailHandler from '../config/email-handler.js';
import { AppError, ConflictAppError, NotFoundAppError } from '../errors/app-error.js';
import { findUserIdByEmailCaseInsensitive } from '../helpers/email-lookup.js';
import {
  StudentInviteOutcome as InviteOutcome,
  STUDENT_INVITE_TTL_MS as INVITE_TTL_MS,
  STUDENT_INVITE_RESEND_COOLDOWN_MS as RESEND_COOLDOWN_MS,
  STUDENT_INVITE_MAX_SENDS as MAX_SENDS,
  STUDENT_INVITE_DAILY_MAX as DAILY_MAX,
  STUDENT_INVITE_DAILY_WINDOW_MS as DAILY_WINDOW_MS,
} from '../constants/student-invite.js';
import {
  NutritionErrorCode,
  NutritionMessageCode,
  PatientInviteStatus as InviteStatus,
  patientInviteStatusValues as inviteStatusValues,
} from '../constants/nutrition.js';
import {
  issueCodeRespectingLimits,
  markVerificationSendFailed,
  confirmVerificationCodeDelivered,
  isUserEmailVerified,
} from './email-verification-service.js';

const UNIQUE_VIOLATION_CODE = 'P2002';
const MS_PER_SECOND = 1000;

// Lowercases and trims an email.
function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

// Full display name of a user row.
function buildFullName(user) {
  return `${user?.firstName ?? ''} ${user?.lastName ?? ''}`.trim();
}

// Status as the nutritionist sees it: a pending invite past expiry is reported as expired.
function resolveEffectiveStatus(invite, now) {
  if (invite.status === InviteStatus.PENDING && invite.expiresAt < now) return InviteStatus.EXPIRED;
  return invite.status;
}

// Whether/when the invite can be resent right now.
function computeResendAvailability(invite, now) {
  const isResendable = invite.status === InviteStatus.PENDING && invite.sendCount < MAX_SENDS;
  if (!isResendable) return { canResend: false, resendAvailableAt: null };
  const availableAt = new Date(invite.lastSentAt.getTime() + RESEND_COOLDOWN_MS);
  if (availableAt > now) return { canResend: false, resendAvailableAt: availableAt };
  return { canResend: true, resendAvailableAt: null };
}

// Adds the effective status and resend availability to an invite row.
function withEffectiveStatus(invite) {
  const now = new Date();
  return { ...invite, status: resolveEffectiveStatus(invite, now), ...computeResendAvailability(invite, now) };
}

// Prisma filter for one status as the nutritionist sees it.
function buildSingleStatusFilter(status, now) {
  if (status === InviteStatus.PENDING) return { status: InviteStatus.PENDING, expiresAt: { gte: now } };
  if (status === InviteStatus.EXPIRED) {
    return {
      OR: [
        { status: InviteStatus.EXPIRED },
        { status: InviteStatus.PENDING, expiresAt: { lt: now } },
      ],
    };
  }
  return { status };
}

// Valid statuses of a comma separated filter value.
function parseStatusList(statusFilter) {
  if (typeof statusFilter !== 'string') return [];
  return statusFilter
    .split(',')
    .map((status) => status.trim())
    .filter((status) => inviteStatusValues.includes(status));
}

// Prisma filter for a comma separated list of statuses (empty when none is valid).
function buildStatusFilter(statusFilter, now) {
  const statuses = parseStatusList(statusFilter);
  if (statuses.length === 0) return {};
  if (statuses.length === 1) return buildSingleStatusFilter(statuses[0], now);
  return { OR: statuses.map((status) => buildSingleStatusFilter(status, now)) };
}

// Name of the inviting nutritionist for emails.
async function findNutritionistName(prisma, nutritionistUserId) {
  const user = await prisma.user.findUnique({
    where: { id: nutritionistUserId },
    select: { firstName: true, lastName: true },
  });
  return buildFullName(user);
}

// Sends the invite email to an email without an account; reports delivery and never throws.
async function deliverNewUserInviteEmail(prisma, { nutritionistUserId, email, emailSender }) {
  try {
    const nutritionistName = await findNutritionistName(prisma, nutritionistUserId);
    const response = await emailSender.sendPatientInviteEmail({ to: email, nutritionistName });
    if (response?.error) {
      console.error('Failed to send patient invite email', response.error);
      return false;
    }
    return true;
  } catch (emailError) {
    console.error('Failed to send patient invite email', emailError);
    return false;
  }
}

// Issues a verification code best-effort (null when blocked or failed).
async function issueCodeBestEffort(prisma, userId) {
  try {
    return await issueCodeRespectingLimits(prisma, userId);
  } catch (issueError) {
    console.warn('Verification code not issued for patient invite email', issueError?.messageCode ?? issueError);
    return null;
  }
}

// Sends the invite to an existing account (with a verification code only when unverified); never throws.
async function deliverExistingUserInviteEmail(prisma, { userId, shouldIssueCode, nutritionistUserId, email, emailSender }) {
  const issued = shouldIssueCode ? await issueCodeBestEffort(prisma, userId) : null;
  try {
    const nutritionistName = await findNutritionistName(prisma, nutritionistUserId);
    const response = await emailSender.sendExistingUserPatientInviteEmail({
      to: email,
      nutritionistName,
      code: issued?.code ?? null,
    });
    if (!response?.error) {
      if (issued) await confirmVerificationCodeDelivered(prisma, issued);
      return true;
    }
    console.error('Failed to send patient invite email', response.error);
  } catch (emailError) {
    console.error('Failed to send patient invite email', emailError);
  }
  if (issued) await markVerificationSendFailed(prisma, issued.tokenId);
  return false;
}

// Id of the active user owning this email, or null.
async function findActiveUserId(prisma, email) {
  const userId = await findUserIdByEmailCaseInsensitive(prisma, email);
  if (!userId) return null;
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { deletedAt: true } });
  return user && !user.deletedAt ? userId : null;
}

// Delivers the invite email for the account that owns the email (null userId: no account); never throws.
async function deliverInviteEmail(prisma, { userId, nutritionistUserId, email, emailSender }) {
  try {
    if (!userId) return await deliverNewUserInviteEmail(prisma, { nutritionistUserId, email, emailSender });
    const isVerified = await isUserEmailVerified(prisma, userId);
    return await deliverExistingUserInviteEmail(prisma, {
      userId,
      shouldIssueCode: !isVerified,
      nutritionistUserId,
      email,
      emailSender,
    });
  } catch (deliveryError) {
    console.error('Failed to deliver patient invite email', deliveryError);
    return false;
  }
}

// Resend delivery: resolves the account behind the email first; a failed lookup falls back to the generic email.
async function deliverResendEmail(prisma, { nutritionistUserId, email, emailSender }) {
  let userId = null;
  try {
    userId = await findActiveUserId(prisma, email);
  } catch (lookupError) {
    console.error('Failed to resolve patient invite recipient; sending generic email', lookupError);
  }
  return deliverInviteEmail(prisma, { userId, nutritionistUserId, email, emailSender });
}

// Throws 422 when the nutritionist tries to invite their own account.
function throwSelfInvite() {
  throw new AppError({
    httpStatus: 422,
    error: NutritionErrorCode.INVITE_SELF,
    messageCode: NutritionMessageCode.INVITE_SELF,
    message: 'A nutritionist cannot add themselves as a patient.',
  });
}

// Throws 409 when the patient is already actively linked.
async function assertNotAlreadyLinked(prisma, { nutritionistId, patientId }) {
  const existing = await prisma.nutritionistPatient.findUnique({
    where: { nutritionistId_patientId: { nutritionistId, patientId } },
  });
  if (existing && !existing.deletedAt) {
    throw new ConflictAppError({
      error: NutritionErrorCode.INVITE_ALREADY_LINKED,
      messageCode: NutritionMessageCode.INVITE_ALREADY_LINKED,
      message: 'This patient is already linked to you.',
    });
  }
}

// Throws unless the existing account can be invited (active, not the nutritionist, not linked yet).
async function assertInvitableAccount(prisma, { nutritionistId, nutritionistUserId, userId }) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, deletedAt: true } });
  if (!user || user.deletedAt) {
    throw new AppError({
      httpStatus: 422,
      error: NutritionErrorCode.INVITE_ACCOUNT_DEACTIVATED,
      messageCode: NutritionMessageCode.INVITE_ACCOUNT_DEACTIVATED,
      message: 'This account is deactivated.',
    });
  }
  if (user.id === nutritionistUserId) throwSelfInvite();
  await assertNotAlreadyLinked(prisma, { nutritionistId, patientId: user.id });
}

// Seconds until a timestamp (at least 1).
function secondsUntil(timestampMs) {
  return Math.max(1, Math.ceil((timestampMs - Date.now()) / MS_PER_SECOND));
}

// Per-nutritionist rolling-window cap on newly created invites.
async function assertDailyInviteLimitNotReached(prisma, nutritionistId) {
  const recentInvites = await prisma.patientInvite.findMany({
    where: { nutritionistId, createdAt: { gte: new Date(Date.now() - DAILY_WINDOW_MS) } },
    orderBy: { createdAt: 'desc' },
    take: DAILY_MAX,
    select: { createdAt: true },
  });
  if (recentInvites.length < DAILY_MAX) return;
  const oldestCountedAt = recentInvites[recentInvites.length - 1].createdAt.getTime();
  throw new AppError({
    httpStatus: 429,
    error: NutritionErrorCode.INVITE_DAILY_LIMIT,
    messageCode: NutritionMessageCode.INVITE_DAILY_LIMIT,
    message: 'Daily invite limit reached. Try again later.',
    details: { retryAfterSeconds: secondsUntil(oldestCountedAt + DAILY_WINDOW_MS) },
  });
}

// Creates the pending invite (flipping a time-expired one first).
async function createPendingInvite(prisma, { nutritionistId, email }) {
  await prisma.patientInvite.updateMany({
    where: { nutritionistId, email, status: InviteStatus.PENDING, expiresAt: { lt: new Date() } },
    data: { status: InviteStatus.EXPIRED },
  });
  try {
    return await prisma.patientInvite.create({
      data: { nutritionistId, email, expiresAt: new Date(Date.now() + INVITE_TTL_MS) },
    });
  } catch (error) {
    if (error?.code === UNIQUE_VIOLATION_CODE) throwAlreadyPending();
    throw error;
  }
}

/**
 * Nutritionist invites a patient by email. Always a pending invite: the link only exists once the patient accepts.
 */
export async function invitePatient(prisma, { nutritionistId, nutritionistUserId, email }, { emailSender = emailHandler } = {}) {
  const normalizedEmail = normalizeEmail(email);
  const existingUserId = await findUserIdByEmailCaseInsensitive(prisma, normalizedEmail);
  if (existingUserId) await assertInvitableAccount(prisma, { nutritionistId, nutritionistUserId, userId: existingUserId });

  await assertDailyInviteLimitNotReached(prisma, nutritionistId);
  const invite = await createPendingInvite(prisma, { nutritionistId, email: normalizedEmail });
  await deliverInviteEmail(prisma, { userId: existingUserId, nutritionistUserId, email: normalizedEmail, emailSender });
  return { outcome: InviteOutcome.INVITED, invite: withEffectiveStatus(invite) };
}

/**
 * Lists the nutritionist's invites; time-expired pending ones are reported as expired.
 */
export async function listPatientInvites(prisma, { nutritionistId, status }) {
  const where = { nutritionistId, ...buildStatusFilter(status, new Date()) };
  const items = await prisma.patientInvite.findMany({ where, orderBy: { createdAt: 'desc' } });
  return { items: items.map(withEffectiveStatus) };
}

// Loads an invite of this nutritionist or throws 404.
async function requireOwnedInvite(prisma, { nutritionistId, inviteId }) {
  const invite = await prisma.patientInvite.findFirst({ where: { id: inviteId, nutritionistId } });
  if (!invite) {
    throw new NotFoundAppError({
      error: NutritionErrorCode.INVITE_NOT_FOUND,
      messageCode: NutritionMessageCode.INVITE_NOT_FOUND,
      message: 'Invite not found.',
    });
  }
  return invite;
}

// Throws 409 because only pending invites can change.
function throwNotPending() {
  throw new ConflictAppError({
    error: NutritionErrorCode.INVITE_NOT_PENDING,
    messageCode: NutritionMessageCode.INVITE_NOT_PENDING,
    message: 'Only pending invites can be changed.',
  });
}

// Throws 429 while the resend cooldown is active.
function throwResendCooldown(remainingMs) {
  throw new AppError({
    httpStatus: 429,
    error: NutritionErrorCode.INVITE_RESEND_COOLDOWN,
    messageCode: NutritionMessageCode.INVITE_RESEND_COOLDOWN,
    message: 'Please wait before resending this invite.',
    details: { retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / MS_PER_SECOND)) },
  });
}

// Whether the invite status allows a resend (a declined invite is revived by it).
function isResendableStatus(status) {
  return status === InviteStatus.PENDING || status === InviteStatus.DECLINED;
}

// Throws when the invite cannot be resent now.
function assertResendAllowed(invite, now) {
  if (!isResendableStatus(invite.status)) throwNotPending();
  if (invite.sendCount >= MAX_SENDS) {
    throw new ConflictAppError({
      error: NutritionErrorCode.INVITE_MAX_SENDS,
      messageCode: NutritionMessageCode.INVITE_MAX_SENDS,
      message: 'This invite reached its resend limit.',
    });
  }
  const remainingMs = invite.lastSentAt.getTime() + RESEND_COOLDOWN_MS - now.getTime();
  if (remainingMs > 0) throwResendCooldown(remainingMs);
}

// Undoes the resend bookkeeping after a failed delivery.
async function rollbackResendBookkeeping(prisma, { previous, resentAt }) {
  try {
    await prisma.patientInvite.updateMany({
      where: { id: previous.id, status: InviteStatus.PENDING, lastSentAt: resentAt },
      data: {
        status: previous.status,
        expiresAt: previous.expiresAt,
        lastSentAt: previous.lastSentAt,
        sendCount: { decrement: 1 },
      },
    });
  } catch (rollbackError) {
    console.error('Failed to roll back patient invite resend', rollbackError);
  }
}

// Bookkeeping written by a resend (a declined invite goes back to pending).
function resendChanges(invite, now) {
  return {
    ...(invite.status === InviteStatus.DECLINED && { status: InviteStatus.PENDING }),
    expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
    lastSentAt: now,
    sendCount: { increment: 1 },
  };
}

// Throws 409 because the email already has another pending invite from this nutritionist.
function throwAlreadyPending() {
  throw new ConflictAppError({
    error: NutritionErrorCode.INVITE_ALREADY_PENDING,
    messageCode: NutritionMessageCode.INVITE_ALREADY_PENDING,
    message: 'There is already a pending invite for this email.',
  });
}

// Atomically bumps the send bookkeeping; returns false when the guard no longer holds.
async function claimResend(prisma, { invite, now }) {
  try {
    const { count } = await prisma.patientInvite.updateMany({
      where: {
        id: invite.id,
        status: invite.status,
        sendCount: { lt: MAX_SENDS },
        lastSentAt: { lte: new Date(now.getTime() - RESEND_COOLDOWN_MS) },
      },
      data: resendChanges(invite, now),
    });
    return count > 0;
  } catch (error) {
    if (error?.code === UNIQUE_VIOLATION_CODE) throwAlreadyPending();
    throw error;
  }
}

/**
 * Resends a pending invite or revives a declined one (cooldown, max sends); delivery failure rolls back and answers 502.
 */
export async function resendPatientInvite(prisma, { nutritionistId, nutritionistUserId, inviteId }, { emailSender = emailHandler } = {}) {
  const invite = await requireOwnedInvite(prisma, { nutritionistId, inviteId });
  const now = new Date();
  assertResendAllowed(invite, now);

  if (!(await claimResend(prisma, { invite, now }))) {
    const current = await requireOwnedInvite(prisma, { nutritionistId, inviteId });
    assertResendAllowed(current, now);
    throwResendCooldown(RESEND_COOLDOWN_MS);
  }

  const delivered = await deliverResendEmail(prisma, { nutritionistUserId, email: invite.email, emailSender });
  if (!delivered) {
    await rollbackResendBookkeeping(prisma, { previous: invite, resentAt: now });
    throw new AppError({
      httpStatus: 502,
      error: NutritionErrorCode.INVITE_EMAIL_SEND_FAILED,
      messageCode: NutritionMessageCode.INVITE_EMAIL_SEND_FAILED,
      message: 'Could not send the invite email. Try again shortly.',
    });
  }
  return withEffectiveStatus(await prisma.patientInvite.findUnique({ where: { id: invite.id } }));
}

/**
 * Cancels a pending invite (race-safe against acceptance).
 */
export async function revokePatientInvite(prisma, { nutritionistId, inviteId }) {
  const { count } = await prisma.patientInvite.updateMany({
    where: { id: inviteId, nutritionistId, status: InviteStatus.PENDING },
    data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
  });
  if (count === 0) {
    await requireOwnedInvite(prisma, { nutritionistId, inviteId });
    throwNotPending();
  }
  return withEffectiveStatus(await prisma.patientInvite.findUnique({ where: { id: inviteId } }));
}
