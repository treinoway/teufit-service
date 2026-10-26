import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import { PLATFORM_PLAN_TIERS, getBillingMonth } from '../../src/constants/platform-plan.js';
import { LLM_PROVIDERS, AI_MODELS } from '../../src/constants/ai.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const { FREE, PRO, DIAMOND } = PLATFORM_PLAN_TIERS;
const PAST_MONTH = '2026-01';
const INVALID_MONTHS = ['2026-13', '2026-00', '2026-1', '26-01', 'january', '2026-01-15'];

e2eDescribe('e2e: admin iArnold token usage', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  function getUsage(accessToken, query = '') {
    return app.inject({
      method: 'GET',
      url: `/admin/ai-usage${query}`,
      headers: accessToken ? { authorization: `Bearer ${accessToken}` } : {},
    });
  }

  async function seedUsage(trainerId, billingMonth, tokens = {}) {
    return prisma.aiTokenUsage.create({
      data: {
        trainerId,
        provider: LLM_PROVIDERS.ANTHROPIC,
        model: AI_MODELS.ANTHROPIC,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        llmCalls: 1,
        billingMonth,
        ...tokens,
      },
    });
  }

  function expectErrorContract(body, { error, messageCode }) {
    expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
    expect(body).toHaveProperty('details');
  }

  describe('access control', () => {
    it('returns 401 without a token', async () => {
      const response = await getUsage(null);

      expect(response.statusCode).toBe(401);
    });

    it('returns 403 auth.forbidden to a trainer', async () => {
      const { accessToken } = await createTrainerWithToken(app);

      const response = await getUsage(accessToken);

      expect(response.statusCode).toBe(403);
      expectErrorContract(response.json(), { error: 'FORBIDDEN', messageCode: 'auth.forbidden' });
    });

    it('returns 403 to a student', async () => {
      const { accessToken } = await createStudentWithToken(app);

      const response = await getUsage(accessToken);

      expect(response.statusCode).toBe(403);
    });
  });

  describe('GET /admin/ai-usage', () => {
    it('returns zeroed totals and no trainers when there is no usage', async () => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        month: PAST_MONTH,
        totals: {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 0,
          turns: 0,
        },
        trainers: [],
      });
    });

    it('defaults to the current UTC month when month is omitted', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await seedUsage(trainerId, getBillingMonth(), { inputTokens: 10 });
      await seedUsage(trainerId, PAST_MONTH, { inputTokens: 999 });

      const response = await getUsage(accessToken);

      const body = response.json();
      expect(body.month).toBe(getBillingMonth());
      expect(body.totals.inputTokens).toBe(10);
    });

    it('only aggregates rows of the requested month', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await seedUsage(trainerId, PAST_MONTH, { inputTokens: 40 });
      await seedUsage(trainerId, '2026-02', { inputTokens: 5000 });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().totals.inputTokens).toBe(40);
    });

    it('sums all token counters and counts turns per trainer', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const { trainerId, email } = await createTrainerWithToken(app, { firstName: 'Ana', lastName: 'Lima' });
      await provisionTrainerPlan(trainerId, PRO);
      await seedUsage(trainerId, PAST_MONTH, {
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10,
      });
      await seedUsage(trainerId, PAST_MONTH, {
        inputTokens: 200, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 5,
      });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().trainers).toEqual([
        {
          trainerId,
          firstName: 'Ana',
          lastName: 'Lima',
          email,
          tier: PRO,
          inputTokens: 300,
          outputTokens: 50,
          cacheReadTokens: 50,
          cacheWriteTokens: 15,
          totalTokens: 415,
          turns: 2,
        },
      ]);
    });

    it('computes month totals across trainers with totalTokens = input + output + cacheRead + cacheWrite', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const first = await createTrainerWithToken(app);
      const second = await createTrainerWithToken(app);
      await seedUsage(first.trainerId, PAST_MONTH, {
        inputTokens: 100, outputTokens: 20, cacheReadTokens: 50, cacheWriteTokens: 10,
      });
      await seedUsage(second.trainerId, PAST_MONTH, {
        inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 1,
      });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().totals).toEqual({
        inputTokens: 110,
        outputTokens: 25,
        cacheReadTokens: 50,
        cacheWriteTokens: 11,
        totalTokens: 196,
        turns: 2,
      });
    });

    it('sorts trainers by totalTokens descending', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const small = await createTrainerWithToken(app);
      const large = await createTrainerWithToken(app);
      const medium = await createTrainerWithToken(app);
      await seedUsage(small.trainerId, PAST_MONTH, { inputTokens: 10 });
      await seedUsage(large.trainerId, PAST_MONTH, { inputTokens: 1000 });
      await seedUsage(medium.trainerId, PAST_MONTH, { inputTokens: 100 });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().trainers.map((t) => t.trainerId)).toEqual([
        large.trainerId,
        medium.trainerId,
        small.trainerId,
      ]);
    });

    it('lists only trainers with usage in the month', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const withUsage = await createTrainerWithToken(app);
      await createTrainerWithToken(app);
      const otherMonthOnly = await createTrainerWithToken(app);
      await seedUsage(withUsage.trainerId, PAST_MONTH, { inputTokens: 1 });
      await seedUsage(otherMonthOnly.trainerId, '2026-02', { inputTokens: 1 });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().trainers.map((t) => t.trainerId)).toEqual([withUsage.trainerId]);
    });

    it('reports FREE for a trainer with usage but no subscription row', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await seedUsage(trainerId, PAST_MONTH, { inputTokens: 1 });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().trainers[0].tier).toBe(FREE);
    });

    it('reports the subscription tier of the trainer', async () => {
      const { accessToken } = await createAdminWithToken(app);
      const { trainerId } = await createTrainerWithToken(app);
      await provisionTrainerPlan(trainerId, DIAMOND);
      await seedUsage(trainerId, PAST_MONTH, { inputTokens: 1 });

      const response = await getUsage(accessToken, `?month=${PAST_MONTH}`);

      expect(response.json().trainers[0].tier).toBe(DIAMOND);
    });

    it.each(INVALID_MONTHS)('returns 400 validation.failed for month=%s', async (month) => {
      const { accessToken } = await createAdminWithToken(app);

      const response = await getUsage(accessToken, `?month=${month}`);

      expect(response.statusCode).toBe(400);
      expectErrorContract(response.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });
});
