import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ASAAS_PAYMENT_STATUSES,
  PLATFORM_SUBSCRIPTION_STATUSES,
} from '../../src/constants/platform-plan.js';

// ─── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../src/services/platform-plan-service.js', () => ({
  syncStudentCapWithPlan: vi.fn().mockResolvedValue(undefined),
}));

import { syncStudentCapWithPlan } from '../../src/services/platform-plan-service.js';
import { handleWebhookEvent } from '../../src/services/asaas-webhook-service.js';

// ─── Prisma mock ───────────────────────────────────────────────────────────────

const mockPrisma = {
  platformSubscription: {
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  platformSubscriptionPayment: {
    findUnique: vi.fn(),
    create: vi.fn(),
    upsert: vi.fn(),
    updateMany: vi.fn(),
  },
};

const silentLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_SUB_ID = 'sub_sandbox_001';
const ASAAS_PAY_ID = 'pay_sandbox_001';

function makePlatformSubscription(overrides = {}) {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier: 'PRO',
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    asaasSubscriptionId: ASAAS_SUB_ID,
    asaasCustomerId: 'cust-001',
    pastDueSince: null,
    cancelAtPeriodEnd: false,
    currentPeriodEnd: null,
    ...overrides,
  };
}

function makePaymentPayload(overrides = {}) {
  return {
    id: ASAAS_PAY_ID,
    subscription: ASAAS_SUB_ID,
    value: 49.90,
    dueDate: '2026-05-16',
    billingType: 'PIX',
    externalReference: 'tier:PRO:trainer:trainer-uuid-1',
    status: 'CONFIRMED',
    ...overrides,
  };
}

// ─── PAYMENT_CREATED ──────────────────────────────────────────────────────────

describe('PAYMENT_CREATED', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts payment as PENDING when payment does not exist', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.create.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CREATED',
      payment: makePaymentPayload(),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.create).toHaveBeenCalledOnce();
    const { data } = mockPrisma.platformSubscriptionPayment.create.mock.calls[0][0];
    expect(data.status).toBe(ASAAS_PAYMENT_STATUSES.PENDING);
    expect(data.asaasPaymentId).toBe(ASAAS_PAY_ID);
  });

  it('skips if payment already exists (idempotency)', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue({ id: 'existing' });

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CREATED',
      payment: makePaymentPayload(),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.create).not.toHaveBeenCalled();
  });

  it('logs and returns when subscription not found in DB', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(null);

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CREATED',
      payment: makePaymentPayload(),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.create).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalled();
  });

  it('normalizes UNDEFINED billingType to PIX', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.create.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CREATED',
      payment: makePaymentPayload({ billingType: 'UNDEFINED' }),
    }, silentLogger);

    const { data } = mockPrisma.platformSubscriptionPayment.create.mock.calls[0][0];
    expect(data.billingType).toBe('PIX');
  });

  it('normalizes null dueDate to current date', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.create.mockResolvedValue({});

    const before = new Date();
    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CREATED',
      payment: makePaymentPayload({ dueDate: null }),
    }, silentLogger);
    const after = new Date();

    const { data } = mockPrisma.platformSubscriptionPayment.create.mock.calls[0][0];
    expect(data.dueDate.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(data.dueDate.getTime()).toBeLessThanOrEqual(after.getTime() + 1000);
  });
});

// ─── PAYMENT_CONFIRMED ────────────────────────────────────────────────────────

describe('PAYMENT_CONFIRMED', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts payment as CONFIRMED and flips tier from externalReference', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(
      makePlatformSubscription({ tier: 'FREE' })
    );
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload({ externalReference: 'tier:PRO:trainer:trainer-uuid-1' }),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.upsert).toHaveBeenCalledOnce();
    const upsertArgs = mockPrisma.platformSubscriptionPayment.upsert.mock.calls[0][0];
    expect(upsertArgs.create.status).toBe(ASAAS_PAYMENT_STATUSES.CONFIRMED);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data.tier).toBe('PRO');
    expect(updateArgs.data.status).toBe(PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE);
    expect(updateArgs.data.pastDueSince).toBeNull();
  });

  it('reconciles the student cap after activating the subscription, so an upgrade unblocks students', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(
      makePlatformSubscription({ tier: 'FREE' })
    );
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload({ externalReference: 'tier:DIAMOND:trainer:trainer-uuid-1' }),
    }, silentLogger);

    expect(syncStudentCapWithPlan).toHaveBeenCalledOnce();
    expect(syncStudentCapWithPlan).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
    // Must run after the tier is persisted, otherwise it would read the old cap.
    expect(mockPrisma.platformSubscription.update.mock.invocationCallOrder[0])
      .toBeLessThan(syncStudentCapWithPlan.mock.invocationCallOrder[0]);
  });

  it('skips processing if payment already CONFIRMED (idempotency)', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue({
      status: ASAAS_PAYMENT_STATUSES.CONFIRMED,
    });

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload(),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.upsert).not.toHaveBeenCalled();
    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    expect(syncStudentCapWithPlan).not.toHaveBeenCalled();
  });

  it('resolves tier from externalReference (PLATINUM)', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload({ externalReference: 'tier:PLATINUM:trainer:trainer-uuid-1' }),
    }, silentLogger);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data.tier).toBe('PLATINUM');
  });

  it('sets paidAt on confirmed payment', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    const before = new Date();
    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload(),
    }, silentLogger);

    const upsertArgs = mockPrisma.platformSubscriptionPayment.upsert.mock.calls[0][0];
    expect(upsertArgs.create.paidAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
  });

  it('handles PAYMENT_RECEIVED the same as PAYMENT_CONFIRMED', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_RECEIVED',
      payment: makePaymentPayload(),
    }, silentLogger);

    expect(mockPrisma.platformSubscription.update).toHaveBeenCalledOnce();
  });

  it('does NOT upgrade tier when externalReference is missing and current tier is FREE', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(
      makePlatformSubscription({ tier: 'FREE' }),
    );
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload({ externalReference: null }),
    }, silentLogger);

    // Payment must still be recorded
    expect(mockPrisma.platformSubscriptionPayment.upsert).toHaveBeenCalledOnce();

    // Subscription must be updated (status/period), but tier must NOT be set
    expect(mockPrisma.platformSubscription.update).toHaveBeenCalledOnce();
    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('tier');
    expect(updateArgs.data.status).toBe(PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE);

    // Warning must be logged with paymentId, trainerId, and externalReference
    expect(silentLogger.warn).toHaveBeenCalledOnce();
    const [warnMeta] = silentLogger.warn.mock.calls[0];
    expect(warnMeta).toMatchObject({
      paymentId: ASAAS_PAY_ID,
      trainerId: TRAINER_ID,
      externalReference: null,
    });
  });

  it('does NOT upgrade tier when externalReference is unparseable and current tier is FREE', async () => {
    mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(
      makePlatformSubscription({ tier: 'FREE' }),
    );
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_CONFIRMED',
      payment: makePaymentPayload({ externalReference: 'totally-invalid-ref' }),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.upsert).toHaveBeenCalledOnce();

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data).not.toHaveProperty('tier');
    expect(updateArgs.data.status).toBe(PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE);

    expect(silentLogger.warn).toHaveBeenCalledOnce();
    const [warnMeta] = silentLogger.warn.mock.calls[0];
    expect(warnMeta).toMatchObject({
      paymentId: ASAAS_PAY_ID,
      trainerId: TRAINER_ID,
      externalReference: 'totally-invalid-ref',
    });
  });
});

// ─── PAYMENT_OVERDUE ──────────────────────────────────────────────────────────

describe('PAYMENT_OVERDUE', () => {
  beforeEach(() => vi.clearAllMocks());

  it('sets subscription status=PAST_DUE and upserts payment as OVERDUE', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_OVERDUE',
      payment: makePaymentPayload({ status: 'OVERDUE' }),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.upsert).toHaveBeenCalledOnce();
    const upsertArgs = mockPrisma.platformSubscriptionPayment.upsert.mock.calls[0][0];
    expect(upsertArgs.update.status).toBe(ASAAS_PAYMENT_STATUSES.OVERDUE);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data.status).toBe(PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE);
  });

  it('sets pastDueSince only if not already set', async () => {
    const existingPastDue = new Date('2026-05-01');
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(
      makePlatformSubscription({ pastDueSince: existingPastDue })
    );
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_OVERDUE',
      payment: makePaymentPayload(),
    }, silentLogger);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    // pastDueSince must not be overwritten with a later date
    expect(updateArgs.data.pastDueSince).toEqual(existingPastDue);
  });

  it('sets pastDueSince to now when subscription has no existing pastDueSince', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(
      makePlatformSubscription({ pastDueSince: null })
    );
    mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    const before = new Date();
    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_OVERDUE',
      payment: makePaymentPayload(),
    }, silentLogger);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data.pastDueSince.getTime()).toBeGreaterThanOrEqual(before.getTime() - 100);
  });
});

// ─── PAYMENT_REFUNDED ─────────────────────────────────────────────────────────

describe('PAYMENT_REFUNDED', () => {
  beforeEach(() => vi.clearAllMocks());

  it('marks payment as REFUNDED without changing tier', async () => {
    mockPrisma.platformSubscriptionPayment.updateMany.mockResolvedValue({ count: 1 });

    await handleWebhookEvent(mockPrisma, {
      event: 'PAYMENT_REFUNDED',
      payment: makePaymentPayload(),
    }, silentLogger);

    expect(mockPrisma.platformSubscriptionPayment.updateMany).toHaveBeenCalledOnce();
    const { where, data } = mockPrisma.platformSubscriptionPayment.updateMany.mock.calls[0][0];
    expect(where.asaasPaymentId).toBe(ASAAS_PAY_ID);
    expect(data.status).toBe(ASAAS_PAYMENT_STATUSES.REFUNDED);
    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});

// ─── SUBSCRIPTION_DELETED ────────────────────────────────────────────────────

describe('SUBSCRIPTION_DELETED', () => {
  beforeEach(() => vi.clearAllMocks());

  it('downgrades to FREE, sets status=CANCELED, clears asaasSubscriptionId, calls syncStudentCapWithPlan', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makePlatformSubscription());
    mockPrisma.platformSubscription.update.mockResolvedValue({});

    await handleWebhookEvent(mockPrisma, {
      event: 'SUBSCRIPTION_DELETED',
      subscription: { id: ASAAS_SUB_ID, status: 'INACTIVE' },
    }, silentLogger);

    const updateArgs = mockPrisma.platformSubscription.update.mock.calls[0][0];
    expect(updateArgs.data.tier).toBe('FREE');
    expect(updateArgs.data.status).toBe(PLATFORM_SUBSCRIPTION_STATUSES.CANCELED);
    expect(updateArgs.data.asaasSubscriptionId).toBeNull();

    expect(syncStudentCapWithPlan).toHaveBeenCalledOnce();
    expect(syncStudentCapWithPlan).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
  });

  it('logs and returns when subscription not found in DB', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(null);

    await handleWebhookEvent(mockPrisma, {
      event: 'SUBSCRIPTION_DELETED',
      subscription: { id: 'unknown-sub-id' },
    }, silentLogger);

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
    expect(syncStudentCapWithPlan).not.toHaveBeenCalled();
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});

// ─── SUBSCRIPTION_CREATED / SUBSCRIPTION_UPDATED ─────────────────────────────

describe('SUBSCRIPTION_CREATED', () => {
  it('is a no-op (logs only)', async () => {
    await handleWebhookEvent(mockPrisma, {
      event: 'SUBSCRIPTION_CREATED',
      subscription: { id: ASAAS_SUB_ID },
    }, silentLogger);

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});

describe('SUBSCRIPTION_UPDATED', () => {
  it('is a no-op (logs only)', async () => {
    await handleWebhookEvent(mockPrisma, {
      event: 'SUBSCRIPTION_UPDATED',
      subscription: { id: ASAAS_SUB_ID },
    }, silentLogger);

    expect(mockPrisma.platformSubscription.update).not.toHaveBeenCalled();
  });
});

// ─── Unknown event type ───────────────────────────────────────────────────────

describe('Unknown event type', () => {
  it('returns false and does not throw', async () => {
    const result = await handleWebhookEvent(mockPrisma, {
      event: 'SOME_FUTURE_ASAAS_EVENT',
    }, silentLogger);

    expect(result).toBe(false);
    expect(silentLogger.warn).toHaveBeenCalled();
  });
});
