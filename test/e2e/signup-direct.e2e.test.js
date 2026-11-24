import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { createAdminWithToken, createTrainerWithToken } from '../helpers/admin-users.js';
import { expectErrorContract } from '../helpers/nutrition-e2e.js';
import emailHandler from '../../src/config/email-handler.js';
import { verifyPassword } from '../../src/helpers/password.js';
import { EMAIL_PROVIDER, EMAIL_VERIFICATION_CODE_LENGTH } from '../../src/constants/email-verification.js';
import { Roles } from '../../src/constants/roles.js';
import { StudentInviteStatus } from '../../src/constants/student-invite.js';

vi.mock('../../src/services/google-id-token-service.js', () => ({
  verifyGoogleIdToken: vi.fn(),
}));
vi.mock('../../src/services/apple-id-token-service.js', () => ({
  verifyAppleIdToken: vi.fn(),
}));
vi.mock('../../src/services/firebase-id-token-service.js', () => ({
  verifyFirebaseIdToken: vi.fn(),
}));

import { verifyGoogleIdToken } from '../../src/services/google-id-token-service.js';
import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';
import { verifyFirebaseIdToken } from '../../src/services/firebase-id-token-service.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const SIGNUP_DIRECT_URL = '/auth/signup/direct';
const PASSWORD = 'StrongPassw0rd!';
const SHORT_PASSWORD = 'Short1!';
const FIRST_NAME = 'Bia';
const LAST_NAME = 'Souza';
const SIGNUP_SOURCE_WEB_DIRECT = 'web_direct';
const EMAIL_IN_USE = 'EMAIL_IN_USE';
const VALIDATION_ERROR = 'VALIDATION_ERROR';
const VALIDATION_MESSAGE_CODE = 'validation.failed';
const CODE_PATTERN = new RegExp(`^[0-9]{${EMAIL_VERIFICATION_CODE_LENGTH}}$`);
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 5000;
const SETTLE_MS = 300;

// Polls until the condition returns a truthy value, which it then returns.
async function waitFor(condition) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return null;
}

// Gives deferred work time to run before a "nothing was sent" assertion.
function settle() {
  return new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
}

e2eDescribe('e2e: POST /auth/signup/direct (open professional signup)', () => {
  let app;
  let sentCodes;
  let emailCounter = 0;

  const uniqueEmail = (prefix) => {
    emailCounter += 1;
    return `e2e+${prefix}-${Date.now()}-${emailCounter}@example.com`;
  };
  const auth = (token) => ({ authorization: `Bearer ${token}` });

  const signupDirect = (payload, headers) => app.inject({ method: 'POST', url: SIGNUP_DIRECT_URL, payload, headers });
  const validBody = (email, overrides = {}) => ({ email, password: PASSWORD, firstName: FIRST_NAME, lastName: LAST_NAME, ...overrides });
  const login = (email, password = PASSWORD) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  const getMe = (token) => app.inject({ method: 'GET', url: '/me', headers: auth(token) });
  const verifyEmail = (token, code) =>
    app.inject({ method: 'POST', url: '/auth/verify-email', headers: auth(token), payload: { code } });
  const findUserByEmail = (email) => prisma.user.findUnique({ where: { email }, include: { accounts: true } });
  const codesSentTo = (email) => sentCodes.filter((sent) => sent.to === email).map((sent) => sent.code);
  const waitForCode = (email) => waitFor(() => codesSentTo(email)[0]);

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    sentCodes = [];
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      sentCodes.push({ to, code });
      return { data: { id: 'email-id' } };
    });
    vi.spyOn(emailHandler, 'sendExistingAccountSignupEmail').mockResolvedValue({ data: { id: 'email-id' } });
    vi.spyOn(emailHandler, 'sendStudentInviteEmail').mockResolvedValue({ data: { id: 'email-id' } });
    vi.spyOn(emailHandler, 'sendExistingUserStudentInviteEmail').mockResolvedValue({ data: { id: 'email-id' } });
  });

  describe('with an unused email', () => {
    it('should answer 201 with the same body shape as POST /auth/signup/verify', async () => {
      const res = await signupDirect(validBody(uniqueEmail('direct')));

      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({
        user: { id: expect.any(String) },
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
        linkedTrainers: 0,
      });
    });

    it('should create the user with no roles and the given names', async () => {
      const email = uniqueEmail('direct');

      const res = await signupDirect(validBody(email));

      const user = await findUserByEmail(email);
      expect(user).toMatchObject({ id: res.json().user.id, email, roles: [], firstName: FIRST_NAME, lastName: LAST_NAME });
    });

    it('should store the email lowercased', async () => {
      const email = uniqueEmail('direct');

      const res = await signupDirect(validBody(email.toUpperCase()));

      expect(res.statusCode).toBe(201);
      const user = await prisma.user.findUnique({ where: { id: res.json().user.id } });
      expect(user.email).toBe(email);
    });

    it('should accept a signup without lastName', async () => {
      const email = uniqueEmail('direct');

      const res = await signupDirect({ email, password: PASSWORD, firstName: FIRST_NAME });

      expect(res.statusCode).toBe(201);
      const user = await findUserByEmail(email);
      expect(user.firstName).toBe(FIRST_NAME);
      expect(user.lastName).toBeNull();
    });

    it('should store the password hashed', async () => {
      const email = uniqueEmail('direct');

      await signupDirect(validBody(email));

      const user = await findUserByEmail(email);
      expect(user.passwordHash).not.toBe(PASSWORD);
      expect(verifyPassword(PASSWORD, user.passwordHash)).toBe(true);
    });

    it('should create one email Account that is not verified yet', async () => {
      const email = uniqueEmail('direct');

      await signupDirect(validBody(email));

      const user = await findUserByEmail(email);
      expect(user.accounts).toEqual([
        expect.objectContaining({ provider: EMAIL_PROVIDER, providerId: email, verifiedAt: null }),
      ]);
    });

    it('should record signupSource web_direct', async () => {
      const email = uniqueEmail('direct');

      await signupDirect(validBody(email));

      const user = await findUserByEmail(email);
      expect(user.signupSource).toBe(SIGNUP_SOURCE_WEB_DIRECT);
    });

    it('should return an access token that reaches GET /me with emailVerified false and betaAccess true', async () => {
      const email = uniqueEmail('direct');
      const res = await signupDirect(validBody(email));

      const me = await getMe(res.json().token.accessToken);

      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({ email, roles: [], firstName: FIRST_NAME, emailVerified: false, betaAccess: true });
    });

    it('should not expose signupSource in GET /me', async () => {
      const res = await signupDirect(validBody(uniqueEmail('direct')));

      const me = await getMe(res.json().token.accessToken);

      expect(me.json()).not.toHaveProperty('signupSource');
    });

    it('should return a refresh token that rotates', async () => {
      const res = await signupDirect(validBody(uniqueEmail('direct')));

      const refreshed = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: res.json().refreshToken } });

      expect(refreshed.statusCode).toBe(200);
    });

    it('should let the user log in with the password right away, before verifying the email', async () => {
      const email = uniqueEmail('direct');
      await signupDirect(validBody(email));

      const res = await login(email);

      expect(res.statusCode).toBe(200);
    });

    it('should ignore properties outside the schema, such as roles or signupSource', async () => {
      const email = uniqueEmail('direct');

      const res = await signupDirect(validBody(email, { roles: [Roles.ADMIN], signupSource: 'forged', status: 'forged' }));

      expect(res.statusCode).toBe(201);
      const user = await findUserByEmail(email);
      expect(user.roles).toEqual([]);
      expect(user.signupSource).toBe(SIGNUP_SOURCE_WEB_DIRECT);
    });
  });

  describe('verification code email', () => {
    it('should email a 6-digit verification code to the normalized email', async () => {
      const email = uniqueEmail('direct');

      await signupDirect(validBody(email.toUpperCase()));

      expect(await waitForCode(email)).toMatch(CODE_PATTERN);
    });

    it('should send a code that verifies the email through POST /auth/verify-email', async () => {
      const email = uniqueEmail('direct');
      const { token } = (await signupDirect(validBody(email))).json();
      const code = await waitForCode(email);

      const verified = await verifyEmail(token.accessToken, code);

      expect(verified.statusCode).toBe(200);
      const me = await getMe(token.accessToken);
      expect(me.json().emailVerified).toBe(true);
    });

    it('should still answer 201 and create the account when the email provider fails', async () => {
      emailHandler.sendEmailVerificationEmail.mockRejectedValue(new Error('provider down'));
      vi.spyOn(console, 'error').mockImplementation(() => {});
      const email = uniqueEmail('direct');

      const res = await signupDirect(validBody(email));

      expect(res.statusCode).toBe(201);
      expect(await findUserByEmail(email)).not.toBeNull();
    });
  });

  describe('pending student invites for the email', () => {
    let trainer;
    let email;

    beforeEach(async () => {
      trainer = await createTrainerWithToken(app);
      email = uniqueEmail('invited');
      const invited = await app.inject({
        method: 'POST',
        url: '/trainer/student-invites',
        headers: auth(trainer.accessToken),
        payload: { email },
      });
      expect(invited.statusCode).toBe(201);
    });

    it('should not link the unverified account to the trainer at signup', async () => {
      const res = await signupDirect(validBody(email));

      expect(res.json().linkedTrainers).toBe(0);
      expect(await prisma.trainerStudent.count({ where: { studentId: res.json().user.id } })).toBe(0);
      const invite = await prisma.studentInvite.findFirst({ where: { email } });
      expect(invite.status).toBe(StudentInviteStatus.PENDING);
    });

    it('should link the account once the email is verified with the code', async () => {
      const { token, user } = (await signupDirect(validBody(email))).json();
      const code = await waitForCode(email);

      const verified = await verifyEmail(token.accessToken, code);

      expect(verified.json()).toMatchObject({ verified: true, linkedTrainers: 1 });
      expect(await prisma.trainerStudent.count({ where: { studentId: user.id } })).toBe(1);
    });
  });

  describe('request validation', () => {
    it.each([
      ['a password shorter than 8 characters', { password: SHORT_PASSWORD }],
      ['a malformed email', { email: 'not-an-email' }],
      ['an empty firstName', { firstName: '' }],
    ])('should answer 400 VALIDATION_ERROR for %s and create no user', async (_label, overrides) => {
      const res = await signupDirect(validBody(uniqueEmail('invalid'), overrides));

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: VALIDATION_ERROR,
        messageCode: VALIDATION_MESSAGE_CODE,
        message: expect.any(String),
        details: expect.any(Array),
      });
      expect(await prisma.user.count()).toBe(0);
    });

    it('should answer 400 VALIDATION_ERROR when firstName is missing', async () => {
      const res = await signupDirect({ email: uniqueEmail('invalid'), password: PASSWORD });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: VALIDATION_ERROR, messageCode: VALIDATION_MESSAGE_CODE });
    });
  });

  describe('with an email that already has an account', () => {
    let existingEmail;
    let existingUserId;

    beforeEach(async () => {
      existingEmail = uniqueEmail('owner');
      const res = await signupVerified(app, { payload: { email: existingEmail, password: PASSWORD } });
      expect(res.statusCode).toBe(201);
      existingUserId = res.json().user.id;
      sentCodes = [];
    });

    it('should answer 409 EMAIL_IN_USE with the unified error contract', async () => {
      const res = await signupDirect(validBody(existingEmail));

      const body = expectErrorContract(res, { statusCode: 409, error: EMAIL_IN_USE });
      expect(body.messageCode.length).toBeGreaterThan(0);
    });

    it('should match the existing account case-insensitively', async () => {
      const res = await signupDirect(validBody(existingEmail.toUpperCase()));

      expectErrorContract(res, { statusCode: 409, error: EMAIL_IN_USE });
    });

    it('should return no tokens', async () => {
      const res = await signupDirect(validBody(existingEmail));

      expect(res.json()).not.toHaveProperty('token');
      expect(res.json()).not.toHaveProperty('refreshToken');
    });

    it('should create no second user and no second account', async () => {
      await signupDirect(validBody(existingEmail, { password: 'AnotherPassw0rd!' }));

      expect(await prisma.user.count()).toBe(1);
      expect(await prisma.account.count({ where: { userId: existingUserId } })).toBe(1);
    });

    it('should leave the existing account untouched', async () => {
      const before = await prisma.user.findUnique({ where: { id: existingUserId } });

      await signupDirect(validBody(existingEmail, { password: 'AnotherPassw0rd!', firstName: 'Mallory' }));

      const after = await prisma.user.findUnique({ where: { id: existingUserId } });
      expect(after).toEqual(before);
      expect((await login(existingEmail)).statusCode).toBe(200);
    });

    it('should send no verification code', async () => {
      await signupDirect(validBody(existingEmail));
      await settle();

      expect(sentCodes).toEqual([]);
      expect(await prisma.emailVerificationToken.count({ where: { userId: existingUserId } })).toBe(0);
    });

    it('should answer 409 for a second direct signup with the same email', async () => {
      const email = uniqueEmail('twice');
      expect((await signupDirect(validBody(email))).statusCode).toBe(201);

      const res = await signupDirect(validBody(email));

      expectErrorContract(res, { statusCode: 409, error: EMAIL_IN_USE });
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });
  });

  describe('signupSource stays null for every other signup path', () => {
    const signupSourceOf = async (userId) => (await prisma.user.findUnique({ where: { id: userId } })).signupSource;

    it('should be null for POST /auth/signup + /auth/signup/verify', async () => {
      const res = await signupVerified(app, { payload: { email: uniqueEmail('code'), password: PASSWORD } });

      expect(res.statusCode).toBe(201);
      expect(await signupSourceOf(res.json().user.id)).toBeNull();
    });

    it('should be null for POST /auth/google/web', async () => {
      verifyFirebaseIdToken.mockResolvedValue({ subject: 'firebase-subject-1', email: uniqueEmail('gweb'), name: 'Web Person', emailVerified: true });

      const res = await app.inject({ method: 'POST', url: '/auth/google/web', payload: { idToken: 'mock-token' } });

      expect(res.statusCode).toBe(200);
      expect(await signupSourceOf(res.json().user.id)).toBeNull();
    });

    it('should be null for POST /auth/google/mobile', async () => {
      verifyGoogleIdToken.mockResolvedValue({ subject: 'google-subject-1', email: uniqueEmail('gmobile'), name: 'Mobile Person', emailVerified: true });

      const res = await app.inject({ method: 'POST', url: '/auth/google/mobile', payload: { idToken: 'mock-token' } });

      expect(res.statusCode).toBeLessThan(300);
      expect(await signupSourceOf(res.json().user.id)).toBeNull();
    });

    it('should be null for POST /auth/apple/mobile', async () => {
      verifyAppleIdToken.mockResolvedValue({ subject: 'apple.subject.1', email: uniqueEmail('apple'), emailVerified: true, isPrivateEmail: false });

      const res = await app.inject({ method: 'POST', url: '/auth/apple/mobile', payload: { identityToken: 'mock-token' } });

      expect(res.statusCode).toBeLessThan(300);
      expect(await signupSourceOf(res.json().user.id)).toBeNull();
    });

    it('should be null for POST /auth/signup/invite', async () => {
      const { accessToken: adminToken } = await createAdminWithToken(app);
      const invited = await app.inject({
        method: 'POST',
        url: '/admin/trainer-invites',
        headers: auth(adminToken),
        payload: { email: uniqueEmail('invitee') },
      });
      expect(invited.statusCode).toBe(201);

      const res = await app.inject({ method: 'POST', url: '/auth/signup/invite', payload: { code: invited.json().code, password: PASSWORD } });

      expect(res.statusCode).toBe(201);
      expect(await signupSourceOf(res.json().user.id)).toBeNull();
    });
  });
});
