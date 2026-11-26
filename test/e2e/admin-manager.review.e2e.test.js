import 'dotenv/config';
import Fastify from 'fastify';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createAdminWithToken, createTrainerWithToken, createStudentWithToken } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { adminManagerRoutes } from '../../api/routes/admin-manager-route.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const OK_STATUS = 200;
const MANAGER_ROUTE_COUNT = 11;
const MANAGER_URL_PREFIX = '/admin/manager';
const EXPECTED_RATE_LIMIT = { max: 60, timeWindow: '1 minute', groupId: 'admin-manager' };
const PROTOCOL_START_DATE = '2026-03-05';
const PROTOCOL_END_DATE = '2026-04-30';
const DURATION_SECONDS = 45;
const REPS_RANGE = { min: 8, max: 12 };
const PRINCIPAL_NAME = 'Supino';
const DURATION_NAME = 'Prancha';
const SUBSTITUTE_NAME = 'Supino com halteres';

// Sends an authenticated GET.
function authGet(app, url, accessToken) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${accessToken}` } });
}

// Creates a protocol for the trainer/student pair.
async function createProtocol(trainerId, assigneeId) {
  return prisma.trainingProtocol.create({
    data: {
      trainerId,
      assigneeId,
      name: 'Protocolo',
      startDate: new Date(`${PROTOCOL_START_DATE}T00:00:00.000Z`),
      expirationDate: new Date(`${PROTOCOL_END_DATE}T00:00:00.000Z`),
    },
  });
}

// Creates a training in the protocol, soft-deleted when deletedAt is given.
async function createTraining(trainingProtocolId, name, order, deletedAt = null) {
  return prisma.training.create({ data: { trainingProtocolId, name, category: 'strength', order, deletedAt } });
}

e2eDescribe('e2e: admin manager review fixes', () => {
  let app;
  let admin;
  let trainer;
  let studentId;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    admin = await createAdminWithToken(app);
    trainer = await createTrainerWithToken(app);
    ({ userId: studentId } = await createStudentWithToken(app));
    await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId } });
  });

  describe('protocol detail exercises', () => {
    let exercises;

    beforeEach(async () => {
      const protocol = await createProtocol(trainer.trainerId, studentId);
      const training = await createTraining(protocol.id, 'Treino A', 0);
      const principal = await prisma.exercise.create({
        data: { trainingId: training.id, name: PRINCIPAL_NAME, type: 'strength', order: 0, sets: 3, repetitions: REPS_RANGE },
      });
      await prisma.exercise.create({
        data: {
          trainingId: training.id,
          name: DURATION_NAME,
          type: 'strength',
          order: 1,
          sets: 3,
          prescriptionMode: 'duration',
          duration: DURATION_SECONDS,
        },
      });
      await prisma.exercise.create({
        data: {
          trainingId: training.id,
          name: SUBSTITUTE_NAME,
          type: 'strength',
          order: 2,
          sets: 3,
          substituteForExerciseId: principal.id,
        },
      });
      const response = await authGet(app, `${MANAGER_URL_PREFIX}/protocols/${protocol.id}`, admin.accessToken);
      expect(response.statusCode).toBe(OK_STATUS);
      exercises = response.json().trainings[0].exercises;
    });

    it('should not list substitute exercises', () => {
      expect(exercises.map((exercise) => exercise.name)).toEqual([PRINCIPAL_NAME, DURATION_NAME]);
    });

    it('should return prescriptionMode and duration for a duration exercise', () => {
      expect(exercises[1]).toMatchObject({ prescriptionMode: 'duration', duration: DURATION_SECONDS });
    });

    it('should return a {min,max} repetitions object raw', () => {
      expect(exercises[0].repetitions).toEqual(REPS_RANGE);
    });
  });

  describe('user protocols trainings count', () => {
    it('should count only live trainings', async () => {
      const protocol = await createProtocol(trainer.trainerId, studentId);
      await createTraining(protocol.id, 'Vivo', 0);
      await createTraining(protocol.id, 'Removido', 1, new Date());

      const response = await authGet(app, `${MANAGER_URL_PREFIX}/users/${studentId}/protocols?as=student`, admin.accessToken);

      expect(response.json().items[0].trainingsCount).toBe(1);
    });
  });

  describe('rate limit config', () => {
    it('should give all manager routes the admin-manager rate limit', async () => {
      const routes = [];
      const bare = Fastify();
      bare.addHook('onRoute', (route) => {
        if (route.url.startsWith(MANAGER_URL_PREFIX) && route.method === 'GET') routes.push(route);
      });
      await bare.register(adminManagerRoutes);
      await bare.ready();
      await bare.close();

      expect(routes).toHaveLength(MANAGER_ROUTE_COUNT);
      expect(routes.map((route) => route.config.rateLimit)).toEqual(Array(MANAGER_ROUTE_COUNT).fill(EXPECTED_RATE_LIMIT));
    });
  });
});
