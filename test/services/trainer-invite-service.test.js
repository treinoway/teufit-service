import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules that trainer-invite-service depends on.
vi.mock('../../src/db.js', () => {
  return {
    prisma: {
      trainerInvite: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
      },
      user: {
        findUnique: vi.fn(),
      },
      $transaction: vi.fn(async (ops) => {
        if (Array.isArray(ops)) {
          return Promise.all(ops);
        }
        if (typeof ops === 'function') {
          return ops(prisma);
        }
        return ops;
      }),
    },
  };
});

vi.mock('../../src/services/user-service.js', () => {
  return {
    setActiveProfileToTrainer: vi.fn(),
  };
});

vi.mock('../../src/config/email-handler.js', () => {
  return {
    default: {
      sendTrainerInviteEmail: vi.fn(),
    },
  };
});

import { prisma } from '../../src/db.js';
import { setActiveProfileToTrainer } from '../../src/services/user-service.js';
import emailHandler from '../../src/config/email-handler.js';
import { Roles } from '../../src/constants/roles.js';
import { InviteStatus, InviteErrorCode, InviteMessageCode } from '../../src/constants/trainer-invite.js';
import {
  assertCanCreateInvite,
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
} from '../../src/services/trainer-invite-service.js';

const ADMIN_ID = 'admin-1';
const USER_ID = 'user-1';
const INVITE_ID = 'invite-1';

// Frozen at module load: tests compare two separate baseInvite() results with
// toEqual, so reading the clock per call flakes whenever the millisecond ticks
// between the mock setup and the assertion.
const NOW = Date.now();

function baseInvite(overrides = {}) {
  return {
    id: INVITE_ID,
    email: 'invitee@example.com',
    codeHash: 'hash',
    status: InviteStatus.PENDING,
    invitedByUserId: ADMIN_ID,
    userId: null,
    expiresAt: new Date(NOW + 1000 * 60 * 60),
    acceptedAt: null,
    revokedAt: null,
    createdAt: new Date(NOW),
    ...overrides,
  };
}

describe('assertCanCreateInvite', () => {
  it('allows a user with the admin role', () => {
    expect(() => assertCanCreateInvite({ roles: [Roles.ADMIN], email: 'admin@example.com' })).not.toThrow();
  });

  it('throws ForbiddenAppError for a plain user without the admin role', () => {
    expect(() => assertCanCreateInvite({ roles: [Roles.TRAINER], email: 'trainer@example.com' })).toThrow(
      expect.objectContaining({ httpStatus: 403, messageCode: 'auth.forbidden' }),
    );
  });

  it('throws ForbiddenAppError when actingUser is missing/undefined roles', () => {
    expect(() => assertCanCreateInvite({ email: 'nobody@example.com' })).toThrow(
      expect.objectContaining({ httpStatus: 403 }),
    );
  });
});

describe('createInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainerInvite.findFirst.mockResolvedValue(null);
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });
    prisma.trainerInvite.create.mockImplementation(async ({ data }) => baseInvite({ ...data, status: InviteStatus.PENDING }));
    prisma.user.findUnique.mockResolvedValue({ firstName: 'Ada', lastName: 'Lovelace' });
    emailHandler.sendTrainerInviteEmail.mockResolvedValue(undefined);
  });

  it('creates an invite with a properly shaped code and a hashed (not raw) codeHash', async () => {
    const { invite, code } = await createInvite({ actingUserId: ADMIN_ID, email: 'Invitee@Example.com' });

    expect(code).toMatch(/^TF-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{2}$/);

    const createCall = prisma.trainerInvite.create.mock.calls[0][0];
    expect(createCall.data.email).toBe('invitee@example.com');
    expect(createCall.data.codeHash).not.toBe(code);
    expect(createCall.data.codeHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex digest
    expect(createCall.data.invitedByUserId).toBe(ADMIN_ID);
    expect(invite.email).toBe('invitee@example.com');
  });

  it('sets a 7-day expiry from now', async () => {
    const before = Date.now();
    const { invite } = await createInvite({ actingUserId: ADMIN_ID, email: 'invitee@example.com' });
    const after = Date.now();

    const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
    expect(invite.expiresAt.getTime()).toBeGreaterThanOrEqual(before + SEVEN_DAYS_MS);
    expect(invite.expiresAt.getTime()).toBeLessThanOrEqual(after + SEVEN_DAYS_MS);
  });

  it('throws ValidationAppError when email is missing', async () => {
    await expect(createInvite({ actingUserId: ADMIN_ID, email: '' })).rejects.toMatchObject({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
    });
    expect(prisma.trainerInvite.create).not.toHaveBeenCalled();
  });

  it('throws ValidationAppError when email is not a string', async () => {
    await expect(createInvite({ actingUserId: ADMIN_ID, email: undefined })).rejects.toMatchObject({
      httpStatus: 400,
    });
  });

  it('revokes a prior pending invite for the same email before creating the new one', async () => {
    await createInvite({ actingUserId: ADMIN_ID, email: 'invitee@example.com' });

    expect(prisma.trainerInvite.updateMany).toHaveBeenCalledWith({
      where: { email: 'invitee@example.com', status: InviteStatus.PENDING },
      data: { status: InviteStatus.REVOKED, revokedAt: expect.any(Date) },
    });
  });

  it('throws ConflictAppError when an accepted invite already exists for the email', async () => {
    prisma.trainerInvite.findFirst.mockResolvedValue({ id: 'existing-accepted' });

    await expect(createInvite({ actingUserId: ADMIN_ID, email: 'invitee@example.com' })).rejects.toMatchObject({
      httpStatus: 409,
      error: InviteErrorCode.INVITE_ALREADY_ACTIVE_FOR_EMAIL,
      messageCode: InviteMessageCode.ALREADY_ACTIVE_FOR_EMAIL,
    });
    expect(prisma.trainerInvite.create).not.toHaveBeenCalled();
  });

  it('does not throw or fail invite creation when the email send rejects', async () => {
    emailHandler.sendTrainerInviteEmail.mockRejectedValue(new Error('SMTP outage'));

    await expect(createInvite({ actingUserId: ADMIN_ID, email: 'invitee@example.com' })).resolves.toMatchObject({
      code: expect.any(String),
    });
    expect(prisma.trainerInvite.create).toHaveBeenCalled();
  });

  it('calls emailHandler.sendTrainerInviteEmail with the plain code and invite details', async () => {
    const { code } = await createInvite({ actingUserId: ADMIN_ID, email: 'invitee@example.com' });

    expect(emailHandler.sendTrainerInviteEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'invitee@example.com', code, invitedByName: 'Ada Lovelace' }),
    );
  });
});

describe('listInvites', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.trainerInvite.findMany.mockResolvedValue([baseInvite()]);
    prisma.trainerInvite.count.mockResolvedValue(1);
  });

  it('paginates with defaults', async () => {
    const result = await listInvites({});

    expect(result).toEqual({ items: [baseInvite()], total: 1, page: 1, pageSize: 20 });
    const args = prisma.trainerInvite.findMany.mock.calls[0][0];
    expect(args.skip).toBe(0);
    expect(args.take).toBe(20);
    expect(args.where).toEqual({});
  });

  it('clamps pageSize to the configured max', async () => {
    await listInvites({ pageSize: 5000 });
    expect(prisma.trainerInvite.findMany.mock.calls[0][0].take).toBe(100);
  });

  it('filters by status', async () => {
    await listInvites({ status: InviteStatus.PENDING });
    expect(prisma.trainerInvite.findMany.mock.calls[0][0].where).toEqual({ status: InviteStatus.PENDING });
  });

  it('throws ValidationAppError for an invalid status filter', async () => {
    await expect(listInvites({ status: 'bogus' })).rejects.toMatchObject({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
    });
    expect(prisma.trainerInvite.findMany).not.toHaveBeenCalled();
  });

  it('filters by email using a case-insensitive equals match', async () => {
    await listInvites({ email: 'Invitee@Example.com' });
    expect(prisma.trainerInvite.findMany.mock.calls[0][0].where).toEqual({
      email: { equals: 'invitee@example.com', mode: 'insensitive' },
    });
  });
});

describe('revokeInvite', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('revokes a pending invite', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite({ status: InviteStatus.PENDING }));
    prisma.trainerInvite.update.mockResolvedValue(baseInvite({ status: InviteStatus.REVOKED, revokedAt: new Date() }));

    const { invite } = await revokeInvite({ inviteId: INVITE_ID });

    expect(prisma.trainerInvite.update).toHaveBeenCalledWith({
      where: { id: INVITE_ID },
      data: { status: InviteStatus.REVOKED, revokedAt: expect.any(Date) },
    });
    expect(invite.status).toBe(InviteStatus.REVOKED);
  });

  it('throws NotFoundAppError when the invite does not exist', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(null);

    await expect(revokeInvite({ inviteId: INVITE_ID })).rejects.toMatchObject({
      httpStatus: 404,
      error: InviteErrorCode.INVITE_NOT_FOUND,
      messageCode: InviteMessageCode.NOT_FOUND,
    });
    expect(prisma.trainerInvite.update).not.toHaveBeenCalled();
  });

  it('throws ConflictAppError when the invite is not pending', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite({ status: InviteStatus.ACCEPTED }));

    await expect(revokeInvite({ inviteId: INVITE_ID })).rejects.toMatchObject({
      httpStatus: 409,
      messageCode: 'resource.conflict',
    });
    expect(prisma.trainerInvite.update).not.toHaveBeenCalled();
  });
});

describe('redeemInvite', () => {
  const user = { id: USER_ID, email: 'invitee@example.com' };

  beforeEach(() => {
    vi.clearAllMocks();
    setActiveProfileToTrainer.mockResolvedValue({ userId: USER_ID, activeProfile: 'trainer' });
  });

  it('throws ValidationAppError when code is missing', async () => {
    await expect(redeemInvite({ user, code: '' })).rejects.toMatchObject({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
    });
    expect(prisma.trainerInvite.findUnique).not.toHaveBeenCalled();
  });

  it('throws ValidationAppError when code is blank/whitespace', async () => {
    await expect(redeemInvite({ user, code: '   ' })).rejects.toMatchObject({ httpStatus: 400 });
  });

  it('throws NotFoundAppError when no invite matches the code hash', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(null);

    await expect(redeemInvite({ user, code: 'TF-ABCD-EFGH-12' })).rejects.toMatchObject({
      httpStatus: 404,
      error: InviteErrorCode.INVITE_NOT_FOUND,
      messageCode: InviteMessageCode.NOT_FOUND,
    });
  });

  it('throws ForbiddenAppError when the invite is revoked', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(baseInvite({ status: InviteStatus.REVOKED }));

    await expect(redeemInvite({ user, code: 'TF-ABCD-EFGH-12' })).rejects.toMatchObject({
      httpStatus: 403,
      error: InviteErrorCode.INVITE_REVOKED,
      messageCode: InviteMessageCode.REVOKED,
    });
  });

  it('marks the invite expired in the DB and throws ForbiddenAppError when pending but past expiresAt', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(
      baseInvite({ status: InviteStatus.PENDING, expiresAt: new Date(Date.now() - 1000) }),
    );

    await expect(redeemInvite({ user, code: 'TF-ABCD-EFGH-12' })).rejects.toMatchObject({
      httpStatus: 403,
      error: InviteErrorCode.INVITE_EXPIRED,
      messageCode: InviteMessageCode.EXPIRED,
    });

    expect(prisma.trainerInvite.updateMany).toHaveBeenCalledWith({
      where: { id: INVITE_ID, status: InviteStatus.PENDING },
      data: { status: InviteStatus.EXPIRED },
    });
    expect(setActiveProfileToTrainer).not.toHaveBeenCalled();
  });

  it('throws ForbiddenAppError when pending but the invite email does not match the user email', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(
      baseInvite({ status: InviteStatus.PENDING, email: 'someone-else@example.com' }),
    );

    await expect(redeemInvite({ user, code: 'TF-ABCD-EFGH-12' })).rejects.toMatchObject({
      httpStatus: 403,
      error: InviteErrorCode.INVITE_EMAIL_MISMATCH,
      messageCode: InviteMessageCode.EMAIL_MISMATCH,
    });
    expect(prisma.trainerInvite.updateMany).not.toHaveBeenCalled();
  });

  it('throws ConflictAppError when already accepted by a different user', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(
      baseInvite({ status: InviteStatus.ACCEPTED, userId: 'someone-else' }),
    );

    await expect(redeemInvite({ user, code: 'TF-ABCD-EFGH-12' })).rejects.toMatchObject({
      httpStatus: 409,
      error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
      messageCode: InviteMessageCode.ALREADY_ACCEPTED,
    });
    expect(setActiveProfileToTrainer).not.toHaveBeenCalled();
  });

  it('is idempotent when the same user re-redeems an invite they already accepted (200, not an error)', async () => {
    const acceptedInvite = baseInvite({ status: InviteStatus.ACCEPTED, userId: USER_ID });
    prisma.trainerInvite.findUnique.mockResolvedValue(acceptedInvite);

    const { invite, preferences } = await redeemInvite({ user, code: 'TF-ABCD-EFGH-12' });

    expect(invite).toBe(acceptedInvite);
    expect(setActiveProfileToTrainer).toHaveBeenCalledWith(USER_ID);
    expect(preferences).toEqual({ userId: USER_ID, activeProfile: 'trainer' });
    expect(prisma.trainerInvite.updateMany).not.toHaveBeenCalled();
  });

  it('grants the trainer role and returns updated invite + preferences on first successful redemption', async () => {
    const pendingInvite = baseInvite({ status: InviteStatus.PENDING, email: 'invitee@example.com' });
    const acceptedInvite = baseInvite({ status: InviteStatus.ACCEPTED, userId: USER_ID });

    prisma.trainerInvite.findUnique
      .mockResolvedValueOnce(pendingInvite) // initial lookup by codeHash
      .mockResolvedValueOnce(acceptedInvite); // refetch after updateMany
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 1 });

    const { invite, preferences } = await redeemInvite({ user, code: 'TF-ABCD-EFGH-12' });

    expect(prisma.trainerInvite.updateMany).toHaveBeenCalledWith({
      where: { id: INVITE_ID, status: InviteStatus.PENDING },
      data: { status: InviteStatus.ACCEPTED, userId: USER_ID, acceptedAt: expect.any(Date) },
    });
    expect(setActiveProfileToTrainer).toHaveBeenCalledWith(USER_ID);
    expect(invite.status).toBe(InviteStatus.ACCEPTED);
    expect(preferences).toEqual({ userId: USER_ID, activeProfile: 'trainer' });
  });

  it('rejects with ConflictAppError (409) — not an idempotent success — when it loses the concurrent-redeem race', async () => {
    const pendingInvite = baseInvite({ status: InviteStatus.PENDING, email: 'invitee@example.com' });
    prisma.trainerInvite.findUnique.mockResolvedValue(pendingInvite);
    // Simulates another concurrent request winning the race: this request's
    // conditional updateMany matches zero rows because status is no longer 'pending'.
    prisma.trainerInvite.updateMany.mockResolvedValue({ count: 0 });

    await expect(redeemInvite({ user, code: 'TF-ABCD-EFGH-12' })).rejects.toMatchObject({
      httpStatus: 409,
      error: InviteErrorCode.INVITE_ALREADY_ACCEPTED,
      messageCode: InviteMessageCode.ALREADY_ACCEPTED,
    });
    expect(setActiveProfileToTrainer).not.toHaveBeenCalled();
  });

  it('normalizes the code (prefix/dashes/case) so equivalent inputs hash identically', async () => {
    prisma.trainerInvite.findUnique.mockResolvedValue(null);

    await redeemInvite({ user, code: 'TF-ABCD-EFGH-12' }).catch(() => {});
    const hashFromCanonical = prisma.trainerInvite.findUnique.mock.calls[0][0].where.codeHash;

    vi.clearAllMocks();
    prisma.trainerInvite.findUnique.mockResolvedValue(null);
    await redeemInvite({ user, code: 'abcd-efgh-12' }).catch(() => {});
    const hashFromLowercaseNoPrefix = prisma.trainerInvite.findUnique.mock.calls[0][0].where.codeHash;

    vi.clearAllMocks();
    prisma.trainerInvite.findUnique.mockResolvedValue(null);
    await redeemInvite({ user, code: 'ABCDEFGH12' }).catch(() => {});
    const hashFromNoDashesNoPrefix = prisma.trainerInvite.findUnique.mock.calls[0][0].where.codeHash;

    expect(hashFromCanonical).toBe(hashFromLowercaseNoPrefix);
    expect(hashFromCanonical).toBe(hashFromNoDashesNoPrefix);
  });
});
