import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getTrainerPlan } from '../../src/services/platform-plan-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const GRACE_EXPIRED_DAYS = 8;

const mockPrisma = {
  platformSubscription: { findUnique: vi.fn(), update: vi.fn() },
  trainerStudent: { count: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
};

// Builds a PAST_DUE row whose grace period ended.
function makeExpiredRow(tier) {
  return {
    id: 'sub-uuid-1',
    trainerId: TRAINER_ID,
    tier,
    status: 'PAST_DUE',
    asaasSubscriptionId: 'sub_sandbox_001',
    pastDueSince: new Date(Date.now() - GRACE_EXPIRED_DAYS * MS_PER_DAY),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.platformSubscription.update.mockResolvedValue({});
});

describe('getTrainerPlan grace expiry on a BETA row', () => {
  it('should keep BETA and drop the Asaas link', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeExpiredRow('BETA'));

    const plan = await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(plan.tier).toBe('BETA');
    expect(plan.status).toBe('ACTIVE');
    expect(plan.limits.studentCap).toBe(Infinity);
    expect(mockPrisma.platformSubscription.update).toHaveBeenCalledWith({
      where: { trainerId: TRAINER_ID },
      data: { asaasSubscriptionId: null, checkoutPendingSince: null, pastDueSince: null, status: 'ACTIVE' },
    });
  });

  it('should not enforce any student cap for BETA', async () => {
    mockPrisma.platformSubscription.findUnique.mockResolvedValue(makeExpiredRow('BETA'));

    await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(mockPrisma.trainerStudent.updateMany).not.toHaveBeenCalled();
  });

  it('should still downgrade an expired PRO row to FREE', async () => {
    mockPrisma.platformSubscription.findUnique
      .mockResolvedValueOnce(makeExpiredRow('PRO'))
      .mockResolvedValueOnce({ ...makeExpiredRow('PRO'), tier: 'FREE', status: 'ACTIVE', pastDueSince: null });
    mockPrisma.trainerStudent.findMany.mockResolvedValue([]);

    const plan = await getTrainerPlan(mockPrisma, TRAINER_ID);

    expect(plan.tier).toBe('FREE');
  });
});
