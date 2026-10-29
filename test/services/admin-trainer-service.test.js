import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
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

vi.mock('../../src/billing/asaas-client.js', () => ({
  createCustomer: vi.fn(),
  getCustomer: vi.fn(),
  createSubscription: vi.fn(),
  cancelSubscriptionAtNextCycle: vi.fn(),
  updateSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  getSubscription: vi.fn(),
}));

import * as asaasClient from '../../src/billing/asaas-client.js';
import {
  getTrainerPlan,
  enforceStudentCapAfterDowngrade,
  reactivateStudentsUpToCap,
} from '../../src/services/platform-plan-service.js';
import { listTrainers, setTrainerTier } from '../../src/services/admin-trainer-service.js';

// ─── Prisma mock ──────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn() },
  platformSubscription: { upsert: vi.fn() },
  trainerStudent: { groupBy: vi.fn(), count: vi.fn() },
  trainerInvite: { findMany: vi.fn() },
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRAINER_ID = 'trainer-uuid-1';
const OTHER_TRAINER_ID = 'trainer-uuid-2';
const USER_ID = 'user-uuid-1';
const { FREE, PRO, PLATINUM, DIAMOND } = PLATFORM_PLAN_TIERS;

// Builds a trainer row with its user and optional subscription as the list query returns it.
function makeTrainerRow(id, { tier, status = 'ACTIVE', asaasSubscriptionId = null, ...user } = {}) {
  return {
    id,
    userId: `user-of-${id}`,
    user: {
      firstName: 'Ana',
      lastName: 'Lima',
      email: `${id}@example.com`,
      ...user,
    },
    platformSubscription: tier ? { tier, status, asaasSubscriptionId } : null,
  };
}

// Stubs the per-trainer active student groupBy result.
function stubActiveStudentCounts(counts = {}) {
  mockPrisma.trainerStudent.groupBy.mockResolvedValue(
    Object.entries(counts).map(([trainerId, count]) => ({ trainerId, _count: { _all: count } }))
  );
}

// Stubs the trainer plan the service resolves before changing the tier.
function stubCurrentPlan(tier) {
  getTrainerPlan.mockResolvedValue({
    tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    limits: PLAN_LIMITS[tier],
    subscription: null,
  });
}

// Stubs the subscription row returned by the tier upsert.
function stubUpsertResult(tier, overrides = {}) {
  mockPrisma.platformSubscription.upsert.mockResolvedValue({
    trainerId: TRAINER_ID,
    tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasSubscriptionId: null,
    ...overrides,
  });
}

// ─── listTrainers ─────────────────────────────────────────────────────────────

describe('listTrainers', () => {
  beforeEach(() => {
    mockPrisma.trainer.findMany.mockResolvedValue([]);
    mockPrisma.trainer.count.mockResolvedValue(0);
    mockPrisma.trainerInvite.findMany.mockResolvedValue([]);
    stubActiveStudentCounts({});
  });

  it('reports FREE with null subscription status when the trainer has no subscription row', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([makeTrainerRow(TRAINER_ID)]);
    mockPrisma.trainer.count.mockResolvedValue(1);

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(items[0]).toMatchObject({
      trainerId: TRAINER_ID,
      userId: `user-of-${TRAINER_ID}`,
      tier: FREE,
      subscriptionStatus: null,
      hasAsaasSubscription: false,
      studentCap: PLAN_LIMITS.FREE.studentCap,
    });
  });

  it('maps name and email from the trainer user', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainerRow(TRAINER_ID, { tier: PRO, firstName: 'Bia', lastName: 'Souza', email: 'bia@example.com' }),
    ]);
    mockPrisma.trainer.count.mockResolvedValue(1);

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(items[0]).toMatchObject({ firstName: 'Bia', lastName: 'Souza', email: 'bia@example.com' });
  });

  it('exposes tier, status and the PRO student cap for a subscribed trainer', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainerRow(TRAINER_ID, { tier: PRO, status: PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE }),
    ]);
    mockPrisma.trainer.count.mockResolvedValue(1);

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(items[0]).toMatchObject({
      tier: PRO,
      subscriptionStatus: PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE,
      studentCap: PLAN_LIMITS.PRO.studentCap,
    });
  });

  it('returns studentCap null for DIAMOND (unlimited)', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([makeTrainerRow(TRAINER_ID, { tier: DIAMOND })]);
    mockPrisma.trainer.count.mockResolvedValue(1);

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(items[0].studentCap).toBeNull();
  });

  it('flags hasAsaasSubscription when an Asaas subscription id is present', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainerRow(TRAINER_ID, { tier: PRO, asaasSubscriptionId: 'sub_asaas_1' }),
    ]);
    mockPrisma.trainer.count.mockResolvedValue(1);

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(items[0].hasAsaasSubscription).toBe(true);
  });

  it('counts only students active on the plan per trainer', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([
      makeTrainerRow(TRAINER_ID, { tier: PRO }),
      makeTrainerRow(OTHER_TRAINER_ID),
    ]);
    mockPrisma.trainer.count.mockResolvedValue(2);
    stubActiveStudentCounts({ [TRAINER_ID]: 7 });

    const { items } = await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(items.map((i) => [i.trainerId, i.activeStudents])).toEqual([
      [TRAINER_ID, 7],
      [OTHER_TRAINER_ID, 0],
    ]);
  });

  it('queries active students with activeOnPlan true', async () => {
    mockPrisma.trainer.findMany.mockResolvedValue([makeTrainerRow(TRAINER_ID)]);
    mockPrisma.trainer.count.mockResolvedValue(1);

    await listTrainers(mockPrisma, { page: 1, pageSize: 20 });

    expect(mockPrisma.trainerStudent.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ activeOnPlan: true }),
      })
    );
  });

  it('returns total, page and pageSize alongside items', async () => {
    mockPrisma.trainer.count.mockResolvedValue(42);

    const result = await listTrainers(mockPrisma, { page: 2, pageSize: 10 });

    expect(result).toMatchObject({ total: 42, page: 2, pageSize: 10, items: [] });
  });

  it('applies skip and take from page and pageSize', async () => {
    await listTrainers(mockPrisma, { page: 3, pageSize: 10 });

    expect(mockPrisma.trainer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 })
    );
  });

  it('searches name or email case-insensitively', async () => {
    await listTrainers(mockPrisma, { search: 'bia', page: 1, pageSize: 20 });

    const { where } = mockPrisma.trainer.findMany.mock.calls[0][0];
    const serialized = JSON.stringify(where);
    expect(serialized).toContain('"bia"');
    expect(serialized).toContain('insensitive');
    ['firstName', 'lastName', 'email'].forEach((field) => expect(serialized).toContain(field));
  });

  it('applies the same search filter to the total count', async () => {
    await listTrainers(mockPrisma, { search: 'bia', page: 1, pageSize: 20 });

    const { where: listWhere } = mockPrisma.trainer.findMany.mock.calls[0][0];
    const { where: countWhere } = mockPrisma.trainer.count.mock.calls[0][0];
    expect(countWhere).toEqual(listWhere);
  });

  it('does not filter by user when search is empty', async () => {
    await listTrainers(mockPrisma, { search: '', page: 1, pageSize: 20 });

    const { where } = mockPrisma.trainer.findMany.mock.calls[0][0];
    expect(JSON.stringify(where ?? {})).not.toContain('insensitive');
  });
});

// ─── setTrainerTier ───────────────────────────────────────────────────────────

describe('setTrainerTier', () => {
  beforeEach(() => {
    mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
    mockPrisma.trainerStudent.count.mockResolvedValue(5);
    stubCurrentPlan(FREE);
    stubUpsertResult(PRO);
  });

  describe('unknown trainer', () => {
    it('throws AppError 404 resource.notFound', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        setTrainerTier(mockPrisma, { trainerId: 'missing', tier: PRO })
      ).rejects.toMatchObject({
        httpStatus: 404,
        messageCode: 'resource.notFound',
      });
    });

    it('does not write anything', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await setTrainerTier(mockPrisma, { trainerId: 'missing', tier: PRO }).catch(() => {});

      expect(mockPrisma.platformSubscription.upsert).not.toHaveBeenCalled();
    });
  });

  describe('trainer without a subscription row', () => {
    it('creates the row with the new tier and status ACTIVE', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(mockPrisma.platformSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { trainerId: TRAINER_ID },
          create: expect.objectContaining({
            trainerId: TRAINER_ID,
            tier: PRO,
            status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
          }),
          update: expect.objectContaining({ tier: PRO }),
        })
      );
    });

    it('returns the previous and new tier with changed true', async () => {
      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(result).toMatchObject({
        trainerId: TRAINER_ID,
        previousTier: FREE,
        tier: PRO,
        changed: true,
        subscriptionStatus: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
        hasAsaasSubscription: false,
        activeStudents: 5,
        studentCap: PLAN_LIMITS.PRO.studentCap,
      });
    });
  });

  describe('Asaas isolation', () => {
    it('never calls the Asaas client', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      Object.values(asaasClient).forEach((fn) => expect(fn).not.toHaveBeenCalled());
    });

    it('reports hasAsaasSubscription true for a trainer billed through Asaas', async () => {
      stubCurrentPlan(PRO);
      stubUpsertResult(PLATINUM, { asaasSubscriptionId: 'sub_asaas_1' });

      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PLATINUM });

      expect(result.hasAsaasSubscription).toBe(true);
    });
  });

  describe('FREE tier', () => {
    it('allows setting a paid trainer to FREE', async () => {
      stubCurrentPlan(PRO);
      stubUpsertResult(FREE);

      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: FREE });

      expect(result).toMatchObject({ previousTier: PRO, tier: FREE, changed: true });
    });
  });

  describe('same tier', () => {
    it('returns changed false without writing', async () => {
      stubCurrentPlan(PRO);

      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(result).toMatchObject({ previousTier: PRO, tier: PRO, changed: false });
      expect(mockPrisma.platformSubscription.upsert).not.toHaveBeenCalled();
    });

    it('triggers neither cap enforcement nor reactivation', async () => {
      stubCurrentPlan(PRO);

      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(enforceStudentCapAfterDowngrade).not.toHaveBeenCalled();
      expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
    });

    it('treats FREE with no subscription row as already FREE', async () => {
      stubCurrentPlan(FREE);

      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: FREE });

      expect(result.changed).toBe(false);
      expect(mockPrisma.platformSubscription.upsert).not.toHaveBeenCalled();
    });
  });

  describe('downgrade', () => {
    beforeEach(() => {
      stubCurrentPlan(PLATINUM);
      stubUpsertResult(PRO);
    });

    it('enforces the student cap for the trainer', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(enforceStudentCapAfterDowngrade).toHaveBeenCalledOnce();
      expect(enforceStudentCapAfterDowngrade).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
    });

    it('enforces the cap only after the new tier is persisted', async () => {
      const order = [];
      mockPrisma.platformSubscription.upsert.mockImplementation(async () => {
        order.push('upsert');
        return { trainerId: TRAINER_ID, tier: PRO, status: 'ACTIVE', asaasSubscriptionId: null };
      });
      enforceStudentCapAfterDowngrade.mockImplementation(async () => {
        order.push('enforce');
      });

      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(order).toEqual(['upsert', 'enforce']);
    });

    it('does not reactivate students', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
    });
  });

  describe('upgrade', () => {
    it('reactivates blocked students for the trainer', async () => {
      stubCurrentPlan(FREE);
      stubUpsertResult(PRO);

      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(reactivateStudentsUpToCap).toHaveBeenCalledOnce();
      expect(reactivateStudentsUpToCap).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
    });

    it('reactivates only after the new tier is persisted', async () => {
      const order = [];
      mockPrisma.platformSubscription.upsert.mockImplementation(async () => {
        order.push('upsert');
        return { trainerId: TRAINER_ID, tier: PRO, status: 'ACTIVE', asaasSubscriptionId: null };
      });
      reactivateStudentsUpToCap.mockImplementation(async () => {
        order.push('reactivate');
      });

      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(order).toEqual(['upsert', 'reactivate']);
    });

    it('does not enforce the cap', async () => {
      stubCurrentPlan(FREE);
      stubUpsertResult(DIAMOND);

      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: DIAMOND });

      expect(enforceStudentCapAfterDowngrade).not.toHaveBeenCalled();
    });

    it('returns studentCap null when upgrading to DIAMOND', async () => {
      stubCurrentPlan(FREE);
      stubUpsertResult(DIAMOND);

      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: DIAMOND });

      expect(result.studentCap).toBeNull();
    });
  });
});
