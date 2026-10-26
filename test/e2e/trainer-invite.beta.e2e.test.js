import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { createAdminWithToken, createTrainerWithToken, linkStudents } from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const INVITEE_EMAIL = 'beta-trainer@example.com';
const PASSWORD = 'StrongPassw0rd!';
const BETA_TIER = 'BETA';
const ASAAS_SUBSCRIPTION_ID = 'mock-asaas-sub-001';
const { FREE, PRO } = PLATFORM_PLAN_TIERS;

e2eDescribe('e2e: closed-beta invite grants the BETA plan', () => {
  let app;
  let adminToken;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockResolvedValue(undefined);
    vi.spyOn(emailHandler, 'sendTrainerInviteEmail').mockResolvedValue(undefined);
    ({ accessToken: adminToken } = await createAdminWithToken(app));
  });

  async function createInviteCode(email) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trainer-invites',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    return res.json().code;
  }

  function redeem(accessToken, code) {
    return app.inject({
      method: 'POST',
      url: '/invite/redeem',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { code },
    });
  }

  async function subscriptionForUser(userId) {
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    return prisma.platformSubscription.findUnique({ where: { trainerId: trainer.id } });
  }

  describe('POST /auth/signup/invite', () => {
    it('should create the trainer with an ACTIVE BETA platform subscription', async () => {
      const code = await createInviteCode(INVITEE_EMAIL);

      const res = await app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code, password: PASSWORD } });

      expect(res.statusCode).toBe(201);
      const subscription = await subscriptionForUser(res.json().user.id);
      expect(subscription).toMatchObject({ tier: BETA_TIER, status: 'ACTIVE' });
    });

    it('should expose tier BETA in GET /trainer/platform-plan right after signup', async () => {
      const code = await createInviteCode(INVITEE_EMAIL);
      const signup = await app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code, password: PASSWORD } });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/platform-plan',
        headers: { authorization: `Bearer ${signup.json().token.accessToken}` },
      });

      expect(res.json().tier).toBe(BETA_TIER);
    });
  });

  describe('POST /invite/redeem', () => {
    it('should grant BETA and reactivate blocked students for an existing FREE trainer', async () => {
      const { userId, trainerId, accessToken, email } = await createTrainerWithToken(app);
      await linkStudents(app, trainerId, { count: 5, blockedCount: 2 });
      const code = await createInviteCode(email);

      const res = await redeem(accessToken, code);

      expect(res.statusCode).toBe(200);
      expect(await subscriptionForUser(userId)).toMatchObject({ tier: BETA_TIER, status: 'ACTIVE' });
      expect(await prisma.trainerStudent.count({ where: { trainerId, activeOnPlan: false } })).toBe(0);
    });

    it('should grant BETA to a plain user without a trainer profile', async () => {
      const signup = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email: INVITEE_EMAIL, password: PASSWORD },
      });
      const code = await createInviteCode(INVITEE_EMAIL);

      const res = await redeem(signup.json().token.accessToken, code);

      expect(res.statusCode).toBe(200);
      expect(await subscriptionForUser(signup.json().user.id)).toMatchObject({ tier: BETA_TIER });
    });

    it('should leave the tier untouched when the trainer already pays through Asaas', async () => {
      const { userId, trainerId, accessToken, email } = await createTrainerWithToken(app);
      await prisma.platformSubscription.create({
        data: { trainerId, tier: PRO, status: 'ACTIVE', asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID },
      });
      const code = await createInviteCode(email);

      const res = await redeem(accessToken, code);

      expect(res.statusCode).toBe(200);
      expect(await subscriptionForUser(userId)).toMatchObject({ tier: PRO, asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID });
    });
  });

  describe('PATCH /become-trainer without an invite', () => {
    it('should not create a BETA subscription', async () => {
      const { userId } = await createTrainerWithToken(app);

      const subscription = await subscriptionForUser(userId);

      expect(subscription?.tier ?? FREE).toBe(FREE);
    });
  });
});
