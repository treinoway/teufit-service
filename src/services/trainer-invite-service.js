import crypto from 'node:crypto';
import { UserStatus } from '../constants/user-status.js';
import { prisma } from '../db.js';
import config from '../../config/index.js';
import { Roles } from '../constants/roles.js';
import {
  InviteStatus,
  InviteErrorCode,
  InviteMessageCode,
  INVITE_TTL_MS,
  INVITE_CODE_ALPHABET,
  INVITE_LIST_PAGE_SIZE_DEFAULT,
  INVITE_LIST_PAGE_SIZE_MAX,
  inviteStatusValues,
} from '../constants/trainer-invite.js';
import { AppError, ValidationAppError, ForbiddenAppError, NotFoundAppError, ConflictAppError } from '../errors/app-error.js';
import { setActiveProfileToTrainer } from './user-service.js';
import { markEmailVerifiedFromInboxProof } from './email-verification-service.js';
import emailHandler from '../config/email-handler.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_SUBSCRIPTION_STATUSES } from '../constants/platform-plan.js';
import { reactivateStudentsUpToCap } from './platform-plan-service.js';
import { hasBetaAccess } from '../helpers/beta-access.js';
import { findUserIdByEmailCaseInsensitive } from '../helpers/email-lookup.js';
import { hashPassword } from '../helpers/password.js';
import { EMAIL_PROVIDER } from '../constants/email-verification.js';

function normalizeEmail(email) {
  if (typeof email !== 'string') return '';
  return email.trim().toLowerCase();
}

/**
 * Generates a `TF-XXXX-XXXX-XX` code: 10 characters from a 32-symbol
 * Crockford base32 alphabet ≈ 50 bits of entropy. crypto.randomInt is used
 * (rather than slicing randomBytes) since 32 divides evenly, avoiding modulo bias.
 */
function generateInviteCode() {
  const chars = Array.from(
    { length: 10 },
    () => INVITE_CODE_ALPHABET[crypto.randomInt(0, INVITE_CODE_ALPHABET.length)],
  ).join('');
  return `TF-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 10)}`;
}

/**
 * Accepts the code with or without the `TF-` prefix/dashes, case-insensitive,
 * so manual entry is forgiving. The normalized core is what gets hashed —
 * generation and redemption must agree on this shape.
 */
function normalizeInviteCode(code) {
  if (typeof code !== 'string') return '';
  return code.trim().toUpperCase().replace(/^TF-?/, '').replace(/[^A-Z0-9]/g, '');
}

function hashInviteCode(code) {
  return crypto.createHash('sha256').update(normalizeInviteCode(code)).digest('hex');
}

function clampPage(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : 1;
  return n < 1 ? 1 : n;
}

function clampPageSize(value) {
  const n = Number.isFinite(value) ? Math.floor(value) : INVITE_LIST_PAGE_SIZE_DEFAULT;
  if (n < 1) return 1;
  if (n > INVITE_LIST_PAGE_SIZE_MAX) return INVITE_LIST_PAGE_SIZE_MAX;
  return n;
}

/**
 * Authorization seam for invite creation.
 * Today: admin-only (role-based). Future trainer-sent invites plug in here as
 * an additional `||` branch with a quota check — no other call site needs to
 * change.
 */
export function assertCanCreateInvite(actingUser) {
  const roles = Array.isArray(actingUser?.roles) ? actingUser.roles : [];
  const isAllowed = roles.includes(Roles.ADMIN);
  // Future: || (roles.includes(Roles.TRAINER) && trainerInviteQuotaOk(actingUser))
  if (!isAllowed) {
    throw new ForbiddenAppError({
      message: 'Only admins can send trainer invites.',
    });
  }
}

// Finds the live account owning this email (case-insensitive), if any.
function findExistingAccountByEmail(email) {
  return prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' }, deletedAt: null },
    select: { id: true, firstName: true, email: true },
  });
}

// Sends the invite email matching whether the invitee already has an account; never throws.
async function sendInviteEmailSafely({ actingUserId, normalizedEmail, rawCode }) {
  try {
    const inviteUrl = `${config.web.baseUrl}/invite?code=${encodeURIComponent(rawCode)}`;
    const existingAccount = await findExistingAccountByEmail(normalizedEmail);
    if (existingAccount?.email?.toLowerCase() === normalizedEmail) {
      await emailHandler.sendExistingAccountTrainerInviteEmail({
        to: normalizedEmail,
        code: rawCode,
        inviteUrl,
        firstName: existingAccount.firstName,
      });
      return;
    }
    const inviter = await prisma.user.findUnique({
      where: { id: actingUserId },
      select: { firstName: true, lastName: true },
    });
    const invitedByName = `${inviter?.firstName ?? ''} ${inviter?.lastName ?? ''}`.trim() || null;
    await emailHandler.sendTrainerInviteEmail({ to: normalizedEmail, code: rawCode, inviteUrl, invitedByName });
  } catch (emailError) {
    console.error('Failed to send trainer invite email', emailError);
  }
}

/**
 * Creates a trainer invite for `email`, superseding any prior pending invite
 * for the same email. Returns the plain (unhashed) code — only ever returned
 * here and emailed; it is not retrievable again afterwards.
 */
export async function createInvite({ actingUserId, email }) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new ValidationAppError({
      message: 'A valid email is required.',
      details: [
        { field: 'email', validations: ['required'], messageCode: 'validation.email.required', message: 'Email is required.' },
      ],
    });
  }

  const rawCode = generateInviteCode();
  const codeHash = hashInviteCode(rawCode);
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  const invite = await prisma.$transaction(async (tx) => {
    const activeExisting = await tx.trainerInvite.findFirst({
      where: { email: normalizedEmail, status: InviteStatus.ACCEPTED },
      select: { id: true },
    });
    if (activeExisting) {
      throw new ConflictAppError({
        error: InviteErrorCode.INVITE_ALREADY_ACTIVE_FOR_EMAIL,
        messageCode: InviteMessageCode.ALREADY_ACTIVE_FOR_EMAIL,
        message: 'This email already has an active trainer invite.',
      });
    }

    // Superseding: any prior pending invite for this email becomes revoked so
    // only the newest code is redeemable.
    await tx.trainerInvite.updateMany({
      where: { email: normalizedEmail, status: InviteStatus.PENDING },
      data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
    });

    return tx.trainerInvite.create({
      data: {
        email: normalizedEmail,
        codeHash,
        invitedByUserId: actingUserId,
        expiresAt,
      },
    });
  });

  await sendInviteEmailSafely({ actingUserId, normalizedEmail, rawCode });

  return { invite, code: rawCode };
}

export async function listInvites({ status, email, page, pageSize } = {}) {
  const where = {};

  if (status !== undefined) {
    if (!inviteStatusValues.includes(status)) {
      throw new ValidationAppError({
        message: 'Invalid status filter.',
        details: [
          { field: 'status', validations: ['enum'], messageCode: 'validation.status.enum', message: 'Invalid status filter.' },
        ],
      });
    }
    where.status = status;
  }

  if (email) {
    // TrainerInvite.email is always written lowercase (see normalizeEmail in
    // createInvite — it is the only write path), so an exact match on the
    // normalized value is sufficient and correct: no ILIKE/wildcard risk,
    // and it can use the plain unique/email btree index.
    where.email = normalizeEmail(email);
  }

  const currentPage = clampPage(page);
  const currentPageSize = clampPageSize(pageSize);

  const [items, total] = await Promise.all([
    prisma.trainerInvite.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: (currentPage - 1) * currentPageSize,
      take: currentPageSize,
    }),
    prisma.trainerInvite.count({ where }),
  ]);

  return { items, total, page: currentPage, pageSize: currentPageSize };
}

function createInviteNotFoundError() {
  return new NotFoundAppError({
    error: InviteErrorCode.INVITE_NOT_FOUND,
    messageCode: InviteMessageCode.NOT_FOUND,
    message: 'Invite not found.',
  });
}

function createInviteRevokedError() {
  return new ForbiddenAppError({
    error: InviteErrorCode.INVITE_REVOKED,
    messageCode: InviteMessageCode.REVOKED,
    message: 'This invite has been revoked.',
  });
}

function createInviteExpiredError() {
  return new ForbiddenAppError({
    error: InviteErrorCode.INVITE_EXPIRED,
    messageCode: InviteMessageCode.EXPIRED,
    message: 'This invite has expired.',
  });
}

function createAlreadyAcceptedError() {
  return new ConflictAppError({
    error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
    messageCode: InviteMessageCode.ALREADY_ACCEPTED,
    message: 'This invite has already been redeemed.',
  });
}

function createOnlyPendingRevocableError() {
  return new ConflictAppError({
    message: 'Only pending invites can be revoked.',
  });
}

/**
 * After a conditional claim updated 0 rows, re-reads the invite and returns
 * the precise error for its current state. Pending-but-past-expiry (the
 * invite expired between the load and the claim) and already-expired rows
 * both map to expired. The caller decides whether to flip a stale pending row
 * (it cannot happen inside a transaction that is about to roll back).
 */
async function resolveLostClaimError(client, inviteId) {
  const current = await client.trainerInvite.findUnique({
    where: { id: inviteId },
    select: { status: true, expiresAt: true },
  });
  if (!current) return createInviteNotFoundError();
  if (current.status === InviteStatus.REVOKED) return createInviteRevokedError();
  if (current.status === InviteStatus.ACCEPTED) return createAlreadyAcceptedError();
  if (current.status === InviteStatus.EXPIRED || current.expiresAt <= new Date()) {
    return createInviteExpiredError();
  }
  return createAlreadyAcceptedError();
}

function expirePendingInvite(inviteId) {
  return prisma.trainerInvite.updateMany({
    where: { id: inviteId, status: InviteStatus.PENDING },
    data: { status: InviteStatus.EXPIRED },
  });
}

export async function revokeInvite({ inviteId }) {
  const invite = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });
  if (!invite) {
    throw new NotFoundAppError({
      error: InviteErrorCode.INVITE_NOT_FOUND,
      messageCode: InviteMessageCode.NOT_FOUND,
      message: 'Invite not found.',
    });
  }

  if (invite.status !== InviteStatus.PENDING) {
    throw createOnlyPendingRevocableError();
  }

  // Conditional claim: a signup/redeem that committed since the read above
  // must not be overwritten with revoked.
  const { count } = await prisma.trainerInvite.updateMany({
    where: { id: inviteId, status: InviteStatus.PENDING },
    data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
  });
  if (count === 0) throw createOnlyPendingRevocableError();

  const updated = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });

  return { invite: updated };
}

/**
 * Loads an invite by its plaintext code and asserts it is in a state that
 * can be acted upon. Shared by redeemInvite (mutating) and getInvitePreview
 * (read-only) so the notFound/revoked/alreadyAccepted/expired branches —
 * status, error, messageCode, message — cannot drift between the two call
 * sites.
 *
 * Two seams let a caller layer its own semantics on top without duplicating
 * the branching:
 * - `isAlreadyAcceptedException(invite)`: when the invite is already
 *   accepted, return true to skip the generic alreadyAccepted throw (used by
 *   redeemInvite for its idempotent same-user reuse). Omitted → always throws.
 * - `onExpiredPending(invite)`: side effect run when a pending invite is
 *   found expired, immediately before the expired error is thrown (used by
 *   redeemInvite to flip the row to EXPIRED). Omitted → read-only.
 *
 * @param {string} code - plaintext invite code (as typed/pasted by the user)
 * @param {object} [options]
 * @param {object} [options.include] - forwarded to the underlying
 *   `trainerInvite.findUnique` (e.g. to include the inviter relation)
 * @param {(invite: object) => boolean} [options.isAlreadyAcceptedException]
 * @param {(invite: object) => Promise<void>} [options.onExpiredPending]
 */
async function loadInviteAndAssertActionable(
  code,
  { include, isAlreadyAcceptedException, onExpiredPending } = {},
) {
  if (typeof code !== 'string' || !code.trim()) {
    throw new ValidationAppError({
      message: 'Invite code is required.',
      details: [
        { field: 'code', validations: ['required'], messageCode: 'validation.code.required', message: 'Invite code is required.' },
      ],
    });
  }

  const codeHash = hashInviteCode(code);
  // Generic 404 on miss — do not reveal whether a code "almost" matched.
  const invite = await prisma.trainerInvite.findUnique({
    where: { codeHash },
    ...(include ? { include } : {}),
  });

  if (!invite) {
    throw createInviteNotFoundError();
  }

  if (invite.status === InviteStatus.REVOKED) {
    throw createInviteRevokedError();
  }

  if (invite.status === InviteStatus.ACCEPTED) {
    if (isAlreadyAcceptedException?.(invite)) {
      return invite;
    }
    throw createAlreadyAcceptedError();
  }

  // Only PENDING (possibly stale) invites reach this point: REVOKED and
  // ACCEPTED were already handled above. A row whose *stored* status is
  // already EXPIRED also falls through here — the expiresAt check below
  // still throws EXPIRED for it, it just skips onExpiredPending since the
  // row is already in that state.
  if (invite.expiresAt < new Date()) {
    if (onExpiredPending) {
      await onExpiredPending(invite);
    }
    throw createInviteExpiredError();
  }

  return invite;
}

// Looks up the id of the trainer profile owned by the user.
async function findTrainerIdByUserId(db, userId) {
  const trainer = await db.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw new NotFoundAppError({
      error: 'TRAINER_NOT_FOUND',
      messageCode: 'trainer.notFound',
      message: 'Trainer profile not found.',
    });
  }
  return trainer.id;
}

// Whether an existing subscription row may be replaced by the invite BETA grant (never a paying one).
function canReceiveBeta(subscription) {
  if (!subscription) return true;
  return subscription.tier === PLATFORM_PLAN_TIERS.FREE && !subscription.asaasSubscriptionId;
}

// Locks the trainer's subscription row so a concurrent checkout cannot interleave with the BETA grant.
async function lockSubscriptionRow(tx, trainerId) {
  await tx.$queryRaw`SELECT id FROM platform_subscriptions WHERE trainer_id = ${trainerId}::uuid FOR UPDATE`;
}

// Writes BETA unless the row already pays through Asaas; returns whether it was written.
async function writeBetaGrant(tx, trainerId) {
  await lockSubscriptionRow(tx, trainerId);
  const subscription = await tx.platformSubscription.findUnique({ where: { trainerId } });
  if (!canReceiveBeta(subscription)) return false;

  const grant = { tier: PLATFORM_PLAN_TIERS.BETA, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE };
  await tx.platformSubscription.upsert({
    where: { trainerId },
    create: { trainerId, ...grant },
    update: { ...grant, pastDueSince: null },
  });
  return true;
}

// Grants BETA to the invited user's trainer unless they already pay through Asaas, then unblocks students.
async function grantBetaToRedeemer(userId) {
  const trainerId = await findTrainerIdByUserId(prisma, userId);
  const granted = await prisma.$transaction((tx) => writeBetaGrant(tx, trainerId));
  if (granted) await reactivateStudentsUpToCap(prisma, trainerId);
}

/**
 * Redeems an invite code for the given authenticated user, granting the
 * trainer role via setActiveProfileToTrainer on success.
 *
 * Race safety: the pending → accepted transition is a conditional
 * `updateMany` (`where: { status: 'pending' }`). If two requests race to
 * redeem the same still-pending invite, only one updates a row (count 1);
 * the loser sees count 0 and is rejected with a 409 — it does not re-read to
 * decide whether it "actually" was the same user, matching the documented
 * edge-case contract exactly.
 */
export async function redeemInvite({ user, code }) {
  const invite = await loadInviteAndAssertActionable(code, {
    isAlreadyAcceptedException: (candidate) => candidate.userId === user.id,
    onExpiredPending: (candidate) => expirePendingInvite(candidate.id),
  });

  if (invite.status === InviteStatus.ACCEPTED) {
    // Idempotent reuse (matched isAlreadyAcceptedException above):
    // setActiveProfileToTrainer is safe to re-run (role-add no-ops when
    // already present) so a stale client retry still succeeds.
    const preferences = await setActiveProfileToTrainer(user.id);
    await grantBetaToRedeemer(user.id);
    return { invite, preferences };
  }

  // status === pending, not expired, beyond this point.
  if (normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
    throw new ForbiddenAppError({
      error: InviteErrorCode.INVITE_EMAIL_MISMATCH,
      messageCode: InviteMessageCode.EMAIL_MISMATCH,
      message: 'This invite is bound to a different email address.',
    });
  }

  const { count } = await prisma.trainerInvite.updateMany({
    where: { id: invite.id, status: InviteStatus.PENDING, expiresAt: { gt: new Date() } },
    data: { status: InviteStatus.ACCEPTED, userId: user.id, acceptedAt: new Date() },
  });

  if (count === 0) {
    const lostClaimError = await resolveLostClaimError(prisma, invite.id);
    if (lostClaimError.messageCode === InviteMessageCode.EXPIRED) await expirePendingInvite(invite.id);
    throw lostClaimError;
  }

  // The TF- code is email-bound and was delivered to that inbox: redeeming it
  // proves ownership. Never throws, response unchanged.
  await markEmailVerifiedFromInboxProof(prisma, user);

  const preferences = await setActiveProfileToTrainer(user.id);
  await grantBetaToRedeemer(user.id);
  const updatedInvite = await prisma.trainerInvite.findUnique({ where: { id: invite.id } });

  return { invite: updatedInvite, preferences };
}

function buildInviterName(inviter) {
  const name = `${inviter?.firstName ?? ''} ${inviter?.lastName ?? ''}`.trim();
  return name || null;
}

/**
 * Public, unauthenticated invite preview — read-only by construction (the
 * shared loader is called with no `onExpiredPending`/mutating hooks). Used
 * by the web signup flow to validate a code, show the inviter, and prefill +
 * lock the bound email before the account exists.
 *
 * Trade-off (accepted): the invite code is effectively a bearer token bound
 * to one email. Whoever holds a valid code can see the email it targets via
 * this endpoint. The code itself is only ever delivered through the invite
 * email, so this does not widen exposure beyond "holds the link".
 */
export async function getInvitePreview({ code }) {
  const invite = await loadInviteAndAssertActionable(code, {
    include: { invitedBy: { select: { firstName: true, lastName: true } } },
  });

  // Case-insensitive match: legacy users may have mixed-case email saved
  // (same convention as findUserByEmailInsensitive in src/helpers/auth.js).
  const existingUserId = await findUserIdByEmailCaseInsensitive(prisma, invite.email);

  return {
    email: invite.email,
    invitedByName: buildInviterName(invite.invitedBy),
    expiresAt: invite.expiresAt,
    accountExists: Boolean(existingUserId),
  };
}

const UNIQUE_VIOLATION_CODE = 'P2002';
const NEW_USER_STATUS = UserStatus.ACTIVE;

function createAccountExistsError() {
  return new ConflictAppError({
    error: InviteErrorCode.INVITE_ACCOUNT_EXISTS,
    messageCode: InviteMessageCode.ACCOUNT_EXISTS,
    message: 'An account already exists for this email. Sign in and redeem the invite.',
  });
}

async function createTrainerAccountFromInvite(invite, passwordHash) {
  const normalizedEmail = normalizeEmail(invite.email);
  const afterCommitTasks = [];
  const created = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: { email: normalizedEmail, passwordHash, roles: [Roles.TRAINER], status: NEW_USER_STATUS },
    });
    await tx.account.create({
      data: { userId: user.id, provider: EMAIL_PROVIDER, providerId: normalizedEmail, verifiedAt: new Date() },
    });

    // Race-safe claim, same conditional update as redeemInvite.
    const { count } = await tx.trainerInvite.updateMany({
      where: { id: invite.id, status: InviteStatus.PENDING, expiresAt: { gt: new Date() } },
      data: { status: InviteStatus.ACCEPTED, userId: user.id, acceptedAt: new Date() },
    });
    if (count === 0) throw await resolveLostClaimError(tx, invite.id);

    // Same grant as /become-trainer and redeemInvite, on the tx client: the
    // global client cannot see the uncommitted user.
    const preferences = await setActiveProfileToTrainer(user.id, {
      tx,
      onCommit: (task) => afterCommitTasks.push(task),
    });
    const trainerId = await findTrainerIdByUserId(tx, user.id);
    await tx.platformSubscription.create({
      data: { trainerId, tier: PLATFORM_PLAN_TIERS.BETA, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE },
    });
    // The signup code flow is superseded by the invite proof for this inbox.
    await tx.pendingSignup.deleteMany({ where: { email: normalizedEmail } });
    return { user, preferences };
  });
  afterCommitTasks.forEach((task) => task());
  return created;
}

/**
 * Lost the user-create race: either a concurrent submit of the same code
 * (the winner already accepted the invite -> alreadyAccepted) or an account
 * created for the email by another path (-> accountExists).
 */
async function resolveUniqueViolation(invite) {
  const current = await prisma.trainerInvite.findUnique({ where: { id: invite.id }, select: { status: true } });
  if (current && current.status !== InviteStatus.PENDING) return createAlreadyAcceptedError();
  return createAccountExistsError();
}

/**
 * Public signup through a trainer invite: the TF- code proves inbox ownership
 * (email-bound, single-use, expiring), so the account is created with a
 * verified email and no 6-digit signup code.
 *
 * Invite semantics = redeemInvite's (an expired pending invite is flipped to
 * `expired` before the error), because this call is a mutating redemption.
 * The invite is validated, and the email checked for an existing account
 * (including soft-deleted users), BEFORE the scrypt hash so rejected calls
 * stay cheap. User + email Account + invite claim + Trainer row + preferences
 * + PendingSignup cleanup commit atomically: any failure leaves nothing behind
 * and the invite stays pending, so the user can retry.
 *
 * Callers must run acceptPendingInvitesForUser afterwards (never throws).
 *
 * @returns {Promise<{ user: object, preferences: object }>}
 */
export async function signupWithInvite({ code, password }) {
  const invite = await loadInviteAndAssertActionable(code, {
    onExpiredPending: (candidate) => expirePendingInvite(candidate.id),
  });

  if (await findUserIdByEmailCaseInsensitive(prisma, invite.email)) throw createAccountExistsError();

  const passwordHash = hashPassword(password);
  try {
    return await createTrainerAccountFromInvite(invite, passwordHash);
  } catch (error) {
    if (error instanceof AppError) {
      // The claim ran inside the rolled-back transaction, so flip a stale
      // pending row here, outside it (same side effect as redeemInvite).
      if (error.messageCode === InviteMessageCode.EXPIRED) await expirePendingInvite(invite.id);
      throw error;
    }
    if (error?.code !== UNIQUE_VIOLATION_CODE) throw error;
    throw await resolveUniqueViolation(invite);
  }
}

export { hasBetaAccess };
