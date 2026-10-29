import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';
import { Roles } from '../../src/constants/roles.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn(),
  reactivateStudentsUpToCap: vi.fn(),
}));

import { listTrainers } from '../../src/services/admin-trainer-service.js';

const ACCOUNT_TYPE = Object.freeze({ TRAINER: 'trainer', SIGNUP: 'signup' });
const INVITE_FILTER = Object.freeze({ NONE: 'none', PENDING: 'pending', ACCEPTED: 'accepted' });
const DEFAULT_PAGE_SIZE = 20;
const SENT_AT = new Date('2026-10-01T12:00:00.000Z');

const mockPrisma = {
  user: { findMany: vi.fn(), count: vi.fn() },
  trainer: { findMany: vi.fn(), count: vi.fn() },
  trainerInvite: { findMany: vi.fn() },
  trainerStudent: { groupBy: vi.fn() },
};

// Builds a user row (optionally with a trainer profile) as the includeSignups list query returns it.
function makeUserRow(id, { email = `${id}@example.com`, trainer = null, ...rest } = {}) {
  return {
    id,
    firstName: 'Ana',
    lastName: 'Lima',
    email,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    trainer,
    ...rest,
  };
}

// Builds a trainer profile with a subscription for a user row.
function makeTrainerProfile(id, tier = PLATFORM_PLAN_TIERS.PRO) {
  return { id, platformSubscription: { tier, status: 'ACTIVE', asaasSubscriptionId: null } };
}

// Builds a TrainerInvite row as the invite lookup returns it.
function makeInvite({ email, userId = null, status = InviteStatus.PENDING, createdAt = SENT_AT }) {
  return { email, userId, status, createdAt, expiresAt: new Date('2099-01-01T00:00:00.000Z') };
}

// Stubs the user-based list (rows + total) used when signups are included.
function stubUserList(rows, total = rows.length) {
  mockPrisma.user.findMany.mockResolvedValue(rows);
  mockPrisma.user.count.mockResolvedValue(total);
}

describe('listTrainers with includeSignups', () => {
  beforeEach(() => {
    mockPrisma.user.findMany.mockResolvedValue([]);
    mockPrisma.user.count.mockResolvedValue(0);
    mockPrisma.trainer.findMany.mockResolvedValue([]);
    mockPrisma.trainer.count.mockResolvedValue(0);
    mockPrisma.trainerInvite.findMany.mockResolvedValue([]);
    mockPrisma.trainerStudent.groupBy.mockResolvedValue([]);
  });

  describe('signup items', () => {
    it('should map a user without a trainer profile to a signup item with null plan fields', async () => {
      stubUserList([makeUserRow('signup-1', { firstName: 'Bia', lastName: 'Souza', email: 'bia@example.com' })]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0]).toEqual({
        accountType: ACCOUNT_TYPE.SIGNUP,
        trainerId: null,
        userId: 'signup-1',
        firstName: 'Bia',
        lastName: 'Souza',
        email: 'bia@example.com',
        tier: null,
        subscriptionStatus: null,
        hasAsaasSubscription: false,
        activeStudents: null,
        studentCap: null,
        inviteStatus: INVITE_FILTER.NONE,
        inviteSentAt: null,
      });
    });

    it('should map a user with a trainer profile to a trainer item with plan fields', async () => {
      stubUserList([makeUserRow('user-t1', { trainer: makeTrainerProfile('trainer-1', PLATFORM_PLAN_TIERS.PRO) })]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0]).toMatchObject({
        accountType: ACCOUNT_TYPE.TRAINER,
        trainerId: 'trainer-1',
        userId: 'user-t1',
        tier: PLATFORM_PLAN_TIERS.PRO,
        subscriptionStatus: 'ACTIVE',
      });
    });

    it('should only count active students for trainer items, not signups', async () => {
      stubUserList([
        makeUserRow('user-t1', { trainer: makeTrainerProfile('trainer-1') }),
        makeUserRow('signup-1'),
      ]);
      mockPrisma.trainerStudent.groupBy.mockResolvedValue([{ trainerId: 'trainer-1', _count: { _all: 3 } }]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items.map((item) => item.activeStudents)).toEqual([3, null]);
    });
  });

  describe('query', () => {
    it('should paginate the user query and report the user total', async () => {
      stubUserList([makeUserRow('signup-1')], 41);

      const result = await listTrainers(mockPrisma, { includeSignups: true, page: 3, pageSize: 10 });

      expect(mockPrisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 10 }));
      expect(result).toMatchObject({ total: 41, page: 3, pageSize: 10 });
    });

    it('should order by createdAt descending', async () => {
      await listTrainers(mockPrisma, { includeSignups: true });

      const { orderBy } = mockPrisma.user.findMany.mock.calls[0][0];
      expect(JSON.stringify(orderBy)).toContain('"createdAt":"desc"');
    });

    it('should exclude deleted users from the list query', async () => {
      await listTrainers(mockPrisma, { includeSignups: true });

      const { where } = mockPrisma.user.findMany.mock.calls[0][0];
      expect(JSON.stringify(where)).toContain('"deletedAt":null');
    });

    it('should exclude trainer, admin and nutritionist roles from the signup branch', async () => {
      await listTrainers(mockPrisma, { includeSignups: true });

      const serializedWhere = JSON.stringify(mockPrisma.user.findMany.mock.calls[0][0].where);
      expect([Roles.TRAINER, Roles.ADMIN, Roles.NUTRITIONIST].every((role) => serializedWhere.includes(role))).toBe(true);
    });

    it('should apply search tokens case-insensitively to the user query', async () => {
      await listTrainers(mockPrisma, { includeSignups: true, search: 'Zelda quasar' });

      const serializedWhere = JSON.stringify(mockPrisma.user.findMany.mock.calls[0][0].where);
      expect(serializedWhere).toContain('Zelda');
      expect(serializedWhere).toContain('quasar');
      expect(serializedWhere).toContain('"mode":"insensitive"');
    });

    it('should apply the same where to the count as to the list', async () => {
      await listTrainers(mockPrisma, { includeSignups: true, search: 'zelda' });

      expect(mockPrisma.user.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: mockPrisma.user.findMany.mock.calls[0][0].where })
      );
    });
  });

  describe('invite status', () => {
    it('should report accepted when an accepted invite was redeemed by the user', async () => {
      stubUserList([makeUserRow('user-t1', { trainer: makeTrainerProfile('trainer-1') })]);
      mockPrisma.trainerInvite.findMany.mockResolvedValue([
        makeInvite({ email: 'user-t1@example.com', userId: 'user-t1', status: InviteStatus.ACCEPTED }),
      ]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0]).toMatchObject({ inviteStatus: INVITE_FILTER.ACCEPTED, inviteSentAt: SENT_AT.toISOString() });
    });

    it('should report pending when a pending invite targets the email case-insensitively', async () => {
      stubUserList([makeUserRow('signup-1', { email: 'Mixed.Case@Example.com' })]);
      mockPrisma.trainerInvite.findMany.mockResolvedValue([makeInvite({ email: 'mixed.case@example.com' })]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0]).toMatchObject({ inviteStatus: INVITE_FILTER.PENDING, inviteSentAt: SENT_AT.toISOString() });
    });

    it('should prefer accepted over a newer pending invite for the same user', async () => {
      stubUserList([makeUserRow('user-t1', { trainer: makeTrainerProfile('trainer-1') })]);
      mockPrisma.trainerInvite.findMany.mockResolvedValue([
        makeInvite({ email: 'user-t1@example.com', createdAt: new Date('2026-10-20T00:00:00.000Z') }),
        makeInvite({ email: 'user-t1@example.com', userId: 'user-t1', status: InviteStatus.ACCEPTED }),
      ]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0]).toMatchObject({ inviteStatus: INVITE_FILTER.ACCEPTED, inviteSentAt: SENT_AT.toISOString() });
    });

    it('should report none with null inviteSentAt when the user has no invite', async () => {
      stubUserList([makeUserRow('signup-1')]);
      mockPrisma.trainerInvite.findMany.mockResolvedValue([makeInvite({ email: 'someone-else@example.com' })]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0]).toMatchObject({ inviteStatus: INVITE_FILTER.NONE, inviteSentAt: null });
    });

    it('should not match an accepted invite redeemed by a different user', async () => {
      stubUserList([makeUserRow('signup-1')]);
      mockPrisma.trainerInvite.findMany.mockResolvedValue([
        makeInvite({ email: 'signup-1@example.com', userId: 'other-user', status: InviteStatus.ACCEPTED }),
      ]);

      const { items } = await listTrainers(mockPrisma, { includeSignups: true });

      expect(items[0].inviteStatus).not.toBe(INVITE_FILTER.ACCEPTED);
    });
  });
});

describe('listTrainers without includeSignups', () => {
  beforeEach(() => {
    mockPrisma.trainer.findMany.mockResolvedValue([
      {
        id: 'trainer-1',
        userId: 'user-t1',
        user: { firstName: 'Ana', lastName: 'Lima', email: 'ana@example.com' },
        platformSubscription: { tier: PLATFORM_PLAN_TIERS.PRO, status: 'ACTIVE', asaasSubscriptionId: null },
      },
    ]);
    mockPrisma.trainer.count.mockResolvedValue(1);
    mockPrisma.trainerInvite.findMany.mockResolvedValue([]);
    mockPrisma.trainerStudent.groupBy.mockResolvedValue([{ trainerId: 'trainer-1', _count: { _all: 2 } }]);
  });

  it('should keep listing from the trainer table and not touch the user list', async () => {
    await listTrainers(mockPrisma, { page: 1, pageSize: DEFAULT_PAGE_SIZE });

    expect(mockPrisma.user.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.trainer.findMany).toHaveBeenCalledTimes(1);
  });

  it('should keep populated plan fields and add accountType trainer with invite fields', async () => {
    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: DEFAULT_PAGE_SIZE });

    expect(items[0]).toEqual({
      accountType: ACCOUNT_TYPE.TRAINER,
      trainerId: 'trainer-1',
      userId: 'user-t1',
      firstName: 'Ana',
      lastName: 'Lima',
      email: 'ana@example.com',
      tier: PLATFORM_PLAN_TIERS.PRO,
      subscriptionStatus: 'ACTIVE',
      hasAsaasSubscription: false,
      activeStudents: 2,
      studentCap: expect.any(Number),
      inviteStatus: INVITE_FILTER.NONE,
      inviteSentAt: null,
    });
  });

  it('should report accepted for a trainer who redeemed an invite', async () => {
    mockPrisma.trainerInvite.findMany.mockResolvedValue([
      makeInvite({ email: 'ana@example.com', userId: 'user-t1', status: InviteStatus.ACCEPTED }),
    ]);

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: DEFAULT_PAGE_SIZE });

    expect(items[0]).toMatchObject({ inviteStatus: INVITE_FILTER.ACCEPTED, inviteSentAt: SENT_AT.toISOString() });
  });
});
