import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PointAction,
  DEFAULT_POINT_VALUES,
  GamificationErrorCode,
} from "../../src/constants/gamification.js";

const TRAINER_ID = "trainer-uuid-1";
const STUDENT_ID = "student-uuid-1";
const SESSION_ID = "session-uuid-1";
const CHALLENGE_ID = "challenge-uuid-1";

// Active challenge with snapshotted pts config (null = use system default)
const makeActiveChallenge = (overrides = {}) => ({
  id: CHALLENGE_ID,
  trainerId: TRAINER_ID,
  startDate: new Date(Date.UTC(2026, 0, 1)),
  endDate: new Date(Date.UTC(2026, 11, 31)),
  cancelledAt: null,
  ptsWorkoutCompleted: null,
  ptsStreak7Days: null,
  ptsStreak30Days: null,
  ptsDailyCheckin: null,
  ptsEvolutionRecord: null,
  ptsWorkoutFeedback: null,
  dailyPointsCap: null,
  ...overrides,
});

const mockPrisma = {
  gamificationConfig: { findUnique: vi.fn() },
  challengeParticipant: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
  challenge: { findUnique: vi.fn() },
  pointTransaction: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    groupBy: vi.fn(),
    aggregate: vi.fn(),
  },
  pointBalance: {
    upsert: vi.fn(),
    findUnique: vi.fn(),
  },
  trainer: { findUnique: vi.fn() },
  training: { findUnique: vi.fn() },
};

import {
  resolvePointValue,
  awardPoints,
  awardManualBonus,
  getStudentPointHistory,
  getStudentPointSummary,
} from "../../src/services/gamification-service.js";

const makeTransaction = (overrides = {}) => ({
  id: "tx-uuid-1",
  studentId: STUDENT_ID,
  trainerId: TRAINER_ID,
  challengeId: CHALLENGE_ID,
  action: PointAction.WORKOUT_COMPLETED,
  points: 10,
  referenceId: SESSION_ID,
  reason: null,
  createdAt: new Date("2026-01-15T10:00:00Z"),
  ...overrides,
});

describe("gamification-service", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ─── resolvePointValue ─────────────────────────────────────────────────────

  describe("resolvePointValue", () => {
    it("returns system default when challenge field is null", () => {
      const challenge = makeActiveChallenge({ ptsWorkoutCompleted: null });
      expect(resolvePointValue(challenge, PointAction.WORKOUT_COMPLETED)).toBe(
        DEFAULT_POINT_VALUES.workout_completed,
      );
    });

    it("returns 0 when action is explicitly disabled (0)", () => {
      const challenge = makeActiveChallenge({ ptsWorkoutCompleted: 0 });
      expect(resolvePointValue(challenge, PointAction.WORKOUT_COMPLETED)).toBe(
        0,
      );
    });

    it("returns custom value when snapshotted in challenge", () => {
      const challenge = makeActiveChallenge({ ptsWorkoutCompleted: 25 });
      expect(resolvePointValue(challenge, PointAction.WORKOUT_COMPLETED)).toBe(
        25,
      );
    });

    it("returns null for TRAINER_BONUS (no config field)", () => {
      expect(
        resolvePointValue(makeActiveChallenge(), PointAction.TRAINER_BONUS),
      ).toBeNull();
    });

    it("returns system default when challenge config is null", () => {
      expect(resolvePointValue(null, PointAction.WORKOUT_COMPLETED)).toBe(
        DEFAULT_POINT_VALUES.workout_completed,
      );
    });
  });

  // ─── awardPoints (fan-out across active challenges) ────────────────────────

  describe("awardPoints", () => {
    it("returns empty array when gamification is disabled", async () => {
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue({
        enabled: false,
      });

      const results = await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      expect(results).toEqual([]);
      expect(mockPrisma.pointTransaction.create).not.toHaveBeenCalled();
    });

    it("returns empty array when student is in no active challenges", async () => {
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null); // gamification not configured = enabled by default
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([]); // no participations

      const results = await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      expect(results).toEqual([]);
    });

    it("creates one PointTransaction per active challenge", async () => {
      const challenge1 = makeActiveChallenge({ id: "challenge-uuid-1" });
      const challenge2 = makeActiveChallenge({ id: "challenge-uuid-2" });

      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { challenge: challenge1 },
        { challenge: challenge2 },
      ]);
      mockPrisma.pointTransaction.create
        .mockResolvedValueOnce(
          makeTransaction({ challengeId: "challenge-uuid-1" }),
        )
        .mockResolvedValueOnce(
          makeTransaction({ challengeId: "challenge-uuid-2" }),
        );
      mockPrisma.pointBalance.upsert.mockResolvedValue({});

      const results = await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      expect(results).toHaveLength(2);
      expect(mockPrisma.pointTransaction.create).toHaveBeenCalledTimes(2);
    });

    it("filters out non-active challenges from fan-out", async () => {
      // Cancelled challenge — should be skipped
      const cancelledChallenge = makeActiveChallenge({
        id: "challenge-cancelled",
        cancelledAt: new Date("2026-01-01"),
      });
      const activeChallenge = makeActiveChallenge({ id: "challenge-active" });

      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { challenge: cancelledChallenge },
        { challenge: activeChallenge },
      ]);
      mockPrisma.pointTransaction.create.mockResolvedValue(
        makeTransaction({ challengeId: "challenge-active" }),
      );
      mockPrisma.pointBalance.upsert.mockResolvedValue({});

      const results = await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      expect(results).toHaveLength(1);
      expect(mockPrisma.pointTransaction.create).toHaveBeenCalledTimes(1);
    });

    it("enforces per-challenge daily cap", async () => {
      const challenge = makeActiveChallenge({ dailyPointsCap: 12 });

      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { challenge },
      ]);
      // Already earned 7 today for this challenge; cap=12; remaining=5; default pts=10 → trim to 5
      mockPrisma.pointTransaction.aggregate.mockResolvedValue({
        _sum: { points: 7 },
      });
      mockPrisma.pointTransaction.create.mockResolvedValue(
        makeTransaction({ points: 5 }),
      );
      mockPrisma.pointBalance.upsert.mockResolvedValue({});

      await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      const createCall = mockPrisma.pointTransaction.create.mock.calls[0][0];
      expect(createCall.data.points).toBe(5);
    });

    it("returns null entry (filtered) when daily cap is fully reached", async () => {
      const challenge = makeActiveChallenge({ dailyPointsCap: 10 });

      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { challenge },
      ]);
      mockPrisma.pointTransaction.aggregate.mockResolvedValue({
        _sum: { points: 10 },
      });

      const results = await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      expect(results).toEqual([]); // null filtered out
    });

    it("skips duplicate transactions silently (P2002)", async () => {
      const challenge = makeActiveChallenge();

      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { challenge },
      ]);
      const dupError = new Error("Unique constraint failed");
      dupError.code = "P2002";
      mockPrisma.pointTransaction.create.mockRejectedValue(dupError);

      const results = await awardPoints({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        trainerId: TRAINER_ID,
        action: PointAction.WORKOUT_COMPLETED,
        referenceId: SESSION_ID,
      });

      expect(results).toEqual([]);
    });

    it("rethrows non-P2002 errors", async () => {
      const challenge = makeActiveChallenge();

      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      mockPrisma.challengeParticipant.findMany.mockResolvedValue([
        { challenge },
      ]);
      mockPrisma.pointTransaction.create.mockRejectedValue(
        new Error("DB connection lost"),
      );

      await expect(
        awardPoints({
          prisma: mockPrisma,
          studentId: STUDENT_ID,
          trainerId: TRAINER_ID,
          action: PointAction.WORKOUT_COMPLETED,
          referenceId: SESSION_ID,
        }),
      ).rejects.toThrow("DB connection lost");
    });
  });

  // ─── awardManualBonus ─────────────────────────────────────────────────────

  describe("awardManualBonus", () => {
    const activeChallenge = makeActiveChallenge();

    it("creates a TRAINER_BONUS transaction with null referenceId", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.challenge.findUnique.mockResolvedValue(activeChallenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID,
      });
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      const bonusTx = makeTransaction({
        action: PointAction.TRAINER_BONUS,
        referenceId: null,
        points: 50,
        reason: "Great work!",
      });
      mockPrisma.pointTransaction.create.mockResolvedValue(bonusTx);
      mockPrisma.pointBalance.upsert.mockResolvedValue({});

      const result = await awardManualBonus({
        prisma: mockPrisma,
        trainerUserId: "trainer-user-id",
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID,
        points: 50,
        reason: "Great work!",
      });

      expect(result.action).toBe(PointAction.TRAINER_BONUS);
      expect(result.referenceId).toBeNull();
      expect(result.points).toBe(50);
    });

    it("throws 404 when trainer profile is missing", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue(null);

      await expect(
        awardManualBonus({
          prisma: mockPrisma,
          trainerUserId: "trainer-user-id",
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID,
          points: 10,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: GamificationErrorCode.TRAINER_PROFILE_MISSING,
      });
    });

    it("throws 404 when challenge not found or not owned by trainer", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.challenge.findUnique.mockResolvedValue(null);

      await expect(
        awardManualBonus({
          prisma: mockPrisma,
          trainerUserId: "trainer-user-id",
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID,
          points: 10,
        }),
      ).rejects.toMatchObject({ httpStatus: 404 });
    });

    it("throws 400 CHALLENGE_NOT_ACTIVE when challenge is cancelled", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeActiveChallenge({ cancelledAt: new Date() }),
      );

      await expect(
        awardManualBonus({
          prisma: mockPrisma,
          trainerUserId: "trainer-user-id",
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID,
          points: 10,
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: GamificationErrorCode.CHALLENGE_NOT_ACTIVE,
      });
    });

    it("throws 400 CHALLENGE_NOT_ACTIVE when challenge is completed", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeActiveChallenge({
          startDate: new Date(Date.UTC(2020, 0, 1)),
          endDate: new Date(Date.UTC(2020, 0, 31)),
        }),
      );

      await expect(
        awardManualBonus({
          prisma: mockPrisma,
          trainerUserId: "trainer-user-id",
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID,
          points: 10,
        }),
      ).rejects.toMatchObject({
        httpStatus: 400,
        error: GamificationErrorCode.CHALLENGE_NOT_ACTIVE,
      });
    });

    it("throws STUDENT_NOT_TRAINEE when student not a participant in the challenge", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.challenge.findUnique.mockResolvedValue(activeChallenge);
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue(null);

      await expect(
        awardManualBonus({
          prisma: mockPrisma,
          trainerUserId: "trainer-user-id",
          challengeId: CHALLENGE_ID,
          studentId: STUDENT_ID,
          points: 10,
        }),
      ).rejects.toMatchObject({
        httpStatus: 404,
        error: GamificationErrorCode.STUDENT_NOT_TRAINEE,
      });
    });

    it("bonus is not subject to daily cap", async () => {
      mockPrisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID });
      mockPrisma.challenge.findUnique.mockResolvedValue(
        makeActiveChallenge({ dailyPointsCap: 5 }),
      );
      mockPrisma.challengeParticipant.findUnique.mockResolvedValue({
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID,
      });
      mockPrisma.gamificationConfig.findUnique.mockResolvedValue(null);
      const bonusTx = makeTransaction({
        action: PointAction.TRAINER_BONUS,
        points: 1000,
      });
      mockPrisma.pointTransaction.create.mockResolvedValue(bonusTx);
      mockPrisma.pointBalance.upsert.mockResolvedValue({});

      const result = await awardManualBonus({
        prisma: mockPrisma,
        trainerUserId: "trainer-user-id",
        challengeId: CHALLENGE_ID,
        studentId: STUDENT_ID,
        points: 1000,
      });

      // No aggregate call for daily cap check
      expect(mockPrisma.pointTransaction.aggregate).not.toHaveBeenCalled();
      expect(result.points).toBe(1000);
    });
  });

  // ─── getStudentPointHistory ────────────────────────────────────────────────

  describe("getStudentPointHistory", () => {
    it("returns paginated transactions scoped to challengeId", async () => {
      const transactions = [
        makeTransaction(),
        makeTransaction({ id: "tx-uuid-2" }),
      ];
      mockPrisma.pointTransaction.findMany.mockResolvedValue(transactions);
      mockPrisma.pointTransaction.count.mockResolvedValue(2);

      const result = await getStudentPointHistory({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        challengeId: CHALLENGE_ID,
        page: 1,
        limit: 20,
      });

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);

      const findCall = mockPrisma.pointTransaction.findMany.mock.calls[0][0];
      expect(findCall.where).toMatchObject({
        studentId: STUDENT_ID,
        challengeId: CHALLENGE_ID,
      });
    });

    it("applies correct skip for page 2", async () => {
      mockPrisma.pointTransaction.findMany.mockResolvedValue([]);
      mockPrisma.pointTransaction.count.mockResolvedValue(0);

      await getStudentPointHistory({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        challengeId: CHALLENGE_ID,
        page: 2,
        limit: 10,
      });

      const findCall = mockPrisma.pointTransaction.findMany.mock.calls[0][0];
      expect(findCall.skip).toBe(10);
      expect(findCall.take).toBe(10);
    });
  });

  // ─── getStudentPointSummary ────────────────────────────────────────────────

  describe("getStudentPointSummary", () => {
    it("returns totalPoints computed from groupBy and breakdown", async () => {
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([
        { action: PointAction.WORKOUT_COMPLETED, _sum: { points: 60 } },
        { action: PointAction.TRAINER_BONUS, _sum: { points: 15 } },
      ]);

      const result = await getStudentPointSummary({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        challengeId: CHALLENGE_ID,
      });

      expect(result.totalPoints).toBe(75);
      expect(result.breakdown[PointAction.WORKOUT_COMPLETED]).toBe(60);
      expect(result.breakdown[PointAction.TRAINER_BONUS]).toBe(15);

      const groupByCall = mockPrisma.pointTransaction.groupBy.mock.calls[0][0];
      expect(groupByCall.where).toMatchObject({
        studentId: STUDENT_ID,
        challengeId: CHALLENGE_ID,
      });
    });

    it("returns totalPoints=0 and empty breakdown when no transactions", async () => {
      mockPrisma.pointTransaction.groupBy.mockResolvedValue([]);

      const result = await getStudentPointSummary({
        prisma: mockPrisma,
        studentId: STUDENT_ID,
        challengeId: CHALLENGE_ID,
      });

      expect(result.totalPoints).toBe(0);
      expect(result.breakdown).toEqual({});
    });
  });
});
