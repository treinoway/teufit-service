import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { WorkoutSessionStatus, ExerciseLogStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: workout-sessions', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Auth helpers ──────────────────────────────────────────────────────────

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    const becomeTrainerResponse = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeTrainerResponse.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeTrainerResponse.json();

    return { userId, accessToken: trainerToken };
  }

  async function createStudentWithToken() {
    const email = `e2e+student-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    return { userId, accessToken, email };
  }

  async function createProtocolAndTraining(trainerToken, studentId) {
    const protocolResponse = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: {
        assigneeId: studentId,
        name: 'Test Protocol',
        startDate: '2026-01-01',
      },
    });
    expect(protocolResponse.statusCode).toBe(201);
    const { id: protocolId } = protocolResponse.json();

    const trainingResponse = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocolId}/trainings`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: {
        name: 'Chest Day',
        category: 'strength',
      },
    });
    expect(trainingResponse.statusCode).toBe(201);
    const { id: trainingId } = trainingResponse.json();

    return { protocolId, trainingId };
  }

  async function createExercise(trainerToken, trainingId) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/exercises`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'Bench Press', type: 'strength', sets: 4, hasLoad: true },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  }

  async function createExerciseWithRestInterval(trainerToken, trainingId, restInterval) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/exercises`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'Squat', type: 'strength', sets: 3, hasLoad: true, restInterval },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  }

  async function startSession(studentToken, trainingId, payload = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/my/trainings/${trainingId}/workout-sessions`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload,
    });
    return response;
  }

  async function linkTrainerStudent(trainerToken, studentEmail) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { email: studentEmail },
    });
    // Accept 201 (created) or 409 (already linked)
    expect([201, 409]).toContain(response.statusCode);
  }

  // ─── POST /my/trainings/:trainingId/workout-sessions ──────────────────────

  describe('POST /my/trainings/:trainingId/workout-sessions', () => {
    it('creates a session with exercise logs for all exercises', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const response = await startSession(studentToken, trainingId);

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        trainingId,
        userId: studentId,
        status: WorkoutSessionStatus.IN_PROGRESS,
        finishedAt: null,
        durationSeconds: null,
      });
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0]).toMatchObject({
        status: ExerciseLogStatus.PENDING,
        setLogs: [],
      });
    });

    it('creates a session with notes', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const response = await startSession(studentToken, trainingId, { notes: 'Feeling good today' });

      expect(response.statusCode).toBe(201);
      expect(response.json().notes).toBe('Feeling good today');
    });

    it('returns 409 with activeSessionId when student already has an in_progress session', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const first = await startSession(studentToken, trainingId);
      expect(first.statusCode).toBe(201);
      const firstSessionId = first.json().id;

      const second = await startSession(studentToken, trainingId);

      expect(second.statusCode).toBe(409);
      const body = second.json();
      expect(body).toMatchObject({
        error: 'SESSION_ALREADY_IN_PROGRESS',
        messageCode: 'workoutSession.alreadyInProgress',
        message: expect.any(String),
        details: { activeSessionId: firstSessionId },
      });
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/my/trainings/00000000-0000-0000-0000-000000000001/workout-sessions',
        payload: {},
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when trainingId does not exist', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await startSession(
        studentToken,
        '00000000-0000-0000-0000-000000000099',
      );

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 when training is not assigned to user', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { accessToken: otherStudentToken } = await createStudentWithToken();
      const { userId: studentId } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const response = await startSession(otherStudentToken, trainingId);

      expect(response.statusCode).toBe(403);
    });

    it('includes restInterval in exercise data in the created session response', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExerciseWithRestInterval(trainerToken, trainingId, 120);

      const response = await startSession(studentToken, trainingId);

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0].exercise.restInterval).toBe(120);
    });
  });

  // ─── GET /my/workout-sessions ─────────────────────────────────────────────

  describe('GET /my/workout-sessions', () => {
    it('returns paginated list of sessions', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      await startSession(studentToken, trainingId);

      const response = await app.inject({
        method: 'GET',
        url: '/my/workout-sessions',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toMatchObject({ total: 1, page: 1, limit: 20 });
      expect(body.data).toHaveLength(1);
      expect(body.data[0]).toMatchObject({ trainingId, status: WorkoutSessionStatus.IN_PROGRESS });
    });

    it('filters by status', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const sessionResponse = await startSession(studentToken, trainingId);
      const sessionId = sessionResponse.json().id;

      // Finish the session
      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      const completedResponse = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions?status=${WorkoutSessionStatus.COMPLETED}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      expect(completedResponse.json().total).toBe(1);

      const inProgressResponse = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions?status=${WorkoutSessionStatus.IN_PROGRESS}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      expect(inProgressResponse.json().total).toBe(0);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({ method: 'GET', url: '/my/workout-sessions' });
      expect(response.statusCode).toBe(401);
    });
  });

  // ─── GET /my/workout-sessions/:sessionId ──────────────────────────────────

  describe('GET /my/workout-sessions/:sessionId', () => {
    it('returns full session detail with exercise and set logs', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(sessionId);
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0].exercise).toMatchObject({ name: 'Bench Press' });
    });

    it('returns 404 for unknown sessionId', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/my/workout-sessions/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 403 for another user\'s session', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { accessToken: otherStudentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${otherStudentToken}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it('includes restInterval in exercise data when set on the exercise', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExerciseWithRestInterval(trainerToken, trainingId, 90);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0].exercise.restInterval).toBe(90);
    });

    it('includes restInterval as null when not set on the exercise', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.exerciseLogs[0].exercise.restInterval).toBeNull();
    });
  });

  // ─── PATCH /my/workout-sessions/:sessionId ────────────────────────────────

  describe('PATCH /my/workout-sessions/:sessionId', () => {
    it('finishes session: status=completed, populates finishedAt and durationSeconds', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe(WorkoutSessionStatus.COMPLETED);
      expect(body.finishedAt).not.toBeNull();
      expect(body.durationSeconds).toBeGreaterThanOrEqual(0);
    });

    it('updates notes without changing status', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { notes: 'Great session' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.notes).toBe('Great session');
      expect(body.status).toBe(WorkoutSessionStatus.IN_PROGRESS);
      expect(body.finishedAt).toBeNull();
    });

    it('returns 404 for unknown session', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'PATCH',
        url: '/my/workout-sessions/00000000-0000-0000-0000-000000000099',
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      expect(response.statusCode).toBe(404);
    });

    it('includes exercise relation inside exerciseLogs when updating notes', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { notes: 'Updated notes' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0].exercise).toMatchObject({ name: 'Bench Press' });
    });

    it('includes training and exercise relations when completing a session', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExerciseWithRestInterval(trainerToken, trainingId, 60);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.training).toMatchObject({ id: trainingId, name: 'Chest Day' });
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0].exercise).toMatchObject({ name: 'Squat', restInterval: 60 });
    });
  });

  // ─── DELETE /my/workout-sessions/:sessionId ───────────────────────────────

  describe('DELETE /my/workout-sessions/:sessionId', () => {
    it('soft-deletes session so it no longer appears in list', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      expect(deleteResponse.statusCode).toBe(200);

      const listResponse = await app.inject({
        method: 'GET',
        url: '/my/workout-sessions',
        headers: { authorization: `Bearer ${studentToken}` },
      });
      expect(listResponse.json().total).toBe(0);
    });
  });

  // ─── PATCH /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId ───

  describe('PATCH /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId', () => {
    it('updates exercise log status to completed', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionResponse = (await startSession(studentToken, trainingId)).json();
      const sessionId = sessionResponse.id;
      const exerciseLogId = sessionResponse.exerciseLogs[0].id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: ExerciseLogStatus.COMPLETED },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(ExerciseLogStatus.COMPLETED);
    });

    it('updates exercise log notes', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionResponse = (await startSession(studentToken, trainingId)).json();
      const sessionId = sessionResponse.id;
      const exerciseLogId = sessionResponse.exerciseLogs[0].id;

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { notes: 'Felt heavy today' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().notes).toBe('Felt heavy today');
    });
  });

  // ─── POST .../sets ────────────────────────────────────────────────────────

  describe('POST /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets', () => {
    async function setupSessionWithExerciseLog() {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionResponse = (await startSession(studentToken, trainingId)).json();
      return {
        studentToken,
        sessionId: sessionResponse.id,
        exerciseLogId: sessionResponse.exerciseLogs[0].id,
      };
    }

    it('creates a set log with all fields', async () => {
      const { studentToken, sessionId, exerciseLogId } = await setupSessionWithExerciseLog();

      const response = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: {
          setNumber: 1,
          repetitions: 10,
          load: 60.0,
          rpe: 7,
          restSeconds: 90,
        },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body).toMatchObject({
        id: expect.any(String),
        exerciseLogId,
        setNumber: 1,
        repetitions: 10,
        load: 60.0,
        rpe: 7,
        restSeconds: 90,
        completed: true,
      });
    });

    it('returns 400 when setNumber is missing', async () => {
      const { studentToken, sessionId, exerciseLogId } = await setupSessionWithExerciseLog();

      const response = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { repetitions: 10 },
      });

      expect(response.statusCode).toBe(400);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/my/workout-sessions/00000000-0000-0000-0000-000000000001/exercise-logs/00000000-0000-0000-0000-000000000002/sets',
        payload: { setNumber: 1 },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ─── PATCH .../sets/:setLogId ─────────────────────────────────────────────

  describe('PATCH /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets/:setLogId', () => {
    it('updates set log fields', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionResponse = (await startSession(studentToken, trainingId)).json();
      const sessionId = sessionResponse.id;
      const exerciseLogId = sessionResponse.exerciseLogs[0].id;

      const setLogResponse = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, load: 60.0 },
      });
      const setLogId = setLogResponse.json().id;

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets/${setLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { load: 70.0, rpe: 8 },
      });

      expect(updateResponse.statusCode).toBe(200);
      expect(updateResponse.json()).toMatchObject({ load: 70.0, rpe: 8 });
    });
  });

  // ─── DELETE .../sets/:setLogId ────────────────────────────────────────────

  describe('DELETE /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId/sets/:setLogId', () => {
    it('deletes a set log', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionResponse = (await startSession(studentToken, trainingId)).json();
      const sessionId = sessionResponse.id;
      const exerciseLogId = sessionResponse.exerciseLogs[0].id;

      const setLogId = (
        await app.inject({
          method: 'POST',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { setNumber: 1, repetitions: 10 },
        })
      ).json().id;

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets/${setLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(deleteResponse.statusCode).toBe(200);
    });
  });

  // ─── Trainer: GET /trainer/students/:studentId/workout-sessions ───────────

  describe('GET /trainer/students/:studentId/workout-sessions', () => {
    it('lists student sessions for trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      await startSession(studentToken, trainingId);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/workout-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.total).toBe(1);
      expect(body.data[0]).toMatchObject({ userId: studentId });
    });

    it('returns 403 when requester is not a trainer', async () => {
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/workout-sessions`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(403);
    });

    it('returns 404 when student is not linked to trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/workout-sessions`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/trainer/students/00000000-0000-0000-0000-000000000001/workout-sessions',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ─── Trainer: GET /trainer/students/:studentId/workout-sessions/:sessionId ─

  describe('GET /trainer/students/:studentId/workout-sessions/:sessionId', () => {
    it('returns full session detail for trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.id).toBe(sessionId);
      expect(body.exerciseLogs).toHaveLength(1);
    });

    it('returns 404 when session does not exist', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/workout-sessions/00000000-0000-0000-0000-000000000099`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('includes restInterval in exercise data for trainer view', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } = await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExerciseWithRestInterval(trainerToken, trainingId, 60);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.exerciseLogs[0].exercise.restInterval).toBe(60);
    });
  });

  // ─── i18n labels ──────────────────────────────────────────────────────────

  describe('i18n labels — workout sessions', () => {
    it('GET /my/workout-sessions/:sessionId returns statusLabel and training.categoryLabel in pt-BR', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('in_progress');
      expect(body.statusLabel).toBe('Em andamento');
      expect(body.training.category).toBe('strength');
      expect(body.training.categoryLabel).toBe('Força');
      expect(body.exerciseLogs[0].status).toBe('pending');
      expect(body.exerciseLogs[0].statusLabel).toBe('Pendente');
    });

    it('GET /my/workout-sessions/:sessionId returns statusLabel in en-US', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}`, 'app-language': 'en-US' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.status).toBe('in_progress');
      expect(body.statusLabel).toBe('In Progress');
      expect(body.exerciseLogs[0].status).toBe('pending');
      expect(body.exerciseLogs[0].statusLabel).toBe('Pending');
    });

    it('GET /my/workout-sessions/:sessionId returns typeLabel for exercise in pt-BR', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const { exerciseLogs } = response.json();
      expect(exerciseLogs[0].exercise.type).toBe('strength');
      expect(exerciseLogs[0].exercise.typeLabel).toBe('Força');
    });
  });
});
