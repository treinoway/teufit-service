import { expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { signupVerified } from './signup-user.js';

const PASSWORD = 'StrongPassw0rd!';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

let counter = 0;

// Returns a unique e2e email for the given role prefix.
function uniqueEmail(prefix) {
  counter += 1;
  return `e2e+${prefix}-${Date.now()}-${counter}@example.com`;
}

// Returns the lowercase UTC weekday name for today.
export function todayWeekday() {
  return WEEKDAYS[new Date().getUTCDay()];
}

// Builds the bi-set e2e toolbox bound to a Fastify app instance.
export function createBisetHarness(app) {
  async function signup(prefix) {
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: uniqueEmail(prefix), password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const { user, token } = response.json();
    return { userId: user.id, email: user.email, accessToken: token.accessToken };
  }

  async function createTrainer() {
    const { userId, email, accessToken } = await signup('trainer');
    const response = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const trainerRecord = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    return { userId, email, trainerId: trainerRecord.id, accessToken: response.json().token.accessToken };
  }

  async function createStudent() {
    return signup('student');
  }

  async function linkStudent(trainerId, studentId) {
    await prisma.trainerStudent.upsert({
      where: { trainerId_studentId: { trainerId, studentId } },
      create: { trainerId, studentId, activeOnPlan: true },
      update: { activeOnPlan: true },
    });
  }

  async function createTraining(trainerToken, protocolId, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocolId}/trainings`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'Chest Day', category: 'strength', ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json().id;
  }

  // why: one call yields trainer, linked student, protocol and one empty training.
  async function setupTraining(trainingOverrides = {}) {
    const trainer = await createTrainer();
    const student = await createStudent();
    await linkStudent(trainer.trainerId, student.userId);
    const protocolResponse = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainer.accessToken}` },
      payload: { assigneeId: student.userId, name: 'Protocol', startDate: '2026-01-01' },
    });
    expect(protocolResponse.statusCode).toBe(201);
    const protocolId = protocolResponse.json().id;
    const trainingId = await createTraining(trainer.accessToken, protocolId, trainingOverrides);
    return { trainer, student, protocolId, trainingId };
  }

  async function createExercise(trainerToken, trainingId, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/exercises`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'Exercise', type: 'strength', sets: 3, ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  async function createSubstitute(trainerToken, principalId, overrides = {}) {
    const response = await app.inject({
      method: 'POST',
      url: `/trainer/exercises/${principalId}/substitutes`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { name: 'Substitute', type: 'strength', sets: 3, ...overrides },
    });
    expect(response.statusCode).toBe(201);
    return response.json();
  }

  function postSuperset(trainerToken, trainingId, payload) {
    return app.inject({
      method: 'POST',
      url: `/trainer/trainings/${trainingId}/supersets`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload,
    });
  }

  function patchSupersetRest(trainerToken, trainingId, groupId, payload) {
    return app.inject({
      method: 'PATCH',
      url: `/trainer/trainings/${trainingId}/supersets/${groupId}`,
      headers: { authorization: `Bearer ${trainerToken}` },
      payload,
    });
  }

  function deleteSuperset(trainerToken, trainingId, groupId) {
    return app.inject({
      method: 'DELETE',
      url: `/trainer/trainings/${trainingId}/supersets/${groupId}`,
      headers: { authorization: `Bearer ${trainerToken}` },
    });
  }

  // why: creates the member exercises (one per memberRests entry) and groups them in array order.
  async function createGroup(trainerToken, trainingId, { restInterval, memberRests = [60, 45] } = {}) {
    const exercises = [];
    for (const [index, rest] of memberRests.entries()) {
      exercises.push(await createExercise(trainerToken, trainingId, { name: `Member ${index}`, restInterval: rest }));
    }
    const payload = { exerciseIds: exercises.map((e) => e.id) };
    if (restInterval !== undefined) payload.restInterval = restInterval;
    const response = await postSuperset(trainerToken, trainingId, payload);
    expect(response.statusCode).toBe(201);
    return { groupId: response.json().supersetGroupId, exercises, response: response.json() };
  }

  async function dbRestIntervals(ids) {
    const rows = await prisma.exercise.findMany({
      where: { id: { in: ids } },
      select: { id: true, supersetRestInterval: true },
    });
    return Object.fromEntries(rows.map((r) => [r.id, r.supersetRestInterval]));
  }

  function startSession(studentToken, trainingId) {
    return app.inject({
      method: 'POST',
      url: `/my/trainings/${trainingId}/workout-sessions`,
      headers: { authorization: `Bearer ${studentToken}` },
      payload: {},
    });
  }

  return {
    createTrainer,
    createStudent,
    linkStudent,
    createTraining,
    setupTraining,
    createExercise,
    createSubstitute,
    postSuperset,
    patchSupersetRest,
    deleteSuperset,
    createGroup,
    dbRestIntervals,
    startSession,
  };
}
