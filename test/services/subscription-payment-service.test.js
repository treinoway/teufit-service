import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Prisma } from '@prisma/client';
import {
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  PaymentStatus,
  EffectivePaymentStatus,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';

import { formatDateOnly } from '../../src/helpers/date-helpers.js';

const { Decimal } = Prisma;

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  studentSubscription: { findFirst: vi.fn() },
  trainerStudent: { findFirst: vi.fn() },
  subscriptionPayment: {
    create: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    findUniqueOrThrow: vi.fn(),
    updateMany: vi.fn(),
  },
  $executeRaw: vi.fn(),
};

import {
  createPayment,
  listPaymentsBySubscription,
  listPaymentsByStudent,
  markPaymentPaid,
  markPaymentPending,
  updatePayment,
  voidPayment,
} from '../../src/services/subscription-payment-service.js';

const TRAINER_USER_ID = 'trainer-user-uuid';
const TRAINER_ID = 'trainer-record-uuid';
const SUBSCRIPTION_ID = 'sub-uuid-1';
const PAYMENT_ID = 'payment-uuid-1';
const STUDENT_ID = 'student-uuid-1';

// 12:00 in Sao Paulo (UTC-3) on 2026-06-10
const NOW = new Date('2026-06-10T15:00:00Z');
const TODAY_SP = '2026-06-10';

function makeSubscriptionRecord(overrides = {}) {
  return {
    id: SUBSCRIPTION_ID,
    trainerId: TRAINER_ID,
    studentId: STUDENT_ID,
    planId: 'plan-uuid-1',
    recurrence: 'monthly',
    price: new Decimal('100.00'),
    discountPercent: null,
    discountAmount: null,
    startDate: new Date('2026-05-01T12:00:00Z'),
    status: SubscriptionStatus.ACTIVE,
    ...overrides,
  };
}

function makePaymentRecord(overrides = {}) {
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
      trainerId: TRAINER_ID,
      status: SubscriptionStatus.ACTIVE,
      cancelledAt: null,
      startDate: new Date('2026-05-01T12:00:00Z'),
    },
    ...overrides,
  };
}

function mockLastCycle(cycleIndex) {
  mockPrisma.subscriptionPayment.findFirst.mockResolvedValue({ cycleIndex });
}

/**
 * Fake the stored row behind a payment: the pre-read returns `record`, the
 * conditional updateMany reports `updateCount` (0 simulates a concurrent write
 * that changed the status after the pre-read) and applies `data` only when it
 * matched, and the reload returns the resulting row. `reloadedRow` overrides
 * what the row looks like after the (lost) race.
 */
function stubStoredPayment(record, { updateCount = 1, reloadedRow } = {}) {
  let row = { ...record };
  mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(record);
  mockPrisma.subscriptionPayment.updateMany.mockImplementation(async ({ data }) => {
    if (updateCount > 0) {
      const defined = Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
      row = { ...row, ...defined };
    }
    return { count: updateCount };
  });
  mockPrisma.subscriptionPayment.findUniqueOrThrow.mockImplementation(async () => reloadedRow ?? row);
}

const VALUES_PER_ROW = 7;

/** Decode the single row bound into the last $executeRaw INSERT. */
function insertedRow() {
  const joined = mockPrisma.$executeRaw.mock.calls.at(-1)[2];
  const [subscriptionId, cycleIndex, cycleStartDate, cycleEndDate, dueDate, amount, notes] =
    joined.values.slice(0, VALUES_PER_ROW);
  return { subscriptionId, cycleIndex, cycleStartDate, cycleEndDate, dueDate, amount, notes };
}

beforeEach(() => {
  vi.resetAllMocks();
  mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
  mockPrisma.studentSubscription.findFirst.mockResolvedValue(makeSubscriptionRecord());
});

// ─── createPayment ────────────────────────────────────────────────────────────

describe('createPayment', () => {
  beforeEach(() => {
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.subscriptionPayment.findUnique.mockImplementation(async () => {
      const row = insertedRow();
      return makePaymentRecord({
        cycleIndex: row.cycleIndex,
        cycleStartDate: new Date(`${row.cycleStartDate}T00:00:00Z`),
        cycleEndDate: new Date(`${row.cycleEndDate}T00:00:00Z`),
        dueDate: new Date(`${row.dueDate}T00:00:00Z`),
        amount: new Decimal(row.amount),
      });
    });
  });

  describe('billingDay', () => {
    it('creates the next cycle on the aligned grid with dueDate = cycle start (D=5, S=May 10, last cycle 0)', async () => {
      mockPrisma.studentSubscription.findFirst.mockResolvedValue(
        makeSubscriptionRecord({ startDate: new Date('2026-05-10T00:00:00Z'), billingDay: 5 }),
      );
      mockLastCycle(0);

      const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

      const row = insertedRow();
      expect(row.cycleIndex).toBe(1);
      expect(row.cycleStartDate).toBe('2026-06-05');
      expect(row.cycleEndDate).toBe('2026-07-04');
      expect(row.dueDate).toBe('2026-06-05');
      expect(result.cycleStartDate).toBe('2026-06-05');
    });

    it('keeps a month-end billing day (D=31, S=Jan 10, last cycle 4 => May 31..Jun 29)', async () => {
      mockPrisma.studentSubscription.findFirst.mockResolvedValue(
        makeSubscriptionRecord({ startDate: new Date('2026-01-10T00:00:00Z'), billingDay: 31 }),
      );
      mockLastCycle(4);

      await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

      expect(insertedRow()).toMatchObject({
        cycleIndex: 5,
        cycleStartDate: '2026-05-31',
        cycleEndDate: '2026-06-29',
      });
    });

    it('allows an aligned cycle starting exactly today + 7 (D=17, S=May 20 => Jun 17)', async () => {
      mockPrisma.studentSubscription.findFirst.mockResolvedValue(
        makeSubscriptionRecord({ startDate: new Date('2026-05-20T00:00:00Z'), billingDay: 17 }),
      );
      mockLastCycle(0);

      await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

      expect(insertedRow().cycleStartDate).toBe('2026-06-17');
    });

    it('rejects with 409 CYCLE_NOT_DUE when the aligned cycle starts after today + 7 (D=18, S=May 20 => Jun 18)', async () => {
      mockPrisma.studentSubscription.findFirst.mockResolvedValue(
        makeSubscriptionRecord({ startDate: new Date('2026-05-20T00:00:00Z'), billingDay: 18 }),
      );
      mockLastCycle(0);

      await expect(
        createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
      ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.CYCLE_NOT_DUE });
    });

    it('an explicit dueDate still overrides the cycle start on an aligned cycle', async () => {
      mockPrisma.studentSubscription.findFirst.mockResolvedValue(
        makeSubscriptionRecord({ startDate: new Date('2026-05-10T00:00:00Z'), billingDay: 5 }),
      );
      mockLastCycle(0);

      await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, { dueDate: '2026-06-12' }, NOW);

      expect(insertedRow().dueDate).toBe('2026-06-12');
    });

    it('billingDay null keeps the legacy cycle anchored on the start date day', async () => {
      mockPrisma.studentSubscription.findFirst.mockResolvedValue(
        makeSubscriptionRecord({ startDate: new Date('2026-05-10T00:00:00Z'), billingDay: null }),
      );
      mockLastCycle(0);

      await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

      expect(insertedRow()).toMatchObject({ cycleStartDate: '2026-06-10', cycleEndDate: '2026-07-09', dueDate: '2026-06-10' });
    });
  });

  it('creates the next cycle (index + 1) from the subscription anchor, ignoring any caller dates', async () => {
    mockLastCycle(0);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    expect(insertedRow().cycleIndex).toBe(1);
    expect(result.cycleStartDate).toBe('2026-06-01');
    expect(result.cycleEndDate).toBe('2026-06-30');
    expect(result.status).toBe(PaymentStatus.PENDING);
  });

  it('inserts through the conditional helper and reads the row back by (subscriptionId, cycleIndex)', async () => {
    mockLastCycle(0);

    await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    expect(mockPrisma.$executeRaw).toHaveBeenCalledOnce();
    expect(mockPrisma.subscriptionPayment.findUnique).toHaveBeenCalledWith({
      where: { subscriptionId_cycleIndex: { subscriptionId: SUBSCRIPTION_ID, cycleIndex: 1 } },
    });
  });

  it('creates cycle 0 when the subscription has no payments yet and starts today', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ startDate: new Date('2026-06-10T00:00:00Z') }),
    );
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    expect(result.cycleIndex).toBe(0);
    expect(result.cycleStartDate).toBe('2026-06-10');
  });

  it('skips ended cycles for a backdated subscription with no payments (jumps to the current grid cycle)', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ startDate: new Date('2025-06-10T00:00:00Z') }),
    );
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    expect(result.cycleIndex).toBe(12);
    expect(result.cycleStartDate).toBe('2026-06-10');
  });

  it('defaults dueDate to the cycle start date', async () => {
    mockLastCycle(0);

    await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    const row = insertedRow();
    expect(row.dueDate).toBe(row.cycleStartDate);
  });

  it('honours an explicit dueDate and notes', async () => {
    mockLastCycle(0);

    await createPayment(
      mockPrisma,
      TRAINER_USER_ID,
      SUBSCRIPTION_ID,
      { dueDate: '2026-06-15', notes: 'pix' },
      NOW,
    );

    expect(insertedRow()).toMatchObject({ dueDate: '2026-06-15', notes: 'pix' });
  });

  it('applies the subscription discount snapshot to the amount', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ price: new Decimal('99.90'), discountPercent: new Decimal('33.33') }),
    );
    mockLastCycle(0);

    await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    expect(insertedRow().amount).toBe('66.60');
  });

  it('allows the cycle that starts exactly today + 7 days (lead window boundary)', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ startDate: new Date('2026-05-17T12:00:00Z') }),
    );
    mockLastCycle(0); // next starts 2026-06-17 = today + 7

    const result = await createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW);

    expect(result.cycleStartDate).toBe('2026-06-17');
  });

  it('rejects with 409 CYCLE_NOT_DUE when the next cycle starts after today + 7 days', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ startDate: new Date('2026-05-18T12:00:00Z') }),
    );
    mockLastCycle(0); // next starts 2026-06-18 = today + 8

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.CYCLE_NOT_DUE,
      messageCode: SubscriptionMessageCode.CYCLE_NOT_DUE,
    });
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('a sequential second call (cycle already materialized up to the lead window) is 409 CYCLE_NOT_DUE', async () => {
    mockLastCycle(1); // Jul 1 > today + 7

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.CYCLE_NOT_DUE });
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('measures the lead window in the business timezone (00:30 UTC is still the previous SP day)', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ startDate: new Date('2026-05-17T12:00:00Z') }),
    );
    mockLastCycle(0); // next starts 2026-06-17
    const lateUtc = new Date('2026-06-10T00:30:00Z'); // SP: 2026-06-09 21:30 -> limit 2026-06-16

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, lateUtc),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.CYCLE_NOT_DUE });
  });

  it('maps a concurrent duplicate (insert skipped by ON CONFLICT, row exists) to 409 CYCLE_ALREADY_EXISTS', async () => {
    mockLastCycle(0);
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockPrisma.subscriptionPayment.findUnique.mockResolvedValue(makePaymentRecord({ cycleIndex: 1 }));

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.CYCLE_ALREADY_EXISTS,
      messageCode: SubscriptionMessageCode.CYCLE_ALREADY_EXISTS,
    });
  });

  it('maps nothing inserted and no row (subscription cancelled mid-flight) to 409 SUBSCRIPTION_CANCELLED', async () => {
    mockLastCycle(0);
    mockPrisma.$executeRaw.mockResolvedValue(0);
    mockPrisma.subscriptionPayment.findUnique.mockResolvedValue(null);

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.SUBSCRIPTION_CANCELLED,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_CANCELLED,
    });
  });

  it('rethrows unexpected insert errors', async () => {
    mockLastCycle(0);
    const boom = new Error('db down');
    mockPrisma.$executeRaw.mockRejectedValue(boom);

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toBe(boom);
  });

  it('rejects with 409 SUBSCRIPTION_CANCELLED for a cancelled subscription', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(
      makeSubscriptionRecord({ status: SubscriptionStatus.CANCELLED }),
    );

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.SUBSCRIPTION_CANCELLED,
      messageCode: SubscriptionMessageCode.SUBSCRIPTION_CANCELLED,
    });
    expect(mockPrisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('throws 404 when subscription not found', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
  });

  it('throws 404 when the trainer profile does not exist', async () => {
    mockPrisma.trainer.findUnique.mockResolvedValue(null);

    await expect(
      createPayment(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, {}, NOW),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.TRAINER_NOT_FOUND });
  });
});

// ─── listPaymentsBySubscription ───────────────────────────────────────────────

describe('listPaymentsBySubscription', () => {
  it('returns formatted payments including effectiveStatus and daysOverdue', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
      makePaymentRecord({ dueDate: new Date('2026-06-01T00:00:00Z') }),
    ]);

    const result = await listPaymentsBySubscription(
      mockPrisma,
      TRAINER_USER_ID,
      SUBSCRIPTION_ID,
      NOW,
    );

    expect(result).toHaveLength(1);
    expect(result[0].effectiveStatus).toBe(EffectivePaymentStatus.OVERDUE);
    expect(result[0].daysOverdue).toBe(9);
    expect(result[0].dueDate).toBe('2026-06-01');
  });

  it('throws 404 when subscription not found', async () => {
    mockPrisma.studentSubscription.findFirst.mockResolvedValue(null);

    await expect(
      listPaymentsBySubscription(mockPrisma, TRAINER_USER_ID, SUBSCRIPTION_ID, NOW),
    ).rejects.toMatchObject({
      httpStatus: 404,
      error: SubscriptionErrorCode.SUBSCRIPTION_NOT_FOUND,
    });
  });
});

// ─── listPaymentsByStudent ────────────────────────────────────────────────────

describe('listPaymentsByStudent', () => {
  const plan = { id: 'plan-1', name: 'Plano', recurrence: 'monthly' };

  function withSubscription(payment, { status = SubscriptionStatus.ACTIVE, startDate } = {}) {
    return {
      ...payment,
      subscription: {
        status,
        startDate: startDate ?? new Date('2026-05-01T12:00:00Z'),
        plan,
      },
    };
  }

  it('scopes by trainerId + studentId only (no live link) in a single query', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

    await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW);

    expect(mockPrisma.subscriptionPayment.findMany).toHaveBeenCalledOnce();
    expect(mockPrisma.subscriptionPayment.findMany.mock.calls[0][0].where).toEqual({
      subscription: { trainerId: TRAINER_ID, studentId: STUDENT_ID },
    });
  });

  it('summarises only paid payments and reports the earliest subscription start as customerSince', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([
      withSubscription(
        makePaymentRecord({ id: 'p3', status: PaymentStatus.PENDING, amount: new Decimal('50') }),
      ),
      withSubscription(
        makePaymentRecord({
          id: 'p2',
          status: PaymentStatus.PAID,
          amount: new Decimal('100.10'),
          paidAt: new Date('2026-06-02T15:00:00Z'),
        }),
      ),
      withSubscription(
        makePaymentRecord({
          id: 'p1',
          status: PaymentStatus.PAID,
          amount: new Decimal('0.20'),
          paidAt: new Date('2026-03-02T15:00:00Z'),
        }),
        { status: SubscriptionStatus.CANCELLED, startDate: new Date('2026-03-01T12:00:00Z') },
      ),
    ]);

    const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW);

    expect(result.summary).toEqual({
      totalReceived: '100.30',
      receivedCount: 2,
      customerSince: '2026-03-01',
    });
    expect(result.payments).toHaveLength(3);
    expect(result.payments[2]).toMatchObject({ subscriptionStatus: SubscriptionStatus.CANCELLED, plan });
  });

  it('returns a zeroed summary and null customerSince when there are no payments', async () => {
    mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);

    const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW);

    expect(result).toEqual({
      student: null,
      summary: { totalReceived: '0.00', receivedCount: 0, customerSince: null },
      payments: [],
    });
  });

  describe('student header', () => {
    const studentRow = { id: STUDENT_ID, firstName: 'Maria', lastName: 'Silva', avatarUrl: 'avatar-key' };
    const resolveAvatarUrl = vi.fn(async (stored) => (stored ? `https://cdn/${stored}` : null));

    it('resolves the student from the first payment subscription without an extra link query', async () => {
      const payment = withSubscription(makePaymentRecord());
      payment.subscription.student = studentRow;
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([payment]);

      const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW, { resolveAvatarUrl });

      expect(result.student).toEqual({ id: STUDENT_ID, name: 'Maria Silva', avatarUrl: 'https://cdn/avatar-key' });
      expect(mockPrisma.trainerStudent.findFirst).not.toHaveBeenCalled();
    });

    it('falls back to the trainer-student link when there are no payments', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
      mockPrisma.trainerStudent.findFirst.mockResolvedValue({ student: studentRow });

      const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW, { resolveAvatarUrl });

      expect(result.student).toEqual({ id: STUDENT_ID, name: 'Maria Silva', avatarUrl: 'https://cdn/avatar-key' });
      expect(mockPrisma.trainerStudent.findFirst).toHaveBeenCalledWith({
        where: { trainerId: TRAINER_ID, studentId: STUDENT_ID },
        select: { student: { select: { id: true, firstName: true, lastName: true, avatarUrl: true } } },
      });
    });

    it('returns null for a student unrelated to the trainer (no user info leak)', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
      mockPrisma.trainerStudent.findFirst.mockResolvedValue(null);

      const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, 'stranger', NOW, { resolveAvatarUrl });

      expect(result.student).toBeNull();
      expect(resolveAvatarUrl).not.toHaveBeenCalled();
    });

    it('keeps the student when history exists but the link was removed', async () => {
      const payment = withSubscription(makePaymentRecord(), { status: SubscriptionStatus.CANCELLED });
      payment.subscription.student = studentRow;
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([payment]);
      mockPrisma.trainerStudent.findFirst.mockResolvedValue(null);

      const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW, { resolveAvatarUrl });

      expect(result.student).toMatchObject({ id: STUDENT_ID, name: 'Maria Silva' });
    });

    it('omits missing name parts and passes a null avatar through', async () => {
      mockPrisma.subscriptionPayment.findMany.mockResolvedValue([]);
      mockPrisma.trainerStudent.findFirst.mockResolvedValue({
        student: { id: STUDENT_ID, firstName: 'Maria', lastName: null, avatarUrl: null },
      });

      const result = await listPaymentsByStudent(mockPrisma, TRAINER_USER_ID, STUDENT_ID, NOW, { resolveAvatarUrl });

      expect(result.student).toEqual({ id: STUDENT_ID, name: 'Maria', avatarUrl: null });
    });
  });
});

// ─── markPaymentPaid ──────────────────────────────────────────────────────────

describe('markPaymentPaid', () => {
  beforeEach(() => {
    stubStoredPayment(makePaymentRecord());
  });

  const lastUpdate = () => mockPrisma.subscriptionPayment.updateMany.mock.calls.at(-1)[0];

  it('conditionally sets status to paid and paidAt to now when no paidAt is supplied', async () => {
    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(lastUpdate()).toEqual({
      where: { id: PAYMENT_ID, status: { in: [PaymentStatus.PENDING, PaymentStatus.CANCELLED] } },
      data: { status: PaymentStatus.PAID, paidAt: NOW },
    });
    expect(result.status).toBe(PaymentStatus.PAID);
  });

  it('is idempotent: an already paid payment without a requested paidAt keeps its paidAt and writes nothing', async () => {
    const existing = new Date('2026-06-01T10:00:00Z');
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: existing }));

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(result.paidAt).toEqual(existing);
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('is idempotent when the requested paidAt is the same Sao Paulo civil day as the existing one', async () => {
    const existing = new Date('2026-06-02T01:00:00Z'); // SP: 2026-06-01 22:00
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: existing }));

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-06-01' }, NOW);

    expect(result.paidAt).toEqual(existing);
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('rejects with 409 PAYMENT_ALREADY_PAID when an already paid payment is paid with a different paidAt', async () => {
    stubStoredPayment(
      makePaymentRecord({ status: PaymentStatus.PAID, paidAt: new Date('2026-06-01T15:00:00Z') }),
    );

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-06-02' }, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
      messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
    });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('stores a retroactive paidAt at midday Sao Paulo of the requested day', async () => {
    await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-05-31' }, NOW);

    expect(lastUpdate().data.paidAt).toEqual(new Date('2026-05-31T15:00:00Z'));
  });

  it('uses the real instant when paidAt is today in Sao Paulo', async () => {
    await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: TODAY_SP }, NOW);

    expect(lastUpdate().data.paidAt).toEqual(NOW);
  });

  it('accepts today as seen in Sao Paulo even though UTC already rolled over', async () => {
    const lateNight = new Date('2026-06-11T02:00:00Z'); // SP: 2026-06-10 23:00

    await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-06-10' }, lateNight);

    expect(lastUpdate().data.paidAt).toEqual(lateNight);
  });

  it('rejects a future paidAt with 400 SUBSCRIPTION_INVALID_PAID_AT', async () => {
    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-06-11' }, NOW),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_PAID_AT,
      messageCode: SubscriptionMessageCode.INVALID_PAID_AT,
    });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  describe('paidAt lower bound (subscription.startDate minus PAID_AT_MAX_ADVANCE_MONTHS)', () => {
    // subscription.startDate in makePaymentRecord is 2026-05-01 -> lower bound 2025-05-01
    it('accepts a paidAt exactly on the lower bound', async () => {
      await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2025-05-01' }, NOW);

      expect(lastUpdate().data.paidAt).toEqual(new Date('2025-05-01T15:00:00Z'));
    });

    it('rejects a paidAt one day before the lower bound with 400 SUBSCRIPTION_INVALID_PAID_AT', async () => {
      await expect(
        markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2025-04-30' }, NOW),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: SubscriptionErrorCode.INVALID_PAID_AT,
        messageCode: SubscriptionMessageCode.INVALID_PAID_AT,
      });
      expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    });

    it('accepts a paidAt before the subscription start but inside the 12-month allowance', async () => {
      await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-04-15' }, NOW);

      expect(lastUpdate().data.paidAt).toEqual(new Date('2026-04-15T15:00:00Z'));
    });
  });

  it('allows paying a voided (cancelled) payment', async () => {
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.CANCELLED }));

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(result.status).toBe(PaymentStatus.PAID);
  });

  it('when a concurrent mark-paid wins the race (updateMany count 0, row now paid) it answers idempotently', async () => {
    const paidAt = new Date('2026-06-10T14:00:00Z');
    stubStoredPayment(makePaymentRecord(), {
      updateCount: 0,
      reloadedRow: makePaymentRecord({ status: PaymentStatus.PAID, paidAt }),
    });

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(result.status).toBe(PaymentStatus.PAID);
    expect(result.paidAt).toEqual(paidAt);
  });

  it('when the lost race left a paid row and a different paidAt was requested it answers 409 PAYMENT_ALREADY_PAID', async () => {
    stubStoredPayment(makePaymentRecord(), {
      updateCount: 0,
      reloadedRow: makePaymentRecord({
        status: PaymentStatus.PAID,
        paidAt: new Date('2026-06-10T14:00:00Z'),
      }),
    });

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-06-05' }, NOW),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID });
  });

  it('retries the conditional write once when the state moved under it, and succeeds on the second attempt', async () => {
    stubStoredPayment(makePaymentRecord());
    mockPrisma.subscriptionPayment.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });
    mockPrisma.subscriptionPayment.findUniqueOrThrow
      .mockResolvedValueOnce(makePaymentRecord())
      .mockResolvedValueOnce(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }));

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledTimes(2);
    expect(result.status).toBe(PaymentStatus.PAID);
  });

  it('answers 409 SUBSCRIPTION_PAYMENT_CONFLICT after one retry when the row is still not paid and nothing matched', async () => {
    stubStoredPayment(makePaymentRecord(), {
      updateCount: 0,
      reloadedRow: makePaymentRecord({ status: PaymentStatus.PENDING }),
    });

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_CONFLICT,
      messageCode: SubscriptionMessageCode.PAYMENT_CONFLICT,
    });
    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledTimes(2);
  });

  it('returns a paid row with null paidAt as-is (no 1970 epoch) when no paidAt was requested', async () => {
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: null }));

    const result = await markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(result.paidAt).toBeNull();
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('handles a paid row with null paidAt safely when a paidAt is requested (400 out of range, 409 otherwise)', async () => {
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: null }));

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '1970-01-01' }, NOW),
    ).rejects.toMatchObject({ httpStatus: 400 });
    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { paidAt: '2026-06-05' }, NOW),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID });
  });

  it('throws 404 when the payment belongs to another trainer', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(
      makePaymentRecord({ subscription: { trainerId: 'someone-else' } }),
    );

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PAYMENT_NOT_FOUND });
  });

  it('throws 404 when payment not found', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      markPaymentPaid(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PAYMENT_NOT_FOUND });
  });
});

// ─── markPaymentPending ───────────────────────────────────────────────────────

describe('markPaymentPending', () => {
  const stubPending = (record, ...updateCounts) => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(record);
    updateCounts.forEach((count) =>
      mockPrisma.subscriptionPayment.updateMany.mockResolvedValueOnce({ count }),
    );
  };

  it('reopens a paid, never-voided payment with a conditional write (voidedAt null) and does not run the fallback', async () => {
    const reopened = makePaymentRecord({ status: PaymentStatus.PENDING, paidAt: null });
    stubPending(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }), 1);
    mockPrisma.subscriptionPayment.findUniqueOrThrow.mockResolvedValue(reopened);

    const result = await markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW);

    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: {
        id: PAYMENT_ID,
        status: { in: [PaymentStatus.PAID, PaymentStatus.PENDING] },
        voidedAt: null,
      },
      data: { status: PaymentStatus.PENDING, paidAt: null },
    });
    expect(result.status).toBe(PaymentStatus.PENDING);
    expect(result.paidAt).toBeNull();
  });

  it('reverts a paid payment that was ever voided (voidedAt set) to cancelled via the second conditional write', async () => {
    stubPending(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }), 0, 1);
    mockPrisma.subscriptionPayment.findUniqueOrThrow.mockResolvedValue(
      makePaymentRecord({ status: PaymentStatus.CANCELLED, paidAt: null }),
    );

    const result = await markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW);

    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledTimes(2);
    expect(mockPrisma.subscriptionPayment.updateMany.mock.calls[1][0]).toEqual({
      where: { id: PAYMENT_ID, status: PaymentStatus.PAID, voidedAt: { not: null } },
      data: { status: PaymentStatus.CANCELLED, paidAt: null },
    });
    expect(result.status).toBe(PaymentStatus.CANCELLED);
  });

  it('does not read the subscription or the payment status to choose the target (no stale-read decision)', async () => {
    // The target is decided by the voidedAt filter of the writes, not by any extra read.
    stubPending(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }), 0, 1);
    mockPrisma.subscriptionPayment.findUniqueOrThrow.mockResolvedValue(
      makePaymentRecord({ status: PaymentStatus.CANCELLED }),
    );

    await markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW);

    expect(mockPrisma.studentSubscription.findFirst).not.toHaveBeenCalled();
  });

  it('rejects with 409 SUBSCRIPTION_PAYMENT_CANCELLED for a voided payment without writing', async () => {
    stubPending(makePaymentRecord({ status: PaymentStatus.CANCELLED }));

    await expect(
      markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_CANCELLED,
      messageCode: SubscriptionMessageCode.PAYMENT_CANCELLED,
    });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('answers 409 PAYMENT_CANCELLED when both conditional writes match nothing (voided between pre-read and write)', async () => {
    stubPending(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }), 0, 0);

    await expect(
      markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PAYMENT_CANCELLED });
    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledTimes(2);
  });

  it('throws 404 when payment not found', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      markPaymentPending(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PAYMENT_NOT_FOUND });
  });
});

// ─── updatePayment ────────────────────────────────────────────────────────────

describe('updatePayment', () => {
  const paidPayment = () =>
    makePaymentRecord({ status: PaymentStatus.PAID, paidAt: new Date('2026-06-05T15:00:00Z') });

  it('updates only the provided fields on a pending payment (conditional on not cancelled)', async () => {
    stubStoredPayment(makePaymentRecord());

    await updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { notes: 'updated' }, NOW);

    const { where, data } = mockPrisma.subscriptionPayment.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: PAYMENT_ID, status: { not: PaymentStatus.CANCELLED } });
    expect(data.notes).toBe('updated');
    expect(data.amount).toBeUndefined();
    expect(data.dueDate).toBeUndefined();
  });

  it('changes amount and dueDate only while the payment is still pending', async () => {
    stubStoredPayment(makePaymentRecord());

    const result = await updatePayment(
      mockPrisma,
      TRAINER_USER_ID,
      PAYMENT_ID,
      { amount: 80.5, dueDate: '2026-06-20' },
      NOW,
    );

    const { where, data } = mockPrisma.subscriptionPayment.updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: PAYMENT_ID, status: PaymentStatus.PENDING });
    expect(data.amount.toFixed(2)).toBe('80.50');
    expect(formatDateOnly(data.dueDate)).toBe('2026-06-20');
    expect(result.amount).toBe('80.5');
    expect(result.dueDate).toBe('2026-06-20');
  });

  it('rejects an amount change on a paid payment with 409 SUBSCRIPTION_PAYMENT_ALREADY_PAID', async () => {
    stubStoredPayment(paidPayment());

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { amount: 90 }, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
      messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
    });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a dueDate change on a paid payment with 409', async () => {
    stubStoredPayment(paidPayment());

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { dueDate: '2026-06-30' }, NOW),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID });
  });

  it('allows notes-only edits on a paid payment', async () => {
    stubStoredPayment(paidPayment());

    const result = await updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { notes: 'recibo 123' }, NOW);

    expect(result.notes).toBe('recibo 123');
  });

  it('allows resubmitting identical amount/dueDate on a paid payment and writes only the changed notes', async () => {
    stubStoredPayment(paidPayment());

    await updatePayment(
      mockPrisma,
      TRAINER_USER_ID,
      PAYMENT_ID,
      { amount: 100, dueDate: '2026-06-10', notes: 'x' },
      NOW,
    );

    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledOnce();
    expect(mockPrisma.subscriptionPayment.updateMany.mock.calls[0][0].data).toEqual({ notes: 'x' });
  });

  it('writes nothing and returns the current formatted payment when no field actually changes', async () => {
    stubStoredPayment(makePaymentRecord({ notes: 'same' }));

    const result = await updatePayment(
      mockPrisma,
      TRAINER_USER_ID,
      PAYMENT_ID,
      { amount: 100, dueDate: '2026-06-10', notes: 'same' },
      NOW,
    );

    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
    expect(result).toMatchObject({ id: PAYMENT_ID, amount: '100', dueDate: '2026-06-10', notes: 'same' });
  });

  it('writes nothing for an empty patch on a cancelled-free pending payment', async () => {
    stubStoredPayment(makePaymentRecord());

    await updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, {}, NOW);

    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('writes only the changed field when several are supplied (dueDate changes, amount identical)', async () => {
    stubStoredPayment(makePaymentRecord());

    await updatePayment(
      mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { amount: 100, dueDate: '2026-06-20' }, NOW,
    );

    const { data } = mockPrisma.subscriptionPayment.updateMany.mock.calls[0][0];
    expect(Object.keys(data)).toEqual(['dueDate']);
  });

  it('rejects any edit of a cancelled payment with 409 SUBSCRIPTION_PAYMENT_CANCELLED', async () => {
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.CANCELLED }));

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { notes: 'x' }, NOW),
    ).rejects.toMatchObject({ httpStatus: 409, error: SubscriptionErrorCode.PAYMENT_CANCELLED });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('answers 409 PAYMENT_CANCELLED when the payment is voided after the pre-read (updateMany count 0)', async () => {
    stubStoredPayment(makePaymentRecord(), {
      updateCount: 0,
      reloadedRow: makePaymentRecord({ status: PaymentStatus.CANCELLED }),
    });

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { notes: 'x' }, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_CANCELLED,
      messageCode: SubscriptionMessageCode.PAYMENT_CANCELLED,
    });
  });

  it('answers 409 PAYMENT_ALREADY_PAID when an amount change loses the race against mark-paid (count 0, row now paid)', async () => {
    stubStoredPayment(makePaymentRecord(), {
      updateCount: 0,
      reloadedRow: paidPayment(),
    });

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { amount: 90 }, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
      messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
    });
  });

  it.each([
    ['more than 2 decimals', 10.005],
    ['above the Decimal(10,2) maximum', 100000000],
  ])('rejects an amount %s with 400 SUBSCRIPTION_INVALID_AMOUNT', async (_label, amount) => {
    stubStoredPayment(makePaymentRecord());

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { amount }, NOW),
    ).rejects.toMatchObject({
      httpStatus: 400,
      error: SubscriptionErrorCode.INVALID_AMOUNT,
      messageCode: SubscriptionMessageCode.INVALID_AMOUNT,
    });
  });

  it('throws 404 when payment not found or wrong trainer', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      updatePayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, { notes: 'x' }, NOW),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PAYMENT_NOT_FOUND });
  });
});

// ─── voidPayment ──────────────────────────────────────────────────────────────

describe('voidPayment', () => {
  it('soft-voids a pending payment with a conditional write (status cancelled, never deleted)', async () => {
    stubStoredPayment(makePaymentRecord());

    const result = await voidPayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW);

    expect(mockPrisma.subscriptionPayment.updateMany).toHaveBeenCalledWith({
      where: { id: PAYMENT_ID, status: PaymentStatus.PENDING },
      data: { status: PaymentStatus.CANCELLED, voidedAt: NOW },
    });
    expect(result.status).toBe(PaymentStatus.CANCELLED);
    expect(result.effectiveStatus).toBe(EffectivePaymentStatus.CANCELLED);
  });

  it('voids an overdue pending payment', async () => {
    stubStoredPayment(makePaymentRecord({ dueDate: new Date('2026-05-01T00:00:00Z') }));

    const result = await voidPayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW);

    expect(result.status).toBe(PaymentStatus.CANCELLED);
  });

  it('is idempotent for an already voided payment (conditional write matches nothing, row returned as-is)', async () => {
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.CANCELLED }), { updateCount: 0 });

    const result = await voidPayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW);

    expect(result.status).toBe(PaymentStatus.CANCELLED);
  });

  it('rejects voiding a paid payment with 409 SUBSCRIPTION_PAYMENT_ALREADY_PAID', async () => {
    stubStoredPayment(makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }));

    await expect(
      voidPayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
      messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
    });
    expect(mockPrisma.subscriptionPayment.updateMany).not.toHaveBeenCalled();
  });

  it('answers 409 PAYMENT_ALREADY_PAID when mark-paid wins between the pre-read and the write (updateMany count 0)', async () => {
    stubStoredPayment(makePaymentRecord(), {
      updateCount: 0,
      reloadedRow: makePaymentRecord({ status: PaymentStatus.PAID, paidAt: NOW }),
    });

    await expect(
      voidPayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW),
    ).rejects.toMatchObject({
      httpStatus: 409,
      error: SubscriptionErrorCode.PAYMENT_ALREADY_PAID,
      messageCode: SubscriptionMessageCode.PAYMENT_ALREADY_PAID,
    });
  });

  it('throws 404 when payment not found', async () => {
    mockPrisma.subscriptionPayment.findFirst.mockResolvedValue(null);

    await expect(
      voidPayment(mockPrisma, TRAINER_USER_ID, PAYMENT_ID, NOW),
    ).rejects.toMatchObject({ httpStatus: 404, error: SubscriptionErrorCode.PAYMENT_NOT_FOUND });
  });
});
