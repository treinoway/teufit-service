import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PAST_DUE_GRACE_DAYS,
  PLAN_LIMITS,
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
} from '../../src/constants/platform-plan.js';

// ─── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn(),
  reactivateStudentsUpToCap: vi.fn(),
}));

import { getTrainerPlan } from '../../src/services/platform-plan-service.js';
import { listTrainers, setTrainerTier } from '../../src/services/admin-trainer-service.js';

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  platformSubscription: { upsert: vi.fn() },
  trainerStudent: { groupBy: vi.fn(), count: vi.fn() },
};

const TRAINER_ID = 'trainer-uuid-1';
const { FREE, PRO } = PLATFORM_PLAN_TIERS;
const { ACTIVE, PAST_DUE, CANCELED } = PLATFORM_SUBSCRIPTION_STATUSES;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Builds the trainer lookup row, optionally soft-deleted on the trainer or its user.
function makeTrainerLookup({ deletedAt = null, userDeletedAt = null } = {}) {
  return { id: TRAINER_ID, userId: 'user-1', deletedAt, user: { deletedAt: userDeletedAt } };
}

// Stubs the trainer plan the service resolves before changing the tier.
function stubCurrentPlan(tier, status = ACTIVE) {
  getTrainerPlan.mockResolvedValue({ tier, status, limits: PLAN_LIMITS[tier], subscription: null });
}

beforeEach(() => {
  mockPrisma.trainer.findUnique.mockResolvedValue(makeTrainerLookup());
  mockPrisma.trainer.findMany.mockResolvedValue([]);
  mockPrisma.trainer.count.mockResolvedValue(0);
  mockPrisma.trainerStudent.groupBy.mockResolvedValue([]);
  mockPrisma.trainerStudent.count.mockResolvedValue(0);
  mockPrisma.platformSubscription.upsert.mockResolvedValue({ trainerId: TRAINER_ID, tier: PRO, status: ACTIVE });
});

// ─── setTrainerTier: subscription row normalisation ───────────────────────────

describe('setTrainerTier — update branch of the upsert', () => {
  it('sets status ACTIVE and clears pastDueSince on a past-due row', async () => {
    stubCurrentPlan(FREE, PAST_DUE);

    await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

    const { update } = mockPrisma.platformSubscription.upsert.mock.calls[0][0];
    expect(update).toEqual({ tier: PRO, status: ACTIVE, pastDueSince: null });
  });

  it('reactivates a canceled row as ACTIVE', async () => {
    stubCurrentPlan(FREE, CANCELED);

    await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

    const { update } = mockPrisma.platformSubscription.upsert.mock.calls[0][0];
    expect(update.status).toBe(ACTIVE);
  });

  it('never writes Asaas ids in the update branch', async () => {
    stubCurrentPlan(FREE);

    await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

    const { update } = mockPrisma.platformSubscription.upsert.mock.calls[0][0];
    expect(Object.keys(update).filter((key) => key.toLowerCase().includes('asaas'))).toEqual([]);
  });
});

describe('setTrainerTier — past-due row survives the grace window', () => {
  it('keeps the admin-set tier when getTrainerPlan runs after the grace period elapsed', async () => {
    const { getTrainerPlan: realGetTrainerPlan } = await vi.importActual(
      '../../src/services/platform-plan-service.js'
    );
    const staleDate = new Date(Date.now() - (PAST_DUE_GRACE_DAYS + 5) * MS_PER_DAY);
    const stubPrisma = {
      platformSubscription: {
        findUnique: vi.fn().mockResolvedValue({
          trainerId: TRAINER_ID,
          tier: PRO,
          status: ACTIVE,
          pastDueSince: null,
        }),
        update: vi.fn(),
      },
    };
    expect(staleDate.getTime()).toBeLessThan(Date.now());

    const plan = await realGetTrainerPlan(stubPrisma, TRAINER_ID);

    expect(plan.tier).toBe(PRO);
    expect(stubPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});

// ─── setTrainerTier: soft-deleted / unknown trainer ───────────────────────────

describe('setTrainerTier — trainer lookup', () => {
  it.each([
    ['missing', null],
    ['soft-deleted trainer', makeTrainerLookup({ deletedAt: new Date() })],
    ['soft-deleted user', makeTrainerLookup({ userDeletedAt: new Date() })],
  ])('throws 404 resource.notFound when the trainer is %s', async (_label, row) => {
    mockPrisma.trainer.findUnique.mockResolvedValue(row);

    const error = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO }).catch((e) => e);

    expect(error).toMatchObject({ httpStatus: 404, messageCode: 'resource.notFound' });
  });

  it('looks the trainer up by id', async () => {
    stubCurrentPlan(FREE);

    await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

    expect(mockPrisma.trainer.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: TRAINER_ID } })
    );
  });

  it('does not upsert when the trainer is soft-deleted', async () => {
    mockPrisma.trainer.findUnique.mockResolvedValue(makeTrainerLookup({ deletedAt: new Date() }));

    await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO }).catch(() => {});

    expect(mockPrisma.platformSubscription.upsert).not.toHaveBeenCalled();
  });
});

// ─── listTrainers: filters and ordering ───────────────────────────────────────

describe('listTrainers — where / orderBy', () => {
  it('excludes soft-deleted trainers and users in findMany', async () => {
    await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(mockPrisma.trainer.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: null,
      user: { deletedAt: null },
    });
  });

  it('uses the same where for count so the total matches the items', async () => {
    await listTrainers(mockPrisma, { search: 'ana', page: 1, pageSize: 20 });

    expect(mockPrisma.trainer.count.mock.calls[0][0].where).toEqual(
      mockPrisma.trainer.findMany.mock.calls[0][0].where
    );
  });

  it('orders by createdAt desc then id asc for stable pagination', async () => {
    await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(mockPrisma.trainer.findMany.mock.calls[0][0].orderBy).toEqual([
      { createdAt: 'desc' },
      { id: 'asc' },
    ]);
  });

  it('ANDs one OR filter per whitespace-separated search token', async () => {
    await listTrainers(mockPrisma, { search: 'Ana Souza', page: 1, pageSize: 20 });

    const tokenFilter = (token) => {
      const contains = { contains: token, mode: 'insensitive' };
      return { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] };
    };
    expect(mockPrisma.trainer.findMany.mock.calls[0][0].where).toEqual({
      deletedAt: null,
      user: { deletedAt: null, AND: [tokenFilter('Ana'), tokenFilter('Souza')] },
    });
  });

  it('collapses repeated whitespace between tokens', async () => {
    await listTrainers(mockPrisma, { search: '  Ana   Souza ', page: 1, pageSize: 20 });

    expect(mockPrisma.trainer.findMany.mock.calls[0][0].where.user.AND).toHaveLength(2);
  });

  it.each([['   '], [''], [undefined]])('adds no AND filter for blank search %j', async (search) => {
    await listTrainers(mockPrisma, { search, page: 1, pageSize: 20 });

    expect(mockPrisma.trainer.findMany.mock.calls[0][0].where.user).toEqual({ deletedAt: null });
  });
});
