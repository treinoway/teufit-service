import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { createAdminWithToken } from '../helpers/admin-users.js';
import { createUser, auth } from '../helpers/nutrition-e2e.js';
import config from '../../config/index.js';
import emailHandler from '../../src/config/email-handler.js';
import { Roles } from '../../src/constants/roles.js';
import { InviteErrorCode } from '../../src/constants/trainer-invite.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_SUBSCRIPTION_STATUSES } from '../../src/constants/platform-plan.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const BECOME_TRAINER_URL = '/become-trainer';
const BECOME_NUTRITIONIST_URL = '/become-nutritionist';
const TRAINER_PROFILE = 'trainer';
const NUTRITIONIST_PROFILE = 'nutritionist';
const ASAAS_SUBSCRIPTION_ID = 'sub_e2e_paid_0001';
const ASAAS_CUSTOMER_ID = 'cus_e2e_paid_0001';

e2eDescribe('e2e: professions without an invite (beta gate removed) and BETA for every new trainer', () => {
  let app;
  let originalGateEnabled;

  const patch = (url, accessToken) => app.inject({ method: 'PATCH', url, headers: accessToken ? auth(accessToken) : {} });
  const getMe = (accessToken) => app.inject({ method: 'GET', url: '/me', headers: auth(accessToken) });
  const trainerOf = (userId) => prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  const subscriptionOf = async (userId) =>
    prisma.platformSubscription.findUnique({ where: { trainerId: (await trainerOf(userId)).id } });

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    originalGateEnabled = config.betaInviteGate.enabled;
    config.betaInviteGate.enabled = true;
    vi.spyOn(emailHandler, 'sendTrainerWelcomeEmail').mockResolvedValue({ data: { id: 'email-id' } });
  });

  afterEach(() => {
    config.betaInviteGate.enabled = originalGateEnabled;
  });

  describe('PATCH /become-trainer for a user who never redeemed an invite (gate flag enabled)', () => {
    let user;
    let res;

    beforeEach(async () => {
      user = await createUser(app);
      res = await patch(BECOME_TRAINER_URL, user.accessToken);
    });

    it('should answer 200 with the trainer profile and new tokens', async () => {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        activeProfile: TRAINER_PROFILE,
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
    });

    it('should not answer INVITE_REQUIRED', async () => {
      expect(res.json().error).not.toBe(InviteErrorCode.INVITE_REQUIRED);
    });

    it('should grant the trainer role', async () => {
      const me = await getMe(res.json().token.accessToken);

      expect(me.json().roles).toContain(Roles.TRAINER);
    });

    it('should create an ACTIVE BETA platform subscription for the new trainer', async () => {
      const subscription = await subscriptionOf(user.userId);

      expect(subscription).toMatchObject({
        tier: PLATFORM_PLAN_TIERS.BETA,
        status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
        asaasSubscriptionId: null,
      });
    });

    it('should report the BETA plan in GET /me', async () => {
      const me = await getMe(res.json().token.accessToken);

      expect(me.json().platformPlan).toMatchObject({
        tier: PLATFORM_PLAN_TIERS.BETA,
        status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      });
    });

    it('should send the welcome email exactly once', async () => {
      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
      expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledWith(expect.objectContaining({ to: user.email }));
    });

    it('should seed the example routine', async () => {
      const trainer = await trainerOf(user.userId);

      expect(await prisma.trainingProtocolTemplate.count({ where: { trainerId: trainer.id, isExample: true } })).toBeGreaterThan(0);
    });

    describe('when the same user calls it again (re-activation)', () => {
      it('should answer 200 without sending a second welcome email', async () => {
        const again = await patch(BECOME_TRAINER_URL, res.json().token.accessToken);

        expect(again.statusCode).toBe(200);
        expect(emailHandler.sendTrainerWelcomeEmail).toHaveBeenCalledTimes(1);
      });

      it('should not seed the example routine again', async () => {
        const trainer = await trainerOf(user.userId);
        const seededBefore = await prisma.trainingProtocolTemplate.count({ where: { trainerId: trainer.id, isExample: true } });

        await patch(BECOME_TRAINER_URL, res.json().token.accessToken);

        expect(await prisma.trainingProtocolTemplate.count({ where: { trainerId: trainer.id, isExample: true } })).toBe(seededBefore);
      });

      it('should keep a single subscription row', async () => {
        const trainer = await trainerOf(user.userId);

        await patch(BECOME_TRAINER_URL, res.json().token.accessToken);

        expect(await prisma.platformSubscription.count({ where: { trainerId: trainer.id } })).toBe(1);
      });

      it('should not change a paid subscription billed through Asaas', async () => {
        const trainer = await trainerOf(user.userId);
        const paid = await prisma.platformSubscription.update({
          where: { trainerId: trainer.id },
          data: {
            tier: PLATFORM_PLAN_TIERS.PRO,
            status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
            asaasSubscriptionId: ASAAS_SUBSCRIPTION_ID,
            asaasCustomerId: ASAAS_CUSTOMER_ID,
          },
        });

        const again = await patch(BECOME_TRAINER_URL, res.json().token.accessToken);

        expect(again.statusCode).toBe(200);
        expect(await subscriptionOf(user.userId)).toEqual(paid);
      });
    });
  });

  describe('PATCH /become-nutritionist for a user who never redeemed an invite (gate flag enabled)', () => {
    let user;
    let res;

    beforeEach(async () => {
      user = await createUser(app);
      res = await patch(BECOME_NUTRITIONIST_URL, user.accessToken);
    });

    it('should answer 200 with the nutritionist profile and new tokens', async () => {
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        activeProfile: NUTRITIONIST_PROFILE,
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
    });

    it('should grant the nutritionist role', async () => {
      const me = await getMe(res.json().token.accessToken);

      expect(me.json().roles).toContain(Roles.NUTRITIONIST);
    });

    it('should let the same user also become a trainer', async () => {
      const both = await patch(BECOME_TRAINER_URL, res.json().token.accessToken);

      expect(both.statusCode).toBe(200);
      const me = await getMe(both.json().token.accessToken);
      expect(me.json().roles).toEqual(expect.arrayContaining([Roles.NUTRITIONIST, Roles.TRAINER]));
    });
  });

  describe.each([BECOME_TRAINER_URL, BECOME_NUTRITIONIST_URL])('PATCH %s without authentication', (url) => {
    it('should still answer 401', async () => {
      const res = await patch(url);

      expect(res.statusCode).toBe(401);
    });
  });

  describe('betaAccess', () => {
    it.each([
      ['enabled', true],
      ['disabled', false],
    ])('should be true in GET /me for a user with no role and no invite when the gate flag is %s', async (_label, gateEnabled) => {
      config.betaInviteGate.enabled = gateEnabled;
      const user = await createUser(app);

      const me = await getMe(user.accessToken);

      expect(me.statusCode).toBe(200);
      expect(me.json().betaAccess).toBe(true);
    });

    it('should be true in GET /me for a nutritionist with no invite', async () => {
      const user = await createUser(app);
      const res = await patch(BECOME_NUTRITIONIST_URL, user.accessToken);

      const me = await getMe(res.json().token.accessToken);

      expect(me.json().betaAccess).toBe(true);
    });

    it('should be true in the PATCH /me/profile response for a user with no invite', async () => {
      const user = await createUser(app);

      const res = await app.inject({
        method: 'PATCH',
        url: '/me/profile',
        headers: auth(user.accessToken),
        payload: { firstName: 'Bia' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().betaAccess).toBe(true);
    });
  });

  describe('POST /invite/redeem keeps working for old invite links', () => {
    let user;
    let redeemed;

    beforeEach(async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      user = await createUser(app);
      const created = await app.inject({
        method: 'POST',
        url: '/admin/trainer-invites',
        headers: auth(adminToken),
        payload: { email: user.email },
      });
      expect(created.statusCode).toBe(201);
      redeemed = await app.inject({
        method: 'POST',
        url: '/invite/redeem',
        headers: auth(user.accessToken),
        payload: { code: created.json().code },
      });
    });

    it('should answer 200 with betaAccess true and the trainer profile', async () => {
      expect(redeemed.statusCode).toBe(200);
      expect(redeemed.json()).toMatchObject({ betaAccess: true, activeProfile: TRAINER_PROFILE });
    });

    it('should leave the trainer with a single ACTIVE BETA subscription', async () => {
      const trainer = await trainerOf(user.userId);

      const subscriptions = await prisma.platformSubscription.findMany({ where: { trainerId: trainer.id } });

      expect(subscriptions).toEqual([
        expect.objectContaining({ tier: PLATFORM_PLAN_TIERS.BETA, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE }),
      ]);
    });
  });
});
