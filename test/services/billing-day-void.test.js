import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { SubscriptionStatus, PaymentStatus } from '../../src/constants/subscription.js';

const { Decimal } = Prisma;

vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

const mockTx = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  trainer: { findUnique: vi.fn() },
  nutritionist: { findFirst: vi.fn() },
  trainerStudent: { findFirst: vi.fn() },
  studentSubscription: { findMany: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  subscriptionPayment: { create: vi.fn(), updateMany: vi.fn() },
};

const mockPrisma = {
  trainerStudent: { findFirst: vi.fn() },
  subscriptionPlan: { findFirst: vi.fn() },
  $transaction: vi.fn(async (fn) => fn(mockTx)),
};

import { assignPlanToStudent } from '../../src/services/student-subscription-service.js';

const TRAINER_USER_ID = 'trainer-user-uuid';
const TRAINER_ID = 'trainer-record-uuid';
const OWNER = { userId: TRAINER_USER_ID, trainerId: TRAINER_ID, nutritionistId: null };
const STUDENT_ID = 'student-uuid-1';
const PLAN_ID = 'plan-uuid-1';
const NOW = new Date('2026-06-10T15:00:00Z');
const OLD_SUBSCRIPTION_ID = 'old-1';

// Plan row as returned by the plan lookup.
function makePlan(overrides = {}) {
  return {
    id: PLAN_ID,
    trainerId: TRAINER_ID,
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
    deletedAt: null,
    ...overrides,
  };
}

// Active subscription being replaced: monthly, started May 12, legacy billing day.
function makeOldSubscription() {
  return {
    id: OLD_SUBSCRIPTION_ID,
    startDate: new Date('2026-05-12T00:00:00Z'),
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
  };
}

// Assigns the plan with the clock fixed at NOW.
function assignOn(startDate, data = {}) {
  return assignPlanToStudent(
    mockPrisma, OWNER, STUDENT_ID, { planId: PLAN_ID, startDate, ...data }, NOW,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.trainerStudent.findFirst.mockResolvedValue({ id: 'link-uuid' });
  mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlan());
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
  mockTx.trainerStudent.findFirst.mockResolvedValue({ id: 'link-uuid' });
  mockTx.$executeRaw.mockResolvedValue(0);
  mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 1 });
  mockTx.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });
  mockTx.studentSubscription.create.mockResolvedValue({
    id: 'new-1', startDate: new Date('2026-06-18T00:00:00Z'), status: SubscriptionStatus.ACTIVE,
    recurrence: 'monthly', price: new Decimal('100.00'), billingDay: null,
  });
  mockTx.subscriptionPayment.create.mockResolvedValue({
    id: 'pay-1', status: PaymentStatus.PENDING, amount: new Decimal('100.00'),
    cycleStartDate: new Date('2026-06-05T00:00:00Z'), cycleEndDate: new Date('2026-07-04T00:00:00Z'),
    dueDate: new Date('2026-06-18T00:00:00Z'),
  });
  mockTx.studentSubscription.findMany.mockResolvedValue([makeOldSubscription()]);
  mockTx.$queryRaw
    .mockResolvedValueOnce([{ locked: true }])
    .mockResolvedValueOnce([
      { subscriptionId: OLD_SUBSCRIPTION_ID, cycleIndex: 0, cycleEndDate: new Date('2026-06-11T00:00:00Z') },
    ]);
});

describe('replace with a future-dated start whose aligned cycle 0 starts before today (today Jun 10, S=Jun 18, D=5)', () => {
  it('materializes the old plan cycles starting in [today+1, S-1] because the effective start is S, not Jun 5', async () => {
    await assignOn('2026-06-18', { billingDay: 5 });

    expect(mockTx.$executeRaw).toHaveBeenCalledOnce();
    const [subscriptionId, cycleIndex, cycleStartDate] = mockTx.$executeRaw.mock.calls[0][2].values;
    expect(subscriptionId).toBe(OLD_SUBSCRIPTION_ID);
    expect(cycleIndex).toBe(1);
    expect(cycleStartDate).toBe('2026-06-12');
  });

  it('voids the old plan pending charges from the effective start S (Jun 18), not from the aligned cycle start (Jun 5)', async () => {
    await assignOn('2026-06-18', { billingDay: 5 });

    const serializedWhere = JSON.stringify(mockTx.subscriptionPayment.updateMany.mock.calls[0][0].where);
    expect(serializedWhere).toContain('2026-06-18T00:00:00.000Z');
    expect(serializedWhere).not.toContain('2026-06-05T00:00:00.000Z');
  });
});

describe('replace with a legacy (billingDay null) future-dated start (regression)', () => {
  it('voids from S and materializes the old plan cycles up to S-1', async () => {
    await assignOn('2026-06-18');

    const serializedWhere = JSON.stringify(mockTx.subscriptionPayment.updateMany.mock.calls[0][0].where);
    expect(serializedWhere).toContain('2026-06-18T00:00:00.000Z');
    expect(mockTx.$executeRaw).toHaveBeenCalledOnce();
  });
});
