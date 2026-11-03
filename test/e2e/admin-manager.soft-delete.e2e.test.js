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

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const OK_STATUS = 200;
const LIVE_TRAINING = 'Treino vivo';
const DELETED_TRAINING = 'Treino removido';
const LIVE_EXERCISE = 'Exercicio vivo';
const DELETED_EXERCISE = 'Exercicio removido';
const PROTOCOL_START_DATE = '2026-03-05';
const PROTOCOL_END_DATE = '2026-04-30';

// Sends an authenticated GET to the protocol detail route.
function getProtocol(app, protocolId, accessToken) {
  return app.inject({
    method: 'GET',
    url: `/admin/manager/protocols/${protocolId}`,
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

// Creates an exercise on the training, soft-deleted when deletedAt is given.
async function createExercise(trainingId, name, order, deletedAt = null) {
  return prisma.exercise.create({
    data: { trainingId, name, type: 'strength', order, sets: 3, deletedAt },
  });
}

// Creates a protocol with live and soft-deleted trainings and exercises.
async function createProtocolWithSoftDeletedContent({ trainerId, assigneeId, deletedAt = null }) {
  const protocol = await prisma.trainingProtocol.create({
    data: {
      trainerId,
      assigneeId,
      name: 'Protocolo',
      startDate: new Date(`${PROTOCOL_START_DATE}T00:00:00.000Z`),
      expirationDate: new Date(`${PROTOCOL_END_DATE}T00:00:00.000Z`),
      deletedAt,
    },
  });
  const liveTraining = await prisma.training.create({
    data: { trainingProtocolId: protocol.id, name: LIVE_TRAINING, category: 'strength', order: 0 },
  });
  await prisma.training.create({
    data: { trainingProtocolId: protocol.id, name: DELETED_TRAINING, category: 'strength', order: 1, deletedAt: new Date() },
  });
  await createExercise(liveTraining.id, LIVE_EXERCISE, 0);
  await createExercise(liveTraining.id, DELETED_EXERCISE, 1, new Date());
  return protocol;
}

e2eDescribe('e2e: admin manager protocol detail soft-delete', () => {
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

  it('should return only live trainings and exercises', async () => {
    const protocol = await createProtocolWithSoftDeletedContent({ trainerId: trainer.trainerId, assigneeId: studentId });

    const response = await getProtocol(app, protocol.id, admin.accessToken);

    const body = response.json();
    expect(response.statusCode).toBe(OK_STATUS);
    expect(body.trainings.map((training) => training.name)).toEqual([LIVE_TRAINING]);
    expect(body.trainings[0].exercises.map((exercise) => exercise.name)).toEqual([LIVE_EXERCISE]);
  });

  it('should return a soft-deleted protocol with 200 and its deletedAt', async () => {
    const protocol = await createProtocolWithSoftDeletedContent({
      trainerId: trainer.trainerId,
      assigneeId: studentId,
      deletedAt: new Date(),
    });

    const response = await getProtocol(app, protocol.id, admin.accessToken);

    expect(response.statusCode).toBe(OK_STATUS);
    expect(response.json().deletedAt).toEqual(expect.any(String));
  });
});
