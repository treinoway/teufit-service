import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  PLAN_LIMITS,
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
} from '../../src/constants/platform-plan.js';

vi.mock('../../src/services/platform-plan-service.js', () => ({
  getTrainerPlan: vi.fn(),
  enforceStudentCapAfterDowngrade: vi.fn(),
  reactivateStudentsUpToCap: vi.fn(),
}));

import {
  getTrainerPlan,
  enforceStudentCapAfterDowngrade,
  reactivateStudentsUpToCap,
} from '../../src/services/platform-plan-service.js';
import { setTrainerTier } from '../../src/services/admin-trainer-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const USER_ID = 'user-uuid-1';
const BETA_TIER = 'BETA';
const BETA_WITH_PAID_ERROR = 'PLATFORM_PLAN_BETA_WITH_PAID_SUBSCRIPTION';
const CONFLICT_MESSAGE_CODE = 'resource.conflict';
const ASAAS_SUBSCRIPTION_ID = 'sub_sandbox_001';
const { FREE, PRO } = PLATFORM_PLAN_TIERS;

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  platformSubscription: { upsert: vi.fn() },
  trainerStudent: { count: vi.fn() },
};

// Stubs the plan the service resolves before changing the tier.
function stubCurrentPlan(tier, subscription = null) {
  getTrainerPlan.mockResolvedValue({
    tier,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    limits: PLAN_LIMITS[tier],
    subscription,
  });
}

describe('setTrainerTier to BETA', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
    mockPrisma.trainerStudent.count.mockResolvedValue(5);
    mockPrisma.platformSubscription.upsert.mockResolvedValue({
      tier: BETA_TIER,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      asaasSubscriptionId: null,
    });
  });

  describe('without an Asaas subscription', () => {
    beforeEach(() => stubCurrentPlan(FREE));

    it('should upsert the BETA tier', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: BETA_TIER });

      expect(mockPrisma.platformSubscription.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { trainerId: TRAINER_ID },
          update: expect.objectContaining({ tier: BETA_TIER }),
        })
      );
    });

    it('should reactivate students when moving from FREE to BETA', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: BETA_TIER });

      expect(reactivateStudentsUpToCap).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
      expect(enforceStudentCapAfterDowngrade).not.toHaveBeenCalled();
    });

    it('should return BETA with an unlimited student cap', async () => {
      const result = await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: BETA_TIER });

      expect(result).toMatchObject({ previousTier: FREE, tier: BETA_TIER, changed: true, studentCap: null });
    });
  });

  describe('with an Asaas subscription', () => {
    beforeEach(() =>
      stubCurrentPlan(PRO, { tier: PRO, status: 'ACTIVE', asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID })
    );

    it('should throw 409 PLATFORM_PLAN_BETA_WITH_PAID_SUBSCRIPTION', async () => {
      await expect(
        setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: BETA_TIER })
      ).rejects.toMatchObject({
        httpStatus: 409,
        error: BETA_WITH_PAID_ERROR,
        messageCode: CONFLICT_MESSAGE_CODE,
      });
    });

    it('should not write anything', async () => {
      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: BETA_TIER }).catch(() => {});

      expect(mockPrisma.platformSubscription.upsert).not.toHaveBeenCalled();
      expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
    });
  });

  describe('away from BETA', () => {
    it('should enforce the student cap when moving BETA to PRO', async () => {
      stubCurrentPlan(BETA_TIER, { tier: BETA_TIER, status: 'ACTIVE', asaasSubscriptionId: null });
      mockPrisma.platformSubscription.upsert.mockResolvedValue({ tier: PRO, status: 'ACTIVE' });

      await setTrainerTier(mockPrisma, { trainerId: TRAINER_ID, tier: PRO });

      expect(enforceStudentCapAfterDowngrade).toHaveBeenCalledWith(mockPrisma, TRAINER_ID);
      expect(reactivateStudentsUpToCap).not.toHaveBeenCalled();
    });
  });
});
