import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import {
  WorkoutSessionStatus,
  ExerciseLogStatus,
  WorkoutSessionFinalizedErrorCode,
  WorkoutSessionFinalizedMessageCode,
} from '../../src/constants/training.js';

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
    // Platform plan guard (assertStudentActiveOnPlan) requires a TrainerStudent
    // link before protocol creation. Resolve trainer.id via /me and upsert link.
    const meRes = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const trainerUserId = meRes.json().id;
    const trainer = await prisma.trainer.findUnique({
      where: { userId: trainerUserId },
      select: { id: true },
    });
    await prisma.trainerStudent.upsert({
      where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
      create: { trainerId: trainer.id, studentId, activeOnPlan: true },
      update: { activeOnPlan: true },
    });

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

    it('exposes estimatedDurationSeconds on the nested training object', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      // Creating the exercise triggers recomputeTrainingDuration, making estimatedDurationSeconds non-zero
      await createExercise(trainerToken, trainingId);

      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.training).toHaveProperty('estimatedDurationSeconds');
      expect(typeof body.training.estimatedDurationSeconds).toBe('number');
      expect(body.training.estimatedDurationSeconds).toBeGreaterThan(0);
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

  // ─── POST /my/workout-sessions/:sessionId/exercise-logs/:logId/substitute ──

  describe('POST /my/workout-sessions/:sessionId/exercise-logs/:logId/substitute', () => {
    async function setupSessionWithSubstitute() {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      // Create principal exercise
      const exResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength', sets: 4 },
      });
      expect(exResponse.statusCode).toBe(201);
      const principalExerciseId = exResponse.json().id;

      // Create substitute exercise
      const subResponse = await app.inject({
        method: 'POST',
        url: `/trainer/exercises/${principalExerciseId}/substitutes`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Dumbbell Press', type: 'strength', sets: 4 },
      });
      expect(subResponse.statusCode).toBe(201);
      const substituteExerciseId = subResponse.json().id;

      // Start session
      const sessionResponse = await startSession(studentToken, trainingId);
      expect(sessionResponse.statusCode).toBe(201);
      const sessionBody = sessionResponse.json();
      const sessionId = sessionBody.id;
      const exerciseLogId = sessionBody.exerciseLogs[0].id;

      return { studentToken, sessionId, exerciseLogId, principalExerciseId, substituteExerciseId };
    }

    it('creates new exercise log for substitute and marks principal as substituted', async () => {
      const { studentToken, sessionId, exerciseLogId, substituteExerciseId } =
        await setupSessionWithSubstitute();

      const response = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId },
      });

      expect(response.statusCode).toBe(201);
      const newLog = response.json();
      expect(newLog).toHaveProperty('id');
      expect(newLog).toHaveProperty('exerciseId', substituteExerciseId);
      expect(newLog).toHaveProperty('workoutSessionId', sessionId);
      expect(newLog).toHaveProperty('status', ExerciseLogStatus.PENDING);
      expect(newLog).toHaveProperty('setLogs');

      // Verify principal log is now substituted
      const sessionResponse = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      const body = sessionResponse.json();
      const principalLog = body.exerciseLogs.find((l) => l.id === exerciseLogId);
      expect(principalLog.status).toBe(ExerciseLogStatus.SUBSTITUTED);
    });

    it('is idempotent — re-calling with same substituteExerciseId returns existing log', async () => {
      const { studentToken, sessionId, exerciseLogId, substituteExerciseId } =
        await setupSessionWithSubstitute();

      const r1 = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId },
      });
      const r2 = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId },
      });

      expect(r1.statusCode).toBe(201);
      expect(r2.statusCode).toBe(201);
      expect(r1.json().id).toBe(r2.json().id);
    });

    it('returns 409 when log is already substituted with a different exercise', async () => {
      const { trainerToken, studentToken, sessionId, exerciseLogId, principalExerciseId } =
        await (async () => {
          const { accessToken: trainerToken } = await createTrainerWithToken();
          const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
          const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

          const exResponse = await app.inject({
            method: 'POST',
            url: `/trainer/trainings/${trainingId}/exercises`,
            headers: { authorization: `Bearer ${trainerToken}` },
            payload: { name: 'Bench Press', type: 'strength', sets: 4 },
          });
          const principalExerciseId = exResponse.json().id;

          const sub1Response = await app.inject({
            method: 'POST',
            url: `/trainer/exercises/${principalExerciseId}/substitutes`,
            headers: { authorization: `Bearer ${trainerToken}` },
            payload: { name: 'Sub A', type: 'strength' },
          });
          const sub2Response = await app.inject({
            method: 'POST',
            url: `/trainer/exercises/${principalExerciseId}/substitutes`,
            headers: { authorization: `Bearer ${trainerToken}` },
            payload: { name: 'Sub B', type: 'strength' },
          });

          const sessionBody = (await startSession(studentToken, trainingId)).json();
          return {
            trainerToken,
            studentToken,
            sessionId: sessionBody.id,
            exerciseLogId: sessionBody.exerciseLogs[0].id,
            principalExerciseId,
            subAId: sub1Response.json().id,
            subBId: sub2Response.json().id,
          };
        })();

      const sub1Response = await app.inject({
        method: 'POST',
        url: `/trainer/exercises/${principalExerciseId}/substitutes`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Sub C', type: 'strength' },
      });
      const subCId = sub1Response.json().id;

      // First substitution succeeds
      const r1 = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId: subCId },
      });
      expect(r1.statusCode).toBe(201);

      // Attempting with a different substitute fails
      const differentSubResponse = await app.inject({
        method: 'POST',
        url: `/trainer/exercises/${principalExerciseId}/substitutes`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Sub D', type: 'strength' },
      });
      const subDId = differentSubResponse.json().id;

      const r2 = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId: subDId },
      });
      expect(r2.statusCode).toBe(409);
      expect(r2.json().messageCode).toBe('exercise.logAlreadySubstituted');
    });

    it('returns 400 when exercise is not a valid substitute for the log', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const exResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength', sets: 4 },
      });
      const principalExerciseId = exResponse.json().id;

      // Create a second unrelated exercise (not a substitute)
      const otherExResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Squat', type: 'strength', sets: 4 },
      });
      const unrelatedExerciseId = otherExResponse.json().id;

      const sessionBody = (await startSession(studentToken, trainingId)).json();
      const sessionId = sessionBody.id;
      const exerciseLogId = sessionBody.exerciseLogs.find(
        (l) => l.exerciseId === principalExerciseId,
      ).id;

      const response = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId: unrelatedExerciseId },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json().messageCode).toBe('exercise.substituteNotFound');
    });

    it('returns 404 for non-existent exercise log', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      const sessionBody = (await startSession(studentToken, trainingId)).json();
      const sessionId = sessionBody.id;

      const response = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/00000000-0000-0000-0000-000000000000/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId: '00000000-0000-0000-0000-000000000001' },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/my/workout-sessions/session-id/exercise-logs/log-id/substitute',
        payload: { substituteExerciseId: '00000000-0000-0000-0000-000000000000' },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ─── DELETE /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId ─────

  describe('DELETE /my/workout-sessions/:sessionId/exercise-logs/:exerciseLogId', () => {
    async function setupSwappedSession() {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      // Principal exercise
      const exResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength', sets: 4 },
      });
      expect(exResponse.statusCode).toBe(201);
      const principalExerciseId = exResponse.json().id;

      // Substitute exercise
      const subResponse = await app.inject({
        method: 'POST',
        url: `/trainer/exercises/${principalExerciseId}/substitutes`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Dumbbell Press', type: 'strength', sets: 4 },
      });
      expect(subResponse.statusCode).toBe(201);
      const substituteExerciseId = subResponse.json().id;

      // Start session
      const sessionResponse = await startSession(studentToken, trainingId);
      expect(sessionResponse.statusCode).toBe(201);
      const sessionBody = sessionResponse.json();
      const sessionId = sessionBody.id;
      const principalLogId = sessionBody.exerciseLogs[0].id;

      // Perform the swap
      const swapResponse = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${principalLogId}/substitute`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { substituteExerciseId },
      });
      expect(swapResponse.statusCode).toBe(201);
      const substituteLogId = swapResponse.json().id;

      return { studentToken, sessionId, principalLogId, substituteLogId, substituteExerciseId };
    }

    it('returns 204 and fully undoes the swap', async () => {
      const { studentToken, sessionId, principalLogId, substituteLogId, substituteExerciseId } =
        await setupSwappedSession();

      const undoResponse = await app.inject({
        method: 'DELETE',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${substituteLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(undoResponse.statusCode).toBe(204);

      // Re-fetch session and verify state
      const sessionResponse = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });
      expect(sessionResponse.statusCode).toBe(200);
      const { exerciseLogs } = sessionResponse.json();

      const principalLog = exerciseLogs.find((l) => l.id === principalLogId);
      expect(principalLog).toBeDefined();
      expect(principalLog.status).toBe(ExerciseLogStatus.PENDING);
      expect(principalLog.substitutedByExerciseId).toBeNull();

      const substituteLog = exerciseLogs.find((l) => l.exerciseId === substituteExerciseId);
      expect(substituteLog).toBeUndefined();

      // Verify no order gap — orders should be contiguous starting from 0
      const orders = exerciseLogs.map((l) => l.order).sort((a, b) => a - b);
      orders.forEach((order, index) => expect(order).toBe(index));
    });

    it('returns 400 with exercise.undoHasSets when the substitute log already has set logs', async () => {
      const { studentToken, sessionId, substituteLogId } = await setupSwappedSession();

      // Log a set on the substitute
      const setResponse = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${substituteLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, completed: true },
      });
      expect(setResponse.statusCode).toBe(201);

      const undoResponse = await app.inject({
        method: 'DELETE',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${substituteLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(undoResponse.statusCode).toBe(400);
      expect(undoResponse.json().messageCode).toBe('exercise.undoHasSets');
    });

    it('returns 400 with exercise.undoNotSubstitute when attempting to delete a plain principal log', async () => {
      const { studentToken, sessionId, principalLogId } = await setupSwappedSession();

      // Attempt to DELETE the principal log (not the substitute)
      const undoResponse = await app.inject({
        method: 'DELETE',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${principalLogId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(undoResponse.statusCode).toBe(400);
      expect(undoResponse.json().messageCode).toBe('exercise.undoNotSubstitute');
    });

    it('returns 404 when the exercise log does not exist', async () => {
      const { studentToken, sessionId } = await setupSwappedSession();

      const response = await app.inject({
        method: 'DELETE',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/00000000-0000-0000-0000-000000000000`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: '/my/workout-sessions/00000000-0000-0000-0000-000000000001/exercise-logs/00000000-0000-0000-0000-000000000002',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  // ─── GET /my/exercises/:exerciseId/last-performance ───────────────────────

  describe('GET /my/exercises/:exerciseId/last-performance', () => {
    async function setupExerciseWithCompletedSession() {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      const exerciseId = await createExercise(trainerToken, trainingId);

      // Start and complete a session so there is a prior performance record
      const sessionResponse = await startSession(studentToken, trainingId);
      const sessionId = sessionResponse.json().id;
      const exerciseLogId = sessionResponse.json().exerciseLogs[0].id;

      // Log one set
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, load: 80.0, rpe: 7, restSeconds: 90, completed: true },
      });

      // Complete the session so it appears in last-performance queries
      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      return { studentToken, exerciseId, trainerToken, studentId, studentEmail, trainingId };
    }

    it('returns 401 when no auth token is provided', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/my/exercises/00000000-0000-0000-0000-000000000001/last-performance',
      });

      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when exerciseId does not exist', async () => {
      const { accessToken: studentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: '/my/exercises/00000000-0000-0000-0000-000000000000/last-performance',
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error).toBe('EXERCISE_NOT_FOUND');
      expect(body.messageCode).toBe('exercise.notFound');
    });

    it('returns 403 when the exercise belongs to a different student', async () => {
      const { exerciseId } = await setupExerciseWithCompletedSession();

      // A second unrelated student tries to access the first student's exercise
      const { accessToken: otherStudentToken } = await createStudentWithToken();

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${otherStudentToken}` },
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error).toBe('EXERCISE_NOT_YOURS');
      expect(body.messageCode).toBe('exercise.notYours');
    });

    it('returns 200 with performedAt=null and sets=[] when exercise has never been logged', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      const exerciseId = await createExercise(trainerToken, trainingId);

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.performedAt).toBeNull();
      expect(body.sets).toEqual([]);
    });

    it('returns 200 with performedAt and set logs after a completed session', async () => {
      const { studentToken, exerciseId } = await setupExerciseWithCompletedSession();

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.performedAt).not.toBeNull();
      expect(body.sets).toHaveLength(1);
      expect(body.sets[0]).toMatchObject({
        setNumber: 1,
        repetitions: 10,
        load: 80.0,
        rpe: 7,
        restSeconds: 90,
        completed: true,
      });
    });

    it('does not return sets from an in-progress session', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      const exerciseId = await createExercise(trainerToken, trainingId);

      // Start a session but do NOT complete it
      const sessionResponse = await startSession(studentToken, trainingId);
      const sessionId = sessionResponse.json().id;
      const exerciseLogId = sessionResponse.json().exerciseLogs[0].id;

      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, load: 80.0, completed: true },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().performedAt).toBeNull();
      expect(response.json().sets).toEqual([]);
    });

    it('returns bestSet: null when exercise has never been logged', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      const exerciseId = await createExercise(trainerToken, trainingId);

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().bestSet).toBeNull();
    });

    it('returns bestSet with correct tonnage after a completed session', async () => {
      // set: 80 × 10 = 800 tonnage
      const { studentToken, exerciseId } = await setupExerciseWithCompletedSession();

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.bestSet).not.toBeNull();
      expect(body.bestSet).toMatchObject({
        setNumber: 1,
        repetitions: 10,
        load: 80.0,
        completed: true,
        tonnage: 800,
      });
    });

    it('returns bestSet as the set with highest tonnage when multiple sets were logged', async () => {
      // Two sets: set 1 = 100 × 5 = 500, set 2 = 80 × 8 = 640 → set 2 is bestSet
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken, email: studentEmail } =
        await createStudentWithToken();
      await linkTrainerStudent(trainerToken, studentEmail);
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      const exerciseId = await createExercise(trainerToken, trainingId);

      const sessionResponse = await startSession(studentToken, trainingId);
      const sessionId = sessionResponse.json().id;
      const exerciseLogId = sessionResponse.json().exerciseLogs[0].id;

      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 5, load: 100.0, completed: true },
      });
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 2, repetitions: 8, load: 80.0, completed: true },
      });

      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/my/exercises/${exerciseId}/last-performance`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.bestSet).toMatchObject({
        setNumber: 2,
        load: 80.0,
        repetitions: 8,
        tonnage: 640,
      });
    });
  });

  // ─── SESSION_FINALIZED guard ──────────────────────────────────────────────

  describe('SESSION_FINALIZED guard — terminal sessions block mutations', () => {
    /**
     * Sets up a full environment and returns a session in the given terminal status.
     * The session has one exercise log (with a set log pre-created) and one
     * substitute exercise to enable substitute/undo-substitute tests.
     */
    async function setupTerminalSession(terminalStatus) {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

      // Create principal exercise
      const exResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength', sets: 3, hasLoad: true },
      });
      expect(exResponse.statusCode).toBe(201);
      const principalExerciseId = exResponse.json().id;

      // Create substitute exercise (needed for substituteExerciseLog tests)
      const subResponse = await app.inject({
        method: 'POST',
        url: `/trainer/exercises/${principalExerciseId}/substitutes`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'DB Press', type: 'strength', sets: 3 },
      });
      expect(subResponse.statusCode).toBe(201);
      const substituteExerciseId = subResponse.json().id;

      // Start session
      const sessionResponse = await startSession(studentToken, trainingId);
      expect(sessionResponse.statusCode).toBe(201);
      const sessionBody = sessionResponse.json();
      const sessionId = sessionBody.id;
      const exerciseLogId = sessionBody.exerciseLogs[0].id;

      // Create a set log (needed for updateSetLog / deleteSetLog tests)
      const setLogResponse = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, load: 60.0 },
      });
      expect(setLogResponse.statusCode).toBe(201);
      const setLogId = setLogResponse.json().id;

      // Transition to terminal state
      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: terminalStatus },
      });
      expect(updateResponse.statusCode).toBe(200);

      return {
        studentToken,
        sessionId,
        exerciseLogId,
        setLogId,
        substituteExerciseId,
      };
    }

    function expectFinalizedError(body) {
      expect(body).toMatchObject({
        error: WorkoutSessionFinalizedErrorCode,
        messageCode: WorkoutSessionFinalizedMessageCode,
        message: expect.any(String),
        details: expect.objectContaining({ status: expect.any(String) }),
      });
    }

    // Run the same 409 cases for both terminal states
    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'PATCH /my/workout-sessions/:id — status change on %s session → 409',
      async (terminalStatus) => {
        const { studentToken, sessionId } = await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { status: WorkoutSessionStatus.COMPLETED },
        });

        expect(response.statusCode).toBe(409);
        expectFinalizedError(response.json());
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'PATCH /my/workout-sessions/:id — notes-only patch on %s session → 200 (allowed)',
      async (terminalStatus) => {
        const { studentToken, sessionId } = await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { notes: 'Post-workout annotation' },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json().notes).toBe('Post-workout annotation');
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'PATCH .../exercise-logs/:exerciseLogId on %s session → 409',
      async (terminalStatus) => {
        const { studentToken, sessionId, exerciseLogId } = await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { status: ExerciseLogStatus.COMPLETED },
        });

        expect(response.statusCode).toBe(409);
        expectFinalizedError(response.json());
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'POST .../sets on %s session → 409',
      async (terminalStatus) => {
        const { studentToken, sessionId, exerciseLogId } = await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'POST',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { setNumber: 2, repetitions: 8 },
        });

        expect(response.statusCode).toBe(409);
        expectFinalizedError(response.json());
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'PATCH .../sets/:setLogId on %s session → 409',
      async (terminalStatus) => {
        const { studentToken, sessionId, exerciseLogId, setLogId } =
          await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets/${setLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { load: 70.0 },
        });

        expect(response.statusCode).toBe(409);
        expectFinalizedError(response.json());
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'DELETE .../sets/:setLogId on %s session → 409',
      async (terminalStatus) => {
        const { studentToken, sessionId, exerciseLogId, setLogId } =
          await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'DELETE',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets/${setLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
        });

        expect(response.statusCode).toBe(409);
        expectFinalizedError(response.json());
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'POST .../substitute on %s session → 409',
      async (terminalStatus) => {
        const { studentToken, sessionId, exerciseLogId, substituteExerciseId } =
          await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'POST',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/substitute`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { substituteExerciseId },
        });

        expect(response.statusCode).toBe(409);
        expectFinalizedError(response.json());
      },
    );

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'DELETE (undo-substitute) .../substitute on %s session → 409',
      async (terminalStatus) => {
        // For this test we need a session that was swapped BEFORE being finalized.
        // We build it independently so the swap happens while IN_PROGRESS.
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);

        const exResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Bench Press', type: 'strength', sets: 3 },
        });
        const principalExerciseId = exResponse.json().id;

        const subResponse = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalExerciseId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'DB Press', type: 'strength', sets: 3 },
        });
        const substituteExerciseId = subResponse.json().id;

        const sessionBody = (await startSession(studentToken, trainingId)).json();
        const sessionId = sessionBody.id;
        const principalLogId = sessionBody.exerciseLogs[0].id;

        // Swap while IN_PROGRESS
        const swapResponse = await app.inject({
          method: 'POST',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${principalLogId}/substitute`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { substituteExerciseId },
        });
        expect(swapResponse.statusCode).toBe(201);
        const substituteLogId = swapResponse.json().id;

        // Finalize the session
        const finalizeResponse = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { status: terminalStatus },
        });
        expect(finalizeResponse.statusCode).toBe(200);

        // Now attempt undo on a finalized session
        const undoResponse = await app.inject({
          method: 'DELETE',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${substituteLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
        });

        expect(undoResponse.statusCode).toBe(409);
        expectFinalizedError(undoResponse.json());
      },
    );

    // ── deleteSession carve-out ──────────────────────────────────────────

    it.each([WorkoutSessionStatus.COMPLETED, WorkoutSessionStatus.ABANDONED])(
      'DELETE /my/workout-sessions/:id on %s session → 200 (soft-delete intentionally allowed)',
      async (terminalStatus) => {
        const { studentToken, sessionId } = await setupTerminalSession(terminalStatus);

        const response = await app.inject({
          method: 'DELETE',
          url: `/my/workout-sessions/${sessionId}`,
          headers: { authorization: `Bearer ${studentToken}` },
        });

        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
          id: sessionId,
          deletedAt: expect.any(String),
        });
      },
    );

    // ── IN_PROGRESS regression guards ────────────────────────────────────

    describe('IN_PROGRESS sessions — no guard triggers', () => {
      async function setupInProgressSession() {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
        await createExercise(trainerToken, trainingId);

        const sessionBody = (await startSession(studentToken, trainingId)).json();
        const sessionId = sessionBody.id;
        const exerciseLogId = sessionBody.exerciseLogs[0].id;

        const setLogResponse = await app.inject({
          method: 'POST',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { setNumber: 1, repetitions: 10, load: 60.0 },
        });
        const setLogId = setLogResponse.json().id;

        return { studentToken, sessionId, exerciseLogId, setLogId };
      }

      it('PATCH session with status change → 200', async () => {
        const { studentToken, sessionId } = await setupInProgressSession();

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { status: WorkoutSessionStatus.COMPLETED },
        });

        expect(response.statusCode).toBe(200);
      });

      it('PATCH exercise log → 200', async () => {
        const { studentToken, sessionId, exerciseLogId } = await setupInProgressSession();

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { status: ExerciseLogStatus.COMPLETED },
        });

        expect(response.statusCode).toBe(200);
      });

      it('POST set log → 201', async () => {
        const { studentToken, sessionId, exerciseLogId } = await setupInProgressSession();

        const response = await app.inject({
          method: 'POST',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { setNumber: 2, repetitions: 8 },
        });

        expect(response.statusCode).toBe(201);
      });

      it('PATCH set log → 200', async () => {
        const { studentToken, sessionId, exerciseLogId, setLogId } = await setupInProgressSession();

        const response = await app.inject({
          method: 'PATCH',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets/${setLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
          payload: { load: 70.0 },
        });

        expect(response.statusCode).toBe(200);
      });

      it('DELETE set log → 200', async () => {
        const { studentToken, sessionId, exerciseLogId, setLogId } = await setupInProgressSession();

        const response = await app.inject({
          method: 'DELETE',
          url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets/${setLogId}`,
          headers: { authorization: `Bearer ${studentToken}` },
        });

        expect(response.statusCode).toBe(200);
      });
    });
  });

  // ─── GET /my/workout-sessions/:sessionId — previousLog field ──────────────

  describe('GET /my/workout-sessions/:sessionId — previousLog field', () => {
    /**
     * Helper: log a set in a session's first exerciseLog and complete the session.
     * Returns the exerciseLogId for the completed session.
     */
    async function logSetAndCompleteSession(studentToken, sessionId, exerciseLogId, setPayload) {
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${sessionId}/exercise-logs/${exerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: setPayload,
      });

      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });
    }

    it('returns previousLog: null for each exerciseLog when no prior completed session exists', async () => {
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
      expect(body.exerciseLogs).toHaveLength(1);
      expect(body.exerciseLogs[0].previousLog).toBeNull();
    });

    it('returns previousLog with setLogs after the student has completed the exercise before', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      // First session: complete with a set
      const firstSessionResponse = (await startSession(studentToken, trainingId)).json();
      const firstSessionId = firstSessionResponse.id;
      const firstExerciseLogId = firstSessionResponse.exerciseLogs[0].id;
      await logSetAndCompleteSession(studentToken, firstSessionId, firstExerciseLogId, {
        setNumber: 1,
        repetitions: 10,
        load: 80.0,
      });

      // Second session: in_progress — previousLog should reflect the first session
      const secondSessionResponse = (await startSession(studentToken, trainingId)).json();
      const secondSessionId = secondSessionResponse.id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${secondSessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.exerciseLogs).toHaveLength(1);
      const previousLog = body.exerciseLogs[0].previousLog;
      expect(previousLog).not.toBeNull();
      expect(previousLog.workoutSessionId).toBe(firstSessionId);
      expect(previousLog.finishedAt).not.toBeNull();
      expect(previousLog.setLogs).toHaveLength(1);
      expect(previousLog.setLogs[0]).toMatchObject({
        setNumber: 1,
        repetitions: 10,
        load: 80.0,
        duration: null,
      });
    });

    it('excludes notes, rpe, restSeconds from previousLog setLogs', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      // Complete a first session with rpe and restSeconds
      const firstSession = (await startSession(studentToken, trainingId)).json();
      await logSetAndCompleteSession(studentToken, firstSession.id, firstSession.exerciseLogs[0].id, {
        setNumber: 1,
        repetitions: 8,
        load: 100.0,
        rpe: 9,
        restSeconds: 120,
        notes: 'Hard set',
      });

      const secondSession = (await startSession(studentToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${secondSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      const previousSetLog = response.json().exerciseLogs[0].previousLog.setLogs[0];
      expect(previousSetLog).toHaveProperty('setNumber');
      expect(previousSetLog).toHaveProperty('repetitions');
      expect(previousSetLog).toHaveProperty('load');
      expect(previousSetLog).toHaveProperty('duration');
      expect(previousSetLog).not.toHaveProperty('notes');
      expect(previousSetLog).not.toHaveProperty('rpe');
      expect(previousSetLog).not.toHaveProperty('restSeconds');
    });

    it('excludes ABANDONED sessions from previousLog', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      // First session: abandoned (should be excluded)
      const abandonedSession = (await startSession(studentToken, trainingId)).json();
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${abandonedSession.id}/exercise-logs/${abandonedSession.exerciseLogs[0].id}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, load: 70.0 },
      });
      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${abandonedSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.ABANDONED },
      });

      // Second session: in_progress
      const currentSession = (await startSession(studentToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${currentSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      // Abandoned session must not appear as previousLog
      expect(response.json().exerciseLogs[0].previousLog).toBeNull();
    });

    it('does not include the current session itself in previousLog even when status is completed', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      // Complete a session and then GET it — it must not reference itself as previousLog
      const session = (await startSession(studentToken, trainingId)).json();
      const exerciseLogId = session.exerciseLogs[0].id;
      await logSetAndCompleteSession(studentToken, session.id, exerciseLogId, {
        setNumber: 1,
        repetitions: 12,
        load: 90.0,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${session.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      // A completed session viewed directly must not reference its own ID as previousLog
      const previousLog = response.json().exerciseLogs[0].previousLog;
      if (previousLog !== null) {
        expect(previousLog.workoutSessionId).not.toBe(session.id);
      }
    });

    it('only includes completed setLogs in previousLog (excludes incomplete sets)', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const firstSession = (await startSession(studentToken, trainingId)).json();
      const firstExerciseLogId = firstSession.exerciseLogs[0].id;

      // Log one completed set and one incomplete set
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${firstSession.id}/exercise-logs/${firstExerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 10, load: 80.0, completed: true },
      });
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${firstSession.id}/exercise-logs/${firstExerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 2, repetitions: 6, load: 80.0, completed: false },
      });

      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${firstSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      const currentSession = (await startSession(studentToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${currentSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const setLogs = response.json().exerciseLogs[0].previousLog.setLogs;
      // Only the completed set (setNumber=1) should appear
      expect(setLogs).toHaveLength(1);
      expect(setLogs[0].setNumber).toBe(1);
    });

    it('returns previousLog: null for a session with no exerciseLogs', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      // Start a session on a training with NO exercises
      const sessionId = (await startSession(studentToken, trainingId)).json().id;

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${sessionId}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().exerciseLogs).toHaveLength(0);
    });

    it('previousLog.bestSet is null when no prior completed session exists', async () => {
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
      expect(response.json().exerciseLogs[0].previousLog).toBeNull();
    });

    it('previousLog.bestSet reflects the highest-tonnage set from the prior session', async () => {
      // First session: set 1 = 100 × 3 = 300, set 2 = 70 × 6 = 420 → bestSet is set 2
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      await createExercise(trainerToken, trainingId);

      const firstSession = (await startSession(studentToken, trainingId)).json();
      const firstExerciseLogId = firstSession.exerciseLogs[0].id;

      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${firstSession.id}/exercise-logs/${firstExerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, repetitions: 3, load: 100.0, completed: true },
      });
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${firstSession.id}/exercise-logs/${firstExerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 2, repetitions: 6, load: 70.0, completed: true },
      });

      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${firstSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      // Second session: in_progress — previousLog should show bestSet from first
      const secondSession = (await startSession(studentToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${secondSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const previousLog = response.json().exerciseLogs[0].previousLog;
      expect(previousLog).not.toBeNull();
      expect(previousLog.bestSet).toMatchObject({
        setNumber: 2,
        load: 70.0,
        repetitions: 6,
        tonnage: 420,
      });
    });

    it('previousLog.bestSet is null when prior session had no qualifying sets (cardio-only)', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId, accessToken: studentToken } = await createStudentWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, studentId);
      // Cardio exercise: load will be null
      const exerciseResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Treadmill Run', type: 'cardio', sets: 1, hasLoad: false },
      });
      expect(exerciseResponse.statusCode).toBe(201);

      const firstSession = (await startSession(studentToken, trainingId)).json();
      const firstExerciseLogId = firstSession.exerciseLogs[0].id;

      // Log a cardio set: no load, no reps — should not qualify for bestSet
      await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${firstSession.id}/exercise-logs/${firstExerciseLogId}/sets`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { setNumber: 1, duration: 1800, completed: true },
      });

      await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${firstSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
        payload: { status: WorkoutSessionStatus.COMPLETED },
      });

      const secondSession = (await startSession(studentToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${secondSession.id}`,
        headers: { authorization: `Bearer ${studentToken}` },
      });

      expect(response.statusCode).toBe(200);
      const previousLog = response.json().exerciseLogs[0].previousLog;
      expect(previousLog).not.toBeNull();
      expect(previousLog.bestSet).toBeNull();
    });
  });
});
