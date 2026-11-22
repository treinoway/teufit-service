import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/db.js', () => ({
  prisma: {
    user: { findUnique: vi.fn() },
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
import { AppError } from '../../src/errors/app-error.js';
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
  stubExistingConversation,
} from '../helpers/ai-engine-fixtures.js';

const EMAIL_VERIFICATION_REQUIRED = Object.freeze({
  httpStatus: 403,
  error: 'EMAIL_VERIFICATION_REQUIRED',
  messageCode: 'emailVerification.required',
});
const REPLY = 'Ok';
const MESSAGE = 'Oi';

// Makes every way of reading the user's accounts report the given verification state.
function stubEmailVerification(isVerified) {
  const verifiedAt = isVerified ? new Date('2026-11-01T12:00:00.000Z') : null;
  const account = { id: 'account-1', userId: USER_ID, provider: EMAIL_PROVIDER, verifiedAt };
  const verifiedAccounts = isVerified ? [account] : [];
  prisma.account.findFirst.mockResolvedValue(verifiedAccounts[0] ?? null);
  prisma.account.findMany.mockResolvedValue(verifiedAccounts);
  prisma.account.count.mockResolvedValue(verifiedAccounts.length);
  prisma.user.findUnique.mockResolvedValue({ id: USER_ID, deletedAt: null, accounts: [account] });
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

describe('AI actions require a verified email', () => {
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

  describe('when the trainer email is unverified', () => {
    beforeEach(() => {
      stubEmailVerification(false);
    });

    describe('processAiChat', () => {
      it('should reject with 403 EMAIL_VERIFICATION_REQUIRED / emailVerification.required', async () => {
        await expect(processAiChat(USER_ID, { message: MESSAGE })).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
      });

      it('should reject with an AppError so the route answers the unified error contract', async () => {
        const rejection = await processAiChat(USER_ID, { message: MESSAGE }).catch((error) => error);

        expect(rejection).toBeInstanceOf(AppError);
      });

      it('should not create a conversation', async () => {
        await processAiChat(USER_ID, { message: MESSAGE }).catch(() => {});

        expect(prisma.aiConversation.create).not.toHaveBeenCalled();
      });

      it('should not save the user message into an existing conversation', async () => {
        stubExistingConversation(prisma);

        await processAiChat(USER_ID, { message: MESSAGE, conversationId: CONVERSATION_ID }).catch(() => {});

        expect(prisma.aiMessage.create).not.toHaveBeenCalled();
      });

      it('should not call the model', async () => {
        await processAiChat(USER_ID, { message: MESSAGE }).catch(() => {});

        expect(mockChat).not.toHaveBeenCalled();
        expect(mockChatStream).not.toHaveBeenCalled();
      });

      it('should not record an AI usage event', async () => {
        await processAiChat(USER_ID, { message: MESSAGE }).catch(() => {});

        expect(prisma.aiUsageEvent.create).not.toHaveBeenCalled();
      });
    });

    describe('processAiChatStream', () => {
      it('should reject before yielding any event, so the route still answers a JSON 403', async () => {
        const turn = processAiChatStream(USER_ID, { message: MESSAGE });

        await expect(turn.next()).rejects.toMatchObject(EMAIL_VERIFICATION_REQUIRED);
      });

      it('should not create a conversation', async () => {
        await drain(processAiChatStream(USER_ID, { message: MESSAGE })).catch(() => {});

        expect(prisma.aiConversation.create).not.toHaveBeenCalled();
      });

      it('should not call the model', async () => {
        await drain(processAiChatStream(USER_ID, { message: MESSAGE })).catch(() => {});

        expect(mockChatStream).not.toHaveBeenCalled();
      });
    });
  });

  describe('when the trainer email is verified', () => {
    beforeEach(() => {
      stubEmailVerification(true);
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
});
