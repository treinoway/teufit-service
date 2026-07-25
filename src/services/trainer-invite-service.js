import crypto from 'node:crypto';
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
import { ValidationAppError, ForbiddenAppError, NotFoundAppError, ConflictAppError } from '../errors/app-error.js';
import { setActiveProfileToTrainer } from './user-service.js';
import emailHandler from '../config/email-handler.js';
import { hasBetaAccess } from '../helpers/beta-access.js';

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

  // Fire-and-forget delivery — an email outage must never fail invite creation.
  try {
    const inviter = await prisma.user.findUnique({
      where: { id: actingUserId },
      select: { firstName: true, lastName: true },
    });
    const invitedByName = `${inviter?.firstName ?? ''} ${inviter?.lastName ?? ''}`.trim() || null;
    const inviteUrl = `${config.web.baseUrl}/invite?code=${encodeURIComponent(rawCode)}`;
    await emailHandler.sendTrainerInviteEmail({ to: normalizedEmail, code: rawCode, inviteUrl, invitedByName });
  } catch (emailError) {
    console.error('Failed to send trainer invite email', emailError);
  }

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
    where.email = { equals: normalizeEmail(email), mode: 'insensitive' };
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
    throw new ConflictAppError({
      message: 'Only pending invites can be revoked.',
    });
  }

  const updated = await prisma.trainerInvite.update({
    where: { id: inviteId },
    data: { status: InviteStatus.REVOKED, revokedAt: new Date() },
  });

  return { invite: updated };
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
  const invite = await prisma.trainerInvite.findUnique({ where: { codeHash } });

  if (!invite) {
    throw new NotFoundAppError({
      error: InviteErrorCode.INVITE_NOT_FOUND,
      messageCode: InviteMessageCode.NOT_FOUND,
      message: 'Invite not found.',
    });
  }

  if (invite.status === InviteStatus.REVOKED) {
    throw new ForbiddenAppError({
      error: InviteErrorCode.INVITE_REVOKED,
      messageCode: InviteMessageCode.REVOKED,
      message: 'This invite has been revoked.',
    });
  }

  if (invite.status === InviteStatus.ACCEPTED) {
    if (invite.userId === user.id) {
      // Idempotent reuse: setActiveProfileToTrainer is safe to re-run (role-add
      // no-ops when already present) so a stale client retry still succeeds.
      const preferences = await setActiveProfileToTrainer(user.id);
      return { invite, preferences };
    }
    throw new ConflictAppError({
      error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
      messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      message: 'This invite has already been redeemed.',
    });
  }

  // status === pending beyond this point.
  if (invite.expiresAt < new Date()) {
    await prisma.trainerInvite.updateMany({
      where: { id: invite.id, status: InviteStatus.PENDING },
      data: { status: InviteStatus.EXPIRED },
    });
    throw new ForbiddenAppError({
      error: InviteErrorCode.INVITE_EXPIRED,
      messageCode: InviteMessageCode.EXPIRED,
      message: 'This invite has expired.',
    });
  }

  if (normalizeEmail(invite.email) !== normalizeEmail(user.email)) {
    throw new ForbiddenAppError({
      error: InviteErrorCode.INVITE_EMAIL_MISMATCH,
      messageCode: InviteMessageCode.EMAIL_MISMATCH,
      message: 'This invite is bound to a different email address.',
    });
  }

  const { count } = await prisma.trainerInvite.updateMany({
    where: { id: invite.id, status: InviteStatus.PENDING },
    data: { status: InviteStatus.ACCEPTED, userId: user.id, acceptedAt: new Date() },
  });

  if (count === 0) {
    throw new ConflictAppError({
      error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
      messageCode: InviteMessageCode.ALREADY_ACCEPTED,
      message: 'This invite has already been redeemed.',
    });
  }

  const preferences = await setActiveProfileToTrainer(user.id);
  const updatedInvite = await prisma.trainerInvite.findUnique({ where: { id: invite.id } });

  return { invite: updatedInvite, preferences };
}

export { hasBetaAccess };
