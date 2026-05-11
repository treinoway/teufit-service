import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: exercises', () => {
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

    return { userId, accessToken: trainerToken };
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

  async function createProtocolAndTraining(trainerToken, assigneeId) {
    const protocolResponse = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: {
        assigneeId,
        name: 'Protocol',
        startDate: '2025-02-01',
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

  describe('Exercise Templates', () => {
    describe('POST /trainer/exercise-templates', () => {
      it('creates exercise template', async () => {
        const { accessToken } = await createTrainerWithToken();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: {
            name: 'Barbell Squat',
            type: 'strength',
            sets: 4,
            repetitions: { min: 10, max: 10 },
            hasLoad: true,
            suggestedLoad: 60,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('name', 'Barbell Squat');
        expect(body).toHaveProperty('type', 'strength');
        expect(body).toHaveProperty('sets', 4);
        expect(body).toHaveProperty('repetitions', { min: 10, max: 10 });
        expect(body).toHaveProperty('hasLoad', true);
        expect(body).toHaveProperty('suggestedLoad', 60);
      });

      it('returns 400 for invalid exercise type', async () => {
        const { accessToken } = await createTrainerWithToken();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: {
            name: 'Yoga Pose',
            type: 'yoga',
          },
        });

        expect(response.statusCode).toBe(400);
      });

      it('rejects without authentication', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          payload: { name: 'Squat', type: 'strength' },
        });

        expect(response.statusCode).toBe(401);
      });
    });

    describe('GET /trainer/exercise-templates', () => {
      it('returns exercise templates', async () => {
        const { accessToken } = await createTrainerWithToken();

        await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Squat', type: 'strength' },
        });

        const response = await app.inject({
          method: 'GET',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
        });

        expect(response.statusCode).toBe(200);
        const templates = response.json();
        expect(templates).toHaveLength(1);
        expect(templates[0]).toHaveProperty('name', 'Squat');
      });
    });
  });

  describe('Exercises', () => {
    describe('POST /trainer/trainings/:trainingId/exercises', () => {
      it('creates exercise in training', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Bench Press',
            type: 'strength',
            sets: 4,
            repetitions: { min: 8, max: 8 },
            hasLoad: true,
            suggestedLoad: 80,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('trainingId', trainingId);
        expect(body).toHaveProperty('name', 'Bench Press');
        expect(body).toHaveProperty('type', 'strength');
        expect(body).toHaveProperty('sets', 4);
        expect(body).toHaveProperty('repetitions', { min: 8, max: 8 });
      });

      it('returns 404 when training does not exist', async () => {
        const { accessToken } = await createTrainerWithToken();
        const fakeTrainingId = '00000000-0000-0000-0000-000000000000';

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${fakeTrainingId}/exercises`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Squat', type: 'strength' },
        });

        expect(response.statusCode).toBe(404);
      });

      it('includes restInterval in response when provided', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Deadlift',
            type: 'strength',
            sets: 3,
            restInterval: 90,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('restInterval', 90);
      });

      it('returns null for restInterval when not provided', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Pull Up',
            type: 'strength',
            sets: 3,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('restInterval', null);
      });
    });

    describe('POST /trainer/exercises/from-template', () => {
      it('creates exercise from template', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Template Squat',
            type: 'strength',
            sets: 5,
            repetitions: { min: 5, max: 5 },
          },
        });
        expect(templateResponse.statusCode).toBe(201);
        const { id: templateId } = templateResponse.json();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercises/from-template',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            trainingId,
            templateId,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('trainingId', trainingId);
        expect(body).toHaveProperty('exerciseTemplateId', templateId);
        expect(body).toHaveProperty('name', 'Template Squat');
        expect(body).toHaveProperty('sets', 5);
        expect(body).toHaveProperty('repetitions', { min: 5, max: 5 });
      });

      it('inherits restInterval from template when not overridden', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Rest Interval Template',
            type: 'strength',
            sets: 4,
            restInterval: 60,
          },
        });
        expect(templateResponse.statusCode).toBe(201);
        const { id: templateId } = templateResponse.json();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercises/from-template',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { trainingId, templateId },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('restInterval', 60);
      });
    });

    describe('GET /trainer/trainings/:trainingId/exercises', () => {
      it('returns exercises for training', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Squat', type: 'strength' },
        });

        const response = await app.inject({
          method: 'GET',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
        });

        expect(response.statusCode).toBe(200);
        const exercises = response.json();
        expect(exercises).toHaveLength(1);
        expect(exercises[0]).toHaveProperty('name', 'Squat');
      });
    });

    describe('GET /my/trainings/:trainingId/exercises', () => {
      it('returns exercises for assignee', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId, accessToken: assigneeToken } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Squat', type: 'strength' },
        });

        const response = await app.inject({
          method: 'GET',
          url: `/my/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${assigneeToken}` },
        });

        expect(response.statusCode).toBe(200);
        const exercises = response.json();
        expect(exercises).toHaveLength(1);
        expect(exercises[0]).toHaveProperty('name', 'Squat');
      });
    });

    describe('PATCH /trainer/exercises/:id', () => {
      it('updates restInterval on an existing exercise', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Romanian Deadlift',
            type: 'strength',
            sets: 3,
          },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();
        expect(createResponse.json()).toHaveProperty('restInterval', null);

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { restInterval: 120 },
        });

        expect(updateResponse.statusCode).toBe(200);
        const body = updateResponse.json();
        expect(body).toHaveProperty('restInterval', 120);
      });

      it('clears sets by sending null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Squat', type: 'strength', sets: 4 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { sets: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('sets', null);
      });

      it('clears duration by sending null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Plank', type: 'strength', duration: 60 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { duration: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('duration', null);
      });

      it('clears suggestedLoad by sending null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Bench Press', type: 'strength', hasLoad: true, suggestedLoad: 80 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { suggestedLoad: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('suggestedLoad', null);
      });

      it('clears restInterval by sending null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Pull Up', type: 'strength', restInterval: 90 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { restInterval: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('restInterval', null);
      });

      it('clears repetitions by sending null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Curl', type: 'strength', repetitions: { min: 8, max: 12 } },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { repetitions: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('repetitions', null);
      });

      it('clears only repetitions.min by sending null for min', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Lateral Raise', type: 'strength', repetitions: { min: 10, max: 15 } },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { repetitions: { min: null, max: 15 } },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('repetitions', { min: null, max: 15 });
      });
    });

    describe('PATCH /trainer/exercise-templates/:id — nullable fields', () => {
      it('clears sets on an exercise template by sending null', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Goblet Squat', type: 'strength', sets: 3 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { sets: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('sets', null);
      });

      it('clears suggestedLoad on an exercise template by sending null', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Overhead Press', type: 'strength', hasLoad: true, suggestedLoad: 40 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { suggestedLoad: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('suggestedLoad', null);
      });

      it('clears restInterval on an exercise template by sending null', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Dip', type: 'strength', restInterval: 60 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { restInterval: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('restInterval', null);
      });

      it('clears repetitions on an exercise template by sending null', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Tricep Extension', type: 'strength', repetitions: { min: 10, max: 12 } },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { repetitions: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('repetitions', null);
      });
    });
  });

  // ==================== prescriptionMode ====================

  describe('prescriptionMode — exercises', () => {
    describe('Create with prescriptionMode="duration"', () => {
      it('creates exercise with duration mode, sets duration, and nulls repetitions', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Prancha',
            type: 'strength',
            sets: 3,
            prescriptionMode: 'duration',
            duration: 45,
            restInterval: 60,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('prescriptionMode', 'duration');
        expect(body).toHaveProperty('duration', 45);
        expect(body).toHaveProperty('repetitions', null);
      });
    });

    describe('Create with prescriptionMode="reps"', () => {
      it('creates exercise with reps mode, sets repetitions, and nulls duration', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Supino',
            type: 'strength',
            sets: 4,
            prescriptionMode: 'reps',
            repetitions: { min: 8, max: 12 },
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('prescriptionMode', 'reps');
        expect(body).toHaveProperty('repetitions', { min: 8, max: 12 });
        expect(body).toHaveProperty('duration', null);
      });
    });

    describe('Update: flip reps → duration', () => {
      it('updates exercise from reps to duration, sets duration, and nulls repetitions', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Agachamento',
            type: 'strength',
            sets: 4,
            prescriptionMode: 'reps',
            repetitions: { min: 10, max: 12 },
          },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { prescriptionMode: 'duration', duration: 30 },
        });

        expect(updateResponse.statusCode).toBe(200);
        const body = updateResponse.json();
        expect(body).toHaveProperty('prescriptionMode', 'duration');
        expect(body).toHaveProperty('duration', 30);
        expect(body).toHaveProperty('repetitions', null);
      });
    });

    describe('Update: flip duration → reps', () => {
      it('updates exercise from duration to reps, sets repetitions, and nulls duration', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Prancha',
            type: 'strength',
            sets: 3,
            prescriptionMode: 'duration',
            duration: 45,
          },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            prescriptionMode: 'reps',
            repetitions: { min: 8, max: 12 },
          },
        });

        expect(updateResponse.statusCode).toBe(200);
        const body = updateResponse.json();
        expect(body).toHaveProperty('prescriptionMode', 'reps');
        expect(body).toHaveProperty('repetitions', { min: 8, max: 12 });
        expect(body).toHaveProperty('duration', null);
      });
    });

    describe('M1: Update with mode="reps" but no repetitions provided', () => {
      it('returns 400 VALIDATION_ERROR when flipping to reps mode without supplying repetitions', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Prancha',
            type: 'strength',
            sets: 3,
            prescriptionMode: 'duration',
            duration: 45,
          },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { prescriptionMode: 'reps' },
        });

        expect(updateResponse.statusCode).toBe(400);
        const body = updateResponse.json();
        expect(body).toHaveProperty('error', 'VALIDATION_ERROR');
        expect(body).toHaveProperty('messageCode', 'validation.failed');
      });
    });
  });

  describe('prescriptionMode — import training from template (C1 regression)', () => {
    it('preserves prescriptionMode="duration" when importing training template into a protocol', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();

      // Create an exercise template with duration mode
      const exerciseTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Prancha Isométrica',
          type: 'strength',
          sets: 3,
          prescriptionMode: 'duration',
          duration: 30,
          restInterval: 60,
        },
      });
      expect(exerciseTemplateResponse.statusCode).toBe(201);
      const { id: exerciseTemplateId } = exerciseTemplateResponse.json();

      // Create a training template referencing the exercise template
      const trainingTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Core Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId }],
        },
      });
      expect(trainingTemplateResponse.statusCode).toBe(201);
      const { id: trainingTemplateId } = trainingTemplateResponse.json();

      // Create a protocol
      const protocolResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId, name: 'My Protocol', startDate: '2025-01-01' },
      });
      expect(protocolResponse.statusCode).toBe(201);
      const { id: protocolId } = protocolResponse.json();

      // Import the training template into the protocol
      const importResponse = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { protocolId, templateId: trainingTemplateId },
      });

      expect(importResponse.statusCode).toBe(201);
      const importBody = importResponse.json();
      expect(importBody).toHaveProperty('exercises');
      expect(importBody.exercises).toHaveLength(1);

      const exercise = importBody.exercises[0];
      expect(exercise).toHaveProperty('prescriptionMode', 'duration');
      expect(exercise).toHaveProperty('duration', 30);
      expect(exercise).toHaveProperty('repetitions', null);
    });

    it('preserves prescriptionMode="reps" when importing training template into a protocol', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();

      const exerciseTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Supino',
          type: 'strength',
          sets: 4,
          prescriptionMode: 'reps',
          repetitions: { min: 8, max: 12 },
          restInterval: 90,
        },
      });
      expect(exerciseTemplateResponse.statusCode).toBe(201);
      const { id: exerciseTemplateId } = exerciseTemplateResponse.json();

      const trainingTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Chest Day',
          category: 'strength',
          exerciseTemplates: [{ exerciseTemplateId }],
        },
      });
      expect(trainingTemplateResponse.statusCode).toBe(201);
      const { id: trainingTemplateId } = trainingTemplateResponse.json();

      const protocolResponse = await app.inject({
        method: 'POST',
        url: '/trainer/protocols',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { assigneeId, name: 'My Protocol', startDate: '2025-01-01' },
      });
      expect(protocolResponse.statusCode).toBe(201);
      const { id: protocolId } = protocolResponse.json();

      const importResponse = await app.inject({
        method: 'POST',
        url: '/trainer/trainings/from-template',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { protocolId, templateId: trainingTemplateId },
      });

      expect(importResponse.statusCode).toBe(201);
      const importBody = importResponse.json();
      expect(importBody.exercises).toHaveLength(1);

      const exercise = importBody.exercises[0];
      expect(exercise).toHaveProperty('prescriptionMode', 'reps');
      expect(exercise).toHaveProperty('repetitions', { min: 8, max: 12 });
      expect(exercise).toHaveProperty('duration', null);
    });
  });

  // ==================== i18n labels ====================

  describe('i18n labels — exercise templates and exercises', () => {
    it('GET /trainer/exercise-templates returns typeLabel in pt-BR', async () => {
      const { accessToken } = await createTrainerWithToken();

      await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Rosca Direta', type: 'strength' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const [template] = response.json();
      expect(template.type).toBe('strength');
      expect(template.typeLabel).toBe('Força');
    });

    it('GET /trainer/exercise-templates returns typeLabel in en-US', async () => {
      const { accessToken } = await createTrainerWithToken();

      await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'Curl', type: 'strength' },
      });

      const response = await app.inject({
        method: 'GET',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${accessToken}`, 'app-language': 'en-US' },
      });

      expect(response.statusCode).toBe(200);
      const [template] = response.json();
      expect(template.type).toBe('strength');
      expect(template.typeLabel).toBe('Strength');
    });

    it('GET /trainer/trainings/:trainingId/exercises returns typeLabel in pt-BR', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

      await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Flexão', type: 'strength' },
      });

      const response = await app.inject({
        method: 'GET',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}`, 'app-language': 'pt-BR' },
      });

      expect(response.statusCode).toBe(200);
      const [exercise] = response.json();
      expect(exercise.type).toBe('strength');
      expect(exercise.typeLabel).toBe('Força');
    });
  });

  // ─── Substitute Exercises ──────────────────────────────────────────────────

  describe('Substitute Exercises', () => {
    async function setupTrainingWithExercise() {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

      const exResponse = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength', sets: 4 },
      });
      expect(exResponse.statusCode).toBe(201);
      const principalId = exResponse.json().id;

      return { trainerToken, trainingId, principalId };
    }

    describe('POST /trainer/exercises/:id/substitutes', () => {
      it('creates a substitute exercise under a principal', async () => {
        const { trainerToken, principalId } = await setupTrainingWithExercise();

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Dumbbell Press', type: 'strength', sets: 4 },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('substituteForExerciseId', principalId);
        expect(body).toHaveProperty('substituteOrder', 0);
      });

      it('assigns incrementing substituteOrder for multiple substitutes', async () => {
        const { trainerToken, principalId } = await setupTrainingWithExercise();

        const r1 = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub A', type: 'strength' },
        });
        const r2 = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub B', type: 'strength' },
        });

        expect(r1.json().substituteOrder).toBe(0);
        expect(r2.json().substituteOrder).toBe(1);
      });

      it('returns 404 when principal exercise does not exist', async () => {
        const { trainerToken } = await setupTrainingWithExercise();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercises/00000000-0000-0000-0000-000000000000/substitutes',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub', type: 'strength' },
        });

        expect(response.statusCode).toBe(404);
      });

      it('rejects when principal is itself a substitute (no chaining)', async () => {
        const { trainerToken, principalId } = await setupTrainingWithExercise();

        const subResponse = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub A', type: 'strength' },
        });
        const subId = subResponse.json().id;

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${subId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub B', type: 'strength' },
        });

        expect(response.statusCode).toBe(400);
        expect(response.json().messageCode).toBe('exercise.substituteCannotChain');
      });

      it('allows adding a substitute to a principal that is itself a superset member (per plan edge case #4)', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const groupId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
        const ex1 = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Bench Press', type: 'strength', order: 0, supersetGroupId: groupId, supersetOrder: 0 },
        });
        expect(ex1.statusCode).toBe(201);
        const ex2 = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Cable Fly', type: 'strength', order: 1, supersetGroupId: groupId, supersetOrder: 1 },
        });
        expect(ex2.statusCode).toBe(201);

        const supersetMemberId = ex1.json().id;

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${supersetMemberId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub for superset member', type: 'strength' },
        });

        expect(response.statusCode).toBe(201);
        expect(response.json().substituteForExerciseId).toBe(supersetMemberId);
        expect(response.json().supersetGroupId).toBeNull();
      });

      it('returns substitutes[] nested under principal in GET exercises', async () => {
        const { trainerToken, trainingId, principalId } = await setupTrainingWithExercise();

        await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Dumbbell Press', type: 'strength' },
        });

        const listResponse = await app.inject({
          method: 'GET',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
        });

        expect(listResponse.statusCode).toBe(200);
        const exercises = listResponse.json();
        // Only principals appear at top level
        expect(exercises).toHaveLength(1);
        expect(exercises[0].substitutes).toHaveLength(1);
        expect(exercises[0].substitutes[0].name).toBe('Dumbbell Press');
      });
    });

    describe('PATCH /trainer/exercises/:id/substitutes/order', () => {
      it('reorders substitutes', async () => {
        const { trainerToken, principalId } = await setupTrainingWithExercise();

        const sub1 = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub A', type: 'strength' },
        });
        const sub2 = await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub B', type: 'strength' },
        });

        const idA = sub1.json().id;
        const idB = sub2.json().id;

        const reorderResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${principalId}/substitutes/order`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { substituteIds: [idB, idA] },
        });

        expect(reorderResponse.statusCode).toBe(200);
        const updated = reorderResponse.json();
        expect(updated[0].id).toBe(idB);
        expect(updated[0].substituteOrder).toBe(0);
        expect(updated[1].id).toBe(idA);
        expect(updated[1].substituteOrder).toBe(1);
      });

      it('returns 400 when substituteIds list length mismatches', async () => {
        const { trainerToken, principalId } = await setupTrainingWithExercise();

        await app.inject({
          method: 'POST',
          url: `/trainer/exercises/${principalId}/substitutes`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Sub A', type: 'strength' },
        });

        const response = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${principalId}/substitutes/order`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { substituteIds: ['00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000002'] },
        });

        expect(response.statusCode).toBe(400);
      });
    });
  });

  // ─── Superset / Bi-set ────────────────────────────────────────────────────

  describe('Superset (bi-set)', () => {
    async function setupTrainingWithTwoExercises() {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();
      const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

      const ex1 = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Bench Press', type: 'strength' },
      });
      const ex2 = await app.inject({
        method: 'POST',
        url: `/trainer/trainings/${trainingId}/exercises`,
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Cable Fly', type: 'strength' },
      });

      return {
        trainerToken,
        trainingId,
        exerciseId1: ex1.json().id,
        exerciseId2: ex2.json().id,
      };
    }

    describe('PATCH /trainer/trainings/:trainingId/supersets/:groupId/order', () => {
      it('reorders exercises within an existing superset group', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        // Create both exercises with the same supersetGroupId at creation time
        const groupId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
        const ex1 = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Bench Press', type: 'strength', order: 0, supersetGroupId: groupId, supersetOrder: 0 },
        });
        expect(ex1.statusCode).toBe(201);
        const exerciseId1 = ex1.json().id;

        const ex2 = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Cable Fly', type: 'strength', order: 1, supersetGroupId: groupId, supersetOrder: 1 },
        });
        expect(ex2.statusCode).toBe(201);
        const exerciseId2 = ex2.json().id;

        const reorderResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/trainings/${trainingId}/supersets/${groupId}/order`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { exerciseIds: [exerciseId2, exerciseId1] },
        });

        expect(reorderResponse.statusCode).toBe(200);
        const updated = reorderResponse.json();
        expect(updated[0].id).toBe(exerciseId2);
        expect(updated[0].supersetOrder).toBe(0);
        expect(updated[1].id).toBe(exerciseId1);
        expect(updated[1].supersetOrder).toBe(1);
      });

      it('returns 404 when superset group does not exist', async () => {
        const { trainerToken, trainingId } = await setupTrainingWithTwoExercises();
        const fakeGroupId = '00000000-0000-0000-0000-000000000000';

        const response = await app.inject({
          method: 'PATCH',
          url: `/trainer/trainings/${trainingId}/supersets/${fakeGroupId}/order`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            exerciseIds: [
              '00000000-0000-0000-0000-000000000001',
              '00000000-0000-0000-0000-000000000002',
            ],
          },
        });

        expect(response.statusCode).toBe(404);
      });
    });
  });
});
