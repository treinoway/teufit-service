import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import { SubscriptionErrorCode, PaymentStatus } from '../../src/constants/subscription.js';
import { computeCycleEndDate } from '../../src/helpers/subscription-helpers.js';

const { Decimal } = Prisma;

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  studentSubscription: { findFirst: vi.fn() },
  subscriptionPayment: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  },
};

import {
  createPayment,
  listPaymentsBySubscription,
  markPaymentPaid,
  markPaymentPending,
  updatePayment,
  deletePayment,
} from '../../src/services/subscription-payment-service.js';

const TRAINER_USER_ID = 'trainer-user-uuid';
const TRAINER_ID = 'trainer-record-uuid';
const SUBSCRIPTION_ID = 'sub-uuid-1';
const PAYMENT_ID = 'payment-uuid-1';

function makeSubscriptionRecord(overrides = {}) {
  return {
    id: SUBSCRIPTION_ID,
    trainerId: TRAINER_ID,
    studentId: 'student-uuid-1',
    planId: 'plan-uuid-1',
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    startDate: new Date('2026-05-01T12:00:00Z'),
    status: 'active',
    ...overrides,
  };
}

function makePaymentRecord(overrides = {}) {
  return {
    id: PAYMENT_ID,
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
    subscription: { trainerId: TRAINER_ID },
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  mockPrisma.studentSubscription.findFirst.mockResolvedValue(makeSubscriptionRecord());
});

// ─── createPayment ────────────────────────────────────────────────────────────

describe('createPayment', () => {
  it('creates a payment with correct cycleEndDate for monthly recurrence', async () => {
    const paymentRecord = makePaymentRecord({
      cycleStartDate: new Date('2026-05-01T12:00:00Z'),
      cycleEndDate: new Date('2026-05-31T12:00:00Z'),
    });
    mockPrisma.subscriptionPayment.create.mockResolvedValue(paymentRecord);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
      cycleStartDate: '2026-05-01',
    });

    expect(result.cycleStartDate).toBe('2026-05-01');
    // May 1 + 1 month - 1 day = May 31
    expect(result.cycleEndDate).toBe('2026-05-31');
    expect(result.status).toBe(PaymentStatus.PENDING);
  });

  it('creates a payment with correct cycleEndDate for quarterly recurrence', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ recurrence: 'quarterly' }),
    );
    const paymentRecord = makePaymentRecord({
      cycleStartDate: new Date('2026-01-01T12:00:00Z'),
      cycleEndDate: new Date('2026-03-31T12:00:00Z'),
    });
    mockPrisma.subscriptionPayment.create.mockResolvedValue(paymentRecord);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
      cycleStartDate: '2026-01-01',
    });

    // Jan 1 + 3 months - 1 day = Mar 31
    expect(result.cycleEndDate).toBe('2026-03-31');
  });

  it('creates a payment with correct cycleEndDate for semiannual recurrence', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ recurrence: 'semiannual' }),
    );
    const paymentRecord = makePaymentRecord({
      cycleStartDate: new Date('2026-01-01T12:00:00Z'),
      cycleEndDate: new Date('2026-06-30T12:00:00Z'),
    });
    mockPrisma.subscriptionPayment.create.mockResolvedValue(paymentRecord);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
      cycleStartDate: '2026-01-01',
    });

    // Jan 1 + 6 months - 1 day = Jun 30
    expect(result.cycleEndDate).toBe('2026-06-30');
  });

  it('creates a payment with correct cycleEndDate for annual recurrence', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ recurrence: 'annual' }),
    );
    const paymentRecord = makePaymentRecord({
      cycleStartDate: new Date('2026-01-01T12:00:00Z'),
      cycleEndDate: new Date('2026-12-31T12:00:00Z'),
    });
    mockPrisma.subscriptionPayment.create.mockResolvedValue(paymentRecord);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
      cycleStartDate: '2026-01-01',
    });

    // Jan 1 + 12 months - 1 day = Dec 31
    expect(result.cycleEndDate).toBe('2026-12-31');
  });

  it('uses cycleStartDate as default dueDate', async () => {
    const paymentRecord = makePaymentRecord();
    mockPrisma.subscriptionPayment.create.mockResolvedValue(paymentRecord);

    await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
      cycleStartDate: '2026-05-01',
    });

    const createCall = mockPrisma.subscriptionPayment.create.mock.calls[0][0];
    // dueDate should equal cycleStartDate
    expect(createCall.data.dueDate.getTime()).toBe(createCall.data.cycleStartDate.getTime());
  });

  it('throws 404 when subscription not found', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {
        cycleStartDate: '2026-05-01',
      }),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
  });
});

// ─── computeCycleEndDate — month-end overflow ─────────────────────────────────

describe('computeCycleEndDate', () => {
  it('Jan 31 + monthly → Feb 28 (non-leap year)', () => {
    const result = computeCycleEndDate('2026-01-31', 'monthly');
    // Feb has 28 days in 2026
    expect(result.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('Jan 31 + monthly → Feb 29 (leap year)', () => {
    const result = computeCycleEndDate('2028-01-31', 'monthly');
    // 2028 is a leap year: Feb has 29 days
    expect(result.toISOString().slice(0, 10)).toBe('2028-02-29');
  });

  it('Aug 31 + monthly → Sep 30', () => {
    const result = computeCycleEndDate('2026-08-31', 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2026-09-30');
  });

  it('Feb 28 (leap year) + monthly → Mar 27 (next billing Mar 28, no overflow)', () => {
    const result = computeCycleEndDate('2028-02-28', 'monthly');
    // Feb 28 → next billing Mar 28 (28 ≤ 31, no overflow) → cycle end = Mar 28 − 1d = Mar 27
    expect(result.toISOString().slice(0, 10)).toBe('2028-03-27');
  });

  it('May 1 + monthly → May 31 (normal path)', () => {
    const result = computeCycleEndDate('2026-05-01', 'monthly');
    expect(result.toISOString().slice(0, 10)).toBe('2026-05-31');
  });

  it('Jan 1 + quarterly → Mar 31', () => {
    const result = computeCycleEndDate('2026-01-01', 'quarterly');
    expect(result.toISOString().slice(0, 10)).toBe('2026-03-31');
  });

  it('Jan 1 + annual → Dec 31', () => {
    const result = computeCycleEndDate('2026-01-01', 'annual');
    expect(result.toISOString().slice(0, 10)).toBe('2026-12-31');
  });
});

// ─── listPaymentsBySubscription ───────────────────────────────────────────────

describe('listPaymentsBySubscription', () => {
  it('returns payments for the subscription', async () => {
    const payments = [makePaymentRecord(), makePaymentRecord({ id: 'payment-2' })];
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue(payments);

    const result = await listPaymentsBySubscription(
      mockPrisma,
      TRAINER_USER_ID,
      SUBSCRIPTION_ID,
    );

    expect(result).toHaveLength(2);
  });

  it('throws 404 when subscription not found', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(
      listPaymentsBySubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ─── markPaymentPaid ──────────────────────────────────────────────────────────

describe('markPaymentPaid', () => {
  it('sets status to paid and paidAt to now', async () => {
    const payment = makePaymentRecord();
    const paid = makePaymentRecord({ status: PaymentStatus.PAID, paidAt: new Date() });
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    mockPrisma.subscriptionPayment.update.mockResolvedValue(paid);

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID);

    expect(result.status).toBe(PaymentStatus.PAID);
    expect(result.paidAt).not.toBeNull();
  });

  it('is idempotent — does not overwrite paidAt if already set', async () => {
    const existingPaidAt = new Date('2026-05-10T10:00:00Z');
    const alreadyPaid = makePaymentRecord({ status: PaymentStatus.PAID, paidAt: existingPaidAt });
    const returnedPaid = makePaymentRecord({ status: PaymentStatus.PAID, paidAt: existingPaidAt });
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(alreadyPaid);
    mockPrisma.subscriptionPayment.update.mockResolvedValue(returnedPaid);

    await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID);

    const updateCall = mockPrisma.subscriptionPayment.update.mock.calls[0][0];
    // paidAt should be the existing one, not a new Date
    expect(updateCall.data.paidAt).toEqual(existingPaidAt);
  });

  it('throws 404 when payment not found', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PAYMENT_NOT_FOUND });
  });
});

// ─── markPaymentPending ───────────────────────────────────────────────────────

describe('markPaymentPending', () => {
  it('sets status to pending and clears paidAt', async () => {
    const paid = makePaymentRecord({ status: PaymentStatus.PAID, paidAt: new Date() });
    const pending = makePaymentRecord({ status: PaymentStatus.PENDING, paidAt: null });
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(paid);
    mockPrisma.subscriptionPayment.update.mockResolvedValue(pending);

    const result = await markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID);

    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.paidAt).toBeNull();
  });

  it('throws 404 when payment not found', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ─── updatePayment ────────────────────────────────────────────────────────────

describe('updatePayment', () => {
  it('updates only the provided fields', async () => {
    const payment = makePaymentRecord();
    const updated = makePaymentRecord({ notes: 'paid via pix' });
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    mockPrisma.subscriptionPayment.update.mockResolvedValue(updated);

    const result = await updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {
      notes: 'paid via pix',
    });

    expect(result.notes).toBe('paid via pix');
  });

  it('throws 404 when payment not found or wrong trainer', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { notes: 'x' }),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});

// ─── deletePayment ────────────────────────────────────────────────────────────

describe('deletePayment', () => {
  it('deletes the payment', async () => {
    const payment = makePaymentRecord();
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(payment);
    mockPrisma.subscriptionPayment.delete.mockResolvedValue(payment);

    await deletePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID);

    expect(mockPrisma.subscriptionPayment.delete).toHaveBeenCalledOnce();
  });

  it('throws 404 when payment not found', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      deletePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID),
    ).rejects.toMatchObject({ httpStatus: 404 });
  });
});
