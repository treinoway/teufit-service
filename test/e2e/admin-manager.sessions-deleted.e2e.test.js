import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createAdminWithToken, createTrainerWithToken, createStudentWithToken } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { WorkoutSessionStatus } from '../../src/constants/training.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const OK_STATUS = 200;
const LIVE_STARTED_AT = new Date('2026-04-02T09:00:00.000Z');
const DELETED_STARTED_AT = new Date('2026-04-01T09:00:00.000Z');
const DELETED_AT = new Date('2026-04-03T12:00:00.000Z');
const SESSION_LENGTH_MS = 3_000_000;
const DURATION_SECONDS = SESSION_LENGTH_MS / 1000;

// Sends an authenticated GET to a manager route.
function get(app, url, accessToken) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${accessToken}` } });
}

// Creates a trainer, a linked student and a protocol training, and returns their ids.
async function createStudentWithTraining(app) {
  const trainer = await createTrainerWithToken(app);
  const { userId: studentId } = await createStudentWithToken(app);
  await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId, activeOnPlan: true } });
  const protocol = await prisma.trainingProtocol.create({
    data: {
      trainerId: trainer.trainerId,
      assigneeId: studentId,
      name: 'Hipertrofia',
      startDate: new Date('2026-03-05T00:00:00.000Z'),
      expirationDate: new Date('2026-04-30T00:00:00.000Z'),
    },
  });
  const training = await prisma.training.create({
    data: { trainingProtocolId: protocol.id, name: 'Treino A', category: 'strength', order: 0 },
  });
  return { studentId, trainingId: training.id };
}

// Creates a completed workout session for the user, optionally soft-deleted.
function createSession({ userId, trainingId, startedAt, deletedAt = null }) {
  return prisma.workoutSession.create({
    data: {
      userId,
      trainingId,
      status: WorkoutSessionStatus.COMPLETED,
      startedAt,
      finishedAt: new Date(startedAt.getTime() + SESSION_LENGTH_MS),
      durationSeconds: DURATION_SECONDS,
      deletedAt,
    },
  });
}

e2eDescribe('e2e: admin manager sessions list exposes deletedAt', () => {
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

  it('should list a soft-deleted session with deletedAt set and a live one with deletedAt null', async () => {
    const { studentId, trainingId } = await createStudentWithTraining(app);
    const live = await createSession({ userId: studentId, trainingId, startedAt: LIVE_STARTED_AT });
    const deleted = await createSession({ userId: studentId, trainingId, startedAt: DELETED_STARTED_AT, deletedAt: DELETED_AT });

    const response = await get(app, `/admin/manager/users/${studentId}/sessions`, admin.accessToken);

    expect(response.statusCode).toBe(OK_STATUS);
    const body = response.json();
    expect(body.total).toBe(2);
    const byId = Object.fromEntries(body.items.map((item) => [item.id, item]));
    expect(byId[deleted.id]).toMatchObject({ deletedAt: DELETED_AT.toISOString() });
    expect(byId[live.id]).toHaveProperty('deletedAt', null);
  });

  it('should return the full item shape including deletedAt', async () => {
    const { studentId, trainingId } = await createStudentWithTraining(app);
    await createSession({ userId: studentId, trainingId, startedAt: DELETED_STARTED_AT, deletedAt: DELETED_AT });

    const body = (await get(app, `/admin/manager/users/${studentId}/sessions`, admin.accessToken)).json();

    expect(body.items[0]).toEqual({
      id: expect.any(String),
      trainingName: 'Treino A',
      startedAt: DELETED_STARTED_AT.toISOString(),
      finishedAt: new Date(DELETED_STARTED_AT.getTime() + SESSION_LENGTH_MS).toISOString(),
      durationSec: DURATION_SECONDS,
      deletedAt: DELETED_AT.toISOString(),
    });
  });
});
