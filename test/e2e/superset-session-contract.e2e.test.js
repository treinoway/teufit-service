import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createBisetHarness, todayWeekday } from '../helpers/biset-e2e.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ROUND_REST = 75;
const SUBSTITUTE_SETS = 5;
const SUBSTITUTE_REPS = { min: 6, max: 8 };
const SUBSTITUTE_VIDEO = 'https://example.com/sub-video.mp4';

e2eDescribe('e2e: superset + substitute contract on session and today endpoints', () => {
  let app;
  let h;

  beforeAll(async () => {
    app = await setupApp();
    h = createBisetHarness(app);
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // why: setup shared by all cases — one bi-set (rest ROUND_REST), one loose exercise with a substitute.
  async function setupGroupedTraining(trainingOverrides = {}) {
    const ctx = await h.setupTraining(trainingOverrides);
    const token = ctx.trainer.accessToken;
    const group = await h.createGroup(token, ctx.trainingId, { restInterval: ROUND_REST });
    const loose = await h.createExercise(token, ctx.trainingId, { name: 'Loose' });
    const substitute = await h.createSubstitute(token, loose.id, {
      name: 'Loose Alt',
      sets: SUBSTITUTE_SETS,
      repetitions: SUBSTITUTE_REPS,
      videoUrl: SUBSTITUTE_VIDEO,
    });
    return { ...ctx, group, loose, substitute };
  }

  function logFor(session, exerciseId) {
    return session.exerciseLogs.find((l) => l.exerciseId === exerciseId);
  }

  function expectGroupedExercise(exercise, groupId, supersetOrder) {
    expect(exercise).toMatchObject({ supersetGroupId: groupId, supersetOrder, supersetRestInterval: ROUND_REST });
  }

  describe('workout session responses (criterion 5)', () => {
    it('POST /my/trainings/:id/workout-sessions exposes superset fields on grouped exercises', async () => {
      const { student, trainingId, group } = await setupGroupedTraining();

      const response = await h.startSession(student.accessToken, trainingId);

      expect(response.statusCode).toBe(201);
      const session = response.json();
      expectGroupedExercise(logFor(session, group.exercises[0].id).exercise, group.groupId, 0);
      expectGroupedExercise(logFor(session, group.exercises[1].id).exercise, group.groupId, 1);
    });

    it('exposes null superset group/rest for ungrouped exercises', async () => {
      const { student, trainingId, loose } = await setupGroupedTraining();

      const session = (await h.startSession(student.accessToken, trainingId)).json();

      expect(logFor(session, loose.id).exercise).toMatchObject({
        supersetGroupId: null,
        supersetOrder: 0,
        supersetRestInterval: null,
      });
    });

    it('GET /my/workout-sessions/:id exposes superset fields', async () => {
      const { student, trainingId, group } = await setupGroupedTraining();
      const started = (await h.startSession(student.accessToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${started.id}`,
        headers: { authorization: `Bearer ${student.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expectGroupedExercise(logFor(response.json(), group.exercises[0].id).exercise, group.groupId, 0);
    });

    it('PATCH /my/workout-sessions/:id exposes superset fields', async () => {
      const { student, trainingId, group } = await setupGroupedTraining();
      const started = (await h.startSession(student.accessToken, trainingId)).json();

      const response = await app.inject({
        method: 'PATCH',
        url: `/my/workout-sessions/${started.id}`,
        headers: { authorization: `Bearer ${student.accessToken}` },
        payload: { notes: 'felt strong' },
      });

      expect(response.statusCode).toBe(200);
      expectGroupedExercise(logFor(response.json(), group.exercises[1].id).exercise, group.groupId, 1);
    });

    it('GET /trainer/students/:studentId/workout-sessions/:sessionId exposes superset fields', async () => {
      const { trainer, student, trainingId, group } = await setupGroupedTraining();
      const started = (await h.startSession(student.accessToken, trainingId)).json();

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/students/${student.userId}/workout-sessions/${started.id}`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      expect(response.statusCode).toBe(200);
      expectGroupedExercise(logFor(response.json(), group.exercises[0].id).exercise, group.groupId, 0);
    });
  });

  describe('substitutes[] meta in session responses (criterion 25)', () => {
    it('includes sets, repetitions, prescriptionMode, gifUrl and videoUrl on each substitute', async () => {
      const { student, trainingId, loose, substitute } = await setupGroupedTraining();

      const session = (await h.startSession(student.accessToken, trainingId)).json();

      const [sub] = logFor(session, loose.id).exercise.substitutes;
      expect(sub).toMatchObject({
        id: substitute.id,
        name: 'Loose Alt',
        sets: SUBSTITUTE_SETS,
        repetitions: SUBSTITUTE_REPS,
        prescriptionMode: 'reps',
        videoUrl: SUBSTITUTE_VIDEO,
      });
      expect(sub).toHaveProperty('gifUrl');
    });

    it('also includes the meta on GET and on the trainer session detail', async () => {
      const { trainer, student, trainingId, loose } = await setupGroupedTraining();
      const started = (await h.startSession(student.accessToken, trainingId)).json();

      const studentView = await app.inject({
        method: 'GET',
        url: `/my/workout-sessions/${started.id}`,
        headers: { authorization: `Bearer ${student.accessToken}` },
      });
      const trainerView = await app.inject({
        method: 'GET',
        url: `/trainer/students/${student.userId}/workout-sessions/${started.id}`,
        headers: { authorization: `Bearer ${trainer.accessToken}` },
      });

      for (const view of [studentView, trainerView]) {
        const [sub] = logFor(view.json(), loose.id).exercise.substitutes;
        expect(sub).toMatchObject({ sets: SUBSTITUTE_SETS, prescriptionMode: 'reps', videoUrl: SUBSTITUTE_VIDEO });
      }
    });
  });

  describe('POST /my/workout-sessions/:sessionId/exercise-logs/:logId/substitute (criterion 9)', () => {
    it('returns the new log with the exercise in the session exercise shape', async () => {
      const { student, trainingId, loose, substitute } = await setupGroupedTraining();
      const started = (await h.startSession(student.accessToken, trainingId)).json();
      const principalLog = logFor(started, loose.id);

      const response = await app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${started.id}/exercise-logs/${principalLog.id}/substitute`,
        headers: { authorization: `Bearer ${student.accessToken}` },
        payload: { substituteExerciseId: substitute.id },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json().exercise).toMatchObject({
        id: substitute.id,
        name: 'Loose Alt',
        type: 'strength',
        sets: SUBSTITUTE_SETS,
        supersetGroupId: null,
        supersetRestInterval: null,
      });
    });

    it('includes exercise on the idempotent re-call as well', async () => {
      const { student, trainingId, loose, substitute } = await setupGroupedTraining();
      const started = (await h.startSession(student.accessToken, trainingId)).json();
      const principalLog = logFor(started, loose.id);
      const request = () => app.inject({
        method: 'POST',
        url: `/my/workout-sessions/${started.id}/exercise-logs/${principalLog.id}/substitute`,
        headers: { authorization: `Bearer ${student.accessToken}` },
        payload: { substituteExerciseId: substitute.id },
      });
      await request();

      const second = await request();

      expect(second.json().exercise).toMatchObject({ id: substitute.id });
    });
  });

  describe('GET /my/workouts/today (criterion 6)', () => {
    function getToday(studentToken) {
      return app.inject({
        method: 'GET',
        url: '/my/workouts/today',
        headers: { authorization: `Bearer ${studentToken}`, 'app-timezone': 'UTC' },
      });
    }

    it('returns superset fields on grouped exercises', async () => {
      const { student, group } = await setupGroupedTraining({ weekDay: todayWeekday() });

      const response = await getToday(student.accessToken);

      expect(response.statusCode).toBe(200);
      const { exercises } = response.json().workouts[0].targetTraining;
      const byId = Object.fromEntries(exercises.map((e) => [e.id, e]));
      expectGroupedExercise(byId[group.exercises[0].id], group.groupId, 0);
      expectGroupedExercise(byId[group.exercises[1].id], group.groupId, 1);
    });

    it('returns null superset group/rest for ungrouped exercises', async () => {
      const { student, loose } = await setupGroupedTraining({ weekDay: todayWeekday() });

      const { exercises } = (await getToday(student.accessToken)).json().workouts[0].targetTraining;

      expect(exercises.find((e) => e.id === loose.id)).toMatchObject({
        supersetGroupId: null,
        supersetRestInterval: null,
      });
    });

    it('does not return substitutes as flat rows (principals only)', async () => {
      const { student, group, loose, substitute } = await setupGroupedTraining({ weekDay: todayWeekday() });

      const { exercises } = (await getToday(student.accessToken)).json().workouts[0].targetTraining;

      expect(exercises.map((e) => e.id).sort()).toEqual([group.exercises[0].id, group.exercises[1].id, loose.id].sort());
      expect(exercises.map((e) => e.id)).not.toContain(substitute.id);
    });
  });
});
