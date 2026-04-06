import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { ChallengeParticipantMode, ChallengeStatus, ChallengeErrorCode } from '../../src/constants/challenge.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: challenges', () => {
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

  const futureDate = (daysFromNow) => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + daysFromNow);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  };

  async function createTrainerWithToken() {
    const email = `trainer+challenge+${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeRes.json();

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    return { userId, trainerId: trainerRecord.id, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    const email = `student+challenge+${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    return { userId, accessToken };
  }

  async function linkStudentToTrainer(trainerId, studentId) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId } });
  }

  async function createChallenge(accessToken, overrides = {}) {
    const res = await app.inject({
      method: 'POST',
      url: '/trainer/challenges',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: {
        name: 'Test Challenge',
        startDate: futureDate(2),
        endDate: futureDate(10),
        participantMode: ChallengeParticipantMode.EXPLICIT,
        studentIds: [],
        ...overrides,
      },
    });
    return res;
  }

  // ─── POST /trainer/challenges ──────────────────────────────────────────────

  describe('POST /trainer/challenges', () => {
    it('creates challenge with EXPLICIT mode and no students', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createChallenge(accessToken);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.id).toBeTruthy();
      expect(body.name).toBe('Test Challenge');
      expect(body.status).toBe(ChallengeStatus.SCHEDULED);
      expect(body.participantMode).toBe(ChallengeParticipantMode.EXPLICIT);
      expect(body.participantCount).toBe(0);
    });

    it('creates challenge with EXPLICIT mode and valid student IDs', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      const res = await createChallenge(accessToken, { studentIds: [studentId] });

      expect(res.statusCode).toBe(201);
      expect(res.json().participantCount).toBe(1);
    });

    it('snapshots pts override fields when provided', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createChallenge(accessToken, {
        ptsWorkoutCompleted: 25,
        ptsDailyCheckin: 5,
        dailyPointsCap: 100,
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.ptsWorkoutCompleted).toBe(25);
      expect(body.ptsDailyCheckin).toBe(5);
      expect(body.dailyPointsCap).toBe(100);
    });

    it('returns null pts fields when no override and no trainer config', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createChallenge(accessToken);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      // No trainer config set, no override → null (system defaults applied at award time)
      expect(body.ptsWorkoutCompleted).toBeNull();
    });

    it('returns 400 when endDate is before startDate', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createChallenge(accessToken, {
        startDate: futureDate(10),
        endDate: futureDate(5),
      });

      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe(ChallengeErrorCode.CHALLENGE_INVALID_DATES);
    });

    it('returns 400 when startDate is in the past', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await createChallenge(accessToken, {
        startDate: '2020-01-01',
        endDate: '2020-01-10',
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when EXPLICIT mode includes non-trainee student', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: outsiderStudentId } = await createStudentWithToken();

      const res = await createChallenge(accessToken, {
        studentIds: [outsiderStudentId],
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(ChallengeErrorCode.CHALLENGE_PARTICIPANT_NOT_TRAINEE);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/challenges',
        payload: {},
      });
      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when called by a student', async () => {
      const { accessToken } = await createStudentWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/challenges',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          name: 'Challenge',
          startDate: futureDate(2),
          endDate: futureDate(10),
          participantMode: ChallengeParticipantMode.EXPLICIT,
        },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── GET /trainer/challenges ───────────────────────────────────────────────

  describe('GET /trainer/challenges', () => {
    it('returns list of trainer challenges', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createChallenge(accessToken, { name: 'Challenge 1' });
      await createChallenge(accessToken, { name: 'Challenge 2' });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/challenges',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });

    it('filters challenges by status=scheduled', async () => {
      const { accessToken } = await createTrainerWithToken();
      await createChallenge(accessToken, { name: 'Scheduled One' });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/challenges?status=scheduled',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list.length).toBeGreaterThan(0);
      list.forEach((c) => expect(c.status).toBe(ChallengeStatus.SCHEDULED));
    });
  });

  // ─── GET /trainer/challenges/:id ──────────────────────────────────────────

  describe('GET /trainer/challenges/:id', () => {
    it('returns challenge detail', async () => {
      const { accessToken } = await createTrainerWithToken();
      const created = await createChallenge(accessToken);
      const { id } = created.json();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/challenges/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(id);
    });

    it('returns 403 when another trainer tries to access', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      const { accessToken: trainerToken2 } = await createTrainerWithToken();
      const created = await createChallenge(trainerToken1);
      const { id } = created.json();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/challenges/${id}`,
        headers: { authorization: `Bearer ${trainerToken2}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 404 for unknown challenge ID', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/challenges/00000000-0000-0000-0000-000000000000',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── PATCH /trainer/challenges/:id ───────────────────────────────────────

  describe('PATCH /trainer/challenges/:id', () => {
    it('updates pts fields on a scheduled challenge', async () => {
      const { accessToken } = await createTrainerWithToken();
      const created = await createChallenge(accessToken);
      const { id } = created.json();

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/challenges/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          ptsWorkoutCompleted: 20,
          ptsStreak7Days: 50,
          dailyPointsCap: 100,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.ptsWorkoutCompleted).toBe(20);
      expect(body.ptsStreak7Days).toBe(50);
      expect(body.dailyPointsCap).toBe(100);
    });

    it('allows setting pts fields to null on a scheduled challenge', async () => {
      const { accessToken } = await createTrainerWithToken();
      const created = await createChallenge(accessToken, { ptsWorkoutCompleted: 10 });
      const { id } = created.json();

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/challenges/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ptsWorkoutCompleted: null },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().ptsWorkoutCompleted).toBeNull();
    });

    it('returns 400 when updating pts fields on an active challenge', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();

      // Insert an active challenge directly (startDate in the past — API forbids it)
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 5);

      const activeChallenge = await prisma.challenge.create({
        data: {
          trainerId,
          name: 'Active Challenge',
          startDate: yesterday,
          endDate: tomorrow,
          participantMode: ChallengeParticipantMode.EXPLICIT,
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/challenges/${activeChallenge.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { ptsWorkoutCompleted: 99 },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(ChallengeErrorCode.CHALLENGE_NOT_SCHEDULABLE);
      expect(res.json().messageCode).toBe('challenge.notActive');
    });

    it('allows updating name on an active challenge (pts fields not provided)', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();

      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const tomorrow = new Date();
      tomorrow.setUTCDate(tomorrow.getUTCDate() + 5);

      const activeChallenge = await prisma.challenge.create({
        data: {
          trainerId,
          name: 'Active Challenge',
          startDate: yesterday,
          endDate: tomorrow,
          participantMode: ChallengeParticipantMode.EXPLICIT,
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/trainer/challenges/${activeChallenge.id}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Renamed Active Challenge' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Renamed Active Challenge');
    });
  });

  // ─── DELETE /trainer/challenges/:id ───────────────────────────────────────

  describe('DELETE /trainer/challenges/:id', () => {
    it('deletes a scheduled challenge', async () => {
      const { accessToken } = await createTrainerWithToken();
      const created = await createChallenge(accessToken);
      const { id } = created.json();

      const deleteRes = await app.inject({
        method: 'DELETE',
        url: `/trainer/challenges/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(deleteRes.statusCode).toBe(204);

      // Verify it's gone
      const getRes = await app.inject({
        method: 'GET',
        url: `/trainer/challenges/${id}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(getRes.statusCode).toBe(404);
    });
  });

  // ─── POST /trainer/challenges/:id/cancel ──────────────────────────────────

  describe('POST /trainer/challenges/:id/cancel', () => {
    it('cancels a scheduled challenge', async () => {
      const { accessToken } = await createTrainerWithToken();
      const created = await createChallenge(accessToken);
      const { id } = created.json();

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/challenges/${id}/cancel`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe(ChallengeStatus.CANCELLED);
    });

    it('returns 409 when cancelling an already-cancelled challenge', async () => {
      const { accessToken } = await createTrainerWithToken();
      const created = await createChallenge(accessToken);
      const { id } = created.json();

      await app.inject({
        method: 'POST',
        url: `/trainer/challenges/${id}/cancel`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/challenges/${id}/cancel`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(ChallengeErrorCode.CHALLENGE_ALREADY_CANCELLED);
    });
  });

  // ─── POST /trainer/challenges/:id/participants ────────────────────────────

  describe('POST /trainer/challenges/:id/participants', () => {
    it('adds participants to a challenge', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const created = await createChallenge(accessToken);
      const { id: challengeId } = created.json();

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/challenges/${challengeId}/participants`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { studentIds: [studentId] },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.added).toBe(1);
      expect(body.participantCount).toBe(1);
    });

    it('returns 409 when adding a duplicate participant', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const created = await createChallenge(accessToken);
      const { id: challengeId } = created.json();

      await app.inject({
        method: 'POST',
        url: `/trainer/challenges/${challengeId}/participants`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { studentIds: [studentId] },
      });

      const res = await app.inject({
        method: 'POST',
        url: `/trainer/challenges/${challengeId}/participants`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { studentIds: [studentId] },
      });

      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe(ChallengeErrorCode.CHALLENGE_PARTICIPANT_DUPLICATE);
    });
  });

  // ─── DELETE /trainer/challenges/:id/participants/:studentId ───────────────

  describe('DELETE /trainer/challenges/:id/participants/:studentId', () => {
    it('removes a participant from a challenge', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const created = await createChallenge(accessToken, { studentIds: [studentId] });
      const { id: challengeId } = created.json();

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/challenges/${challengeId}/participants/${studentId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when participant not in challenge', async () => {
      const { accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const created = await createChallenge(accessToken);
      const { id: challengeId } = created.json();

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/challenges/${challengeId}/participants/${studentId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(404);
    });
  });

  // ─── GET /trainer/challenges/:id/ranking ──────────────────────────────────

  describe('GET /trainer/challenges/:id/ranking', () => {
    it('returns empty ranking when no participants have points', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const created = await createChallenge(accessToken, { studentIds: [studentId] });
      const { id: challengeId } = created.json();

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/challenges/${challengeId}/ranking`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      // Student appears with 0 points
      const ranking = res.json();
      expect(Array.isArray(ranking)).toBe(true);
    });
  });

  // ─── GET /my/challenges ───────────────────────────────────────────────────

  describe('GET /my/challenges', () => {
    it('returns challenges the student participates in', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      await createChallenge(trainerToken, {
        name: 'My Challenge',
        studentIds: [studentId],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/my/challenges',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list.some((c) => c.name === 'My Challenge')).toBe(true);
    });

    it('does not return challenges from which the student is not a participant', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { accessToken: studentToken } = await createStudentWithToken();

      await createChallenge(trainerToken, { name: 'Not My Challenge' });

      const res = await app.inject({
        method: 'GET',
        url: '/my/challenges',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      const list = res.json();
      expect(list.some((c) => c.name === 'Not My Challenge')).toBe(false);
    });
  });

  // ─── GET /my/challenges/:id ────────────────────────────────────────────────

  describe('GET /my/challenges/:id', () => {
    it('returns challenge detail for participant', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);
      const created = await createChallenge(trainerToken, { studentIds: [studentId] });
      const { id: challengeId } = created.json();

      const res = await app.inject({
        method: 'GET',
        url: `/my/challenges/${challengeId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe(challengeId);
    });

    it('returns 403 for non-participant student', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { accessToken: studentToken } = await createStudentWithToken();
      const created = await createChallenge(trainerToken);
      const { id: challengeId } = created.json();

      const res = await app.inject({
        method: 'GET',
        url: `/my/challenges/${challengeId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(res.statusCode).toBe(403);
    });
  });

  // ─── POST /trainer/challenges/preview-participants ────────────────────────

  describe('POST /trainer/challenges/preview-participants', () => {
    it('returns student IDs matching ALL mode', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();
      await linkStudentToTrainer(trainerId, studentId);

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/challenges/preview-participants',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { mode: ChallengeParticipantMode.ALL },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.studentIds).toContain(studentId);
      expect(body.count).toBeGreaterThan(0);
    });

    it('returns empty list for FILTER mode matching no students', async () => {
      const { accessToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/challenges/preview-participants',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          mode: ChallengeParticipantMode.FILTER,
          filter: { gender: 'X_NONEXISTENT_GENDER' },
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(0);
    });
  });
});
