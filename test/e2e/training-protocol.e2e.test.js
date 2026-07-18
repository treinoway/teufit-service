import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: training protocols', () => {
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

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    await provisionTrainerPlan(trainerRecord.id);

    return { userId, trainerId: trainerRecord.id, accessToken: trainerToken };
  }

  async function createAssigneeWithToken(firstName = 'John', lastName = 'Doe') {
    const email = `e2e+assignee-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupResponse = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupResponse.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupResponse.json();

    await app.inject({
      method: 'PATCH',
      url: '/me/profile',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { firstName, lastName },
    });

    return { userId, accessToken };
  }

  async function linkStudentToTrainer(trainerId, studentId) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId } });
  }

  describe('POST /trainer/protocols', () => {
    it('creates protocol and returns assignee with id, firstName, lastName, avatarUrl', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Jane', 'Smith');
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          assigneeId,
          name: 'Protocol Hipertrofia',
          startDate: '2025-02-01',
          genderOrdination: 'female',
          trainingLevel: 'intermediate',
        },
      });

      expect(createResponse.statusCode).toBe(201);
      const body = createResponse.json();

      expect(body).toHaveProperty('id');
      expect(body).toHaveProperty('assigneeId', assigneeId);
      expect(body).toHaveProperty('name', 'Protocol Hipertrofia');
      expect(body).toHaveProperty('genderOrdination', 'female');
      expect(body).toHaveProperty('trainingLevel', 'intermediate');
      expect(body).toHaveProperty('assignee');
      expect(body.assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Jane',
        lastName: 'Smith',
      });
      expect(body.assignee).toHaveProperty('avatarUrl');
    });

    it('returns 404 when assignee user does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const fakeAssigneeId = '00000000-0000-0000-0000-000000000000';

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId: fakeAssigneeId,
          name: 'Protocol',
          startDate: '2025-02-01',
        },
      });

      expect(response.statusCode).toBe(404);
    });

    it('rejects without authentication', async () => {
      const { userId: assigneeId } = await createAssigneeWithToken();

      const response = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        payload: {
          assigneeId,
          name: 'Protocol',
          startDate: '2025-02-01',
        },
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('GET /trainer/protocols', () => {
    it('returns protocols with assignee info', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Maria', 'Silva');
      await linkStudentToTrainer(trainerId, assigneeId);

      await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId,
          name: 'Protocol A',
          startDate: '2025-02-01',
        },
      });

      const listResponse = await app.inject({
        method: 'GET',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(listResponse.statusCode).toBe(200);
      const protocols = listResponse.json();
      expect(protocols).toHaveLength(1);
      expect(protocols[0]).toHaveProperty('assignee');
      expect(protocols[0].assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Maria',
        lastName: 'Silva',
      });
    });
  });

  describe('GET /trainer/protocols/:id', () => {
    it('returns protocol by id with assignee', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Carlos', 'Santos');
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId,
          name: 'Protocol Detalhado',
          startDate: '2025-02-01',
        },
      });
      const { id: protocolId } = createResponse.json();

      const getResponse = await app.inject({
        method: 'GET',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(getResponse.statusCode).toBe(200);
      const body = getResponse.json();
      expect(body).toHaveProperty('id', protocolId);
      expect(body).toHaveProperty('assignee');
      expect(body.assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Carlos',
        lastName: 'Santos',
      });
    });
  });

  describe('PATCH /trainer/protocols/:id', () => {
    it('updates protocol and returns assignee', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken('Ana', 'Costa');
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: {
          assigneeId,
          name: 'Original Name',
          startDate: '2025-02-01',
        },
      });
      const { id: protocolId } = createResponse.json();

      const updateResponse = await app.inject({
        method: 'PATCH',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Updated Name', genderOrdination: 'male', trainingLevel: 'athlete' },
      });

      expect(updateResponse.statusCode).toBe(200);
      const body = updateResponse.json();
      expect(body).toHaveProperty('name', 'Updated Name');
      expect(body).toHaveProperty('genderOrdination', 'male');
      expect(body).toHaveProperty('trainingLevel', 'athlete');
      expect(body).toHaveProperty('assignee');
      expect(body.assignee).toMatchObject({
        id: assigneeId,
        firstName: 'Ana',
        lastName: 'Costa',
      });
    });
  });

  describe('GET /my/protocols', () => {
    it('returns protocols assigned to authenticated user', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId, accessToken: assigneeToken } = await createAssigneeWithToken('Pedro', 'Lima');
      await linkStudentToTrainer(trainerId, assigneeId);

      await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          assigneeId,
          name: 'Meu Protocolo',
          startDate: '2025-02-01',
        },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/my/protocols',
        headers: { authorization: `Bearer ${assigneeToken}` },
      });

      expect(response.statusCode).toBe(200);
      const protocols = response.json();
      expect(protocols).toHaveLength(1);
      expect(protocols[0]).toHaveProperty('name', 'Meu Protocolo');
      expect(protocols[0]).toHaveProperty('trainer');
    });
  });

  // ==================== DELETE ====================

  describe('DELETE /trainer/protocols/:id', () => {
    it('returns 409 when protocol status is active', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { assigneeId, name: 'Active Protocol', startDate: '2025-02-01' },
      });
      expect(createResponse.statusCode).toBe(201);
      const { id: protocolId, status } = createResponse.json();
      expect(status).toBe('active');

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(deleteResponse.statusCode).toBe(409);
      expect(deleteResponse.json()).toMatchObject({
        error: 'Active protocols cannot be deleted. Archive the protocol first.',
      });
    });

    it('returns 200 when protocol status is completed', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { assigneeId, name: 'Completed Protocol', startDate: '2025-02-01' },
      });
      const { id: protocolId } = createResponse.json();

      await app.inject({
        method: 'PATCH',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { status: 'completed' },
      });

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toHaveProperty('deletedAt');
    });

    it('returns 200 when protocol status is archived', async () => {
      const { trainerId, accessToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { assigneeId, name: 'Archived Protocol', startDate: '2025-02-01' },
      });
      const { id: protocolId } = createResponse.json();

      await app.inject({
        method: 'PATCH',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { status: 'archived' },
      });

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(deleteResponse.statusCode).toBe(200);
      expect(deleteResponse.json()).toHaveProperty('deletedAt');
    });

    it('returns 404 when protocol does not exist', async () => {
      const { accessToken } = await createTrainerWithToken();
      const fakeId = '00000000-0000-0000-0000-000000000000';

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: `/trainer/protocols/${fakeId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(deleteResponse.statusCode).toBe(404);
    });

    it('returns 401 without authentication', async () => {
      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/trainer/protocols/00000000-0000-0000-0000-000000000000',
      });

      expect(deleteResponse.statusCode).toBe(401);
    });
  });

  // ==================== i18n labels ====================

  describe('i18n labels — training protocol', () => {
    it('GET /trainer/protocols returns statusLabel in pt-BR', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId, name: 'Protocolo Força', startDate: '2025-02-01' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const [protocol] = response.json();
      expect(protocol.status).toBe('active');
      expect(protocol.statusLabel).toBe('Ativo');
    });

    it('GET /trainer/protocols returns statusLabel in en-US', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId, name: 'Strength Protocol', startDate: '2025-02-01' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}`, 'app-language': 'en-US' },
      });

      expect(response.statusCode).toBe(200);
      const [protocol] = response.json();
      expect(protocol.status).toBe('active');
      expect(protocol.statusLabel).toBe('Active');
    });

    it('GET /my/protocols returns categoryLabel for nested trainings in pt-BR', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId, accessToken: assigneeToken } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      const createResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId, name: 'Meu Protocolo', startDate: '2025-02-01' },
      });
      const { id: protocolId } = createResponse.json();

      // Create a training inside the protocol
      await app.inject({
        method: 'POST',
        url: `/trainer/protocols/${protocolId}/trainings`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Treino A', category: 'strength' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/my/protocols',
        headers: { authorization: `Bearer ${assigneeToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const [protocol] = response.json();
      expect(protocol.trainings).toHaveLength(1);
      expect(protocol.trainings[0].category).toBe('strength');
      expect(protocol.trainings[0].categoryLabel).toBe('Força');
    });
  });

  // ==================== estimatedDurationSeconds serialization ====================

  describe('estimatedDurationSeconds — present on nested trainings', () => {
    async function buildProtocolWithTrainingAndExercise(trainerToken, assigneeId) {
      const protocolResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId, name: 'Protocolo Duração', startDate: '2025-02-01' },
      });
      expect(protocolResponse.statusCode).toBe(201);
      const { id: protocolId } = protocolResponse.json();

      const trainingResponse = await app.inject({
        method: 'POST',
        url: `/trainer/protocols/${protocolId}/trainings`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Treino Duração', category: 'strength' },
      });
      expect(trainingResponse.statusCode).toBe(201);
      const { id: trainingId } = trainingResponse.json();

      // Creating the exercise triggers recomputeTrainingDuration, making estimatedDurationSeconds non-zero
      await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength', sets: 4, hasLoad: true },
      });

      return { protocolId, trainingId };
    }

    it('GET /trainer/protocols/:id exposes estimatedDurationSeconds on nested trainings', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      const { protocolId, trainingId } = await buildProtocolWithTrainingAndExercise(trainerToken, assigneeId);

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.trainings).toHaveLength(1);
      expect(body.trainings[0].id).toBe(trainingId);
      expect(body.trainings[0]).toHaveProperty('estimatedDurationSeconds');
      expect(typeof body.trainings[0].estimatedDurationSeconds).toBe('number');
      expect(body.trainings[0].estimatedDurationSeconds).toBeGreaterThan(0);
    });

    it('GET /my/protocols/:id exposes estimatedDurationSeconds on nested trainings', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId, accessToken: assigneeToken } = await createAssigneeWithToken();
      await linkStudentToTrainer(trainerId, assigneeId);

      const { protocolId, trainingId } = await buildProtocolWithTrainingAndExercise(trainerToken, assigneeId);

      const response = await app.inject({
        method: 'GET',
        url: `/my/protocols/${protocolId}`,
        headers: { authorization: `Bearer ${assigneeToken}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.trainings).toHaveLength(1);
      expect(body.trainings[0].id).toBe(trainingId);
      expect(body.trainings[0]).toHaveProperty('estimatedDurationSeconds');
      expect(typeof body.trainings[0].estimatedDurationSeconds).toBe('number');
      expect(body.trainings[0].estimatedDurationSeconds).toBeGreaterThan(0);
    });
  });
});
