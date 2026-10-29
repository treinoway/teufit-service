import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  createAdminWithToken,
  createTrainerWithToken,
  createStudentWithToken,
} from '../helpers/admin-users.js';
import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { InviteStatus } from '../../src/constants/trainer-invite.js';
import { PLATFORM_PLAN_TIERS } from '../../src/constants/platform-plan.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ACCOUNT_TYPE = Object.freeze({ TRAINER: 'trainer', SIGNUP: 'signup' });
const INVITE_FILTER = Object.freeze({ NONE: 'none', PENDING: 'pending', ACCEPTED: 'accepted' });
const BAD_REQUEST_STATUS = 400;
const OK_STATUS = 200;
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;
const BASE_TIME = Date.UTC(2026, 5, 1);
const BETA_TIER = PLATFORM_PLAN_TIERS.BETA;

e2eDescribe('e2e: GET /admin/trainers with signups and invite status', () => {
  let app;
  let adminToken;
  let adminUserId;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.spyOn(emailHandler, 'sendTrainerInviteEmail').mockResolvedValue(undefined);
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockResolvedValue(undefined);
    ({ accessToken: adminToken, userId: adminUserId } = await createAdminWithToken(app));
  });

  function authHeader(accessToken) {
    return { authorization: `Bearer ${accessToken}` };
  }

  async function listTrainers(query = '') {
    return app.inject({ method: 'GET', url: `/admin/trainers${query}`, headers: authHeader(adminToken) });
  }

  async function createSignup({ firstName = 'Sig', lastName = 'Nup', createdAt, email } = {}) {
    const created = await createStudentWithToken(app);
    const data = { roles: [], firstName, lastName };
    if (createdAt) data.createdAt = createdAt;
    if (email) data.email = email;
    const user = await prisma.user.update({ where: { id: created.userId }, data });
    return { ...created, email: user.email };
  }

  async function createInviteRow({ email, status = InviteStatus.PENDING, userId = null, createdAt, expiresAt }) {
    return prisma.trainerInvite.create({
      data: {
        email,
        codeHash: `hash-${email}-${status}-${Math.random()}`,
        status,
        userId,
        invitedByUserId: adminUserId,
        expiresAt: expiresAt ?? new Date(Date.now() + WEEK_MS),
        ...(createdAt ? { createdAt } : {}),
      },
    });
  }

  function byUserId(items, userId) {
    return items.find((item) => item.userId === userId);
  }

  describe('without includeSignups (backward compatible)', () => {
    it('should list only trainers and not signups', async () => {
      const trainer = await createTrainerWithToken(app);
      await createSignup();

      const body = (await listTrainers()).json();

      expect(body.items.map((item) => item.userId)).toEqual([trainer.userId]);
    });

    it('should count only trainers in total', async () => {
      await createTrainerWithToken(app);
      await createSignup();

      const body = (await listTrainers()).json();

      expect(body.total).toBe(1);
    });

    it('should keep tier, subscription and student fields populated for trainers', async () => {
      await createTrainerWithToken(app);

      const [item] = (await listTrainers()).json().items;

      expect(item).toMatchObject({
        trainerId: expect.any(String),
        tier: expect.any(String),
        hasAsaasSubscription: false,
        activeStudents: 0,
      });
    });

    it('should tag trainer items with accountType trainer and the new invite fields', async () => {
      await createTrainerWithToken(app);

      const [item] = (await listTrainers()).json().items;

      expect(item).toMatchObject({
        accountType: ACCOUNT_TYPE.TRAINER,
        inviteStatus: INVITE_FILTER.NONE,
        inviteSentAt: null,
      });
    });
  });

  describe('with includeSignups=true', () => {
    it('should list trainers and signups together', async () => {
      const trainer = await createTrainerWithToken(app);
      const signup = await createSignup();

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(items.map((item) => item.userId).sort()).toEqual([trainer.userId, signup.userId].sort());
    });

    it('should shape a signup item with null plan fields and accountType signup', async () => {
      const signup = await createSignup({ firstName: 'Bia', lastName: 'Souza' });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId)).toMatchObject({
        accountType: ACCOUNT_TYPE.SIGNUP,
        trainerId: null,
        tier: null,
        subscriptionStatus: null,
        activeStudents: null,
        studentCap: null,
        hasAsaasSubscription: false,
        firstName: 'Bia',
        lastName: 'Souza',
        email: signup.email,
      });
    });

    it('should shape a trainer item with accountType trainer', async () => {
      const trainer = await createTrainerWithToken(app);

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, trainer.userId)).toMatchObject({
        accountType: ACCOUNT_TYPE.TRAINER,
        trainerId: trainer.trainerId,
      });
    });

    it('should order trainers and signups by createdAt descending', async () => {
      const oldest = await createSignup({ createdAt: new Date(BASE_TIME) });
      const newest = await createSignup({ createdAt: new Date(BASE_TIME + 2 * HOUR_MS) });
      const middle = await createTrainerWithToken(app);
      await prisma.user.update({ where: { id: middle.userId }, data: { createdAt: new Date(BASE_TIME + HOUR_MS) } });
      await prisma.trainer.update({ where: { id: middle.trainerId }, data: { createdAt: new Date(BASE_TIME + HOUR_MS) } });

      const { items } = (await listTrainers('?includeSignups=true')).json();
      const ids = items.map((item) => item.userId).filter((id) => [oldest, newest, middle].some((u) => u.userId === id));

      expect(ids).toEqual([newest.userId, middle.userId, oldest.userId]);
    });

    it('should paginate with a correct total across trainers and signups', async () => {
      await createTrainerWithToken(app);
      await createSignup({ createdAt: new Date(BASE_TIME) });
      await createSignup({ createdAt: new Date(BASE_TIME + HOUR_MS) });

      const body = (await listTrainers('?includeSignups=true&page=2&pageSize=2')).json();

      expect(body).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(body.items).toHaveLength(1);
    });

    it('should apply search to signups by name case-insensitively', async () => {
      const match = await createSignup({ firstName: 'Zelda', lastName: 'Quasar' });
      await createSignup({ firstName: 'Other', lastName: 'Person' });

      const { items } = (await listTrainers('?includeSignups=true&search=zEL%20quas')).json();

      expect(items.map((item) => item.userId)).toEqual([match.userId]);
    });

    it('should apply search to signups by email', async () => {
      const match = await createSignup({ email: 'needle.signup@example.com' });
      await createSignup();

      const { items } = (await listTrainers('?includeSignups=true&search=NEEDLE.signup')).json();

      expect(items.map((item) => item.userId)).toEqual([match.userId]);
    });

    it('should never list a student linked to a trainer', async () => {
      const trainer = await createTrainerWithToken(app);
      const student = await createSignup();
      await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId: student.userId } });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, student.userId)).toBeUndefined();
    });

    it('should never list a soft-deleted user', async () => {
      const deleted = await createSignup();
      await prisma.user.update({ where: { id: deleted.userId }, data: { deletedAt: new Date() } });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, deleted.userId)).toBeUndefined();
    });

    it('should never list an admin or nutritionist user as a signup', async () => {
      const nutri = await createSignup();
      await prisma.user.update({ where: { id: nutri.userId }, data: { roles: ['nutritionist'] } });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, nutri.userId)).toBeUndefined();
    });

    it('should not list a user who redeemed an invite as a signup', async () => {
      const redeemer = await createSignup();
      await createInviteRow({
        email: redeemer.email,
        status: InviteStatus.ACCEPTED,
        userId: redeemer.userId,
      });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, redeemer.userId)).toBeUndefined();
    });
  });

  describe('inviteStatus and inviteSentAt', () => {
    it('should report none and null inviteSentAt without any invite', async () => {
      const signup = await createSignup();

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId)).toMatchObject({ inviteStatus: INVITE_FILTER.NONE, inviteSentAt: null });
    });

    it('should report pending with the invite createdAt for a non-expired invite to the email', async () => {
      const signup = await createSignup();
      const sentAt = new Date(BASE_TIME);
      await createInviteRow({ email: signup.email, createdAt: sentAt });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId)).toMatchObject({
        inviteStatus: INVITE_FILTER.PENDING,
        inviteSentAt: sentAt.toISOString(),
      });
    });

    it('should match the pending invite email case-insensitively', async () => {
      const signup = await createSignup({ email: 'mixed.case@example.com' });
      await createInviteRow({ email: 'MIXED.Case@Example.com' });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId).inviteStatus).toBe(INVITE_FILTER.PENDING);
    });

    it('should report none for an expired pending invite', async () => {
      const signup = await createSignup();
      await createInviteRow({ email: signup.email, expiresAt: new Date(Date.now() - HOUR_MS) });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId).inviteStatus).toBe(INVITE_FILTER.NONE);
    });

    it('should report none for a revoked invite', async () => {
      const signup = await createSignup();
      await createInviteRow({ email: signup.email, status: InviteStatus.REVOKED });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId).inviteStatus).toBe(INVITE_FILTER.NONE);
    });

    it('should report accepted with the invite createdAt for a trainer who redeemed an invite', async () => {
      const trainer = await createTrainerWithToken(app);
      const sentAt = new Date(BASE_TIME);
      await createInviteRow({
        email: trainer.email,
        status: InviteStatus.ACCEPTED,
        userId: trainer.userId,
        createdAt: sentAt,
      });

      const [item] = (await listTrainers()).json().items;

      expect(item).toMatchObject({ inviteStatus: INVITE_FILTER.ACCEPTED, inviteSentAt: sentAt.toISOString() });
    });

    it('should report pending for a trainer that has a pending invite to their email', async () => {
      const trainer = await createTrainerWithToken(app);
      await createInviteRow({ email: trainer.email });

      const [item] = (await listTrainers()).json().items;

      expect(item.inviteStatus).toBe(INVITE_FILTER.PENDING);
    });
  });

  describe('inviteStatus filter', () => {
    async function seedOnePerState() {
      const none = await createSignup();
      const pending = await createSignup();
      await createInviteRow({ email: pending.email });
      const accepted = await createTrainerWithToken(app);
      await createInviteRow({ email: accepted.email, status: InviteStatus.ACCEPTED, userId: accepted.userId });
      return { none, pending, accepted };
    }

    it.each([
      [INVITE_FILTER.NONE, 'none'],
      [INVITE_FILTER.PENDING, 'pending'],
      [INVITE_FILTER.ACCEPTED, 'accepted'],
    ])('should return only %s items when inviteStatus=%s', async (status, key) => {
      const seeded = await seedOnePerState();

      const { items, total } = (await listTrainers(`?includeSignups=true&inviteStatus=${status}`)).json();

      expect(items.map((item) => item.userId)).toEqual([seeded[key].userId]);
      expect(total).toBe(1);
    });

    it('should combine inviteStatus with search', async () => {
      const first = await createSignup({ firstName: 'Findme' });
      const second = await createSignup({ firstName: 'Hidden' });

      const { items } = (await listTrainers('?includeSignups=true&inviteStatus=none&search=findme')).json();

      expect(items.map((item) => item.userId)).toEqual([first.userId]);
      expect(items.some((item) => item.userId === second.userId)).toBe(false);
    });

    it('should filter trainers only when includeSignups is omitted', async () => {
      const trainer = await createTrainerWithToken(app);
      await createSignup();

      const { items } = (await listTrainers('?inviteStatus=none')).json();

      expect(items.map((item) => item.userId)).toEqual([trainer.userId]);
    });

    it('should reject an invalid inviteStatus with 400 validation error', async () => {
      const response = await listTrainers('?inviteStatus=bogus');

      expect(response.statusCode).toBe(BAD_REQUEST_STATUS);
      expect(response.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: expect.any(String),
      });
    });

    it('should accept includeSignups=false and behave like the default', async () => {
      await createSignup();

      const response = await listTrainers('?includeSignups=false');

      expect(response.statusCode).toBe(OK_STATUS);
      expect(response.json().items.every((item) => item.accountType === ACCOUNT_TYPE.TRAINER)).toBe(true);
    });
  });

  describe('criterion 7: signup redeems an invite', () => {
    it('should make a roles [] signup a trainer on the BETA tier', async () => {
      const signup = await createSignup();
      const create = await app.inject({
        method: 'POST',
        url: '/admin/trainer-invites',
        headers: authHeader(adminToken),
        payload: { email: signup.email },
      });
      const { code } = create.json();

      const redeem = await app.inject({
        method: 'POST',
        url: '/invite/redeem',
        headers: authHeader(signup.accessToken),
        payload: { code },
      });

      expect(redeem.statusCode).toBe(OK_STATUS);
      const user = await prisma.user.findUnique({ where: { id: signup.userId }, include: { trainer: true } });
      expect(user.roles).toContain('trainer');
      const subscription = await prisma.platformSubscription.findUnique({ where: { trainerId: user.trainer.id } });
      expect(subscription).toMatchObject({ tier: BETA_TIER, status: 'ACTIVE' });
    });

    it('should list the redeemer as an accepted trainer afterwards', async () => {
      const signup = await createSignup();
      const { code } = (
        await app.inject({
          method: 'POST',
          url: '/admin/trainer-invites',
          headers: authHeader(adminToken),
          payload: { email: signup.email },
        })
      ).json();
      await app.inject({
        method: 'POST',
        url: '/invite/redeem',
        headers: authHeader(signup.accessToken),
        payload: { code },
      });

      const { items } = (await listTrainers('?includeSignups=true')).json();

      expect(byUserId(items, signup.userId)).toMatchObject({
        accountType: ACCOUNT_TYPE.TRAINER,
        inviteStatus: INVITE_FILTER.ACCEPTED,
      });
    });
  });
});
