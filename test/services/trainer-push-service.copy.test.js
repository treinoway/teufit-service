import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTrainerPushService } from '../../src/services/trainer-push-service.js';
import { FcmStaleTokenCode } from '../../src/constants/mobile-app.js';

const STUDENT_ID = '22222222-2222-4222-8222-222222222222';
const TRAINER_USER_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const ANAMNESIS_ID = '66666666-6666-4666-8666-666666666666';
const DEVICE_TOKEN = 'trainer-token-copy';
const FALLBACK_NAME = 'Um aluno';
const HEALTH_TERMS = /anamnese:|dor|les[aã]o|medica|doen[cç]a|alergia|pressão|diabetes|cirurgia/i;

let prisma;
let fcmClient;
let service;

// Builds a Prisma stand-in linking one trainer device to the student.
function buildPrisma(student) {
  return {
    trainerStudent: { findMany: vi.fn().mockResolvedValue([{ trainer: { userId: TRAINER_USER_ID } }]) },
    user: { findUnique: vi.fn().mockResolvedValue(student) },
    device: {
      findMany: vi.fn().mockResolvedValue([{ token: DEVICE_TOKEN, userId: TRAINER_USER_ID }]),
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
  };
}

// Wires the service with fresh mocks for the given student row.
function setup(student) {
  prisma = buildPrisma(student);
  fcmClient = { sendToToken: vi.fn().mockResolvedValue({ messageId: 'm' }) };
  service = createTrainerPushService({ prisma, fcmClient });
}

describe('trainer-push-service copy', () => {
  beforeEach(() => setup({ firstName: 'Ana', lastName: 'Silva' }));

  it('should use pt-BR text containing the student name for a completed workout', async () => {
    await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

    const { notification } = fcmClient.sendToToken.mock.calls[0][0];
    expect(notification.title).toBe('Treino concluído');
    expect(notification.body).toBe('Ana Silva concluiu um treino.');
  });

  it('should use pt-BR text containing the student name for a submitted anamnesis', async () => {
    await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

    const { notification } = fcmClient.sendToToken.mock.calls[0][0];
    expect(notification.title).toBe('Anamnese enviada');
    expect(notification.body).toBe('Ana Silva enviou a anamnese.');
  });

  it('should not leak health data into the anamnesis push', async () => {
    await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

    const { notification, data } = fcmClient.sendToToken.mock.calls[0][0];
    expect(`${notification.title} ${notification.body}`).not.toMatch(HEALTH_TERMS);
    expect(Object.keys(data).sort()).toEqual(['anamnesisId', 'studentId', 'type']);
  });

  it('should only read the student name fields, never health details', async () => {
    await service.notifyAnamnesisSubmitted({ studentId: STUDENT_ID, anamnesisId: ANAMNESIS_ID });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: STUDENT_ID },
      select: { firstName: true, lastName: true },
    });
  });

  it('should fall back to a generic label when the student names are null', async () => {
    setup({ firstName: null, lastName: null });

    await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

    expect(fcmClient.sendToToken.mock.calls[0][0].notification.body).toContain(FALLBACK_NAME);
  });

  it('should fall back to a generic label when the student row is missing', async () => {
    setup(null);

    await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

    expect(fcmClient.sendToToken.mock.calls[0][0].notification.body).toContain(FALLBACK_NAME);
  });

  it('should remove the token when FCM reports an invalid registration token', async () => {
    fcmClient.sendToToken.mockRejectedValue({ code: FcmStaleTokenCode.INVALID_TOKEN });

    await service.notifyWorkoutCompleted({ studentId: STUDENT_ID, sessionId: SESSION_ID });

    expect(prisma.device.deleteMany).toHaveBeenCalledWith({ where: { token: DEVICE_TOKEN } });
  });
});
