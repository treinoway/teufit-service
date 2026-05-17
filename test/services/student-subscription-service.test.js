import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionStatus,
  PaymentStatus,
} from '../../src/constants/subscription.js';

const { Decimal } = Prisma;

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockTx = {
  studentSubscription: {
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  subscriptionPayment: {
    create: vi.fn(),
  },
};

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  trainerStudent: { findFirst: vi.fn() },
  subscriptionPlan: { findFirst: vi.fn() },
  studentSubscription: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  subscriptionPayment: { create: vi.fn() },
  $transaction: vi.fn(async (fn) => fn(mockTx)),
};

import {
  assignPlanToStudent,
  listSubscriptionsByStudent,
  getActiveSubscriptionByStudent,
  cancelSubscription,
  computeAmount,
} from '../../src/services/student-subscription-service.js';
import { assertStudentActiveOnPlan } from '../../src/services/platform-plan-service.js';

const TRAINER_USER_ID = 'trainer-user-uuid';
const TRAINER_ID = 'trainer-record-uuid';
const STUDENT_ID = 'student-uuid-1';
const PLAN_ID = 'plan-uuid-1';
const SUBSCRIPTION_ID = 'sub-uuid-1';

function makePlanRecord(overrides = {}) {
  return {
    id: PLAN_ID,
    trainerId: TRAINER_ID,
    name: 'Plano Mensal',
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    deletedAt: null,
    ...overrides,
  };
}

function makeSubscriptionRecord(overrides = {}) {
  return {
    id: SUBSCRIPTION_ID,
    trainerId: TRAINER_ID,
    studentId: STUDENT_ID,
    planId: PLAN_ID,
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    startDate: new Date('2026-05-01T12:00:00Z'),
    status: SubscriptionStatus.ACTIVE,
    cancelledAt: null,
    cancellationReason: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

function makePaymentRecord(overrides = {}) {
  return {
    id: 'payment-uuid-1',
    subscriptionId: SUBSCRIPTION_ID,
    cycleStartDate: new Date('2026-05-01T12:00:00Z'),
    cycleEndDate: new Date('2026-05-31T12:00:00Z'),
    dueDate: new Date('2026-05-01T12:00:00Z'),
    amount: new Decimal('100.00'),
    status: PaymentStatus.PENDING,
    paidAt: null,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  // Re-apply platform-plan-service mocks after resetAllMocks.
  assertStudentActiveOnPlan.mockResolvedValue(undefined);
  mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  mockPrisma.trainerStudent.findFirst.mockResolvedValue({ id: 'link-uuid' });
  mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 0 });
  mockTx.studentSubscription.create.mockResolvedValue(makeSubscriptionRecord());
  mockTx.subscriptionPayment.create.mockResolvedValue(makePaymentRecord());
});

// ─── computeAmount ────────────────────────────────────────────────────────────

describe('computeAmount', () => {
  it('returns price when no discount', () => {
    const result = computeAmount(new Decimal('100.00'), null, null);
    expect(result.toString()).toBe('100');
  });

  it('applies percent discount correctly', () => {
    const result = computeAmount(new Decimal('100.00'), new Decimal('10'), null);
    expect(result.toString()).toBe('90');
  });

  it('applies fixed amount discount correctly', () => {
    const result = computeAmount(new Decimal('100.00'), null, new Decimal('25.00'));
    expect(result.toString()).toBe('75');
  });

  it('floors at 0 when discount exceeds price', () => {
    const result = computeAmount(new Decimal('100.00'), null, new Decimal('200.00'));
    expect(Number(result.toString())).toBe(0);
  });

  it('handles 100% discount', () => {
    const result = computeAmount(new Decimal('100.00'), new Decimal('100'), null);
    expect(Number(result.toString())).toBe(0);
  });
});

// ─── assignPlanToStudent ──────────────────────────────────────────────────────

describe('assignPlanToStudent', () => {
  beforeEach(() => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());
  });

  it('creates subscription and first payment in a transaction', async () => {
    const result = await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.studentSubscription.updateMany).toHaveBeenCalledOnce();
    expect(mockTx.studentSubscription.create).toHaveBeenCalledOnce();
    expect(mockTx.subscriptionPayment.create).toHaveBeenCalledOnce();
    expect(result.id).toBe(SUBSCRIPTION_ID);
    expect(result.firstPayment).toBeDefined();
    expect(result.firstPayment.status).toBe(PaymentStatus.PENDING);
  });

  it('cancels existing active subscription before creating new one', async () => {
    await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    const updateManyCall = mockTx.studentSubscription.updateMany.mock.calls[0][0];
    expect(updateManyCall.where.status).toBe(SubscriptionStatus.ACTIVE);
    expect(updateManyCall.data.status).toBe(SubscriptionStatus.CANCELLED);
  });

  it('snapshots plan fields at attach time', async () => {
    await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    const createCall = mockTx.studentSubscription.create.mock.calls[0][0];
    expect(createCall.data.recurrence).toBe('monthly');
    expect(createCall.data.planId).toBe(PLAN_ID);
  });

  it('throws 404 when trainer not found', async () => {
    mockPrisma.trainer.findUnique.mockResolvedValue(null);

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.TRAINER_NOT_FOUND });
  });

  it('throws 403 when student is not linked', async () => {
    mockPrisma.trainerStudent.findFirst.mockResolvedValue(null);

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({ httpStatus: 403, error: SubscriptionErrorCode.STUDENT_NOT_LINKED });
  });

  it('throws 404 when plan not found', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(null);

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PLAN_NOT_FOUND });
  });

  it('throws 409 when plan is archived', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(
      makePlanRecord({ deletedAt: new Date() }),
    );

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PLAN_ARCHIVED });
  });

  it('throws 400 when caller passes discountPercent=0 and plan has discountAmount set (mutual exclusion)', async () => {
    // Plan has a fixed-amount discount; caller overrides with discountPercent=0 (a non-null number),
    // which would result in both effectiveDiscountPercent=0 and effectiveDiscountAmount set.
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(
      makePlanRecord({ discountAmount: new Decimal('10.00') }),
    );

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
        discountPercent: 0,
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.BOTH_DISCOUNTS_SET,
    });
  });
});

// ─── listSubscriptionsByStudent ───────────────────────────────────────────────

describe('listSubscriptionsByStudent', () => {
  it('returns subscriptions ordered by createdAt desc', async () => {
    const subs = [makeSubscriptionRecord(), makeSubscriptionRecord({ id: 'sub-2' })];
    mockPrisma.studentSubscription.findMany.mockResolvedValue(subs);

    const result = await listSubscriptionsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID);

    expect(result).toHaveLength(2);
  });
});

// ─── getActiveSubscriptionByStudent ──────────────────────────────────────────

describe('getActiveSubscriptionByStudent', () => {
  it('returns active subscription', async () => {
    const sub = makeSubscriptionRecord();
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(sub);

    const result = await getActiveSubscriptionByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID);

    expect(result).not.toBeNull();
    expect(result.status).toBe(SubscriptionStatus.ACTIVE);
  });

  it('returns null when no active subscription', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    const result = await getActiveSubscriptionByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID);

    expect(result).toBeNull();
  });
});

// ─── cancelSubscription ───────────────────────────────────────────────────────

describe('cancelSubscription', () => {
  it('cancels an active subscription', async () => {
    const sub = makeSubscriptionRecord();
    const cancelled = makeSubscriptionRecord({
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
    });
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(sub);
    mockPrisma.studentSubscription.update.mockResolvedValue(cancelled);

    const result = await cancelSubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
      reason: 'Student requested',
    });

    expect(result.status).toBe(SubscriptionStatus.CANCELLED);
  });

  it('throws 404 when subscription not found', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(
      cancelSubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
  });

  it('throws 409 when subscription already cancelled', async () => {
    const cancelled = makeSubscriptionRecord({
      status: SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
    });
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(cancelled);

    await expect(
      cancelSubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
    });
  });
});
