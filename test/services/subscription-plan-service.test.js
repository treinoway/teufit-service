import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';

const { Decimal } = Prisma;

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  subscriptionPlan: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  },
  studentSubscription: { groupBy: vi.fn() },
};

import {
  createPlan,
  listPlans,
  getPlanById,
  updatePlan,
  archivePlan,
  unarchivePlan,
} from '../../src/services/subscription-plan-service.js';

const TRAINER_USER_ID = 'trainer-user-uuid';
const TRAINER_ID = 'trainer-record-uuid';
const PLAN_ID = 'plan-uuid-1';

function makePlanRecord(overrides = {}) {
  return {
    id: PLAN_ID,
    trainerId: TRAINER_ID,
    name: 'Plano Mensal',
    description: null,
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
});

// ─── createPlan ───────────────────────────────────────────────────────────────

describe('createPlan', () => {
  it('creates a plan with no discount', async () => {
    const plan = makePlanRecord();
    mockPrisma.subscriptionPlan.create.mockResolvedValue(plan);

    const result = await createPlan(mockPrisma, TRAINER_USER_ID, {
      name: 'Plano Mensal',
      recurrence: 'monthly',
      price: 100,
    });

    expect(result.id).toBe(PLAN_ID);
    expect(Number(result.price)).toBe(100);
    expect(result.discountPercent).toBeNull();
    expect(result.isArchived).toBe(false);
  });

  it('creates a plan with percent discount', async () => {
    const plan = makePlanRecord({ discountPercent: new Decimal('10.00') });
    mockPrisma.subscriptionPlan.create.mockResolvedValue(plan);

    const result = await createPlan(mockPrisma, TRAINER_USER_ID, {
      name: 'Plano com desconto',
      recurrence: 'monthly',
      price: 100,
      discountPercent: 10,
    });

    expect(Number(result.discountPercent)).toBe(10);
    expect(result.discountAmount).toBeNull();
  });

  it('throws 400 when both discounts are set', async () => {
    await expect(
      createPlan(mockPrisma, TRAINER_USER_ID, {
        name: 'Plano',
        recurrence: 'monthly',
        price: 100,
        discountPercent: 10,
        discountAmount: 5,
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.BOTH_DISCOUNTS_SET,
      messageCode: SubscriptionMessageCode.BOTH_DISCOUNTS_SET,
    });
  });

  it('throws 400 when discount amount exceeds price', async () => {
    await expect(
      createPlan(mockPrisma, TRAINER_USER_ID, {
        name: 'Plano',
        recurrence: 'monthly',
        price: 100,
        discountAmount: 150,
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.DISCOUNT_EXCEEDS_PRICE,
    });
  });

  it.each([
    ['price with more than 2 decimals', { price: 10.005 }],
    ['price above the Decimal(10,2) maximum', { price: 100000000 }],
    ['discountAmount with more than 2 decimals', { price: 100, discountAmount: 1.001 }],
    ['discountPercent with more than 2 decimals', { price: 100, discountPercent: 33.333 }],
  ])('throws 400 SUBSCRIPTION_INVALID_AMOUNT for %s', async (_label, money) => {
    await expect(
      createPlan(mockPrisma, TRAINER_USER_ID, { name: 'x', recurrence: 'monthly', ...money }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
      messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
    });
    expect(mockPrisma.subscriptionPlan.create).not.toHaveBeenCalled();
  });

  it('throws 404 when trainer not found', async () => {
    mockPrisma.trainer.findUnique.mockResolvedValue(null);

    await expect(
      createPlan(mockPrisma, TRAINER_USER_ID, {
        name: 'Plano',
        recurrence: 'monthly',
        price: 100,
      }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.TRAINER_NOT_FOUND,
    });
  });
});

// ─── listPlans ────────────────────────────────────────────────────────────────

describe('listPlans', () => {
  beforeEach(() => {
    mockPrisma.studentSubscription.groupBy.mockResolvedValue([]);
  });

  it('excludes archived plans by default', async () => {
    const activePlan = makePlanRecord();
    mockPrisma.subscriptionPlan.findMany.mockResolvedValue([activePlan]);

    const result = await listPlans(mockPrisma, TRAINER_USER_ID);

    expect(result).toHaveLength(1);
    const callArgs = mockPrisma.subscriptionPlan.findMany.mock.calls[0][0];
    expect(callArgs.where.deletedAt).toBeNull();
  });

  it('includes archived plans when flag is set', async () => {
    const activePlan = makePlanRecord();
    const archivedPlan = makePlanRecord({ id: 'plan-2', deletedAt: new Date() });
    mockPrisma.subscriptionPlan.findMany.mockResolvedValue([activePlan, archivedPlan]);

    const result = await listPlans(mockPrisma, TRAINER_USER_ID, { includeArchived: true });

    expect(result).toHaveLength(2);
    const callArgs = mockPrisma.subscriptionPlan.findMany.mock.calls[0][0];
    expect(callArgs.where.deletedAt).toBeUndefined();
  });

  describe('activeSubscriptionCount', () => {
    it('adds the count per plan using a single groupBy for all plans (no N+1)', async () => {
      mockPrisma.subscriptionPlan.findMany.mockResolvedValue([
        makePlanRecord({ id: 'plan-a' }),
        makePlanRecord({ id: 'plan-b' }),
        makePlanRecord({ id: 'plan-c' }),
      ]);
      mockPrisma.studentSubscription.groupBy.mockResolvedValue([
        { planId: 'plan-a', _count: { _all: 2 } },
        { planId: 'plan-b', _count: { _all: 1 } },
      ]);

      const result = await listPlans(mockPrisma, TRAINER_USER_ID);

      expect(mockPrisma.studentSubscription.groupBy).toHaveBeenCalledOnce();
      expect(result.map((plan) => plan.activeSubscriptionCount)).toEqual([2, 1, 0]);
    });

    it('counts only active subscriptions of the listed plans', async () => {
      mockPrisma.subscriptionPlan.findMany.mockResolvedValue([
        makePlanRecord({ id: 'plan-a' }),
        makePlanRecord({ id: 'plan-b' }),
      ]);
      mockPrisma.studentSubscription.groupBy.mockResolvedValue([]);

      await listPlans(mockPrisma, TRAINER_USER_ID);

      const args = mockPrisma.studentSubscription.groupBy.mock.calls[0][0];
      expect(args.by).toEqual(['planId']);
      expect(args.where).toEqual({
        planId: { in: ['plan-a', 'plan-b'] },
        status: SubscriptionStatus.ACTIVE,
      });
    });

    it('returns zero for plans whose subscriptions are all cancelled (absent from groupBy)', async () => {
      mockPrisma.subscriptionPlan.findMany.mockResolvedValue([makePlanRecord()]);
      mockPrisma.studentSubscription.groupBy.mockResolvedValue([]);

      const [plan] = await listPlans(mockPrisma, TRAINER_USER_ID);

      expect(plan.activeSubscriptionCount).toBe(0);
    });

    it('skips the groupBy query when the trainer has no plans', async () => {
      mockPrisma.subscriptionPlan.findMany.mockResolvedValue([]);

      const result = await listPlans(mockPrisma, TRAINER_USER_ID);

      expect(result).toEqual([]);
      expect(mockPrisma.studentSubscription.groupBy).not.toHaveBeenCalled();
    });

    it('is not included by getPlanById, createPlan or updatePlan', async () => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());
      mockPrisma.subscriptionPlan.create.mockResolvedValue(makePlanRecord());
      mockPrisma.subscriptionPlan.update.mockResolvedValue(makePlanRecord());

      const results = [
        await getPlanById(mockPrisma, TRAINER_USER_ID, PLAN_ID),
        await createPlan(mockPrisma, TRAINER_USER_ID, { name: 'x', recurrence: 'monthly', price: 100 }),
        await updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { name: 'y' }),
      ];

      results.forEach((plan) => expect(plan).not.toHaveProperty('activeSubscriptionCount'));
    });
  });
});

// ─── getPlanById ──────────────────────────────────────────────────────────────

describe('getPlanById', () => {
  it('returns a plan by id', async () => {
    const plan = makePlanRecord();
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(plan);

    const result = await getPlanById(mockPrisma, TRAINER_USER_ID, PLAN_ID);

    expect(result.id).toBe(PLAN_ID);
  });

  it('throws 404 when plan not found', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);

    await expect(
      getPlanById(mockPrisma, TRAINER_USER_ID, PLAN_ID),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.PLAN_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PLAN_NOT_FOUND,
    });
  });
});

// ─── updatePlan ───────────────────────────────────────────────────────────────

describe('updatePlan', () => {
  it('updates allowed fields', async () => {
    const existing = makePlanRecord();
    const updated = makePlanRecord({ name: 'Novo Nome', price: new Decimal('120.00') });
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(existing);
    mockPrisma.subscriptionPlan.update.mockResolvedValue(updated);

    const result = await updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, {
      name: 'Novo Nome',
      price: 120,
    });

    expect(result.name).toBe('Novo Nome');
    expect(Number(result.price)).toBe(120);
  });

  it('throws 400 SUBSCRIPTION_INVALID_AMOUNT when the patch has a discountPercent with more than 2 decimals', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());

    await expect(
      updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { discountPercent: 33.333 }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
      messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
    });
    expect(mockPrisma.subscriptionPlan.update).not.toHaveBeenCalled();
  });

  it('accepts a discountPercent with exactly 2 decimals on update', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());
    mockPrisma.subscriptionPlan.update.mockResolvedValue(makePlanRecord({ discountPercent: new Decimal('33.33') }));

    const result = await updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { discountPercent: 33.33 });

    expect(result.discountPercent).toBe('33.33');
  });

  it('throws 404 when plan not found', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);

    await expect(
      updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { name: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PLAN_NOT_FOUND });
  });

  it('throws 409 when plan is archived', async () => {
    const archived = makePlanRecord({ deletedAt: new Date() });
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(archived);

    await expect(
      updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { name: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PLAN_ARCHIVED });
  });

  it.each([
    ['price with more than 2 decimals', { price: 99.999 }],
    ['price above the Decimal(10,2) maximum', { price: 100000000.5 }],
    ['discountAmount with more than 2 decimals', { discountAmount: 0.001 }],
  ])('throws 400 SUBSCRIPTION_INVALID_AMOUNT on update for %s', async (_label, patch) => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());

    await expect(updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, patch)).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
    });
    expect(mockPrisma.subscriptionPlan.update).not.toHaveBeenCalled();
  });

  it('throws 400 when patch sets both discounts', async () => {
    const existing = makePlanRecord();
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(existing);

    await expect(
      updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, {
        discountPercent: 10,
        discountAmount: 5,
      }),
    ).rejects.toMatchObject({ httpStatus: 400, error: SubscriptionErrorCode.BOTH_DISCOUNTS_SET });
  });
});

// ─── archivePlan ──────────────────────────────────────────────────────────────

describe('archivePlan', () => {
  it('sets deletedAt on the plan', async () => {
    const existing = makePlanRecord();
    const archived = makePlanRecord({ deletedAt: new Date() });
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(existing);
    mockPrisma.subscriptionPlan.update.mockResolvedValue(archived);

    const result = await archivePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID);

    expect(result.isArchived).toBe(true);
  });

  it('is idempotent — does not change deletedAt if already set', async () => {
    const frozenDate = new Date('2026-03-01T00:00:00Z');
    const alreadyArchived = makePlanRecord({ deletedAt: frozenDate });
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(alreadyArchived);
    mockPrisma.subscriptionPlan.update.mockResolvedValue(alreadyArchived);

    await archivePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID);

    const updateCall = mockPrisma.subscriptionPlan.update.mock.calls[0][0];
    // Should preserve original date (deletedAt ?? new Date() → frozenDate)
    expect(updateCall.data.deletedAt).toEqual(frozenDate);
  });

  it('throws 404 when plan not found', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);

    await expect(
      archivePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ─── unarchivePlan ────────────────────────────────────────────────────────────

describe('unarchivePlan', () => {
  it('clears deletedAt', async () => {
    const archived = makePlanRecord({ deletedAt: new Date() });
    const active = makePlanRecord({ deletedAt: null });
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(archived);
    mockPrisma.subscriptionPlan.update.mockResolvedValue(active);

    const result = await unarchivePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID);

    expect(result.isArchived).toBe(false);
    const updateCall = mockPrisma.subscriptionPlan.update.mock.calls[0][0];
    expect(updateCall.data.deletedAt).toBeNull();
  });

  it('throws 404 when plan not found', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);

    await expect(
      unarchivePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ─── billingDay ───────────────────────────────────────────────────────────────

describe('plan billingDay', () => {
  const BASE_PLAN_INPUT = { name: 'Plano Mensal', recurrence: 'monthly', price: 100 };

  describe('createPlan', () => {
    it('persists the given billingDay and returns it', async () => {
      mockPrisma.subscriptionPlan.create.mockResolvedValue(makePlanRecord({ billingDay: 31 }));

      const result = await createPlan(mockPrisma, TRAINER_USER_ID, { ...BASE_PLAN_INPUT, billingDay: 31 });

      expect(mockPrisma.subscriptionPlan.create.mock.calls[0][0].data.billingDay).toBe(31);
      expect(result.billingDay).toBe(31);
    });

    it('persists null when billingDay is omitted and returns null', async () => {
      mockPrisma.subscriptionPlan.create.mockResolvedValue(makePlanRecord());

      const result = await createPlan(mockPrisma, TRAINER_USER_ID, BASE_PLAN_INPUT);

      expect(mockPrisma.subscriptionPlan.create.mock.calls[0][0].data.billingDay).toBeNull();
      expect(result.billingDay).toBeNull();
    });

    it('persists null when billingDay is explicitly null', async () => {
      mockPrisma.subscriptionPlan.create.mockResolvedValue(makePlanRecord());

      await createPlan(mockPrisma, TRAINER_USER_ID, { ...BASE_PLAN_INPUT, billingDay: null });

      expect(mockPrisma.subscriptionPlan.create.mock.calls[0][0].data.billingDay).toBeNull();
    });
  });

  describe('getPlanById / listPlans', () => {
    it('getPlanById returns the billingDay', async () => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord({ billingDay: 10 }));

      const result = await getPlanById(mockPrisma, TRAINER_USER_ID, PLAN_ID);

      expect(result.billingDay).toBe(10);
    });

    it('listPlans returns the billingDay of each plan, null when unset', async () => {
      mockPrisma.subscriptionPlan.findMany.mockResolvedValue([
        makePlanRecord({ id: 'with-day', billingDay: 15 }),
        makePlanRecord({ id: 'without-day', billingDay: null }),
      ]);
      mockPrisma.studentSubscription.groupBy.mockResolvedValue([]);

      const result = await listPlans(mockPrisma, TRAINER_USER_ID);

      expect(result.map((plan) => plan.billingDay)).toEqual([15, null]);
    });
  });

  describe('updatePlan', () => {
    beforeEach(() => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord({ billingDay: 7 }));
      mockPrisma.subscriptionPlan.update.mockImplementation(async ({ data }) => makePlanRecord(data));
    });

    it('sets a new billingDay', async () => {
      const result = await updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { billingDay: 20 });

      expect(mockPrisma.subscriptionPlan.update.mock.calls[0][0].data.billingDay).toBe(20);
      expect(result.billingDay).toBe(20);
    });

    it('keeps the current billingDay when the patch omits it', async () => {
      const result = await updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { name: 'Novo Nome' });

      expect(mockPrisma.subscriptionPlan.update.mock.calls[0][0].data.billingDay).toBe(7);
      expect(result.billingDay).toBe(7);
    });

    it('clears the billingDay when the patch sends null', async () => {
      const result = await updatePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID, { billingDay: null });

      expect(mockPrisma.subscriptionPlan.update.mock.calls[0][0].data.billingDay).toBeNull();
      expect(result.billingDay).toBeNull();
    });
  });

  describe('archive / unarchive', () => {
    it('archivePlan keeps returning the billingDay', async () => {
      mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord({ billingDay: 12 }));
      mockPrisma.subscriptionPlan.update.mockResolvedValue(
        makePlanRecord({ billingDay: 12, deletedAt: new Date() }),
      );

      const result = await archivePlan(mockPrisma, TRAINER_USER_ID, PLAN_ID);

      expect(result.billingDay).toBe(12);
    });
  });
});
