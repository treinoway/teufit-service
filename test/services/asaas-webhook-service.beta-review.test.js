import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  enforceStudentCapAfterDowngrade: vi.fn().mockResolvedValue(undefined),
  reactivateStudentsUpToCap: vi.fn().mockResolvedValue(undefined),
}));

import {
  enforceStudentCapAfterDowngrade,
  reactivateStudentsUpToCap,
} from '../../src/services/platform-plan-service.js';
import { handleWebhookEvent } from '../../src/services/asaas-webhook-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const ASAAS_SUB_ID = 'sub_sandbox_001';
const ASAAS_PAY_ID = 'pay_sandbox_001';
const { ACTIVE } = PLATFORM_SUBSCRIPTION_STATUSES;

const mockPrisma = {
  platformSubscription: { findFirst: vi.fn(), update: vi.fn() },
  platformSubscriptionPayment: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
};
const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

// Builds an abandoned-checkout subscription row for the given tier.
function makeSubscription(tier, overrides = {}) {
  return {
    id: 'platsub-uuid-1',
    trainerId: TRAINER_ID,
    tier,
    status: ACTIVE,
    asaasSubscriptionId: ASAAS_SUB_ID,
    checkoutPendingSince: new Date(),
    pastDueSince: null,
    ...overrides,
  };
}

// Builds a payment payload for the Asaas subscription.
function makePayment(externalReference) {
  return { id: ASAAS_PAY_ID, subscription: ASAAS_SUB_ID, value: 49.9, dueDate: '2026-05-16', billingType: 'PIX', externalReference };
}

// Returns the data written by the single platformSubscription.update call.
function writtenData() {
  return mockPrisma.platformSubscription.update.mock.calls[0][0].data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.platformSubscriptionPayment.findUnique.mockResolvedValue(null);
  mockPrisma.platformSubscriptionPayment.upsert.mockResolvedValue({});
  mockPrisma.platformSubscription.update.mockResolvedValue({});
});

describe('abandoned checkout on a BETA trainer', () => {
  it('should drop the Asaas link and keep BETA on PAYMENT_OVERDUE', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('BETA'));

    await handleWebhookEvent(mockPrisma, { event: 'PAYMENT_OVERDUE', payment: makePayment('tier:PRO:trainer:x') }, silentLogger);

    expect(writtenData()).toEqual({
      asaasSubscriptionId: null,
      checkoutPendingSince: null,
      pastDueSince: null,
      status: ACTIVE,
    });
  });

  it('should drop the Asaas link and keep BETA on SUBSCRIPTION_DELETED', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('BETA'));

    await handleWebhookEvent(mockPrisma, { event: 'SUBSCRIPTION_DELETED', subscription: { id: ASAAS_SUB_ID } }, silentLogger);

    expect(writtenData()).toMatchObject({ asaasSubscriptionId: null, status: ACTIVE });
    expect(writtenData()).not.toHaveProperty('tier');
    expect(enforceStudentCapAfterDowngrade).not.toHaveBeenCalled();
  });

  it('should still mark a paid tier PAST_DUE on PAYMENT_OVERDUE', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('PRO', { checkoutPendingSince: null }));

    await handleWebhookEvent(mockPrisma, { event: 'PAYMENT_OVERDUE', payment: makePayment('tier:PRO:trainer:x') }, silentLogger);

    expect(writtenData()).toMatchObject({ status: PLATFORM_SUBSCRIPTION_STATUSES.PAST_DUE });
  });

  it('should still downgrade a paid tier to FREE on SUBSCRIPTION_DELETED', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('PRO', { checkoutPendingSince: null }));

    await handleWebhookEvent(mockPrisma, { event: 'SUBSCRIPTION_DELETED', subscription: { id: ASAAS_SUB_ID } }, silentLogger);

    expect(writtenData()).toMatchObject({ tier: 'FREE', asaasSubscriptionId: null });
    expect(enforceStudentCapAfterDowngrade).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
  });
});

describe('PAYMENT_CONFIRMED student cap and pending flag', () => {
  it('should enforce the student cap when BETA moves down to PRO', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('BETA'));

    await handleWebhookEvent(mockPrisma, { event: 'PAYMENT_CONFIRMED', payment: makePayment(`tier:PRO:trainer:${TRAINER_ID}`) }, silentLogger);

    expect(enforceStudentCapAfterDowngrade).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
    expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
  });

  it('should reactivate students on an upgrade and not enforce the cap', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('PRO'));

    await handleWebhookEvent(mockPrisma, { event: 'PAYMENT_CONFIRMED', payment: makePayment(`tier:DIAMOND:trainer:${TRAINER_ID}`) }, silentLogger);

    expect(reactivateStudentsUpToCap).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
    expect(enforceStudentCapAfterDowngrade).not.toHaveBeenCalled();
  });

  it('should touch no student when the confirmed tier equals the current tier', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('PRO'));

    await handleWebhookEvent(mockPrisma, { event: 'PAYMENT_CONFIRMED', payment: makePayment(`tier:PRO:trainer:${TRAINER_ID}`) }, silentLogger);

    expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
    expect(enforceStudentCapAfterDowngrade).not.toHaveBeenCalled();
  });

  it('should clear checkoutPendingSince when the payment is confirmed', async () => {
    mockPrisma.platformSubscription.findFirst.mockResolvedValue(makeSubscription('FREE'));

    await handleWebhookEvent(mockPrisma, { event: 'PAYMENT_CONFIRMED', payment: makePayment(`tier:PRO:trainer:${TRAINER_ID}`) }, silentLogger);

    expect(writtenData()).toMatchObject({ tier: 'PRO', checkoutPendingSince: null });
  });
});
