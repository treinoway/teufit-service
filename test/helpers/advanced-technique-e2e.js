import { expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { signupVerified } from './signup-user.js';
import { provisionTrainerPlan } from './platform-plan.js';

const PASSWORD = 'StrongPassw0rd!';
let emailCounter = 0;

/** Unique e2e email so several users can be created inside one millisecond. */
function uniqueEmail(prefix) {
  emailCounter += 1;
  return `e2e+${prefix}-${Date.now()}-${emailCounter}@example.com`;
}

/** Bearer header for a token. */
export const bearer = (token) => ({ authorization: `Bearer ${token}` });

/**
 * Builds the user/trainer/technique fixture helpers shared by the advanced-technique e2e suites.
 * @param {import('fastify').FastifyInstance} app
 */
export function createAdvancedTechniqueFixtures(app) {
  async function createTrainer() {
    const signup = await signupVerified(app, {
      payload: { email: uniqueEmail('trainer'), password: PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signup.json();

    const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: bearer(accessToken) });
    expect(become.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);

    return { userId, trainerId: trainer.id, accessToken: become.json().token.accessToken };
  }

  async function createStudent() {
    const signup = await signupVerified(app, {
      payload: { email: uniqueEmail('student'), password: PASSWORD },
    });
    expect(signup.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signup.json();
    return { userId, accessToken };
  }

  async function linkStudent(trainerId, studentId) {
    await prisma.trainerStudent.upsert({
      where: { trainerId_studentId: { trainerId, studentId } },
      create: { trainerId, studentId, activeOnPlan: true },
      update: { activeOnPlan: true },
    });
  }

  async function createProtocolAndTraining(trainer, studentId) {
    await linkStudent(trainer.trainerId, studentId);
    const protocol = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: bearer(trainer.accessToken),
      payload: { assigneeId: studentId, name: 'Protocol', startDate: '2026-01-01' },
    });
    expect(protocol.statusCode).toBe(201);
    const { id: protocolId } = protocol.json();

    const training = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocolId}/trainings`,
      headers: bearer(trainer.accessToken),
      payload: { name: 'Chest Day', category: 'strength' },
    });
    expect(training.statusCode).toBe(201);
    return { protocolId, trainingId: training.json().id };
  }

  async function createTechnique(accessToken, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/advanced-techniques',
      headers: bearer(accessToken),
      payload: { name: 'Myo-reps', description: 'Activation set followed by mini-sets', ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function deleteTechnique(accessToken, id) {
    const response = await app.inject({
      method: 'DELETE',
      url: `/trainer/advanced-techniques/${id}`,
      headers: bearer(accessToken),
    });
    expect(response.statusCode).toBe(200);
  }

  async function systemTechniqueByKey(key) {
    return prisma.advancedTechnique.findUnique({ where: { key } });
  }

  async function createExerciseTemplate(accessToken, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/exercise-templates',
      headers: bearer(accessToken),
      payload: { name: 'Leg Press', type: 'strength', ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createExercise(accessToken, trainingId, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/exercises`,
      headers: bearer(accessToken),
      payload: { name: 'Bench Press', type: 'strength', sets: 3, ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createTrainingTemplate(accessToken, payload = {}) {
    const response = await app.inject({
      method: 'POST',
      url: '/trainer/training-templates',
      headers: bearer(accessToken),
      payload: { name: 'Leg Day', category: 'strength', ...payload },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  return {
    createTrainer,
    createStudent,
    linkStudent,
    createProtocolAndTraining,
    createTechnique,
    deleteTechnique,
    systemTechniqueByKey,
    createExerciseTemplate,
    createExercise,
    createTrainingTemplate,
  };
}

/** Ids of an `advancedTechniques` response array, in returned order. */
export const techniqueIds = (list) => list.map((item) => item.id);
