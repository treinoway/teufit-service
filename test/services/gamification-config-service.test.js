import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DEFAULT_POINT_VALUES, DEFAULT_STREAK_TOLERANCE_HOURS } from '../../src/constants/gamification.js';

const mockPrisma = {
  trainer: { findUnique: vi.fn() },
  gamificationConfig: { findUnique: vi.fn(), upsert: vi.fn() },
};

import {
  upsertConfig,
  getConfig,
  upsertConfigByUserId,
  getConfigByUserId,
} from '../../src/services/gamification-config-service.js';

const TRAINER_ID = 'trainer-uuid-1';
const USER_ID = 'user-uuid-1';

const baseStoredConfig = {
  id: 'config-uuid-1',
  trainerId: TRAINER_ID,
  enabled: true,
  ptsWorkoutCompleted: null,
  ptsStreak7Days: null,
  ptsStreak30Days: null,
  ptsDailyCheckin: null,
  ptsEvolutionRecord: null,
  ptsWorkoutFeedback: null,
  dailyPointsCap: null,
  streakToleranceHours: DEFAULT_STREAK_TOLERANCE_HOURS,
  anonymousRanking: false,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: null,
};

describe('gamification-config-service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── upsertConfig ──────────────────────────────────────────────────────────

  describe('upsertConfig', () => {
    it('returns config with system defaults applied for null fields', async () => {
      mockPrisma.gamificationConfig.upsert.mockResolvedValue(baseStoredConfig);

      const result = await upsertConfig({ prisma: mockPrisma, trainerId: TRAINER_ID, data: {} });

      expect(result.ptsWorkoutCompleted).toBe(DEFAULT_POINT_VALUES.workout_completed);
      expect(result.ptsStreak7Days).toBe(DEFAULT_POINT_VALUES.streak_7_days);
      expect(result.streakToleranceHours).toBe(DEFAULT_STREAK_TOLERANCE_HOURS);
    });

    it('preserves explicitly configured point values', async () => {
      const configWithCustomPoints = { ...baseStoredConfig, ptsWorkoutCompleted: 25 };
      mockPrisma.gamificationConfig.upsert.mockResolvedValue(configWithCustomPoints);

      const result = await upsertConfig({
        prisma: mockPrisma,
        trainerId: TRAINER_ID,
        data: { ptsWorkoutCompleted: 25 },
      });

      expect(result.ptsWorkoutCompleted).toBe(25);
    });

    it('preserves 0 as a valid point value (action disabled)', async () => {
      const configWithZero = { ...baseStoredConfig, ptsWorkoutCompleted: 0 };
      mockPrisma.gamificationConfig.upsert.mockResolvedValue(configWithZero);

      const result = await upsertConfig({
        prisma: mockPrisma,
        trainerId: TRAINER_ID,
        data: { ptsWorkoutCompleted: 0 },
      });

      expect(result.ptsWorkoutCompleted).toBe(0);
    });

    it('calls upsert with correct create and update payloads', async () => {
      mockPrisma.gamificationConfig.upsert.mockResolvedValue(baseStoredConfig);

      await upsertConfig({
        prisma: mockPrisma,
        trainerId: TRAINER_ID,
        data: { enabled: false, anonymousRanking: true },
      });

      const call = mockPrisma.gamificationConfig.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ trainerId: TRAINER_ID });
      expect(call.create.trainerId).toBe(TRAINER_ID);
      expect(call.update.enabled).toBe(false);
      expect(call.update.anonymousRanking).toBe(true);
    });
  });

  // ─── getConfig ─────────────────────────────────────────────────────────────

  describe('getConfig', () => {
    it('returns stored config with defaults applied', async () => {
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(baseStoredConfig);

      const result = await getConfig({ prisma: mockPrisma, trainerId: TRAINER_ID });

      expect(result.id).toBe('config-uuid-1');
      expect(result.ptsWorkoutCompleted).toBe(DEFAULT_POINT_VALUES.workout_completed);
    });

    it('returns virtual config with defaults when no config row exists', async () => {
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);

      const result = await getConfig({ prisma: mockPrisma, trainerId: TRAINER_ID });

      expect(result.id).toBeNull();
      expect(result.trainerId).toBe(TRAINER_ID);
      expect(result.enabled).toBe(true);
      expect(result.ptsWorkoutCompleted).toBe(DEFAULT_POINT_VALUES.workout_completed);
      expect(result.anonymousRanking).toBe(false);
    });

    it('does not include rankingMode in the returned config', async () => {
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(baseStoredConfig);

      const result = await getConfig({ prisma: mockPrisma, trainerId: TRAINER_ID });

      expect(result.rankingMode).toBeUndefined();
    });
  });

  // ─── upsertConfigByUserId ──────────────────────────────────────────────────

  describe('upsertConfigByUserId', () => {
    it('resolves trainer and delegates to upsertConfig', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.gamificationConfig.upsert.mockResolvedValue(baseStoredConfig);

      const result = await upsertConfigByUserId({
        prisma: mockPrisma,
        userId: USER_ID,
        data: {},
      });

      expect(mockPrisma.trainer.findUnique).toHaveBeenCalledWith({
        where: { userId: USER_ID },
        select: { id: true },
      });
      expect(result.trainerId).toBe(TRAINER_ID);
    });

    it('throws 404 when trainer profile is missing', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        upsertConfigByUserId({ prisma: mockPrisma, userId: USER_ID, data: {} }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: 'TRAINER_PROFILE_MISSING',
        messageCode: 'trainer.notFound',
      });
    });
  });

  // ─── getConfigByUserId ─────────────────────────────────────────────────────

  describe('getConfigByUserId', () => {
    it('resolves trainer and returns config', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(baseStoredConfig);

      const result = await getConfigByUserId({ prisma: mockPrisma, userId: USER_ID });

      expect(result.id).toBe('config-uuid-1');
    });

    it('throws 404 when trainer profile is missing', async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        getConfigByUserId({ prisma: mockPrisma, userId: USER_ID }),
      ).rejects.toMatchObject({ httpStatus: 404, error: 'TRAINER_PROFILE_MISSING' });
    });
  });
});
