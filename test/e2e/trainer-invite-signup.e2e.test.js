import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { signupVerified } from '../helpers/signup-user.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { prisma } from '../../src/db.js';
import emailHandler from '../../src/config/email-handler.js';
import { Roles } from '../../src/constants/roles.js';
import { hashPassword, verifyPassword } from '../../src/helpers/password.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { StudentInviteStatus } from '../../src/constants/student-invite.js';
import { InviteStatus, InviteErrorCode, InviteMessageCode } from '../../src/constants/trainer-invite.js';

// Mirrors normalizeInviteCode()/hashInviteCode() in
// src/services/trainer-invite-service.js (not exported).
function hashInviteCodeForSeed(code) {
  const normalized = code.trim().toUpperCase().replace(/^TF-?/, '').replace(/[^A-Z0-9]/g, '');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const ADMIN_EMAIL = 'admin@example.com';
const INVITEE_EMAIL = 'new-trainer@example.com';
const PASSWORD = 'StrongPassw0rd!';
const OTHER_PASSWORD = 'AnotherPassw0rd!';
const SHORT_PASSWORD = 'Sh0rt!1'; // 7 chars
const UNKNOWN_CODE = 'TF-ZZZZ-ZZZZ-99';
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function expectErrorContract(body, { error, messageCode }) {
  expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
}

e2eDescribe('e2e: POST /auth/signup/invite (trainer invite signup)', () => {
  let app;
  let adminToken;
  let adminUserId;
  let verificationEmails;

  const auth = (token) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    verificationEmails = [];
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async (payload) => {
      verificationEmails.push(payload);
    });
    vi.spyOn(emailHandler, 'sendTrainerInviteEmail').mockResolvedValue(undefined);
    vi.spyOn(emailHandler, 'sendStudentInviteEmail').mockResolvedValue(undefined);

    const admin = await signupVerified(app, { payload: { email: ADMIN_EMAIL, password: PASSWORD } });
    expect(admin.statusCode).toBe(201);
    adminUserId = admin.json().user.id;
    await prisma.user.update({ where: { id: adminUserId }, data: { roles: { set: [Roles.ADMIN] } } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: ADMIN_EMAIL, password: PASSWORD } });
    adminToken = login.json().token.accessToken;
    verificationEmails = [];
    emailHandler.sendEmailVerificationEmail.mockClear();
  });

  async function createInviteCode(email = INVITEE_EMAIL) {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/trainer-invites',
      headers: auth(adminToken),
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    return { code: res.json().code, inviteId: res.json().invite.id };
  }

  const signupWithInvite = (code, password = PASSWORD) =>
    app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code, password } });

  const getMe = (token) => app.inject({ method: 'GET', url: '/me', headers: auth(token) });

  async function seedInvite({ code, email = INVITEE_EMAIL, status = InviteStatus.PENDING, expiresAt = new Date(Date.now() + WEEK_MS) }) {
    return prisma.trainerInvite.create({
      data: { email, codeHash: hashInviteCodeForSeed(code), status, invitedByUserId: adminUserId, expiresAt },
    });
  }

  async function createTrainerWithStudentCapacity(email) {
    const res = await signupVerified(app, { payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    const userId = res.json().user.id;
    const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(res.json().token.accessToken) });
    expect(become.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { token: become.json().token.accessToken, trainerId: trainer.id };
  }

  describe('happy path', () => {
    it('should answer 201 with the signup response shape', async () => {
      const { code } = await createInviteCode();

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        user: { id: expect.any(String) },
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
        linkedTrainers: 0,
        betaAccess: true,
        activeProfile: 'trainer',
      });
    });

    it('should create an active trainer user with a hashed password and a Trainer row', async () => {
      const { code } = await createInviteCode();

      const res = await signupWithInvite(code);

      const user = await prisma.user.findUnique({ where: { id: res.json().user.id } });
      expect(user).toMatchObject({ email: INVITEE_EMAIL, roles: [Roles.TRAINER], status: 'active' });
      expect(verifyPassword(PASSWORD, user.passwordHash)).toBe(true);
      expect(await prisma.trainer.count({ where: { userId: user.id } })).toBe(1);
    });

    it('should expose the trainer profile and onboarding on GET /me like a /become-trainer user', async () => {
      const { code } = await createInviteCode();
      const res = await signupWithInvite(code);

      const me = await app.inject({
        method: 'GET',
        url: '/me?include=trainerOnboarding',
        headers: auth(res.json().token.accessToken),
      });

      expect(me.statusCode).toBe(200);
      expect(me.json().trainerOnboarding).toBeDefined();
      expect(me.json().trainerOnboarding).not.toBeNull();
    });

    it('should create an email account with verifiedAt set', async () => {
      const { code } = await createInviteCode();

      const res = await signupWithInvite(code);

      const account = await prisma.account.findFirst({ where: { userId: res.json().user.id, provider: EMAIL_PROVIDER } });
      expect(account).toMatchObject({ providerId: INVITEE_EMAIL, verifiedAt: expect.any(Date) });
    });

    it('should set the active profile preference to trainer', async () => {
      const { code } = await createInviteCode();

      const res = await signupWithInvite(code);

      const preferences = await prisma.userPreferences.findUnique({ where: { userId: res.json().user.id } });
      expect(preferences.activeProfile).toBe('trainer');
    });

    it('should accept the invite and record the new user on it', async () => {
      const { code, inviteId } = await createInviteCode();

      const res = await signupWithInvite(code);

      const invite = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });
      expect(invite).toMatchObject({
        status: InviteStatus.ACCEPTED,
        userId: res.json().user.id,
        acceptedAt: expect.any(Date),
      });
    });

    it('should return an access token that works on GET /me with a verified email and the trainer role', async () => {
      const { code } = await createInviteCode();
      const res = await signupWithInvite(code);

      const me = await getMe(res.json().token.accessToken);

      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        id: res.json().user.id,
        email: INVITEE_EMAIL,
        emailVerified: true,
        betaAccess: true,
      });
      expect(me.json().roles).toContain(Roles.TRAINER);
    });

    it('should return a refresh token that can be exchanged for a new access token', async () => {
      const { code } = await createInviteCode();
      const res = await signupWithInvite(code);

      const refreshed = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: res.json().refreshToken },
      });

      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().token.accessToken).toBeTypeOf('string');
    });

    it('should allow logging in with the chosen password afterwards', async () => {
      const { code } = await createInviteCode();
      await signupWithInvite(code);

      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: INVITEE_EMAIL, password: PASSWORD } });

      expect(login.statusCode).toBe(200);
    });

    it('should not send any 6-digit verification email nor create a signup code', async () => {
      const { code } = await createInviteCode();

      await signupWithInvite(code);
      await new Promise((resolve) => setTimeout(resolve, 200));

      expect(emailHandler.sendEmailVerificationEmail).not.toHaveBeenCalled();
      expect(verificationEmails).toHaveLength(0);
      expect(await prisma.pendingSignupCode.count()).toBe(0);
    });

    it('should accept a lowercase code typed without dashes', async () => {
      const { code } = await createInviteCode();

      const res = await signupWithInvite(code.toLowerCase().replace(/-/g, ''));

      expect(res.statusCode).toBe(201);
    });

    it('should use the invite email, normalized to lowercase, even when the invite was stored mixed-case', async () => {
      const code = 'TF-MIXD-CASE-01';
      await seedInvite({ code, email: 'Mixed.Case@Example.com' });

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(201);
      const user = await prisma.user.findUnique({ where: { id: res.json().user.id } });
      expect(user.email).toBe('mixed.case@example.com');
    });
  });

  describe('pending signup cleanup', () => {
    it('should delete the pending signup and its codes for the invited email', async () => {
      const { code } = await createInviteCode();
      const pendingSignup = await prisma.pendingSignup.create({ data: { email: INVITEE_EMAIL } });
      await prisma.pendingSignupCode.create({
        data: {
          pendingSignupId: pendingSignup.id,
          tokenHash: crypto.createHash('sha256').update('123456').digest('hex'),
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      });

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(201);
      expect(await prisma.pendingSignup.count({ where: { email: INVITEE_EMAIL } })).toBe(0);
      expect(await prisma.pendingSignupCode.count({ where: { pendingSignupId: pendingSignup.id } })).toBe(0);
    });

    it('should keep pending signups of other emails', async () => {
      const { code } = await createInviteCode();
      await prisma.pendingSignup.create({ data: { email: 'someone-else@example.com' } });

      await signupWithInvite(code);

      expect(await prisma.pendingSignup.count({ where: { email: 'someone-else@example.com' } })).toBe(1);
    });

    it('should leave no pending signup when a real POST /auth/signup preceded the invite signup', async () => {
      const { code } = await createInviteCode();
      const signup = await app.inject({ method: 'POST', url: '/auth/signup', payload: { email: INVITEE_EMAIL, password: PASSWORD } });
      expect(signup.statusCode).toBe(202);
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline && (await prisma.pendingSignup.count({ where: { email: INVITEE_EMAIL } })) === 0) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(201);
      expect(await prisma.pendingSignup.count({ where: { email: INVITEE_EMAIL } })).toBe(0);
    });
  });

  describe('pending student invites', () => {
    it('should accept pending student invites for the email and report linkedTrainers', async () => {
      const trainerA = await createTrainerWithStudentCapacity('trainer-a@example.com');
      const trainerB = await createTrainerWithStudentCapacity('trainer-b@example.com');
      for (const trainer of [trainerA, trainerB]) {
        const invited = await app.inject({
          method: 'POST',
          url: '/trainer/student-invites',
          headers: auth(trainer.token),
          payload: { email: INVITEE_EMAIL },
        });
        expect(invited.statusCode).toBe(201);
      }
      const { code } = await createInviteCode();

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(201);
      expect(res.json().linkedTrainers).toBe(2);
      const links = await prisma.trainerStudent.count({ where: { studentId: res.json().user.id } });
      expect(links).toBe(2);
      const accepted = await prisma.studentInvite.count({ where: { email: INVITEE_EMAIL, status: StudentInviteStatus.ACCEPTED } });
      expect(accepted).toBe(2);
    });
  });

  describe('invite errors', () => {
    it('should answer 404 invite.notFound for an unknown code', async () => {
      const res = await signupWithInvite(UNKNOWN_CODE);

      expect(res.statusCode).toBe(404);
      expectErrorContract(res.json(), { error: InviteErrorCode.INVITE_NOT_FOUND, messageCode: InviteMessageCode.NOT_FOUND });
      expect(await prisma.user.findFirst({ where: { email: INVITEE_EMAIL } })).toBeNull();
    });

    it('should answer 403 invite.revoked for a revoked invite and create no user', async () => {
      const { code, inviteId } = await createInviteCode();
      await prisma.trainerInvite.update({ where: { id: inviteId }, data: { status: InviteStatus.REVOKED, revokedAt: new Date() } });

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(403);
      expectErrorContract(res.json(), { error: InviteErrorCode.INVITE_REVOKED, messageCode: InviteMessageCode.REVOKED });
      expect(await prisma.user.findFirst({ where: { email: INVITEE_EMAIL } })).toBeNull();
    });

    it('should answer 403 invite.expired and flip the pending invite to expired', async () => {
      const code = 'TF-EXPD-CODE-01';
      const invite = await seedInvite({ code, expiresAt: new Date(Date.now() - HOUR_MS) });

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(403);
      expectErrorContract(res.json(), { error: InviteErrorCode.INVITE_EXPIRED, messageCode: InviteMessageCode.EXPIRED });
      const persisted = await prisma.trainerInvite.findUnique({ where: { id: invite.id } });
      expect(persisted.status).toBe(InviteStatus.EXPIRED);
      expect(await prisma.user.findFirst({ where: { email: INVITEE_EMAIL } })).toBeNull();
    });

    it('should answer 409 invite.alreadyAccepted when the code was already used', async () => {
      const { code } = await createInviteCode();
      expect((await signupWithInvite(code)).statusCode).toBe(201);

      const res = await signupWithInvite(code, OTHER_PASSWORD);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: InviteErrorCode.INVITE_ALREADY_ACCEPTED, messageCode: InviteMessageCode.ALREADY_ACCEPTED });
      expect(await prisma.user.count({ where: { email: INVITEE_EMAIL } })).toBe(1);
    });
  });

  describe('existing account', () => {
    it('should answer 409 trainerInvite.accountExists and create nothing for a registered email', async () => {
      const { code, inviteId } = await createInviteCode();
      await seedLegacyUnverifiedUser(app, { email: INVITEE_EMAIL, password: OTHER_PASSWORD });
      const usersBefore = await prisma.user.count();

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: InviteErrorCode.INVITE_ACCOUNT_EXISTS, messageCode: InviteMessageCode.ACCOUNT_EXISTS });
      expect(await prisma.user.count()).toBe(usersBefore);
      const invite = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });
      expect(invite).toMatchObject({ status: InviteStatus.PENDING, userId: null });
    });

    it('should not change the existing account password or roles', async () => {
      const { code } = await createInviteCode();
      const existing = await seedLegacyUnverifiedUser(app, { email: INVITEE_EMAIL, password: OTHER_PASSWORD });

      await signupWithInvite(code, PASSWORD);

      const user = await prisma.user.findUnique({ where: { id: existing.userId } });
      expect(verifyPassword(OTHER_PASSWORD, user.passwordHash)).toBe(true);
      expect(user.roles).not.toContain(Roles.TRAINER);
      expect(await prisma.trainer.count({ where: { userId: existing.userId } })).toBe(0);
    });

    it('should match the existing account case-insensitively', async () => {
      const { code } = await createInviteCode();
      await prisma.user.create({
        data: { email: 'New-Trainer@Example.com', passwordHash: hashPassword(OTHER_PASSWORD), roles: [], status: 'pending' },
      });

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(409);
      expect(res.json().messageCode).toBe(InviteMessageCode.ACCOUNT_EXISTS);
    });

    it('should answer 409 accountExists for a soft-deleted account with the same email', async () => {
      const { code, inviteId } = await createInviteCode();
      await prisma.user.create({
        data: { email: INVITEE_EMAIL, passwordHash: hashPassword(OTHER_PASSWORD), roles: [], status: 'pending', deletedAt: new Date() },
      });

      const res = await signupWithInvite(code);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: InviteErrorCode.INVITE_ACCOUNT_EXISTS, messageCode: InviteMessageCode.ACCOUNT_EXISTS });
      expect(await prisma.user.count({ where: { email: INVITEE_EMAIL } })).toBe(1);
      const invite = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });
      expect(invite.status).toBe(InviteStatus.PENDING);
    });
  });

  describe('validation', () => {
    it('should answer 400 validation.failed for a password shorter than 8 characters and keep the invite pending', async () => {
      const { code, inviteId } = await createInviteCode();

      const res = await signupWithInvite(code, SHORT_PASSWORD);

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      // The web signup maps the error to the password field through details[].field.
      expect(res.json().details).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'password' })]));
      expect(await prisma.user.findFirst({ where: { email: INVITEE_EMAIL } })).toBeNull();
      const invite = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });
      expect(invite.status).toBe(InviteStatus.PENDING);
    });

    it('should answer 400 validation.failed when the code is missing', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { password: PASSWORD } });

      expect(res.statusCode).toBe(400);
      expect(res.json().messageCode).toBe('validation.failed');
    });

    it('should answer 400 validation.failed when the password is missing', async () => {
      const { code } = await createInviteCode();

      const res = await app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code } });

      expect(res.statusCode).toBe(400);
      expect(res.json().messageCode).toBe('validation.failed');
    });

    it('should be public: no Authorization header required', async () => {
      const { code } = await createInviteCode();

      const res = await app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code, password: PASSWORD } });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('concurrency', () => {
    it('should create exactly one user when the same code is submitted twice at once', async () => {
      const { code, inviteId } = await createInviteCode();

      const [first, second] = await Promise.all([signupWithInvite(code), signupWithInvite(code, OTHER_PASSWORD)]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([201, 409]);
      expect(await prisma.user.count({ where: { email: INVITEE_EMAIL } })).toBe(1);
      expect(await prisma.trainer.count({ where: { user: { email: INVITEE_EMAIL } } })).toBe(1);
      const invite = await prisma.trainerInvite.findUnique({ where: { id: inviteId } });
      expect(invite.status).toBe(InviteStatus.ACCEPTED);
    });

    it('should answer the loser with a 409 error contract', async () => {
      const { code } = await createInviteCode();

      const responses = await Promise.all([signupWithInvite(code), signupWithInvite(code)]);

      const loser = responses.find((response) => response.statusCode === 409);
      expect(loser).toBeDefined();
      expect([InviteErrorCode.INVITE_ALREADY_ACCEPTED, InviteErrorCode.INVITE_ACCOUNT_EXISTS]).toContain(loser.json().error);
      expect(loser.json()).toMatchObject({ messageCode: expect.any(String), message: expect.any(String) });
    });
  });
});
