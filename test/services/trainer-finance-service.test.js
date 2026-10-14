import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';

vi.mock('../../src/services/subscription-cycle-service.js', () => ({
  ensureUpcomingCycles: vi.fn(),
}));

import { getFinanceOverview } from '../../src/services/trainer-finance-service.js';
import { ensureUpcomingCycles } from '../../src/services/subscription-cycle-service.js';
import {
  PaymentStatus,
  EffectivePaymentStatus,
  SubscriptionStatus,
  SubscriptionErrorCode,
} from '../../src/constants/subscription.js';

const { Decimal } = Prisma;

const TRAINER_USER_ID = 'trainer-user-1';
const TRAINER_ID = 'trainer-1';
// 12:00 BRT on 2026-06-10
const NOW = new Date('2026-06-10T15:00:00Z');
const TODAY = new Date('2026-06-10T00:00:00Z');

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  subscriptionPayment: { findMany: vi.fn() },
};

let paymentSeq = 0;
function makePayment({
  studentId = 'student-1',
  firstName = 'Ana',
  lastName = 'Silva',
  status = PaymentStatus.PENDING,
  dueDate = '2026-06-10',
  amount = '100.00',
  subscriptionStatus = SubscriptionStatus.ACTIVE,
  paidAt = null,
} = {}) {
  paymentSeq += 1;
  return {
    id: `payment-${paymentSeq}`,
    subscriptionId: `sub-${studentId}`,
    cycleIndex: paymentSeq,
    cycleStartDate: new Date(`${dueDate}T00:00:00Z`),
    cycleEndDate: new Date(`${dueDate}T00:00:00Z`),
    dueDate: new Date(`${dueDate}T00:00:00Z`),
    amount: new Decimal(amount),
    status,
    paidAt: paidAt ? new Date(paidAt) : null,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
    subscription: {
      status: subscriptionStatus,
      student: { id: studentId, firstName, lastName, avatarUrl: `key-${studentId}` },
      plan: { id: 'plan-1', name: 'Plano', recurrence: 'monthly' },
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  paymentSeq = 0;
  mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  ensureUpcomingCycles.mockResolvedValue({ subscriptionsChecked: 0, cyclesCreated: 0 });
});

describe('getFinanceOverview', () => {
  it('logs through the injected logger and still returns data when cycle generation fails', async () => {
    const failure = new Error('generator down');
    ensureUpcomingCycles.mockRejectedValue(failure);
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([makePayment()]);
    const logger = { error: vi.fn() };

    const result = await getFinanceOverview(
      mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW, logger },
    );

    expect(logger.error).toHaveBeenCalledOnce();
    expect(logger.error.mock.calls[0][0]).toEqual({ err: failure });
    expect(result.payments).toHaveLength(1);
  });

  it('falls back to console when no logger is injected and generation fails', async () => {
    ensureUpcomingCycles.mockRejectedValue(new Error('generator down'));
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(
      getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW }),
    ).resolves.toBeDefined();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('throws 404 TRAINER_NOT_FOUND when the user has no trainer profile', async () => {
    mockPrisma.trainer.findUnique.mockResolvedValue(null);

    await expect(
      getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW }),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.TRAINER_NOT_FOUND });
  });

  it('generates upcoming cycles scoped to the trainer BEFORE reading payments', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

    await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

    expect(ensureUpcomingCycles).toHaveBeenCalledWith(mockPrisma, {
      trainerId: TRAINER_ID,
      today: TODAY,
    });
    expect(ensureUpcomingCycles.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.subscriptionPayment.findMany.mock.invocationCallOrder[0],
    );
  });

  it('defaults the month to the current Sao Paulo month', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
    const justAfterUtcRollover = new Date('2026-07-01T01:00:00Z'); // still June 30 in SP

    const result = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, {}, { now: justAfterUtcRollover });

    expect(result.month).toBe('2026-06');
  });

  it('builds the row filter: paid in the SP month window, pending due before next month, or overdue', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

    await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-05' }, { now: NOW });

    const args = mockPrisma.subscriptionPayment.findMany.mock.calls[0][0];
    expect(args.where.subscription).toEqual({ trainerId: TRAINER_ID });
    expect(args.where.OR).toEqual([
      {
        status: PaymentStatus.PAID,
        paidAt: {
          gte: new Date('2026-05-01T03:00:00Z'),
          lt: new Date('2026-06-01T03:00:00Z'),
        },
      },
      { status: PaymentStatus.PENDING, dueDate: { lt: new Date('2026-06-01T00:00:00Z') } },
      { status: PaymentStatus.PENDING, dueDate: { lt: new Date('2026-06-07T00:00:00Z') } },
    ]);
  });

  it('reads payments with a single findMany that includes subscription, student and plan (fixed query budget)', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([makePayment()]);

    await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

    expect(mockPrisma.subscriptionPayment.findMany).toHaveBeenCalledOnce();
    const { include } = mockPrisma.subscriptionPayment.findMany.mock.calls[0][0];
    expect(include.subscription.select).toHaveProperty('student');
    expect(include.subscription.select).toHaveProperty('plan');
  });

  it('returns zeroed KPIs and delinquencyRate 0 (no division by zero) for an empty month', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

    const result = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

    expect(result.kpis).toEqual({
      receivedAmount: '0.00',
      receivedCount: 0,
      pendingAmount: '0.00',
      pendingCount: 0,
      overdueAmount: '0.00',
      overdueCount: 0,
      overdueStudents: 0,
      billedStudents: 0,
      delinquencyRate: 0,
    });
    expect(result.payments).toEqual([]);
  });

  describe('KPIs', () => {
    function mixedRows() {
      return [
        makePayment({ studentId: 'a', status: PaymentStatus.PAID, amount: '100.10', dueDate: '2026-06-01', paidAt: '2026-06-02T15:00:00Z' }),
        makePayment({ studentId: 'a', status: PaymentStatus.PAID, amount: '0.20', dueDate: '2026-06-03', paidAt: '2026-06-04T15:00:00Z' }),
        makePayment({ studentId: 'b', status: PaymentStatus.PENDING, amount: '50.00', dueDate: '2026-06-10' }),
        makePayment({ studentId: 'b', status: PaymentStatus.PENDING, amount: '25.50', dueDate: '2026-06-07' }), // today-3 => pending
        makePayment({ studentId: 'c', status: PaymentStatus.PENDING, amount: '70.00', dueDate: '2026-06-06' }), // today-4 => overdue
        makePayment({ studentId: 'c', status: PaymentStatus.PENDING, amount: '30.00', dueDate: '2026-04-01', subscriptionStatus: SubscriptionStatus.CANCELLED }),
      ];
    }

    it('sums amounts per effective status with Decimal precision', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue(mixedRows());

      const { kpis } = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

      expect(kpis).toMatchObject({
        receivedAmount: '100.30',
        receivedCount: 2,
        pendingAmount: '75.50',
        pendingCount: 2,
        overdueAmount: '100.00',
        overdueCount: 2,
      });
    });

    it('counts overdue debt of cancelled subscriptions', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue(mixedRows());

      const { payments } = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

      const cancelledSubRow = payments.find((row) => row.subscriptionStatus === SubscriptionStatus.CANCELLED);
      expect(cancelledSubRow.effectiveStatus).toBe(EffectivePaymentStatus.OVERDUE);
      expect(cancelledSubRow.daysOverdue).toBe(70);
    });

    it('computes distinct billed / overdue students and the delinquency percentage (2 dp)', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue(mixedRows());

      const { kpis } = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

      expect(kpis.billedStudents).toBe(3);
      expect(kpis.overdueStudents).toBe(1);
      expect(kpis.delinquencyRate).toBe(33.33);
    });

    it('reports delinquencyRate as a number between 0 and 100', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        makePayment({ studentId: 'a', dueDate: '2026-05-01' }),
      ]);

      const { kpis } = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

      expect(kpis.delinquencyRate).toBe(100);
      expect(typeof kpis.delinquencyRate).toBe('number');
    });
  });

  describe('rows', () => {
    it('shapes each row with student name/avatar, plan, subscriptionStatus and derived status fields', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        makePayment({ studentId: 'a', firstName: 'Ana', lastName: null, dueDate: '2026-06-01' }),
      ]);
      const resolveAvatarUrl = vi.fn(async (stored) => `https://cdn/${stored}`);

      const { payments } = await getFinanceOverview(
        mockPrisma,
        TRAINER_USER_ID,
        { month: '2026-06' },
        { now: NOW, resolveAvatarUrl },
      );

      expect(payments[0]).toMatchObject({
        dueDate: '2026-06-01',
        effectiveStatus: EffectivePaymentStatus.OVERDUE,
        daysOverdue: 9,
        subscriptionStatus: SubscriptionStatus.ACTIVE,
        student: { id: 'a', name: 'Ana', avatarUrl: 'https://cdn/key-a' },
        plan: { id: 'plan-1', name: 'Plano', recurrence: 'monthly' },
      });
    });

    it('resolves each student avatar once even with several rows per student', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        makePayment({ studentId: 'a' }),
        makePayment({ studentId: 'a' }),
        makePayment({ studentId: 'b' }),
      ]);
      const resolveAvatarUrl = vi.fn(async (stored) => stored);

      await getFinanceOverview(
        mockPrisma,
        TRAINER_USER_ID,
        { month: '2026-06' },
        { now: NOW, resolveAvatarUrl },
      );

      expect(resolveAvatarUrl).toHaveBeenCalledTimes(2);
    });

    it('resolves avatars concurrently (all calls started before the first one settles)', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
        makePayment({ studentId: 'a' }),
        makePayment({ studentId: 'b' }),
        makePayment({ studentId: 'c' }),
      ]);
      let startedBeforeFirstSettled = 0;
      let anySettled = false;
      const resolveAvatarUrl = vi.fn(async (stored) => {
        if (!anySettled) startedBeforeFirstSettled += 1;
        await Promise.resolve();
        anySettled = true;
        return stored;
      });

      await getFinanceOverview(
        mockPrisma,
        TRAINER_USER_ID,
        { month: '2026-06' },
        { now: NOW, resolveAvatarUrl },
      );

      expect(startedBeforeFirstSettled).toBe(3);
    });

    it('falls back to the stored avatar value when no resolver is injected', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([makePayment({ studentId: 'a' })]);

      const { payments } = await getFinanceOverview(mockPrisma, TRAINER_USER_ID, { month: '2026-06' }, { now: NOW });

      expect(payments[0].student.avatarUrl).toBe('key-a');
    });
  });
});
