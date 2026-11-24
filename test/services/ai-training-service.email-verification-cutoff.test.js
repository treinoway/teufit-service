import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn(), findFirst: vi.fn() },
    account: { findFirst: vi.fn(), findMany: vi.fn(), count: vi.fn() },
    trainer: { findUnique: vi.fn(), findFirst: vi.fn() },
    trainerStudent: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), count: vi.fn() },
    platformSubscription: { findUnique: vi.fn(), update: vi.fn() },
    aiUsageEvent: { count: vi.fn(), create: vi.fn(), groupBy: vi.fn() },
    anamnesisResponse: { findMany: vi.fn() },
    trainingProtocolTemplate: { findMany: vi.fn() },
    trainingTemplate: { findMany: vi.fn() },
    trainingProtocol: { findMany: vi.fn() },
    exerciseTemplate: { findMany: vi.fn() },
    aiConversation: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    aiMessage: { create: vi.fn() },
    aiTokenUsage: { create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

const mockChat = vi.fn();
const mockChatStream = vi.fn();

vi.mock('../../src/llm/index.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getLlmProvider: vi.fn(() => ({
    chat: mockChat,
    chatStream: mockChatStream,
    buildToolResultMessages: vi.fn(),
  })),
}));

vi.mock('../../src/services/training-protocol-service.js', () => ({
  importFromTemplate: vi.fn(),
}));
vi.mock('../../src/services/trainer-onboarding-service.js', () => ({
  maybeMarkFirstProtocolCreated: vi.fn(),
}));
vi.mock('../../src/services/student-dashboard-service.js', () => ({
  buildAiPerformanceSnapshot: vi.fn(),
}));
vi.mock('../../src/services/ai-interaction-log-service.js', () => ({
  writeInteractionLog: vi.fn(),
}));

import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { processAiChat, processAiChatStream } from '../../src/services/ai-training-service.js';
import { writeInteractionLog } from '../../src/services/ai-interaction-log-service.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import {
  USER_ID,
  TRAINER_ID,
  CONVERSATION_ID,
  textResponse,
  streamOf,
  drain,
  stubTrainerContext,
  stubNewConversation,
} from '../helpers/ai-engine-fixtures.js';

const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  httpStatus: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});
const REPLY = 'Ok';
const MESSAGE = 'Oi';
const ONE_MS = 1;

// Instant from which unverified accounts are restricted, read from the configuration under test.
function enforcedFrom() {
  return new Date(config.emailVerification?.enforcedFrom);
}

// Makes the trainer an account with an UNVERIFIED e-mail created at the given instant.
function stubUnverifiedTrainerCreatedAt(createdAt) {
  const account = { id: 'account-1', userId: USER_ID, provider: EMAIL_PROVIDER, verifiedAt: null };
  const user = { id: USER_ID, deletedAt: null, createdAt, accounts: [account] };
  prisma.account.findFirst.mockResolvedValue(null);
  prisma.account.findMany.mockResolvedValue([]);
  prisma.account.count.mockResolvedValue(0);
  prisma.user.findUnique.mockResolvedValue(user);
  prisma.user.findFirst.mockResolvedValue(user);
}

// Gives the trainer an ACTIVE BETA plan with no AI usage, so only the email rule can refuse the turn.
function stubBetaPlan() {
  prisma.platformSubscription.findUnique.mockResolvedValue({
    trainerId: TRAINER_ID,
    tier: PLATFORM_PLAN_TIERS.BETA,
    status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    pastDueSince: null,
    asaasSubscriptionId: null,
  });
  prisma.aiUsageEvent.count.mockResolvedValue(0);
  prisma.aiUsageEvent.create.mockResolvedValue({});
  prisma.aiUsageEvent.groupBy.mockResolvedValue([]);
}

describe('AI actions and the open-signup cut-off of the verified-email rule', () => {
  beforeEach(() => {
    writeInteractionLog.mockResolvedValue(undefined);
    prisma.aiTokenUsage.create.mockResolvedValue({});
    prisma.anamnesisResponse.findMany.mockResolvedValue([]);
    prisma.trainerStudent.count.mockResolvedValue(0);
    stubTrainerContext(prisma);
    prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
    prisma.trainer.findFirst.mockResolvedValue({ id: TRAINER_ID, userId: USER_ID });
    stubNewConversation(prisma);
    stubBetaPlan();
    mockChat.mockResolvedValue(textResponse(REPLY));
    mockChatStream.mockImplementation(streamOf(textResponse(REPLY)));
  });

  describe('when the unverified trainer account was created before the cut-off', () => {
    beforeEach(() => {
      stubUnverifiedTrainerCreatedAt(new Date(enforcedFrom().getTime() - ONE_MS));
    });

    it('should answer the turn through processAiChat', async () => {
      await expect(processAiChat(USER_ID, { message: MESSAGE })).resolves.toMatchObject({
        conversationId: CONVERSATION_ID,
        message: REPLY,
      });
    });

    it('should finish the stream with a done event through processAiChatStream', async () => {
      const events = await drain(processAiChatStream(USER_ID, { message: MESSAGE }));

      expect(events.at(-1)).toMatchObject({ event: 'done', data: { message: REPLY } });
    });
  });

  describe('when the unverified trainer account was created at the cut-off', () => {
    beforeEach(() => {
      stubUnverifiedTrainerCreatedAt(enforcedFrom());
    });

    it('should reject processAiChat with 403 emailVerification.required and not call the model', async () => {
      await expect(processAiChat(USER_ID, { message: MESSAGE })).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
      expect(Number.isNaN(enforcedFrom().getTime())).toBe(false);
      expect(mockChat).not.toHaveBeenCalled();
    });

    it('should reject processAiChatStream before yielding any event', async () => {
      const turn = processAiChatStream(USER_ID, { message: MESSAGE });

      await expect(turn.next()).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
      expect(mockChatStream).not.toHaveBeenCalled();
    });
  });
});
