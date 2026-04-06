import "dotenv/config";
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { prisma } from "../../src/db.js";
import { setupApp } from "../helpers/setup-app.js";
import { cleanDatabase } from "../helpers/db-cleanup.js";
import { GamificationErrorCode } from "../../src/constants/gamification.js";
import { ChallengeParticipantMode } from "../../src/constants/challenge.js";

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe("e2e: gamification", () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `trainer+gamification+${Date.now()}@example.com`;
    const password = "StrongPassw0rd!";

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const {
      user: { id: userId },
      token: { accessToken },
    } = signupRes.json();

    const becomeRes = await app.inject({
      method: "PATCH",
      url: "/become-trainer",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const {
      token: { accessToken: trainerToken },
    } = becomeRes.json();

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    return { userId, trainerId: trainerRecord.id, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    const email = `student+gamification+${Date.now()}@example.com`;
    const password = "StrongPassw0rd!";

    const signupRes = await app.inject({
      method: "POST",
      url: "/auth/signup",
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const {
      user: { id: userId },
      token: { accessToken },
    } = signupRes.json();

    return { userId, accessToken };
  }

  async function linkStudentToTrainer(trainerId, studentId) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId } });
  }

  /**
   * Create an active challenge (starts today or in past, ends in future).
   */
  async function createActiveChallenge(trainerId, studentIds = []) {
    const today = new Date();
    const startDate = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    const endDate = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth() + 1,
        today.getUTCDate(),
      ),
    );

    const challenge = await prisma.challenge.create({
      data: {
        trainerId,
        name: "Active Test Challenge",
        startDate,
        endDate,
        participantMode: ChallengeParticipantMode.EXPLICIT,
        ptsWorkoutCompleted: 10,
        ptsStreak7Days: 50,
        ptsDailyCheckin: 2,
        dailyPointsCap: null,
      },
    });

    if (studentIds.length > 0) {
      await prisma.challengeParticipant.createMany({
        data: studentIds.map((studentId) => ({
          challengeId: challenge.id,
          studentId,
        })),
      });
    }

    return challenge;
  }

  async function seedPointTransaction(
    studentId,
    trainerId,
    challengeId,
    points,
    action = "workout_completed",
  ) {
    const tx = await prisma.pointTransaction.create({
      data: {
        studentId,
        trainerId,
        challengeId,
        action,
        points,
        referenceId: null,
      },
    });
    await prisma.pointBalance.upsert({
      where: { studentId_trainerId: { studentId, trainerId } },
      create: { studentId, trainerId, totalPoints: points },
      update: { totalPoints: { increment: points } },
    });
    return tx;
  }

  // ─── PUT /trainer/gamification/config ──────────────────────────────────────

  describe("PUT /trainer/gamification/config", () => {
    it("creates a new config with defaults applied", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/gamification/config",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { anonymousRanking: true },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.anonymousRanking).toBe(true);
      expect(body.ptsWorkoutCompleted).toBe(10); // default
      expect(body.rankingMode).toBeUndefined();
    });

    it("updates existing config", async () => {
      const { accessToken } = await createTrainerWithToken();

      // First upsert
      await app.inject({
        method: "PUT",
        url: "/trainer/gamification/config",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ptsWorkoutCompleted: 15 },
      });

      // Second upsert — updates the value
      const res = await app.inject({
        method: "PUT",
        url: "/trainer/gamification/config",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ptsWorkoutCompleted: 20 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ptsWorkoutCompleted).toBe(20);
    });

    it("returns 401 when unauthenticated", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/trainer/gamification/config",
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it("returns 403 when called by a student", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "PUT",
        url: "/trainer/gamification/config",
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {},
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // ─── GET /trainer/gamification/config ──────────────────────────────────────

  describe("GET /trainer/gamification/config", () => {
    it("returns virtual config with defaults when no config exists", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/trainer/gamification/config",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.enabled).toBe(true);
      expect(body.ptsWorkoutCompleted).toBe(10);
      expect(body.rankingMode).toBeUndefined();
    });
  });

  // ─── POST /trainer/challenges/:challengeId/students/:studentId/bonus ────────

  describe("POST /trainer/challenges/:challengeId/students/:studentId/bonus", () => {
    it("awards bonus points and returns 201 with transaction", async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const challenge = await createActiveChallenge(trainerId, [studentId]);

      const res = await app.inject({
        method: "POST",
        url: `/trainer/challenges/${challenge.id}/students/${studentId}/bonus`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { points: 50, reason: "Excellent effort!" },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.action).toBe("trainer_bonus");
      expect(body.points).toBe(50);
      expect(body.reason).toBe("Excellent effort!");
      expect(body.challengeId).toBe(challenge.id);
    });

    it("returns 400 when points is missing", async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const challenge = await createActiveChallenge(trainerId, [studentId]);

      const res = await app.inject({
        method: "POST",
        url: `/trainer/challenges/${challenge.id}/students/${studentId}/bonus`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { reason: "No points" },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 400 when challenge is not active (scheduled)", async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      // Scheduled challenge (starts in the future)
      const futureStart = new Date();
      futureStart.setUTCDate(futureStart.getUTCDate() + 5);
      const futureEnd = new Date();
      futureEnd.setUTCDate(futureEnd.getUTCDate() + 30);
      const scheduledChallenge = await prisma.challenge.create({
        data: {
          trainerId,
          name: "Scheduled Challenge",
          startDate: futureStart,
          endDate: futureEnd,
          participantMode: ChallengeParticipantMode.EXPLICIT,
        },
      });

      await prisma.challengeParticipant.create({
        data: { challengeId: scheduledChallenge.id, studentId },
      });

      const res = await app.inject({
        method: "POST",
        url: `/trainer/challenges/${scheduledChallenge.id}/students/${studentId}/bonus`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { points: 10 },
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe(GamificationErrorCode.CHALLENGE_NOT_ACTIVE);
      expect(body.messageCode).toBeTruthy();
    });

    it("returns 404 when student is not a participant in the challenge", async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const challenge = await createActiveChallenge(trainerId); // student NOT added

      const res = await app.inject({
        method: "POST",
        url: `/trainer/challenges/${challenge.id}/students/${studentId}/bonus`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { points: 10 },
      });

      expect(res.statusCode).toBe(404);
      const body = res.json();
      expect(body.error).toBeTruthy();
      expect(body.messageCode).toBeTruthy();
    });
  });

  // ─── GET /trainer/ranking → 410 Gone ──────────────────────────────────────

  describe("GET /trainer/ranking", () => {
    it("returns 410 Gone with GLOBAL_RANKING_REMOVED error", async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/trainer/ranking",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(410);
      const body = res.json();
      expect(body.error).toBe(GamificationErrorCode.GLOBAL_RANKING_REMOVED);
      expect(body.messageCode).toBeTruthy();
    });
  });

  // ─── GET /my/ranking → 410 Gone ───────────────────────────────────────────

  describe("GET /my/ranking", () => {
    it("returns 410 Gone with GLOBAL_RANKING_REMOVED error", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/my/ranking",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(410);
      const body = res.json();
      expect(body.error).toBe(GamificationErrorCode.GLOBAL_RANKING_REMOVED);
    });
  });

  // ─── GET /my/points ────────────────────────────────────────────────────────

  describe("GET /my/points", () => {
    it("returns paginated point history for the student scoped to a challenge", async () => {
      const { trainerId } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } =
        await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const challenge = await createActiveChallenge(trainerId, [studentId]);
      await seedPointTransaction(studentId, trainerId, challenge.id, 10);

      const res = await app.inject({
        method: "GET",
        url: `/my/points?challengeId=${challenge.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.data).toBeDefined();
      expect(body.total).toBeGreaterThanOrEqual(0);
    });

    it("returns 400 when challengeId is missing", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/my/points",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });

    it("returns 404 when student is not a participant in the challenge", async () => {
      const { trainerId } = await createTrainerWithToken();
      const { accessToken: studentToken } = await createStudentWithToken();
      const challenge = await createActiveChallenge(trainerId); // student NOT added

      const res = await app.inject({
        method: "GET",
        url: `/my/points?challengeId=${challenge.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── GET /my/points/summary ────────────────────────────────────────────────

  describe("GET /my/points/summary", () => {
    it("returns totalPoints and breakdown scoped to a challenge", async () => {
      const { trainerId } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } =
        await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const challenge = await createActiveChallenge(trainerId, [studentId]);
      await seedPointTransaction(studentId, trainerId, challenge.id, 10);

      const res = await app.inject({
        method: "GET",
        url: `/my/points/summary?challengeId=${challenge.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalPoints).toBe(10);
      expect(body.breakdown).toBeDefined();
    });

    it("returns 400 when challengeId is missing", async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: "GET",
        url: "/my/points/summary",
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── GET /trainer/students/:studentId/points ───────────────────────────────

  describe("GET /trainer/students/:studentId/points", () => {
    it("returns point history for a student scoped to a challenge", async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const challenge = await createActiveChallenge(trainerId, [studentId]);
      await seedPointTransaction(studentId, trainerId, challenge.id, 20);

      const res = await app.inject({
        method: "GET",
        url: `/trainer/students/${studentId}/points?challengeId=${challenge.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBeGreaterThanOrEqual(1);
      expect(body.data[0].points).toBe(20);
    });

    it("returns 400 when challengeId is missing", async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();

      const res = await app.inject({
        method: "GET",
        url: `/trainer/students/${studentId}/points`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  // ─── Fan-out: workout completion across multiple challenges ───────────────

  describe("fan-out: awardWorkoutCompletionPoints", () => {
    it("creates one PointTransaction per active challenge when student is in 2 active challenges", async () => {
      const { trainerId } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      // Create two active challenges with the student as participant
      const challenge1 = await createActiveChallenge(trainerId, [studentId]);
      const challenge2 = await createActiveChallenge(trainerId, [studentId]);

      // Simulate award for workout_completed action
      const { awardPoints } =
        await import("../../src/services/gamification-service.js");

      await awardPoints({
        prisma,
        studentId,
        trainerId,
        action: "workout_completed",
        referenceId: "00000000-0000-0000-0000-000000000001",
      });

      const transactions = await prisma.pointTransaction.findMany({
        where: { studentId, trainerId, action: "workout_completed" },
      });

      // Expect one transaction per active challenge
      expect(transactions).toHaveLength(2);
      const challengeIds = transactions.map((t) => t.challengeId);
      expect(challengeIds).toContain(challenge1.id);
      expect(challengeIds).toContain(challenge2.id);
    });
  });

  // ─── Daily cap enforced per-challenge ─────────────────────────────────────

  describe("per-challenge daily cap", () => {
    it("caps points per challenge independently", async () => {
      const { trainerId } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      // Challenge with a daily cap of 5 points
      const cappedChallenge = await prisma.challenge.create({
        data: {
          trainerId,
          name: "Capped Challenge",
          startDate: new Date(Date.UTC(2026, 0, 1)),
          endDate: new Date(Date.UTC(2026, 11, 31)),
          participantMode: ChallengeParticipantMode.EXPLICIT,
          ptsWorkoutCompleted: 10,
          dailyPointsCap: 5,
        },
      });
      await prisma.challengeParticipant.create({
        data: { challengeId: cappedChallenge.id, studentId },
      });

      const { awardPoints } =
        await import("../../src/services/gamification-service.js");

      // First award — cap is 5, pts=10 → trimmed to 5
      await awardPoints({
        prisma,
        studentId,
        trainerId,
        action: "workout_completed",
        referenceId: "00000000-0000-0000-0000-000000000010",
      });

      const txAfterFirst = await prisma.pointTransaction.findMany({
        where: { studentId, challengeId: cappedChallenge.id },
      });
      expect(txAfterFirst[0].points).toBe(5);

      // Second award — cap fully used → no transaction created
      await awardPoints({
        prisma,
        studentId,
        trainerId,
        action: "workout_completed",
        referenceId: "00000000-0000-0000-0000-000000000011",
      });

      const txAfterSecond = await prisma.pointTransaction.findMany({
        where: { studentId, challengeId: cappedChallenge.id },
      });
      expect(txAfterSecond).toHaveLength(1); // still only one, second was blocked
    });
  });
});
