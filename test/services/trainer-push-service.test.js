import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrainerPushService } from '../../src/services/trainer-push-service.js';

const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const TRAINER_USER_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_TRAINER_USER_ID = '44444444-4444-4444-8444-444444444444';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ANAMNESIS_ID = '66666666-6666-4666-8666-666666666666';
const TRAINER_TOKEN = 'trainer-token-1';
const TRAINER_TOKEN_2 = 'trainer-token-2';
const OTHER_TRAINER_TOKEN = 'other-trainer-token';
const EVENT_WORKOUT_COMPLETED = 'workout_completed';
const EVENT_ANAMNESIS_SUBMITTED = 'anamnesis_submitted';
const FCM_INVALID_TOKEN_CODE = 'messaging/registration-token-not-registered';

let prismaMock;
let fcmClient;
let service;

// Builds a Prisma stand-in with the delegates the notifier reads and cleans up.
function buildPrismaMock() {
  return {
    trainerStudent: { findMany: vi.fn() },
    user: { findUnique: vi.fn().mockResolvedValue({ firstName: 'Ana', lastName: 'Silva' }) },
    device: { findMany: vi.fn(), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
  };
}

// Makes the student appear linked to the given trainer user ids.
function linkTrainers(...trainerUserIds) {
  prismaMock.trainerStudent.findMany.mockResolvedValue(
    trainerUserIds.map((userId) => ({ trainer: { userId } })),
  );
}

// Makes the device lookup return one device row per token.
function registerTokens(...tokens) {
  prismaMock.device.findMany.mockResolvedValue(
    tokens.map((token) => ({ token, userId: TRAINER_USER_ID, platform: 'ios', appId: 'br.com.teufit.coach' })),
  );
}

// Lists every token the fake FCM client was asked to deliver to.
function sentTokens() {
  return fcmClient.sendToToken.mock.calls.map(([message]) => message.token);
}

describe('trainer-push-service', () => {
  beforeEach(() => {
    prismaMock = buildPrismaMock();
    fcmClient = { sendToToken: vi.fn().mockResolvedValue({ messageId: 'm-1' }) };
    service = createTrainerPushService({ prisma: prismaMock, fcmClient });
  });

  describe('notifyWorkoutCompleted', () => {
    it('should send one push per trainer device when the student completes a workout', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN, TRAINER_TOKEN_2);

      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(sentTokens()).toEqual([TRAINER_TOKEN, TRAINER_TOKEN_2]);
    });

    it('should include the event type and ids in the data payload so a tap can open the right screen', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);

      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(fcmClient.sendToToken.mock.calls[0][0].data).toMatchObject({
        type: EVENT_WORKOUT_COMPLETED,
        studentId: STUDENT_ID,
        sessionId: SESSION_ID,
      });
    });

    it('should look up devices only for the trainers linked to the student', async () => {
      linkTrainers(TRAINER_USER_ID, OTHER_TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN, OTHER_TRAINER_TOKEN);

      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      const where = prismaMock.device.findMany.mock.calls[0][0].where;
      expect(where.userId).toEqual({ in: [TRAINER_USER_ID, OTHER_TRAINER_USER_ID] });
    });

    it('should not call FCM nor throw when the student has no trainer', async () => {
      linkTrainers();

      await expect(
        service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID }),
      ).resolves.not.toThrow();
      expect(fcmClient.sendToToken).not.toHaveBeenCalled();
    });

    it('should not call FCM nor throw when the trainer has no registered device', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens();

      await expect(
        service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID }),
      ).resolves.not.toThrow();
      expect(fcmClient.sendToToken).not.toHaveBeenCalled();
    });

    it('should resolve without throwing when FCM fails', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);
      fcmClient.sendToToken.mockRejectedValue(new Error('fcm unavailable'));

      await expect(
        service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID }),
      ).resolves.not.toThrow();
    });

    it('should not delete the token when FCM fails for a transient reason', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);
      fcmClient.sendToToken.mockRejectedValue(new Error('fcm unavailable'));

      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(prismaMock.device.deleteMany).not.toHaveBeenCalled();
    });

    it('should resolve without throwing when the database lookup fails', async () => {
      prismaMock.trainerStudent.findMany.mockRejectedValue(new Error('db down'));

      await expect(
        service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID }),
      ).resolves.not.toThrow();
    });

    it('should remove a token that FCM reports as not registered', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);
      fcmClient.sendToToken.mockRejectedValue(
        Object.assign(new Error('not registered'), { code: FCM_INVALID_TOKEN_CODE }),
      );

      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(prismaMock.device.deleteMany).toHaveBeenCalledWith({ where: { token: TRAINER_TOKEN } });
    });

    it('should keep delivering to valid tokens when another token is invalid', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN, TRAINER_TOKEN_2);
      fcmClient.sendToToken.mockImplementation(async ({ token }) => {
        if (token === TRAINER_TOKEN) {
          throw Object.assign(new Error('not registered'), { code: FCM_INVALID_TOKEN_CODE });
        }
        return { messageId: 'm-2' };
      });

      await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

      expect(sentTokens()).toContain(TRAINER_TOKEN_2);
      expect(prismaMock.device.deleteMany).toHaveBeenCalledTimes(1);
    });
  });

  describe('notifyAnamnesisSubmitted', () => {
    it('should send a push with the anamnesis event type and ids to the trainer device', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);

      await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

      expect(fcmClient.sendToToken).toHaveBeenCalledTimes(1);
      expect(fcmClient.sendToToken.mock.calls[0][0]).toMatchObject({
        token: TRAINER_TOKEN,
        data: { type: EVENT_ANAMNESIS_SUBMITTED, studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID },
      });
    });

    it('should not call FCM nor throw when the student has no trainer', async () => {
      linkTrainers();

      await expect(
        service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID }),
      ).resolves.not.toThrow();
      expect(fcmClient.sendToToken).not.toHaveBeenCalled();
    });

    it('should resolve without throwing when FCM fails', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);
      fcmClient.sendToToken.mockRejectedValue(new Error('fcm unavailable'));

      await expect(
        service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID }),
      ).resolves.not.toThrow();
    });

    it('should remove a token that FCM reports as not registered', async () => {
      linkTrainers(TRAINER_USER_ID);
      registerTokens(TRAINER_TOKEN);
      fcmClient.sendToToken.mockRejectedValue(
        Object.assign(new Error('not registered'), { code: FCM_INVALID_TOKEN_CODE }),
      );

      await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

      expect(prismaMock.device.deleteMany).toHaveBeenCalledWith({ where: { token: TRAINER_TOKEN } });
    });
  });
});
