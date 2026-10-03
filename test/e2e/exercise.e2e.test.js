import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { prisma } from '../../src/db.js';
import { signupVerified } from '../helpers/signup-user.js';

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

    const signupResponse = await signupVerified(app, {
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

    const signupResponse = await signupVerified(app, {
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

  // Platform plan guard (assertStudentActiveOnPlan) requires an active
  // TrainerStudent link before protocol creation. Resolve trainer.id via /me
  // and upsert the link.
  async function activatePlanLink(trainerToken, assigneeId) {
    const meRes = await app.inject({
      method: 'GET',
      url: '/me',
      headers: { authorization: `Bearer ${trainerToken}` },
    });
    expect(meRes.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({
      where: { userId: meRes.json().id },
      select: { id: true },
    });
    await prisma.trainerStudent.upsert({
      where: { trainerId_studentId: { trainerId: trainer.id, studentId: assigneeId } },
      create: { trainerId: trainer.id, studentId: assigneeId, activeOnPlan: true },
      update: { activeOnPlan: true },
    });
  }

  async function createProtocolAndTraining(trainerToken, assigneeId) {
    await activatePlanLink(trainerToken, assigneeId);

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
      it('creates exercise template with identity fields only', async () => {
        const { accessToken } = await createTrainerWithToken();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: {
            name: 'Barbell Squat',
            type: 'strength',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('id');
        expect(body).toHaveProperty('name', 'Barbell Squat');
        expect(body).toHaveProperty('type', 'strength');
        // Library template response must NOT contain prescription fields
        expect(body).not.toHaveProperty('sets');
        expect(body).not.toHaveProperty('repetitions');
        expect(body).not.toHaveProperty('hasLoad');
        expect(body).not.toHaveProperty('suggestedLoad');
        expect(body).not.toHaveProperty('prescriptionMode');
        expect(body).not.toHaveProperty('intensity');
      });

      it('strips prescription fields silently and creates identity-only template when prescription fields are sent', async () => {
        const { accessToken } = await createTrainerWithToken();

        // Fastify strips additionalProperties silently (removeAdditional: true default).
        // Prescription fields sent to POST exercise-templates are ignored, not rejected.
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
        expect(body).toHaveProperty('name', 'Barbell Squat');
        expect(body).toHaveProperty('type', 'strength');
        // Prescription fields must not appear on the response (identity-only template)
        expect(body).not.toHaveProperty('sets');
        expect(body).not.toHaveProperty('repetitions');
        expect(body).not.toHaveProperty('hasLoad');
        expect(body).not.toHaveProperty('suggestedLoad');
      });

      it('strips prescriptionMode/intensity silently when sent to POST /trainer/exercise-templates', async () => {
        const { accessToken } = await createTrainerWithToken();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: {
            name: 'Running',
            type: 'cardio',
            prescriptionMode: 'duration',
            intensity: 'moderate',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('name', 'Running');
        expect(body).toHaveProperty('type', 'cardio');
        // Prescription fields must not appear on the response
        expect(body).not.toHaveProperty('prescriptionMode');
        expect(body).not.toHaveProperty('intensity');
      });

      it('creates template with videoUrl and isPublic', async () => {
        const { accessToken } = await createTrainerWithToken();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: {
            name: 'Pull-Up',
            type: 'strength',
            videoUrl: 'https://example.com/pullup.mp4',
            isPublic: false,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('name', 'Pull-Up');
        expect(body).toHaveProperty('videoUrl', 'https://example.com/pullup.mp4');
        expect(body).toHaveProperty('isPublic', false);
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
        const { data: templates } = response.json();
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

      it('returns 201 with intensity and intensityLabel (pt-BR) for cardio exercise', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Running',
            type: 'cardio',
            prescriptionMode: 'duration',
            duration: 30,
            intensity: 'moderate',
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('intensity', 'moderate');
        expect(body).toHaveProperty('intensityLabel', 'Moderada');
      });

      it('returns 400 when intensity set on a non-cardio exercise', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const response = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Squat',
            type: 'strength',
            intensity: 'moderate',
          },
        });

        expect(response.statusCode).toBe(400);
        const body = response.json();
        expect(body).toHaveProperty('messageCode', 'exercise.intensityRequiresCardio');
      });
    });

    describe('POST /trainer/exercises/from-template', () => {
      it('creates exercise from template — inherits identity from library, prescription defaults to null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        // Library template carries only identity
        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: {
            name: 'Template Squat',
            type: 'strength',
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
        // Library template carries no prescription — defaults to null/REPS
        expect(body).toHaveProperty('sets', null);
        expect(body).toHaveProperty('repetitions', null);
        expect(body).toHaveProperty('prescriptionMode', 'reps');
      });

      it('caller-supplied prescription is applied when importing from template', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Template Squat', type: 'strength' },
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
            sets: 5,
            prescriptionMode: 'reps',
            repetitions: { min: 5, max: 5 },
            restInterval: 60,
          },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('sets', 5);
        expect(body).toHaveProperty('repetitions', { min: 5, max: 5 });
        expect(body).toHaveProperty('restInterval', 60);
        expect(body).toHaveProperty('prescriptionMode', 'reps');
      });

      it('does NOT inherit prescription from library template — prescription defaults to null when not in request', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Cardio Exercise', type: 'cardio' },
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
        // No prescription in library template or request → null defaults
        expect(body).toHaveProperty('intensity', null);
        expect(body).toHaveProperty('sets', null);
        expect(body).toHaveProperty('restInterval', null);
      });

      it('applies caller-supplied intensity when importing a cardio template', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Treadmill Run', type: 'cardio' },
        });
        expect(templateResponse.statusCode).toBe(201);
        const { id: templateId } = templateResponse.json();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercises/from-template',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { trainingId, templateId, intensity: 'moderate', prescriptionMode: 'duration', duration: 30 },
        });

        expect(response.statusCode).toBe(201);
        const body = response.json();
        expect(body).toHaveProperty('intensity', 'moderate');
        expect(body).toHaveProperty('intensityLabel', 'Moderada');
      });

      it('returns intensityLabel in en-US when app-language header is en-US', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const templateResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Cycling', type: 'cardio' },
        });
        expect(templateResponse.statusCode).toBe(201);
        const { id: templateId } = templateResponse.json();

        const response = await app.inject({
          method: 'POST',
          url: '/trainer/exercises/from-template',
          headers: { authorization: `Bearer ${trainerToken}`, 'app-language': 'en-US' },
          payload: { trainingId, templateId, intensity: 'moderate', prescriptionMode: 'duration', duration: 30 },
        });

        expect(response.statusCode).toBe(201);
        expect(response.json()).toHaveProperty('intensityLabel', 'Moderate');
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

      it('sets intensity on a cardio exercise and returns intensityLabel', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Cycling', type: 'cardio', prescriptionMode: 'duration', duration: 30 },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { intensity: 'vigorous' },
        });

        expect(updateResponse.statusCode).toBe(200);
        const body = updateResponse.json();
        expect(body).toHaveProperty('intensity', 'vigorous');
        expect(body).toHaveProperty('intensityLabel', 'Vigorosa');
      });

      it('clears intensity by sending null', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Running', type: 'cardio', prescriptionMode: 'duration', duration: 20, intensity: 'moderate' },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { intensity: null },
        });

        expect(updateResponse.statusCode).toBe(200);
        const body = updateResponse.json();
        expect(body).toHaveProperty('intensity', null);
        expect(body).toHaveProperty('intensityLabel', null);
      });

      it('returns 400 when changing exercise type to strength while intensity is set', async () => {
        const { accessToken: trainerToken } = await createTrainerWithToken();
        const { userId: assigneeId } = await createAssigneeWithToken();
        const { trainingId } = await createProtocolAndTraining(trainerToken, assigneeId);

        const createResponse = await app.inject({
          method: 'POST',
          url: `/trainer/trainings/${trainingId}/exercises`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { name: 'Jump Rope', type: 'cardio', prescriptionMode: 'duration', duration: 10, intensity: 'light' },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: exerciseId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercises/${exerciseId}`,
          headers: { authorization: `Bearer ${trainerToken}` },
          payload: { type: 'strength' },
        });

        expect(updateResponse.statusCode).toBe(400);
        expect(updateResponse.json()).toHaveProperty('messageCode', 'exercise.intensityRequiresCardio');
      });
    });

    describe('PATCH /trainer/exercise-templates/:id — identity fields', () => {
      it('updates name on an exercise template', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Goblet Squat', type: 'strength' },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Goblet Squat Updated' },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('name', 'Goblet Squat Updated');
      });

      it('updates videoUrl on an exercise template', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Overhead Press', type: 'strength' },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { videoUrl: 'https://example.com/overhead.mp4' },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('videoUrl', 'https://example.com/overhead.mp4');
      });

      it('strips prescription fields silently on PATCH /trainer/exercise-templates/:id — response contains no prescription', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Dip', type: 'strength' },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        // Fastify strips additionalProperties silently — prescription fields are ignored, not rejected
        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { restInterval: 60, sets: 3, name: 'Dip Updated' },
        });

        expect(updateResponse.statusCode).toBe(200);
        const body = updateResponse.json();
        // Name change is applied (valid identity field)
        expect(body).toHaveProperty('name', 'Dip Updated');
        // Prescription fields must not appear on the response
        expect(body).not.toHaveProperty('restInterval');
        expect(body).not.toHaveProperty('sets');
      });

      it('updates isPublic flag on an exercise template', async () => {
        const { accessToken } = await createTrainerWithToken();

        const createResponse = await app.inject({
          method: 'POST',
          url: '/trainer/exercise-templates',
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { name: 'Tricep Extension', type: 'strength' },
        });
        expect(createResponse.statusCode).toBe(201);
        const { id: templateId } = createResponse.json();

        const updateResponse = await app.inject({
          method: 'PATCH',
          url: `/trainer/exercise-templates/${templateId}`,
          headers: { authorization: `Bearer ${accessToken}` },
          payload: { isPublic: true },
        });

        expect(updateResponse.statusCode).toBe(200);
        expect(updateResponse.json()).toHaveProperty('isPublic', true);
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
    it('training template junction prescription is preserved when importing into a protocol (duration mode)', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();

      // Library template carries only identity
      const exerciseTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Prancha Isométrica', type: 'strength' },
      });
      expect(exerciseTemplateResponse.statusCode).toBe(201);
      const { id: exerciseTemplateId } = exerciseTemplateResponse.json();

      // Training template specifies prescription on the junction row
      const trainingTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Core Day',
          category: 'strength',
          exerciseTemplates: [{
            exerciseTemplateId,
            prescriptionMode: 'duration',
            duration: 30,
            sets: 3,
            restInterval: 60,
          }],
        },
      });
      expect(trainingTemplateResponse.statusCode).toBe(201);
      const { id: trainingTemplateId } = trainingTemplateResponse.json();

      // Create a protocol and import
      await activatePlanLink(trainerToken, assigneeId);
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
      expect(importBody).toHaveProperty('exercises');
      expect(importBody.exercises).toHaveLength(1);

      const exercise = importBody.exercises[0];
      expect(exercise).toHaveProperty('prescriptionMode', 'duration');
      expect(exercise).toHaveProperty('duration', 30);
      expect(exercise).toHaveProperty('repetitions', null);
    });

    it('training template junction prescription is preserved when importing into a protocol (reps mode)', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: assigneeId } = await createAssigneeWithToken();

      // Library template identity only
      const exerciseTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/exercise-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { name: 'Supino', type: 'strength' },
      });
      expect(exerciseTemplateResponse.statusCode).toBe(201);
      const { id: exerciseTemplateId } = exerciseTemplateResponse.json();

      // Training template junction has prescription
      const trainingTemplateResponse = await app.inject({
        method: 'POST',
        url: '/trainer/training-templates',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {
          name: 'Chest Day',
          category: 'strength',
          exerciseTemplates: [{
            exerciseTemplateId,
            prescriptionMode: 'reps',
            sets: 4,
            repetitions: { min: 8, max: 12 },
            restInterval: 90,
          }],
        },
      });
      expect(trainingTemplateResponse.statusCode).toBe(201);
      const { id: trainingTemplateId } = trainingTemplateResponse.json();

      await activatePlanLink(trainerToken, assigneeId);
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
      const { data: [template] } = response.json();
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
      const { data: [template] } = response.json();
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
