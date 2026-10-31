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
const TRAINER_FCM_TOKEN = 'fcm-token-trainer-push-e2e';
const COACH_APP_ID = 'br.com.teufit.coach';
const PLATFORM_ANDROID = 'android';
const EVENT_WORKOUT_COMPLETED = 'workout_completed';
const EVENT_ANAMNESIS_SUBMITTED = 'anamnesis_submitted';
const FCM_INVALID_TOKEN_CODE = 'messaging/registration-token-not-registered';

e2eDescribe('e2e: trainer push notifications', () => {
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

  async function createTrainer() {
    const { userId, accessToken } = await signup('trainer');
    const response = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(response.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    return { userId, trainerId: trainer.id, accessToken: response.json().token.accessToken };
  }

  async function registerTrainerDevice(accessToken) {
    const response = await app.inject({
      method: 'POST',
      url: '/me/devices',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { token: TRAINER_FCM_TOKEN, platform: PLATFORM_ANDROID, appId: COACH_APP_ID },
    });
    expect(response.statusCode).toBe(200);
  }

  async function linkStudent(trainerId, studentId) {
    await prisma.trainerStudent.create({ data: { trainerId, studentId, activeOnPlan: true } });
  }

  async function completeWorkout(trainer, student) {
    const protocol = await app.inject({
      method: 'POST',
      url: '/trainer/protocols',
      headers: { authorization: `Bearer ${trainer.accessToken}` },
      payload: { assigneeId: student.userId, name: 'Push Protocol', startDate: '2026-01-01' },
    });
    expect(protocol.statusCode).toBe(201);
    const training = await app.inject({
      method: 'POST',
      url: `/trainer/protocols/${protocol.json().id}/trainings`,
      headers: { authorization: `Bearer ${trainer.accessToken}` },
      payload: { name: 'Push Day', category: 'strength' },
    });
    expect(training.statusCode).toBe(201);
    const session = await app.inject({
      method: 'POST',
      url: `/my/trainings/${training.json().id}/workout-sessions`,
      headers: { authorization: `Bearer ${student.accessToken}` },
      payload: {},
    });
    expect(session.statusCode).toBe(201);
    return app.inject({
      method: 'PATCH',
      url: `/my/workout-sessions/${session.json().id}`,
      headers: { authorization: `Bearer ${student.accessToken}` },
      payload: { status: WorkoutSessionStatus.COMPLETED },
    });
  }

  async function submitAnamnesis(trainer, student) {
    const anamnesis = await prisma.anamnesis.create({
      data: {
        title: 'Push anamnesis',
        trainerId: trainer.trainerId,
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
    await prisma.studentAnamnesis.create({
      data: { anamnesisId: anamnesis.id, studentId: student.userId, trainerId: trainer.trainerId },
    });
    return app.inject({
      method: 'POST',
      url: `/my/anamneses/${anamnesis.id}/response`,
      headers: { authorization: `Bearer ${student.accessToken}` },
      payload: { answers: [{ questionId: anamnesis.sections[0].questions[0].id, value: 'ok' }] },
    });
  }

  async function setupLinkedPair({ withDevice = true } = {}) {
    const trainer = await createTrainer();
    const student = await signup('student');
    await linkStudent(trainer.trainerId, student.userId);
    if (withDevice) await registerTrainerDevice(trainer.accessToken);
    return { trainer, student };
  }

  describe('when the student completes a workout', () => {
    it('should push the trainer device with the workout event data', async () => {
      const { trainer, student } = await setupLinkedPair();

      const response = await completeWorkout(trainer, student);

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(fcmClient.sendToToken).toHaveBeenCalledTimes(1));
      expect(fcmClient.sendToToken.mock.calls[0][0]).toMatchObject({
        token: TRAINER_FCM_TOKEN,
        data: { type: EVENT_WORKOUT_COMPLETED, studentId: student.userId },
      });
    });

    it('should still complete the workout when FCM fails', async () => {
      const { trainer, student } = await setupLinkedPair();
      fcmClient.sendToToken.mockRejectedValue(new Error('fcm unavailable'));

      const response = await completeWorkout(trainer, student);

      expect(response.statusCode).toBe(200);
      expect(response.json().status).toBe(WorkoutSessionStatus.COMPLETED);
    });

    it('should delete the trainer token when FCM reports it as not registered', async () => {
      const { trainer, student } = await setupLinkedPair();
      fcmClient.sendToToken.mockRejectedValue(
        Object.assign(new Error('not registered'), { code: FCM_INVALID_TOKEN_CODE }),
      );

      await completeWorkout(trainer, student);

      await vi.waitFor(async () => {
        expect(await prisma.device.count({ where: { token: TRAINER_FCM_TOKEN } })).toBe(0);
      });
    });

    it('should not call FCM when the trainer has no registered device', async () => {
      const { trainer, student } = await setupLinkedPair({ withDevice: false });

      const response = await completeWorkout(trainer, student);

      expect(response.statusCode).toBe(200);
      expect(fcmClient.sendToToken).not.toHaveBeenCalled();
    });
  });

  describe('when the student submits an anamnesis', () => {
    it('should push the trainer device with the anamnesis event data', async () => {
      const { trainer, student } = await setupLinkedPair();

      const response = await submitAnamnesis(trainer, student);

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(fcmClient.sendToToken).toHaveBeenCalledTimes(1));
      expect(fcmClient.sendToToken.mock.calls[0][0]).toMatchObject({
        token: TRAINER_FCM_TOKEN,
        data: { type: EVENT_ANAMNESIS_SUBMITTED, studentId: student.userId },
      });
    });

    it('should still accept the response when FCM fails', async () => {
      const { trainer, student } = await setupLinkedPair();
      fcmClient.sendToToken.mockRejectedValue(new Error('fcm unavailable'));

      const response = await submitAnamnesis(trainer, student);

      expect(response.statusCode).toBe(200);
    });
  });
});
