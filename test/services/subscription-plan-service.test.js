import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
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
