import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
} from '../../src/constants/subscription.js';

import { formatDateOnly } from '../../src/helpers/date-helpers.js';

const { Decimal } = Prisma;

// Mock platform-plan-service — gating is tested separately
vi.mock('../../src/services/platform-plan-service.js', () => ({
  assertStudentActiveOnPlan: vi.fn().mockResolvedValue(undefined),
}));

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockTx = {
  $queryRaw: vi.fn(),
  $executeRaw: vi.fn(),
  trainerStudent: { findFirst: vi.fn() },
  studentSubscription: {
    findMany: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  subscriptionPayment: {
    create: vi.fn(),
    updateMany: vi.fn(),
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
    billingDay: null,
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
    billingDay: null,
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
    cycleIndex: 0,
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
  mockTx.$queryRaw.mockResolvedValue([{ locked: true }]);
  mockTx.$executeRaw.mockResolvedValue(0);
  mockTx.trainerStudent.findFirst.mockResolvedValue({ id: 'link-uuid' });
  mockTx.studentSubscription.findMany.mockResolvedValue([]);
  mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 0 });
  mockTx.studentSubscription.create.mockResolvedValue(makeSubscriptionRecord());
  mockTx.subscriptionPayment.create.mockResolvedValue(makePaymentRecord());
  mockTx.subscriptionPayment.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.$transaction.mockImplementation(async (fn) => fn(mockTx));
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

  it('rounds half-up to 2 decimals: 99.90 with 33.33% discount => 66.60', () => {
    const result = computeAmount(new Decimal('99.90'), new Decimal('33.33'), null);
    expect(result.toFixed(2)).toBe('66.60');
  });

  it('rounds the exact .005 midpoint up (0.01 with 50% discount => 0.01)', () => {
    const result = computeAmount(new Decimal('0.01'), new Decimal('50'), null);
    expect(result.toFixed(2)).toBe('0.01');
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

  it('creates subscription and first payment in a transaction without replacing when none is active', async () => {
    const result = await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(mockTx.studentSubscription.updateMany).not.toHaveBeenCalled();
    expect(mockTx.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.studentSubscription.create).toHaveBeenCalledOnce();
    expect(mockTx.subscriptionPayment.create).toHaveBeenCalledOnce();
    expect(result.id).toBe(SUBSCRIPTION_ID);
    expect(result.firstPayment.status).toBe(PaymentStatus.PENDING);
  });

  it('rejects a discountPercent override with more than 2 decimals before opening the transaction', async () => {
    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
        discountPercent: 33.333,
      }),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
      messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('accepts a discountPercent override with exactly 2 decimals', async () => {
    await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
      discountPercent: 33.33,
    });

    expect(mockTx.studentSubscription.create).toHaveBeenCalledOnce();
  });

  it('cancels the found active subscriptions by id (not by a re-evaluated filter) before creating the new one', async () => {
    mockTx.studentSubscription.findMany.mockResolvedValue([{ id: 'old-1' }, { id: 'old-2' }]);
    const now = new Date('2026-06-11T02:00:00Z');

    await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-06-10' }, now,
    );

    expect(mockTx.studentSubscription.findMany).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: STUDENT_ID, status: SubscriptionStatus.ACTIVE },
      select: {
        id: true,
        startDate: true,
        recurrence: true,
        price: true,
        discountPercent: true,
        discountAmount: true,
        billingDay: true,
      },
    });
    const call = mockTx.studentSubscription.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ id: { in: ['old-1', 'old-2'] } });
    expect(call.data).toMatchObject({ status: SubscriptionStatus.CANCELLED, cancelledAt: now });
    expect(mockTx.studentSubscription.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.studentSubscription.create.mock.invocationCallOrder[0],
    );
  });

  it('voids only the replaced subscriptions pending payments whose effective start is on/after the new cut-off, stamping voidedAt', async () => {
    mockTx.studentSubscription.findMany.mockResolvedValue([{ id: 'old-1' }]);
    const now = new Date('2026-06-11T02:00:00Z'); // still Jun 10 in Sao Paulo

    await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-06-10' }, now,
    );

    expect(mockTx.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: {
        status: PaymentStatus.PENDING,
        subscription: { id: { in: ['old-1'] } },
        OR: [
          { cycleStartDate: { gte: new Date('2026-06-10T00:00:00Z') } },
          { subscription: { startDate: { gte: new Date('2026-06-10T00:00:00Z') } } },
        ],
      },
      data: { status: PaymentStatus.CANCELLED, voidedAt: now },
    });
    expect(mockTx.subscriptionPayment.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.studentSubscription.create.mock.invocationCallOrder[0],
    );
  });

  it('uses the new first cycle start (future start date) as the only void cut-off', async () => {
    mockTx.studentSubscription.findMany.mockResolvedValue([makeSubscriptionRecord({ id: 'old-1' })]);
    const now = new Date('2026-06-10T15:00:00Z');

    await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-06-25' }, now,
    );

    const { where } = mockTx.subscriptionPayment.updateMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { cycleStartDate: { gte: new Date('2026-06-25T00:00:00Z') } },
      { subscription: { startDate: { gte: new Date('2026-06-25T00:00:00Z') } } },
    ]);
    expect(JSON.stringify(where)).not.toContain('2026-06-10T00:00:00.000Z');
  });

  describe('materializing the replaced plan cycles before cancelling it', () => {
    const NOW = new Date('2026-06-10T15:00:00Z'); // today = 2026-06-10 in Sao Paulo
    const REPLACED = {
      id: 'old-1',
      startDate: new Date('2026-06-05T12:00:00Z'),
      recurrence: 'monthly',
      price: new Decimal('100.00'),
      discountPercent: null,
      discountAmount: null,
    };
    const VALUES_PER_ROW = 7;

    function mockLockThenLatestCycle() {
      mockTx.$queryRaw
        .mockResolvedValueOnce([{ locked: true }])
        .mockResolvedValueOnce([
          { subscriptionId: 'old-1', cycleIndex: 0, cycleEndDate: new Date('2026-07-04T00:00:00Z') },
        ]);
    }

    it('inserts the old plan cycles starting in [today+1, newStart) before the subscription is cancelled', async () => {
      mockTx.studentSubscription.findMany.mockResolvedValue([REPLACED]);
      mockLockThenLatestCycle();

      await assignPlanToStudent(
        mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-07-20' }, NOW,
      );

      expect(mockTx.$executeRaw).toHaveBeenCalledOnce();
      const joined = mockTx.$executeRaw.mock.calls[0][2];
      expect(joined.values.length).toBe(VALUES_PER_ROW);
      const [subscriptionId, cycleIndex, cycleStartDate] = joined.values;
      expect(subscriptionId).toBe('old-1');
      expect(cycleIndex).toBe(1);
      expect(cycleStartDate).toBe('2026-07-05');
      expect(mockTx.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        mockTx.studentSubscription.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('does not insert a cycle starting on/after the new first cycle', async () => {
      mockTx.studentSubscription.findMany.mockResolvedValue([REPLACED]);
      mockLockThenLatestCycle();

      // New start == the old plan's next cycle start (2026-07-05): generation limit is 07-04.
      await assignPlanToStudent(
        mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-07-05' }, NOW,
      );

      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['today', '2026-06-10'],
      ['a backdated day', '2026-05-20'],
    ])('does not materialize anything when the new start is %s', async (_label, startDate) => {
      mockTx.studentSubscription.findMany.mockResolvedValue([REPLACED]);

      await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate }, NOW);

      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
      expect(mockTx.$queryRaw).toHaveBeenCalledOnce(); // advisory lock only
    });

    it('does not materialize anything when no subscription is being replaced', async () => {
      mockTx.studentSubscription.findMany.mockResolvedValue([]);

      await assignPlanToStudent(
        mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-07-20' }, NOW,
      );

      expect(mockTx.$executeRaw).not.toHaveBeenCalled();
    });
  });

  it('creates the first payment with cycleIndex 0 anchored on startDate and rounded amount', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(
      makePlanRecord({ price: new Decimal('99.90'), discountPercent: new Decimal('33.33') }),
    );

    await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID,
      { planId: PLAN_ID, startDate: '2026-01-31' },
      new Date('2026-01-31T15:00:00Z'),
    );

    const { data } = mockTx.subscriptionPayment.create.mock.calls[0][0];
    expect(data.cycleIndex).toBe(0);
    expect(formatDateOnly(data.cycleStartDate)).toBe('2026-01-31');
    expect(formatDateOnly(data.cycleEndDate)).toBe('2026-02-27');
    expect(formatDateOnly(data.dueDate)).toBe('2026-01-31');
    expect(data.amount.toFixed(2)).toBe('66.60');
  });

  it('for a backdated start bills the grid cycle containing today (never a stale cycle 0), anchored on startDate', async () => {
    const now = new Date('2026-06-10T15:00:00Z');

    await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-03-15' }, now,
    );

    const { data: paymentData } = mockTx.subscriptionPayment.create.mock.calls[0][0];
    expect(paymentData.cycleIndex).toBe(2);
    expect(formatDateOnly(paymentData.cycleStartDate)).toBe('2026-05-15');
    expect(formatDateOnly(paymentData.cycleEndDate)).toBe('2026-06-14');
    expect(formatDateOnly(paymentData.dueDate)).toBe('2026-05-15');
    const { data: subData } = mockTx.studentSubscription.create.mock.calls[0][0];
    expect(formatDateOnly(subData.startDate)).toBe('2026-03-15');
  });

  describe('billingDay', () => {
    const NOW_OCT_10 = new Date('2026-10-10T15:00:00Z');

    function assignOn(startDate, data = {}, now = NOW_OCT_10) {
      return assignPlanToStudent(
        mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate, ...data }, now,
      );
    }

    function createdSubscriptionData() {
      return mockTx.studentSubscription.create.mock.calls[0][0].data;
    }

    function createdPaymentData() {
      return mockTx.subscriptionPayment.create.mock.calls[0][0].data;
    }

    describe('which billingDay is stored on the subscription', () => {
      it('stores the plan billingDay when the body has no override', async () => {
        mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord({ billingDay: 5 }));

        await assignOn('2026-10-10');

        expect(createdSubscriptionData().billingDay).toBe(5);
      });

      it('stores the body override instead of the plan billingDay', async () => {
        mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord({ billingDay: 5 }));

        await assignOn('2026-10-10', { billingDay: 20 });

        expect(createdSubscriptionData().billingDay).toBe(20);
      });

      it('stores the body override when the plan has no billingDay', async () => {
        await assignOn('2026-10-10', { billingDay: 28 });

        expect(createdSubscriptionData().billingDay).toBe(28);
      });

      it('stores null when neither the body nor the plan define a billingDay (legacy: day of startDate)', async () => {
        await assignOn('2026-10-10');

        expect(createdSubscriptionData().billingDay).toBeNull();
      });
    });

    describe('first cycle and dueDate', () => {
      it('aligns cycle 0 to the billingDay and uses startDate as dueDate when the cycle starts before it (S=Oct 10, D=5)', async () => {
        await assignOn('2026-10-10', { billingDay: 5 });

        const payment = createdPaymentData();
        expect(payment.cycleIndex).toBe(0);
        expect(formatDateOnly(payment.cycleStartDate)).toBe('2026-10-05');
        expect(formatDateOnly(payment.cycleEndDate)).toBe('2026-11-04');
        expect(formatDateOnly(payment.dueDate)).toBe('2026-10-10');
      });

      it('dueDate equals startDate (not the cycle start) when the aligned cycle starts in the previous month (S=Oct 3, D=5)', async () => {
        await assignOn('2026-10-03', { billingDay: 5 }, new Date('2026-10-03T15:00:00Z'));

        const payment = createdPaymentData();
        expect(formatDateOnly(payment.cycleStartDate)).toBe('2026-09-05');
        expect(formatDateOnly(payment.cycleEndDate)).toBe('2026-10-04');
        expect(formatDateOnly(payment.dueDate)).toBe('2026-10-03');
      });

      it('dueDate equals the cycle start when startDate is the billing day itself (S=D=Oct 5)', async () => {
        await assignOn('2026-10-05', { billingDay: 5 }, new Date('2026-10-05T15:00:00Z'));

        const payment = createdPaymentData();
        expect(formatDateOnly(payment.cycleStartDate)).toBe('2026-10-05');
        expect(formatDateOnly(payment.dueDate)).toBe('2026-10-05');
      });

      it('clamps a month-end billing day (S=Mar 15 2026, D=31 => cycle Feb 28..Mar 30, dueDate Mar 15)', async () => {
        await assignOn('2026-03-15', { billingDay: 31 }, new Date('2026-03-15T15:00:00Z'));

        const payment = createdPaymentData();
        expect(formatDateOnly(payment.cycleStartDate)).toBe('2026-02-28');
        expect(formatDateOnly(payment.cycleEndDate)).toBe('2026-03-30');
        expect(formatDateOnly(payment.dueDate)).toBe('2026-03-15');
      });

      it('uses the plan billingDay for the first cycle when the body has no override', async () => {
        mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord({ billingDay: 5 }));

        await assignOn('2026-10-10');

        expect(formatDateOnly(createdPaymentData().cycleStartDate)).toBe('2026-10-05');
      });

      it('billingDay null keeps the legacy cycle anchored on startDate with dueDate = cycle start', async () => {
        await assignOn('2026-10-10');

        const payment = createdPaymentData();
        expect(formatDateOnly(payment.cycleStartDate)).toBe('2026-10-10');
        expect(formatDateOnly(payment.cycleEndDate)).toBe('2026-11-09');
        expect(formatDateOnly(payment.dueDate)).toBe('2026-10-10');
      });

      it('backdated start bills the aligned grid cycle containing today, with dueDate = that cycle start (S=Mar 10, D=5, today Jun 10)', async () => {
        await assignOn('2026-03-10', { billingDay: 5 }, new Date('2026-06-10T15:00:00Z'));

        const payment = createdPaymentData();
        expect(payment.cycleIndex).toBe(3);
        expect(formatDateOnly(payment.cycleStartDate)).toBe('2026-06-05');
        expect(formatDateOnly(payment.cycleEndDate)).toBe('2026-07-04');
        expect(formatDateOnly(payment.dueDate)).toBe('2026-06-05');
      });
    });

    describe('replacing a subscription', () => {
      const NOW = new Date('2026-06-10T15:00:00Z');

      it('cuts the voiding of the replaced plan at the new subscription effective start, not the aligned cycle start (S=Jul 20, D=5 => Jul 20)', async () => {
        mockTx.studentSubscription.findMany.mockResolvedValue([
          makeSubscriptionRecord({ id: 'old-1', startDate: new Date('2026-06-05T00:00:00Z') }),
        ]);

        await assignOn('2026-07-20', { billingDay: 5 }, NOW);

        const { where } = mockTx.subscriptionPayment.updateMany.mock.calls[0][0];
        const serializedWhere = JSON.stringify(where);
        expect(serializedWhere).toContain('2026-07-20T00:00:00.000Z');
        expect(serializedWhere).not.toContain('2026-07-05T00:00:00.000Z');
      });

      it('materializes the replaced plan cycles using the replaced subscription billingDay', async () => {
        const replaced = {
          id: 'old-1',
          startDate: new Date('2026-06-20T00:00:00Z'),
          recurrence: 'monthly',
          price: new Decimal('100.00'),
          discountPercent: null,
          discountAmount: null,
          billingDay: 5,
        };
        mockTx.studentSubscription.findMany.mockResolvedValue([replaced]);
        mockTx.$queryRaw
          .mockResolvedValueOnce([{ locked: true }])
          .mockResolvedValueOnce([
            { subscriptionId: 'old-1', cycleIndex: 0, cycleEndDate: new Date('2026-07-04T00:00:00Z') },
          ]);

        await assignOn('2026-07-20', {}, NOW);

        expect(mockTx.$executeRaw).toHaveBeenCalledOnce();
        const [subscriptionId, cycleIndex, cycleStartDate, cycleEndDate, dueDate] =
          mockTx.$executeRaw.mock.calls[0][2].values;
        expect(subscriptionId).toBe('old-1');
        expect(cycleIndex).toBe(1);
        expect(cycleStartDate).toBe('2026-07-05');
        expect(cycleEndDate).toBe('2026-08-04');
        expect(dueDate).toBe('2026-07-05');
      });
    });
  });

  it('maps a unique violation (concurrent assign) to 409 SUBSCRIPTION_ALREADY_ACTIVE', async () => {
    mockPrisma.$transaction.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.SUBSCRIPTION_ALREADY_ACTIVE,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_ALREADY_ACTIVE,
    });
  });

  it('takes the per-pair advisory try-lock before replacing or creating anything', async () => {
    await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    expect(mockTx.$queryRaw).toHaveBeenCalledOnce();
    const [strings, lockKey] = mockTx.$queryRaw.mock.calls[0];
    expect(strings.join('?')).toContain('pg_try_advisory_xact_lock');
    expect(lockKey).toContain(TRAINER_ID);
    expect(lockKey).toContain(STUDENT_ID);
    expect(mockTx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mockTx.studentSubscription.findMany.mock.invocationCallOrder[0],
    );
  });

  it('re-checks the trainer-student link inside the transaction, after the lock and before any write', async () => {
    await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    expect(mockTx.trainerStudent.findFirst).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID, studentId: STUDENT_ID },
    });
    const recheck = mockTx.trainerStudent.findFirst.mock.invocationCallOrder[0];
    expect(mockTx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(mockTx.studentSubscription.findMany.mock.invocationCallOrder[0]);
    expect(recheck).toBeLessThan(mockTx.studentSubscription.create.mock.invocationCallOrder[0]);
  });

  it('answers 403 SUBSCRIPTION_STUDENT_NOT_LINKED and writes nothing when an unlink committed before the in-transaction re-check', async () => {
    mockTx.trainerStudent.findFirst.mockResolvedValue(null);

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({
      httpStatus: 403,
      error: SubscriptionErrorCode.STUDENT_NOT_LINKED,
      messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
    });
    expect(mockTx.studentSubscription.updateMany).not.toHaveBeenCalled();
    expect(mockTx.studentSubscription.create).not.toHaveBeenCalled();
    expect(mockTx.subscriptionPayment.create).not.toHaveBeenCalled();
  });

  it('answers 409 SUBSCRIPTION_ALREADY_ACTIVE without touching any row when the advisory lock is already held', async () => {
    mockTx.$queryRaw.mockResolvedValue([{ locked: false }]);

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.SUBSCRIPTION_ALREADY_ACTIVE,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_ALREADY_ACTIVE,
      message: expect.not.stringMatching(/try again/i),
    });
    expect(mockTx.studentSubscription.updateMany).not.toHaveBeenCalled();
    expect(mockTx.studentSubscription.create).not.toHaveBeenCalled();
    expect(mockTx.subscriptionPayment.create).not.toHaveBeenCalled();
    expect(mockTx.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('scopes the replacement to the same trainer (a second trainer\'s subscription is never cancelled)', async () => {
    await assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
      planId: PLAN_ID,
      startDate: '2026-05-01',
    });

    expect(mockTx.studentSubscription.findMany.mock.calls[0][0].where).toEqual({
      trainerId: TRAINER_ID,
      studentId: STUDENT_ID,
      status: SubscriptionStatus.ACTIVE,
    });
  });

  it('rethrows non-unique transaction errors untouched', async () => {
    const boom = new Error('db down');
    mockPrisma.$transaction.mockRejectedValue(boom);

    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
      }),
    ).rejects.toBe(boom);
  });

  it('rejects a discountAmount override with more than 2 decimals with 400 SUBSCRIPTION_INVALID_AMOUNT', async () => {
    await expect(
      assignPlanToStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, {
        planId: PLAN_ID,
        startDate: '2026-05-01',
        discountAmount: 1.005,
      }),
    ).rejects.toMatchObject({ httpStatus: 400, error: SubscriptionErrorCode.INVALID_AMOUNT });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
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

  it('does not require a live trainer-student link (history survives unlink)', async () => {
    mockPrisma.trainerStudent.findFirst.mockResolvedValue(null);
    mockPrisma.studentSubscription.findMany.mockResolvedValue([makeSubscriptionRecord()]);

    const result = await listSubscriptionsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID);

    expect(result).toHaveLength(1);
    expect(mockPrisma.trainerStudent.findFirst).not.toHaveBeenCalled();
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
  const cancelledRecord = () =>
    makeSubscriptionRecord({ status: SubscriptionStatus.CANCELLED, cancelledAt: new Date() });

  it('cancels an active subscription with a conditional updateMany then re-reads it', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(makeSubscriptionRecord());
    mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 1 });
    mockTx.studentSubscription.findUniqueOrThrow.mockResolvedValue(cancelledRecord());
    const now = new Date('2026-06-10T15:00:00Z');

    const result = await cancelSubscription(
      mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, { reason: 'Student requested' }, now,
    );

    expect(mockTx.studentSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: SUBSCRIPTION_ID, status: SubscriptionStatus.ACTIVE },
      data: {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: now,
        cancellationReason: 'Student requested',
      },
    });
    expect(mockTx.studentSubscription.findUniqueOrThrow).toHaveBeenCalledWith({
      where: { id: SUBSCRIPTION_ID },
    });
    expect(result.status).toBe(SubscriptionStatus.CANCELLED);
  });

  it('voids upcoming pending payments (cycleStartDate > today SP) stamping voidedAt in the same transaction', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(makeSubscriptionRecord());
    mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 1 });
    mockTx.studentSubscription.findUniqueOrThrow.mockResolvedValue(cancelledRecord());
    // 02:00 UTC on Jun 11 is still Jun 10 in Sao Paulo
    const now = new Date('2026-06-11T02:00:00Z');

    await cancelSubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, now);

    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
    expect(mockTx.subscriptionPayment.updateMany).toHaveBeenCalledOnce();
    expect(mockTx.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: {
        status: PaymentStatus.PENDING,
        subscription: { id: SUBSCRIPTION_ID },
        OR: [
          { cycleStartDate: { gt: new Date('2026-06-10T00:00:00Z') } },
          { subscription: { startDate: { gt: new Date('2026-06-10T00:00:00Z') } } },
        ],
      },
      data: { status: PaymentStatus.CANCELLED, voidedAt: now },
    });
  });

  it('answers 409 CANNOT_EDIT_CANCELLED and voids nothing when a concurrent cancel won (updateMany count 0)', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(makeSubscriptionRecord());
    mockTx.studentSubscription.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      cancelSubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
      messageCode: SubscriptionMessageCode.CANNOT_EDIT_CANCELLED,
    });
    expect(mockTx.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(mockTx.studentSubscription.findUniqueOrThrow).not.toHaveBeenCalled();
  });

  it('does not open a transaction when the subscription is already cancelled', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(cancelledRecord());

    await expect(
      cancelSubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.CANNOT_EDIT_CANCELLED,
    });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockTx.subscriptionPayment.updateMany).not.toHaveBeenCalled();
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
});

// ─── billingDay in subscription responses ─────────────────────────────────────

describe('subscription responses expose the effective billingDay', () => {
  const LEGACY_START_DAY = 17;

  function legacyRecord() {
    return makeSubscriptionRecord({
      billingDay: null,
      startDate: new Date(`2026-05-${LEGACY_START_DAY}T00:00:00Z`),
    });
  }

  it('assign returns the stored billingDay', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());
    mockTx.studentSubscription.create.mockResolvedValue(
      makeSubscriptionRecord({ billingDay: 5, startDate: new Date('2026-10-10T00:00:00Z') }),
    );

    const result = await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-10-10', billingDay: 5 },
    );

    expect(result.billingDay).toBe(5);
  });

  it('assign returns the day of startDate for a subscription stored without billingDay', async () => {
    mockPrisma.subscriptionPlan.findFirst.mockResolvedValue(makePlanRecord());
    mockTx.studentSubscription.create.mockResolvedValue(legacyRecord());

    const result = await assignPlanToStudent(
      mockPrisma, TRAINER_USER_ID, STUDENT_ID, { planId: PLAN_ID, startDate: '2026-05-17' },
    );

    expect(result.billingDay).toBe(LEGACY_START_DAY);
  });

  it('listSubscriptionsByStudent returns stored and legacy (day of startDate) billing days', async () => {
    mockPrisma.studentSubscription.findMany.mockResolvedValue([
      makeSubscriptionRecord({ id: 'with-day', billingDay: 31 }),
      { ...legacyRecord(), id: 'legacy' },
    ]);

    const result = await listSubscriptionsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID);

    expect(result.map((subscription) => subscription.billingDay)).toEqual([31, LEGACY_START_DAY]);
  });

  it('getActiveSubscriptionByStudent returns the effective billingDay', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(legacyRecord());

    const result = await getActiveSubscriptionByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID);

    expect(result.billingDay).toBe(LEGACY_START_DAY);
  });
});
