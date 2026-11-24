import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SubscriptionStatus,
  PaymentStatus,
} from '../../src/constants/subscription.js';
import {
  createPayment,
  listPaymentsBySubscription,
  listPaymentsByStudent,
  markPaymentPaid,
  markPaymentPending,
  updatePayment,
  voidPayment,
} from '../../src/services/subscription-payment-service.js';
import {
  ServiceType,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  nutritionistOwner,
  dualOwner,
} from '../helpers/subscription-owner-fixtures.js';

const { Decimal } = Prisma;
const SUBSCRIPTION_ID = 'sub-uuid-1';
const PAYMENT_ID = 'payment-uuid-1';
const STUDENT_ID = 'student-uuid-1';
const NOW = new Date('2026-06-10T15:00:00Z');
const NOT_FOUND = 404;

const mockPrisma = {
  studentSubscription: { findFirst: vi.fn() },
  trainerStudent: { findFirst: vi.fn(), findUnique: vi.fn() },
  nutritionistPatient: { findFirst: vi.fn(), findUnique: vi.fn() },
  subscriptionPayment: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  $executeRaw: vi.fn(),
};

// Builds a payment row of a nutritionist-owned subscription.
function makePayment(overrides = {}) {
  return {
    id: PAYMENT_ID,
    subscriptionId: SUBSCRIPTION_ID,
    cycleIndex: 0,
    cycleStartDate: new Date('2026-06-10T00:00:00Z'),
    cycleEndDate: new Date('2026-07-09T00:00:00Z'),
    dueDate: new Date('2026-06-10T00:00:00Z'),
    amount: new Decimal('100.00'),
    status: PaymentStatus.PENDING,
    paidAt: null,
    notes: null,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: null,
    subscription: {
      trainerId: null,
      nutritionistId: OWNER_NUTRITIONIST_ID,
      serviceType: ServiceType.NUTRITION,
      status: SubscriptionStatus.ACTIVE,
      cancelledAt: null,
      startDate: new Date('2026-05-01T12:00:00Z'),
    },
    ...overrides,
  };
}

// Builds a history row with the include shape listPaymentsByStudent reads.
function makeHistoryPayment(serviceType) {
  return makePayment({
    subscription: {
      status: SubscriptionStatus.ACTIVE,
      serviceType,
      startDate: new Date('2026-05-01T12:00:00Z'),
      plan: { id: 'plan-1', name: 'Plano', recurrence: 'monthly' },
      student: { id: STUDENT_ID, firstName: 'Ana', lastName: 'Silva', avatarUrl: null },
    },
  });
}

// Fakes the stored row behind a payment: pre-read, conditional write and reload.
function stubStoredPayment(record) {
  let row = { ...record };
  mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(record);
  mockPrisma.subscriptionPayment.updateMany.mockImplementation(async ({ data }) => {
    row = { ...row, ...data };
    return { count: 1 };
  });
  mockPrisma.subscriptionPayment.findUniqueOrThrow.mockImplementation(async () => row);
}

// Asserts the payment lookup was scoped to the owner rows through the subscription relation.
function expectPaymentScope(expectedSubscriptionWhere) {
  expect(mockPrisma.subscriptionPayment.findFirst.mock.calls[0][0].where).toEqual({
    id: PAYMENT_ID,
    subscription: expectedSubscriptionWhere,
  });
}

beforeEach(() => {
  mockPrisma.studentSubscription.findFirst.mockResolvedValue({
    id: SUBSCRIPTION_ID,
    trainerId: null,
    nutritionistId: OWNER_NUTRITIONIST_ID,
    serviceType: ServiceType.NUTRITION,
    status: SubscriptionStatus.ACTIVE,
    startDate: new Date('2026-05-01T12:00:00Z'),
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    billingDay: null,
  });
  mockPrisma.trainerStudent.findFirst.mockResolvedValue(null);
  mockPrisma.trainerStudent.findUnique.mockResolvedValue(null);
  mockPrisma.nutritionistPatient.findFirst.mockResolvedValue(null);
  mockPrisma.nutritionistPatient.findUnique.mockResolvedValue(null);
  mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
});

describe('subscription lookups scoped by the owner (AC 8)', () => {
  it('listPaymentsBySubscription should scope the subscription to the nutritionist rows', async () => {
    await listPaymentsBySubscription(mockPrisma, nutritionistOwner(), SUBSCRIPTION_ID, NOW);

    expect(mockPrisma.studentSubscription.findFirst.mock.calls[0][0].where).toEqual({
      id: SUBSCRIPTION_ID,
      nutritionistId: OWNER_NUTRITIONIST_ID,
    });
  });

  it('listPaymentsBySubscription should answer 404 SUBSCRIPTION_NOT_FOUND for another professional subscription', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(
      listPaymentsBySubscription(mockPrisma, nutritionistOwner(), SUBSCRIPTION_ID, NOW),
    ).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_NOT_FOUND,
    });
    expect(mockPrisma.subscriptionPayment.findMany).not.toHaveBeenCalled();
  });

  it('createPayment should answer 404 SUBSCRIPTION_NOT_FOUND for another professional subscription', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(createPayment(mockPrisma, nutritionistOwner(), SUBSCRIPTION_ID, {}, NOW)).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('createPayment should resolve the subscription through either owner row of a dual-role owner', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue({ cycleIndex: 0 });
    mockPrisma.$executeRaw.mockResolvedValue(0);

    await createPayment(mockPrisma, dualOwner(), SUBSCRIPTION_ID, {}, NOW).catch(() => {});

    const { where } = mockPrisma.studentSubscription.findFirst.mock.calls[0][0];
    expect(where.id).toBe(SUBSCRIPTION_ID);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });
});

describe('payment actions scoped by ownerScopeWhere (AC 8)', () => {
  it.each([
    ['markPaymentPaid', (owner) => markPaymentPaid(mockPrisma, owner, PAYMENT_ID, {}, NOW)],
    ['markPaymentPending', (owner) => markPaymentPending(mockPrisma, owner, PAYMENT_ID, NOW)],
    ['updatePayment', (owner) => updatePayment(mockPrisma, owner, PAYMENT_ID, { notes: 'x' }, NOW)],
    ['voidPayment', (owner) => voidPayment(mockPrisma, owner, PAYMENT_ID, NOW)],
  ])('%s should answer 404 PAYMENT_NOT_FOUND for a payment of another professional', async (_name, call) => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(call(nutritionistOwner())).rejects.toMatchObject({
      httpStatus: NOT_FOUND,
      error: SubscriptionErrorCode.PAYMENT_NOT_FOUND,
      messageCode: SubscriptionMessageCode.PAYMENT_NOT_FOUND,
      message: expect.any(String),
    });
    expectPaymentScope({ nutritionistId: OWNER_NUTRITIONIST_ID });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('should scope a dual-role owner payment lookup to either owner row', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await markPaymentPaid(mockPrisma, dualOwner(), PAYMENT_ID, {}, NOW).catch(() => {});

    const { subscription } = mockPrisma.subscriptionPayment.findFirst.mock.calls[0][0].where;
    expect(subscription.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('markPaymentPaid should settle a nutritionist payment like a trainer one', async () => {
    stubStoredPayment(makePayment());

    const result = await markPaymentPaid(mockPrisma, nutritionistOwner(), PAYMENT_ID, {}, NOW);

    expect(result).toMatchObject({ id: PAYMENT_ID, status: PaymentStatus.PAID, paidAt: NOW });
  });

  it('voidPayment should void a pending nutritionist payment', async () => {
    stubStoredPayment(makePayment());

    const result = await voidPayment(mockPrisma, nutritionistOwner(), PAYMENT_ID, NOW);

    expect(result.status).toBe(PaymentStatus.CANCELLED);
  });

  it('markPaymentPending should revert a paid nutritionist payment', async () => {
    stubStoredPayment(makePayment({ status: PaymentStatus.PAID, paidAt: NOW, voidedAt: null }));

    const result = await markPaymentPending(mockPrisma, nutritionistOwner(), PAYMENT_ID, NOW);

    expect(result.status).toBe(PaymentStatus.PENDING);
  });
});

describe('listPaymentsByStudent across owner rows (AC 8, 9)', () => {
  it('should scope a nutritionist-only owner to the nutritionist rows of the student', async () => {
    await listPaymentsByStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, NOW);

    expect(mockPrisma.subscriptionPayment.findMany.mock.calls[0][0].where).toEqual({
      subscription: { nutritionistId: OWNER_NUTRITIONIST_ID, studentId: STUDENT_ID },
    });
  });

  it('should cover both owner rows for a dual-role owner', async () => {
    await listPaymentsByStudent(mockPrisma, dualOwner(), STUDENT_ID, NOW);

    const { subscription } = mockPrisma.subscriptionPayment.findMany.mock.calls[0][0].where;
    expect(subscription.studentId).toBe(STUDENT_ID);
    expect(subscription.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });

  it('should expose the serviceType of each payment subscription', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
      makeHistoryPayment(ServiceType.TRAINING),
      makeHistoryPayment(ServiceType.NUTRITION),
    ]);

    const result = await listPaymentsByStudent(mockPrisma, dualOwner(), STUDENT_ID, NOW);

    expect(result.payments.map((payment) => payment.serviceType)).toEqual([ServiceType.TRAINING, ServiceType.NUTRITION]);
  });

  it('should request serviceType in the subscription select so history rows can carry it', async () => {
    await listPaymentsByStudent(mockPrisma, dualOwner(), STUDENT_ID, NOW);

    const { include } = mockPrisma.subscriptionPayment.findMany.mock.calls[0][0];
    expect(include.subscription.select.serviceType).toBe(true);
  });

  it('should fall back to the live patient link for the student header when there are no payments', async () => {
    const student = { id: STUDENT_ID, firstName: 'Ana', lastName: 'Silva', avatarUrl: null };
    mockPrisma.nutritionistPatient.findFirst.mockResolvedValue({ student, deletedAt: null });
    mockPrisma.nutritionistPatient.findUnique.mockResolvedValue({ student, deletedAt: null });

    const result = await listPaymentsByStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, NOW);

    expect(result.student).toMatchObject({ id: STUDENT_ID, name: 'Ana Silva' });
  });

  it('should return a null student header when there are no payments and no live link', async () => {
    const result = await listPaymentsByStudent(mockPrisma, nutritionistOwner(), STUDENT_ID, NOW);

    expect(result.student).toBeNull();
  });
});
