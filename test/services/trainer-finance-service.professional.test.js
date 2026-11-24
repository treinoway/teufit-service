import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { getFinanceOverview } from '../../src/services/trainer-finance-service.js';
import { ensureUpcomingCycles } from '../../src/services/subscription-cycle-service.js';
import { PaymentStatus, SubscriptionStatus } from '../../src/constants/subscription.js';
import {
  ServiceType,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  nutritionistOwner,
  dualOwner,
} from '../helpers/subscription-owner-fixtures.js';

vi.mock('../../src/services/subscription-cycle-service.js', () => ({
  ensureUpcomingCycles: vi.fn(),
}));

const { Decimal } = Prisma;
const NOW = new Date('2026-06-10T15:00:00Z');
const TODAY = new Date('2026-06-10T00:00:00Z');
const MONTH = '2026-06';

const mockPrisma = {
  subscriptionPayment: { findMany: vi.fn() },
};

let paymentSeq = 0;
// Builds a payment row of the overview include shape, tagged with the subscription service type.
function makePayment({ serviceType, studentId, status = PaymentStatus.PENDING, dueDate = '2026-06-10', amount = '100.00' }) {
  paymentSeq += 1;
  return {
    id: `payment-${paymentSeq}`,
    subscriptionId: `sub-${paymentSeq}`,
    cycleIndex: paymentSeq,
    cycleStartDate: new Date(`${dueDate}T00:00:00Z`),
    cycleEndDate: new Date(`${dueDate}T00:00:00Z`),
    dueDate: new Date(`${dueDate}T00:00:00Z`),
    amount: new Decimal(amount),
    status,
    paidAt: status === PaymentStatus.PAID ? new Date('2026-06-05T15:00:00Z') : null,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
    subscription: {
      status: SubscriptionStatus.ACTIVE,
      serviceType,
      student: { id: studentId, firstName: 'Ana', lastName: studentId, avatarUrl: null },
      plan: { id: 'plan-1', name: 'Plano', recurrence: 'monthly' },
    },
  };
}

beforeEach(() => {
  paymentSeq = 0;
  ensureUpcomingCycles.mockResolvedValue({ subscriptionsChecked: 0, cyclesCreated: 0 });
  mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
});

describe('getFinanceOverview with an owner object (AC 9)', () => {
  it('should scope the payments query to both owner rows of a dual-role owner', async () => {
    await getFinanceOverview(mockPrisma, dualOwner(), { month: MONTH }, { now: NOW });

    const { subscription } = mockPrisma.subscriptionPayment.findMany.mock.calls[0][0].where;
    expect(subscription.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('should scope the payments query to the nutritionist rows of a nutritionist-only owner', async () => {
    await getFinanceOverview(mockPrisma, nutritionistOwner(), { month: MONTH }, { now: NOW });

    expect(mockPrisma.subscriptionPayment.findMany.mock.calls[0][0].where.subscription).toEqual({
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });

  it('should generate upcoming cycles for the whole owner before reading payments', async () => {
    const owner = dualOwner();

    await getFinanceOverview(mockPrisma, owner, { month: MONTH }, { now: NOW });

    expect(ensureUpcomingCycles).toHaveBeenCalledWith(mockPrisma, { owner, today: TODAY });
    expect(ensureUpcomingCycles.mock.invocationCallOrder[0]).toBeLessThan(
      mockPrisma.subscriptionPayment.findMany.mock.invocationCallOrder[0],
    );
  });

  it('should request serviceType in the subscription select', async () => {
    await getFinanceOverview(mockPrisma, dualOwner(), { month: MONTH }, { now: NOW });

    const { include } = mockPrisma.subscriptionPayment.findMany.mock.calls[0][0];
    expect(include.subscription.select.serviceType).toBe(true);
  });

  it('should carry the serviceType of each payment subscription on the rows', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
      makePayment({ serviceType: ServiceType.TRAINING, studentId: 'student-a' }),
      makePayment({ serviceType: ServiceType.NUTRITION, studentId: 'student-b' }),
      makePayment({ serviceType: ServiceType.BOTH, studentId: 'student-c' }),
    ]);

    const { payments } = await getFinanceOverview(mockPrisma, dualOwner(), { month: MONTH }, { now: NOW });

    expect(payments.map((payment) => payment.serviceType)).toEqual([
      ServiceType.TRAINING,
      ServiceType.NUTRITION,
      ServiceType.BOTH,
    ]);
  });

  it('should sum KPIs across the trainer and nutritionist rows', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
      makePayment({ serviceType: ServiceType.TRAINING, studentId: 'student-a', status: PaymentStatus.PAID, amount: '120.00' }),
      makePayment({ serviceType: ServiceType.NUTRITION, studentId: 'student-b', status: PaymentStatus.PAID, amount: '80.00' }),
      makePayment({ serviceType: ServiceType.NUTRITION, studentId: 'student-c', dueDate: '2026-06-01', amount: '50.00' }),
    ]);

    const { kpis } = await getFinanceOverview(mockPrisma, dualOwner(), { month: MONTH }, { now: NOW });

    expect(kpis).toMatchObject({
      receivedAmount: '200.00',
      receivedCount: 2,
      overdueAmount: '50.00',
      overdueCount: 1,
      billedStudents: 3,
    });
  });
});
