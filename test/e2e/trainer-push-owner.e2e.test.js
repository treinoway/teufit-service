import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { prisma } from '../../src/db.js';
import { WorkoutSessionStatus } from '../../src/constants/training.js';
import { AnamnesisQuestionType } from '../../src/constants/anamnesis.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_ANDROID = 'android';
const FCM_SETTLE_MS = 300;

e2eDescribe('e2e: trainer push targeting', () => {
  let app;
  let fcmClient;
  let emailCounter = 0;

  beforeAll(async () => {
    fcmClient = { sendToToken: vi.fn() };
    app = await setupApp({ logger: false, fcmClient });
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    await cleanDatabase();
    fcmClient.sendToToken.mockReset();
    fcmClient.sendToToken.mockResolvedValue({ messageId: 'm-1' });
  });

  async function signup(label) {
    emailCounter += 1;
    const response = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email: `e2e+${label}-${Date.now()}-${emailCounter}@example.com`, password: PASSWORD },
    });
    expect(response.statusCode).toBe(201);
    const body = response.json();
    return { userId: body.user.id, accessToken: body.token.accessToken };
  }

  async function createTrainerWithDevice(deviceToken) {
    const { userId, accessToken } = await signup('trainer');
    const become = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(become.statusCode).toBe(200);
    const trainerAccessToken = become.json().token.accessToken;
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    const device = await app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: { authorization: `Bearer ${trainerAccessToken}` },
      payload: { token: deviceToken, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });
    expect(device.statusCode).toBe(200);
    return { userId, trainerId: trainer.id, accessToken: trainerAccessToken };
  }

  function linkStudent(trainer, student, activeOnPlan = true) {
    return prisma.trainerStudent.create({
      data: { trainerId: trainer.trainerId, studentId: student.userId, activeOnPlan },
    });
  }

  async function createAnamnesis({ trainerId, isGeneral }) {
    return prisma.anamnesis.create({
      data: {
        title: 'Owner anamnesis',
        trainerId,
        isGeneral,
        sections: {
          create: [
            {
              title: 'Section',
              order: 0,
              questions: {
                create: [{ text: 'Notes', type: AnamnesisQuestionType.FREE_TEXT, required: false, order: 0 }],
              },
            },
          ],
        },
      },
      include: { sections: { include: { questions: true } } },
    });
  }

  function assignAnamnesis(anamnesis, student, trainer) {
    return prisma.studentAnamnesis.create({
      data: { anamnesisId: anamnesis.id, studentId: student.userId, trainerId: trainer.trainerId },
    });
  }

  function submitAnamnesis(anamnesis, student) {
    return app.inject({
      method: 'POST',
      url: `/my/anamneses/${anamnesis.id}/response`,
      headers: { authorization: `Bearer ${student.accessToken}` },
      payload: { answers: [{ questionId: anamnesis.sections[0].questions[0].id, value: 'ok' }] },
    });
  }

  async function startWorkout(trainer, student) {
    const protocol = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainer.accessToken}` },
      payload: { assigneeId: student.userId, name: 'Owner Protocol', startDate: '2026-01-01' },
    });
    expect(protocol.statusCode).toBe(201);
    const training = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocol.json().id}/trainings`,
      headers: { authorization: `Bearer ${trainer.accessToken}` },
      payload: { name: 'Owner Day', category: 'strength' },
    });
    expect(training.statusCode).toBe(201);
    const session = await app.inject({
      method: 'POST',
      url: `/my/trainings/${training.json().id}/workout-sessions`,
      headers: { authorization: `Bearer ${student.accessToken}` },
      payload: {},
    });
    expect(session.statusCode).toBe(201);
    return session.json().id;
  }

  function completeWorkout(student, sessionId) {
    return app.inject({
      method: 'PATCH',
      url: `/my/workout-sessions/${sessionId}`,
      headers: { authorization: `Bearer ${student.accessToken}` },
      payload: { status: WorkoutSessionStatus.COMPLETED },
    });
  }

  function settle() {
    return new Promise((resolve) => setTimeout(resolve, FCM_SETTLE_MS));
  }

  function sentTokens() {
    return fcmClient.sendToToken.mock.calls.map(([message]) => message.token);
  }

  describe('anamnesis submitted', () => {
    it('should push only the trainer that assigned the anamnesis', async () => {
      const trainerA = await createTrainerWithDevice('device-trainer-a');
      const trainerB = await createTrainerWithDevice('device-trainer-b');
      const student = await signup('student');
      await linkStudent(trainerA, student);
      await linkStudent(trainerB, student);
      const anamnesis = await createAnamnesis({ trainerId: trainerA.trainerId, isGeneral: false });
      await assignAnamnesis(anamnesis, student, trainerA);

      const response = await submitAnamnesis(anamnesis, student);

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(fcmClient.sendToToken).toHaveBeenCalled());
      await settle();
      expect(sentTokens()).toEqual(['device-trainer-a']);
    });

    it('should push only the assigning trainer for a general anamnesis', async () => {
      const trainerA = await createTrainerWithDevice('device-trainer-a');
      const trainerB = await createTrainerWithDevice('device-trainer-b');
      const student = await signup('student');
      await linkStudent(trainerA, student);
      await linkStudent(trainerB, student);
      const anamnesis = await createAnamnesis({ trainerId: null, isGeneral: true });
      await assignAnamnesis(anamnesis, student, trainerA);

      const response = await submitAnamnesis(anamnesis, student);

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(fcmClient.sendToToken).toHaveBeenCalled());
      await settle();
      expect(sentTokens()).toEqual(['device-trainer-a']);
    });

    it('should not push a trainer whose link is not active on the plan', async () => {
      const trainer = await createTrainerWithDevice('device-trainer-a');
      const student = await signup('student');
      await linkStudent(trainer, student, false);
      const anamnesis = await createAnamnesis({ trainerId: trainer.trainerId, isGeneral: false });
      await assignAnamnesis(anamnesis, student, trainer);

      const response = await submitAnamnesis(anamnesis, student);

      expect(response.statusCode).toBe(200);
      await settle();
      expect(fcmClient.sendToToken).not.toHaveBeenCalled();
    });
  });

  describe('workout completed', () => {
    it('should not push a trainer whose link became inactive on the plan', async () => {
      const trainer = await createTrainerWithDevice('device-trainer-a');
      const student = await signup('student');
      await linkStudent(trainer, student);
      const sessionId = await startWorkout(trainer, student);
      await prisma.trainerStudent.updateMany({
        where: { trainerId: trainer.trainerId, studentId: student.userId },
        data: { activeOnPlan: false },
      });

      const response = await completeWorkout(student, sessionId);

      expect(response.statusCode).toBe(200);
      await settle();
      expect(fcmClient.sendToToken).not.toHaveBeenCalled();
    });
  });
});
