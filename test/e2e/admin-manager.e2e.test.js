import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { createAdminPrisma } from '../../src/db-admin.js';
import { Roles } from '../../src/constants/roles.js';
import config from '../../config/index.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const OK_STATUS = 200;
const BAD_REQUEST_STATUS = 400;
const UNAUTHORIZED_STATUS = 401;
const FORBIDDEN_STATUS = 403;
const NOT_FOUND_STATUS = 404;
const UNAVAILABLE_STATUS = 503;
const STATEMENT_TIMEOUT_MS = 150;
const SLEEP_SECONDS = 3;
const MANAGER_RATE_LIMIT = { max: 60, timeWindow: '1 minute' };
const PROTOCOL_START_DATE = '2026-03-05';
const PROTOCOL_END_DATE = '2026-04-30';
const SESSION_BASE_TIME = Date.UTC(2026, 3, 1, 9, 0, 0);

// Sends an authenticated (or anonymous when token is null) GET to a manager route.
function get(app, url, accessToken) {
  return app.inject({
    method: 'GET',
    url,
    headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
  });
}

// Asserts the unified error contract for an error response body.
function expectErrorContract(body, { error, messageCode }) {
  expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
  expect(body).toHaveProperty('details');
}

// Creates a plain student linked to the trainer and returns its user id.
async function linkNamedStudent(app, trainerId, { firstName, lastName, activeOnPlan = true }) {
  const { userId } = await createStudentWithToken(app);
  await prisma.user.update({ where: { id: userId }, data: { firstName, lastName } });
  await prisma.trainerStudent.create({ data: { trainerId, studentId: userId, activeOnPlan } });
  return userId;
}

// Creates a protocol with two trainings holding one and two exercises, assigned to the student.
async function createProtocolWithContent({ trainerId, assigneeId, name }) {
  const protocol = await prisma.trainingProtocol.create({
    data: {
      trainerId,
      assigneeId,
      name,
      startDate: new Date(`${PROTOCOL_START_DATE}T00:00:00.000Z`),
      expirationDate: new Date(`${PROTOCOL_END_DATE}T00:00:00.000Z`),
    },
  });
  const trainingB = await prisma.training.create({
    data: { trainingProtocolId: protocol.id, name: 'Treino B', category: 'strength', order: 1 },
  });
  const trainingA = await prisma.training.create({
    data: { trainingProtocolId: protocol.id, name: 'Treino A', category: 'strength', order: 0 },
  });
  await prisma.exercise.create({
    data: { trainingId: trainingA.id, name: 'Supino reto', type: 'strength', order: 1, sets: 4, repetitions: [10, 10, 8, 8], restInterval: 90, notes: 'Controlar a descida' },
  });
  await prisma.exercise.create({
    data: { trainingId: trainingA.id, name: 'Agachamento', type: 'strength', order: 0, sets: 3, repetitions: [12, 12, 12], hasLoad: true, suggestedLoad: 80 },
  });
  await prisma.exercise.create({
    data: { trainingId: trainingB.id, name: 'Remada', type: 'strength', order: 0, sets: 3 },
  });
  return { protocol, trainingA, trainingB };
}

// Creates `count` finished workout sessions for the user on the training, oldest first.
async function createSessions({ userId, trainingId, count }) {
  const sessionIds = [];
  for (let index = 0; index < count; index += 1) {
    const startedAt = new Date(SESSION_BASE_TIME + index * 86_400_000);
    const session = await prisma.workoutSession.create({
      data: {
        userId,
        trainingId,
        status: 'completed',
        startedAt,
        finishedAt: new Date(startedAt.getTime() + 3_000_000),
        durationSeconds: 3000,
      },
    });
    sessionIds.push(session.id);
  }
  return sessionIds;
}

// Creates `count` training templates and one exercise template for the trainer.
async function createTemplates({ trainerId, count }) {
  for (let index = 0; index < count; index += 1) {
    await prisma.trainingTemplate.create({
      data: { trainerId, name: `Template ${index}`, category: 'strength' },
    });
  }
  await prisma.exerciseTemplate.create({ data: { trainerId, name: 'Supino template', type: 'strength' } });
}

e2eDescribe('e2e: admin manager (read-only backoffice)', () => {
  let app;
  let admin;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    admin = await createAdminWithToken(app);
  });

  describe('criterion 3: access control on every manager route', () => {
    const routes = [
      ['GET /admin/manager/users', () => '/admin/manager/users'],
      ['GET /admin/manager/users/:userId', () => `/admin/manager/users/${UNKNOWN_ID}`],
      ['GET /admin/manager/users/:userId/students', () => `/admin/manager/users/${UNKNOWN_ID}/students`],
      ['GET /admin/manager/users/:userId/trainers', () => `/admin/manager/users/${UNKNOWN_ID}/trainers`],
      ['GET /admin/manager/users/:userId/protocols', () => `/admin/manager/users/${UNKNOWN_ID}/protocols?as=trainer`],
      ['GET /admin/manager/users/:userId/templates', () => `/admin/manager/users/${UNKNOWN_ID}/templates?type=training`],
      ['GET /admin/manager/users/:userId/sessions', () => `/admin/manager/users/${UNKNOWN_ID}/sessions`],
      ['GET /admin/manager/protocols/:protocolId', () => `/admin/manager/protocols/${UNKNOWN_ID}`],
    ];

    it.each(routes)('%s returns 401 without a token', async (_name, buildUrl) => {
      const response = await get(app, buildUrl(), null);

      expect(response.statusCode).toBe(UNAUTHORIZED_STATUS);
    });

    it.each(routes)('%s returns 403 auth.forbidden to a trainer', async (_name, buildUrl) => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await get(app, buildUrl(), accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it.each(routes)('%s returns 403 to a student', async (_name, buildUrl) => {
      const { accessToken } = await createStudentWithToken(app);

      const response = await get(app, buildUrl(), accessToken);

      expect(response.statusCode).toBe(FORBIDDEN_STATUS);
    });

    it('should configure the manager rate limit at 60 per minute per user', () => {
      expect(config.rateLimit.adminManager).toEqual(MANAGER_RATE_LIMIT);
    });
  });

  describe('criterion 5: GET /admin/manager/users', () => {
    it('should return the paginated envelope with the documented item fields', async () => {
      const response = await get(app, '/admin/manager/users', admin.accessToken);

      expect(response.statusCode).toBe(OK_STATUS);
      const body = response.json();
      expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(body.items[0]).toEqual({
        id: admin.userId,
        firstName: expect.anything(),
        lastName: expect.anything(),
        email: expect.any(String),
        roles: [Roles.ADMIN],
        isTrainer: false,
        isStudent: false,
        status: expect.any(String),
        createdAt: expect.any(String),
        deletedAt: null,
      });
    });

    it('should order by createdAt desc', async () => {
      const first = await createStudentWithToken(app);
      const second = await createStudentWithToken(app);

      const { items } = (await get(app, '/admin/manager/users', admin.accessToken)).json();

      expect(items.map((item) => item.id).indexOf(second.userId)).toBeLessThan(
        items.map((item) => item.id).indexOf(first.userId),
      );
    });

    it('should paginate with page and pageSize', async () => {
      await createStudentWithToken(app);
      await createStudentWithToken(app);

      const body = (await get(app, '/admin/manager/users?page=2&pageSize=2', admin.accessToken)).json();

      expect(body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(body.items).toHaveLength(1);
    });

    it('should reject a pageSize above 50 with a validation error', async () => {
      const response = await get(app, '/admin/manager/users?pageSize=51', admin.accessToken);

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should reject a search longer than 200 characters', async () => {
      const response = await get(app, `/admin/manager/users?search=${'a'.repeat(201)}`, admin.accessToken);

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });

    it('should reject an unknown kind', async () => {
      const response = await get(app, '/admin/manager/users?kind=wizard', admin.accessToken);

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });

    it('should match tokens across first name and last name case-insensitively', async () => {
      const { userId } = await createStudentWithToken(app);
      await prisma.user.update({ where: { id: userId }, data: { firstName: 'Zelda', lastName: 'Quimby' } });

      const { items } = (await get(app, '/admin/manager/users?search=QUIMBY%20zel', admin.accessToken)).json();

      expect(items.map((item) => item.id)).toEqual([userId]);
    });

    it('should match search against the email', async () => {
      const { userId, email } = await createStudentWithToken(app);

      const { items } = (await get(app, `/admin/manager/users?search=${encodeURIComponent(email)}`, admin.accessToken)).json();

      expect(items.map((item) => item.id)).toEqual([userId]);
    });

    it('should return only trainers for kind=trainer and flag isTrainer', async () => {
      const trainer = await createTrainerWithToken(app);
      await createStudentWithToken(app);

      const { items } = (await get(app, '/admin/manager/users?kind=trainer', admin.accessToken)).json();

      expect(items.map((item) => item.id)).toEqual([trainer.userId]);
      expect(items[0].isTrainer).toBe(true);
    });

    it('should return only admins for kind=admin', async () => {
      await createTrainerWithToken(app);

      const { items } = (await get(app, '/admin/manager/users?kind=admin', admin.accessToken)).json();

      expect(items.map((item) => item.id)).toEqual([admin.userId]);
    });

    it('should return only users with a TrainerStudent row for kind=student', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      await createStudentWithToken(app);

      const { items } = (await get(app, '/admin/manager/users?kind=student', admin.accessToken)).json();

      expect(items.map((item) => item.id)).toEqual([studentId]);
      expect(items[0].isStudent).toBe(true);
    });

    it('should return only nutritionists for kind=nutritionist', async () => {
      const { userId } = await createStudentWithToken(app);
      await prisma.user.update({ where: { id: userId }, data: { roles: [Roles.NUTRITIONIST] } });

      const { items } = (await get(app, '/admin/manager/users?kind=nutritionist', admin.accessToken)).json();

      expect(items.map((item) => item.id)).toEqual([userId]);
    });

    it('should include soft-deleted users flagged with deletedAt', async () => {
      const { userId } = await createStudentWithToken(app);
      await prisma.user.update({ where: { id: userId }, data: { deletedAt: new Date() } });

      const { items } = (await get(app, '/admin/manager/users', admin.accessToken)).json();

      expect(items.find((item) => item.id === userId).deletedAt).toEqual(expect.any(String));
    });
  });

  describe('criterion 6: GET /admin/manager/users/:userId', () => {
    it('should return 404 admin.userNotFound for an unknown user', async () => {
      const response = await get(app, `/admin/manager/users/${UNKNOWN_ID}`, admin.accessToken);

      expect(response.statusCode).toBe(NOT_FOUND_STATUS);
      expectErrorContract(response.json(), { error: 'NOT_FOUND', messageCode: 'admin.userNotFound' });
    });

    it('should return profile, trainer, counts and lastWorkoutAt for a trainer', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      await linkNamedStudent(app, trainer.trainerId, { firstName: 'Caio', lastName: 'Reis', activeOnPlan: false });
      const { trainingA } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });
      await createTemplates({ trainerId: trainer.trainerId, count: 2 });
      await createSessions({ userId: studentId, trainingId: trainingA.id, count: 1 });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}`, admin.accessToken)).json();

      expect(body.user).toMatchObject({ id: trainer.userId, email: trainer.email });
      expect(body.trainer).toMatchObject({ id: trainer.trainerId, createdAt: expect.any(String) });
      expect(body.trainer).toHaveProperty('planTier');
      expect(body.counts).toEqual({
        students: 2,
        activeStudents: 1,
        protocolsCreated: 1,
        trainingTemplates: 2,
        exerciseTemplates: 1,
        challenges: 0,
        trainers: 0,
        protocolsAssigned: 0,
        workoutSessions: 0,
      });
      expect(body).toHaveProperty('lastWorkoutAt');
    });

    it('should return trainer null and student counts for a student', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { trainingA } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });
      await createSessions({ userId: studentId, trainingId: trainingA.id, count: 3 });

      const body = (await get(app, `/admin/manager/users/${studentId}`, admin.accessToken)).json();

      expect(body.trainer).toBeNull();
      expect(body.counts).toMatchObject({ trainers: 1, protocolsAssigned: 1, workoutSessions: 3, students: 0 });
      expect(body.lastWorkoutAt).toEqual(expect.any(String));
    });

    it('should return a null lastWorkoutAt for a user who never trained', async () => {
      const { userId } = await createStudentWithToken(app);

      const body = (await get(app, `/admin/manager/users/${userId}`, admin.accessToken)).json();

      expect(body.lastWorkoutAt).toBeNull();
    });
  });

  describe('criterion 7: GET /admin/manager/users/:userId/students', () => {
    it('should return the trainer students with the documented fields', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/students`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(body.items[0]).toEqual({
        studentId,
        firstName: 'Bia',
        lastName: 'Souza',
        email: expect.any(String),
        status: expect.any(String),
        activeOnPlan: true,
        lastWorkoutAt: null,
        linkedAt: expect.any(String),
      });
    });

    it('should paginate students', async () => {
      const trainer = await createTrainerWithToken(app);
      await linkNamedStudent(app, trainer.trainerId, { firstName: 'A', lastName: 'One' });
      await linkNamedStudent(app, trainer.trainerId, { firstName: 'B', lastName: 'Two' });
      await linkNamedStudent(app, trainer.trainerId, { firstName: 'C', lastName: 'Three' });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/students?page=2&pageSize=2`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(body.items).toHaveLength(1);
    });

    it('should return an empty list for a non-trainer', async () => {
      const { userId } = await createStudentWithToken(app);

      const response = await get(app, `/admin/manager/users/${userId}/students`, admin.accessToken);

      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json()).toEqual({ items: [], total: 0, page: 1, pageSize: 20 });
    });
  });

  describe('criterion 8: GET /admin/manager/users/:userId/trainers', () => {
    it('should return the trainers linked to the student', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });

      const body = (await get(app, `/admin/manager/users/${studentId}/trainers`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(body.items[0]).toEqual({
        trainerId: trainer.trainerId,
        userId: trainer.userId,
        firstName: expect.anything(),
        lastName: expect.anything(),
        email: trainer.email,
        status: expect.any(String),
        linkedAt: expect.any(String),
      });
    });

    it('should return an empty list for a user without trainers', async () => {
      const { userId } = await createStudentWithToken(app);

      const body = (await get(app, `/admin/manager/users/${userId}/trainers`, admin.accessToken)).json();

      expect(body).toMatchObject({ items: [], total: 0 });
    });
  });

  describe('criterion 9: GET /admin/manager/users/:userId/protocols', () => {
    it('should list protocols created by a trainer with date-only start and end', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { protocol } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/protocols?as=trainer`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 1, page: 1, pageSize: 20 });
      expect(body.items[0]).toEqual({
        id: protocol.id,
        name: 'Hipertrofia',
        trainerName: expect.any(String),
        assigneeName: 'Bia Souza',
        startDate: PROTOCOL_START_DATE,
        endDate: PROTOCOL_END_DATE,
        trainingsCount: 2,
        createdAt: expect.any(String),
        deletedAt: null,
      });
    });

    it('should list protocols assigned to a student when as=student', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { protocol } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });

      const body = (await get(app, `/admin/manager/users/${studentId}/protocols?as=student`, admin.accessToken)).json();

      expect(body.items.map((item) => item.id)).toEqual([protocol.id]);
    });

    it('should not list assigned protocols when as=trainer for a student', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });

      const body = (await get(app, `/admin/manager/users/${studentId}/protocols?as=trainer`, admin.accessToken)).json();

      expect(body.items).toEqual([]);
    });

    it('should include soft-deleted protocols flagged with deletedAt', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { protocol } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });
      await prisma.trainingProtocol.update({ where: { id: protocol.id }, data: { deletedAt: new Date() } });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/protocols?as=trainer`, admin.accessToken)).json();

      expect(body.items[0].deletedAt).toEqual(expect.any(String));
    });

    it('should reject an invalid as value', async () => {
      const response = await get(app, `/admin/manager/users/${admin.userId}/protocols?as=wizard`, admin.accessToken);

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });
  });

  describe('criterion 10 and 13: GET /admin/manager/protocols/:protocolId', () => {
    it('should return 404 admin.protocolNotFound for an unknown protocol', async () => {
      const response = await get(app, `/admin/manager/protocols/${UNKNOWN_ID}`, admin.accessToken);

      expect(response.statusCode).toBe(NOT_FOUND_STATUS);
      expectErrorContract(response.json(), { error: 'NOT_FOUND', messageCode: 'admin.protocolNotFound' });
    });

    it('should return the header with date-only fields', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { protocol } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });

      const body = (await get(app, `/admin/manager/protocols/${protocol.id}`, admin.accessToken)).json();

      expect(body).toMatchObject({
        id: protocol.id,
        name: 'Hipertrofia',
        startDate: PROTOCOL_START_DATE,
        endDate: PROTOCOL_END_DATE,
      });
    });

    it('should return trainings ordered by order', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { protocol } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });

      const body = (await get(app, `/admin/manager/protocols/${protocol.id}`, admin.accessToken)).json();

      expect(body.trainings.map((training) => training.name)).toEqual(['Treino A', 'Treino B']);
    });

    it('should return each training exercises ordered by order with stored prescription fields', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { protocol } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });

      const body = (await get(app, `/admin/manager/protocols/${protocol.id}`, admin.accessToken)).json();

      const exercises = body.trainings[0].exercises;
      expect(exercises.map((exercise) => exercise.name)).toEqual(['Agachamento', 'Supino reto']);
      expect(exercises[1]).toMatchObject({
        sets: 4,
        repetitions: [10, 10, 8, 8],
        restInterval: 90,
        notes: 'Controlar a descida',
      });
      expect(exercises[0]).toMatchObject({ suggestedLoad: 80 });
    });

    it('should have applied the migration indexes on users(created_at) and trainings(training_protocol_id)', async () => {
      const indexes = await prisma.$queryRaw`
        SELECT tablename, indexdef FROM pg_indexes
        WHERE (tablename = 'users' AND indexdef LIKE '%(created_at)%')
           OR (tablename = 'trainings' AND indexdef LIKE '%(training_protocol_id)%')
      `;

      expect(indexes.map((row) => row.tablename).sort()).toEqual(['trainings', 'users']);
    });
  });

  describe('criterion 11: GET /admin/manager/users/:userId/templates', () => {
    it('should list training templates with the documented fields', async () => {
      const trainer = await createTrainerWithToken(app);
      await createTemplates({ trainerId: trainer.trainerId, count: 2 });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/templates?type=training`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 2, page: 1, pageSize: 20 });
      expect(body.items[0]).toEqual({
        id: expect.any(String),
        name: expect.stringContaining('Template'),
        createdAt: expect.any(String),
        deletedAt: null,
      });
    });

    it('should list exercise templates when type=exercise', async () => {
      const trainer = await createTrainerWithToken(app);
      await createTemplates({ trainerId: trainer.trainerId, count: 2 });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/templates?type=exercise`, admin.accessToken)).json();

      expect(body.items.map((item) => item.name)).toEqual(['Supino template']);
    });

    it('should include soft-deleted templates flagged with deletedAt', async () => {
      const trainer = await createTrainerWithToken(app);
      await prisma.trainingTemplate.create({
        data: { trainerId: trainer.trainerId, name: 'Removido', category: 'strength', deletedAt: new Date() },
      });

      const body = (await get(app, `/admin/manager/users/${trainer.userId}/templates?type=training`, admin.accessToken)).json();

      expect(body.items[0].deletedAt).toEqual(expect.any(String));
    });

    it('should return an empty list for a non-trainer', async () => {
      const { userId } = await createStudentWithToken(app);

      const body = (await get(app, `/admin/manager/users/${userId}/templates?type=training`, admin.accessToken)).json();

      expect(body).toMatchObject({ items: [], total: 0 });
    });

    it('should reject an invalid type', async () => {
      const response = await get(app, `/admin/manager/users/${admin.userId}/templates?type=wizard`, admin.accessToken);

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
    });
  });

  describe('criterion 12: GET /admin/manager/users/:userId/sessions', () => {
    it('should list sessions newest first with the documented fields', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { trainingA } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });
      await createSessions({ userId: studentId, trainingId: trainingA.id, count: 3 });

      const body = (await get(app, `/admin/manager/users/${studentId}/sessions`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 3, page: 1, pageSize: 20 });
      expect(body.items[0]).toEqual({
        id: expect.any(String),
        trainingName: 'Treino A',
        startedAt: new Date(SESSION_BASE_TIME + 2 * 86_400_000).toISOString(),
        finishedAt: expect.any(String),
        durationSec: 3000,
      });
      const startedAts = body.items.map((item) => item.startedAt);
      expect(startedAts).toEqual([...startedAts].sort().reverse());
    });

    it('should paginate sessions', async () => {
      const trainer = await createTrainerWithToken(app);
      const studentId = await linkNamedStudent(app, trainer.trainerId, { firstName: 'Bia', lastName: 'Souza' });
      const { trainingA } = await createProtocolWithContent({ trainerId: trainer.trainerId, assigneeId: studentId, name: 'Hipertrofia' });
      await createSessions({ userId: studentId, trainingId: trainingA.id, count: 3 });

      const body = (await get(app, `/admin/manager/users/${studentId}/sessions?page=2&pageSize=2`, admin.accessToken)).json();

      expect(body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(body.items).toHaveLength(1);
    });

    it('should return an empty list for a user without sessions', async () => {
      const { userId } = await createStudentWithToken(app);

      const body = (await get(app, `/admin/manager/users/${userId}/sessions`, admin.accessToken)).json();

      expect(body).toMatchObject({ items: [], total: 0 });
    });
  });

  describe('criterion 1 and 4: dedicated read-only admin client', () => {
    let adminDb;

    beforeAll(() => {
      adminDb = createAdminPrisma({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      });
    });

    afterAll(async () => {
      if (adminDb) await adminDb.$disconnect();
    });

    it('should connect with application_name teufit-manager', async () => {
      const [row] = await adminDb.$queryRaw`SELECT current_setting('application_name') AS value`;

      expect(row.value).toBe('teufit-manager');
    });

    it('should apply the configured statement_timeout to the session', async () => {
      const [row] = await adminDb.$queryRaw`SELECT current_setting('statement_timeout') AS value`;

      expect(row.value).toBe(`${STATEMENT_TIMEOUT_MS}ms`);
    });

    it('should enable default_transaction_read_only on the session', async () => {
      const [row] = await adminDb.$queryRaw`SELECT current_setting('default_transaction_read_only') AS value`;

      expect(row.value).toBe('on');
    });

    it('should reject a Prisma model write with a read-only transaction error', async () => {
      const { userId } = await createStudentWithToken(app);

      await expect(
        adminDb.user.update({ where: { id: userId }, data: { firstName: 'Hacked' } }),
      ).rejects.toThrow(/read-only/i);
    });

    it('should leave the row untouched after a rejected write', async () => {
      const { userId } = await createStudentWithToken(app);
      await adminDb.user.update({ where: { id: userId }, data: { firstName: 'Hacked' } }).catch(() => null);

      const row = await prisma.user.findUnique({ where: { id: userId }, select: { firstName: true } });

      expect(row.firstName).not.toBe('Hacked');
    });

    it('should reject a raw write', async () => {
      await expect(adminDb.$executeRaw`DELETE FROM users`).rejects.toThrow(/read-only/i);
    });

    it('should cancel a query that exceeds the statement timeout', async () => {
      await expect(adminDb.$queryRaw`SELECT pg_sleep(${SLEEP_SECONDS})`).rejects.toThrow();
    });
  });

  describe('criterion 2: statement timeout surfaces as 503 admin.queryTimeout', () => {
    let slowDb;
    let slowApp;

    beforeAll(async () => {
      const baseDb = createAdminPrisma({
        connectionString: process.env.DATABASE_URL,
        max: 1,
        statementTimeoutMs: STATEMENT_TIMEOUT_MS,
      });
      slowDb = baseDb.$extends({
        query: {
          $allModels: {
            async $allOperations({ args, query }) {
              await baseDb.$queryRaw`SELECT pg_sleep(${SLEEP_SECONDS})`;
              return query(args);
            },
          },
        },
      });
      slowApp = await setupApp({ logger: false, adminDb: slowDb });
    });

    afterAll(async () => {
      if (slowApp) await slowApp.close();
      if (slowDb) await slowDb.$disconnect();
    });

    it('should return 503 with the unified contract instead of a 500', async () => {
      const token = slowApp.jwt.sign({
        sub: admin.userId,
        email: 'admin@example.com',
        roles: [Roles.ADMIN],
        status: 'active',
      });

      const response = await get(slowApp, '/admin/manager/users', token);

      expect(response.statusCode).toBe(UNAVAILABLE_STATUS);
      expectErrorContract(response.json(), { error: expect.any(String), messageCode: 'admin.queryTimeout' });
    });
  });
});
