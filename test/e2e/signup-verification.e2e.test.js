import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { signupVerified } from '../helpers/signup-user.js';
import emailHandler from '../../src/config/email-handler.js';
import { hashPassword, verifyPassword } from '../../src/helpers/password.js';
import {
  EmailVerificationErrorCode,
  EmailVerificationMessageCode,
  EMAIL_PROVIDER,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
} from '../../src/constants/email-verification.js';
import { SignupStatus } from '../../src/constants/signup-verification.js';
import { StudentInviteStatus } from '../../src/constants/student-invite.js';

const PASSWORD = 'StrongPassw0rd!';
const OTHER_PASSWORD = 'AnotherPassw0rd!';
const PENDING_BODY = { status: SignupStatus.PENDING_VERIFICATION };
// Signup / resend do their work after the response; negative checks ("nothing
// was sent") wait this long for the deferred task to have run.
const DEFERRED_SETTLE_MS = 300;
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 5000;

const settle = () => new Promise((resolve) => setTimeout(resolve, DEFERRED_SETTLE_MS));

async function waitFor(condition) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  throw new Error('Timed out waiting for the deferred signup task');
}

describe('e2e: signup with email verification (no enumeration)', () => {
  let app;
  let sentCodes;
  let existingAccountEmails;
  let emailCounter = 0;

  const uniqueEmail = (prefix) => `${prefix}-${Date.now()}-${emailCounter++}@example.com`;
  const auth = (token) => ({ authorization: `Bearer ${token}` });

  const signup = (email, password = PASSWORD, headers) =>
    app.inject({ method: 'POST', url: '/auth/signup', payload: { email, password }, headers });
  const verify = (email, code, password = PASSWORD, headers) =>
    app.inject({ method: 'POST', url: '/auth/signup/verify', payload: { email, code, password }, headers });
  const resend = (email) => app.inject({ method: 'POST', url: '/auth/signup/resend', payload: { email } });
  const login = (email, password) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

  const codesSentTo = (email) => sentCodes.filter((sent) => sent.to === email).map((sent) => sent.code);
  const waitForCode = (email, nth = 1) => waitFor(() => codesSentTo(email)[nth - 1]);

  async function signupAndGetCode(email, password = PASSWORD) {
    const res = await signup(email, password);
    expect(res.statusCode).toBe(202);
    return waitForCode(email);
  }

  async function createActiveUser(email) {
    const res = await signupVerified(app, { payload: { email, password: PASSWORD } });
    expect(res.statusCode).toBe(201);
    sentCodes = [];
    return res.json();
  }

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    sentCodes = [];
    existingAccountEmails = [];
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      sentCodes.push({ to, code });
      return { data: { id: 'email-id' } };
    });
    vi.spyOn(emailHandler, 'sendExistingAccountSignupEmail').mockImplementation(async ({ to }) => {
      existingAccountEmails.push(to);
      return { data: { id: 'email-id' } };
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /auth/signup', () => {
    it('should answer 202 pending_verification and email a code without creating a user', async () => {
      const email = uniqueEmail('new');

      const res = await signup(email);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(PENDING_BODY);
      expect(await waitForCode(email)).toMatch(/^[0-9]{6}$/);
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      expect(await prisma.pendingSignup.findUnique({ where: { email } })).not.toBeNull();
    });

    it('should not store the password anywhere before verification', async () => {
      const email = uniqueEmail('no-hash');

      await signupAndGetCode(email);

      const pending = await prisma.pendingSignup.findUnique({ where: { email } });
      expect(Object.keys(pending)).not.toContain('passwordHash');
      expect(JSON.stringify(pending)).not.toContain(PASSWORD);
    });

    it('should answer the exact same 202 for an email that already has an account, without touching it', async () => {
      const email = uniqueEmail('taken');
      const { user } = await createActiveUser(email);
      const before = await prisma.user.findUnique({ where: { id: user.id } });

      const res = await signup(email, OTHER_PASSWORD);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(PENDING_BODY);
      await waitFor(() => existingAccountEmails.length > 0);
      expect(existingAccountEmails).toEqual([email]);
      expect(codesSentTo(email)).toEqual([]);
      const after = await prisma.user.findUnique({ where: { id: user.id } });
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });

    it('should match an existing account case-insensitively', async () => {
      const email = uniqueEmail('case');
      await createActiveUser(email);

      await signup(email.toUpperCase());

      await waitFor(() => existingAccountEmails.length > 0);
      expect(codesSentTo(email)).toEqual([]);
      expect(await prisma.user.count()).toBe(1);
    });

    // Without a decoy pending signup on owned emails, an email with an account
    // would answer invalidCode forever while a free one reaches 429 after the
    // attempts cap: an enumeration oracle on the public verify endpoint.
    it.each([
      ['an email that has an account', true],
      ['an email without an account', false],
    ])('should make /auth/signup/verify reach tooManyAttempts the same way for %s', async (_label, hasAccount) => {
      const email = uniqueEmail(hasAccount ? 'oracle-taken' : 'oracle-free');
      if (hasAccount) await createActiveUser(email);

      expect((await signup(email)).statusCode).toBe(202);
      await waitFor(() => prisma.pendingSignupCode.findFirst({ where: { pendingSignup: { email } } }));
      if (!hasAccount) await waitForCode(email);

      const guess = codesSentTo(email)[0] === '000000' ? '111111' : '000000';
      const statuses = [];
      for (let attempt = 0; attempt <= EMAIL_VERIFICATION_MAX_ATTEMPTS; attempt += 1) {
        const res = await verify(email, guess);
        statuses.push(`${res.statusCode}:${res.json().messageCode}`);
      }

      expect(statuses).toEqual([
        ...Array(EMAIL_VERIFICATION_MAX_ATTEMPTS).fill(`400:${EmailVerificationMessageCode.INVALID_CODE}`),
        `429:${EmailVerificationMessageCode.TOO_MANY_ATTEMPTS}`,
      ]);
      expect(await prisma.user.count({ where: { email } })).toBe(hasAccount ? 1 : 0);
    });

    it('should send the "existing account" email at most once per throttle window', async () => {
      const email = uniqueEmail('throttle');
      await createActiveUser(email);

      await signup(email);
      await waitFor(() => existingAccountEmails.length > 0);
      await signup(email);
      await settle();

      expect(existingAccountEmails).toHaveLength(1);
    });

    it('should answer 202 and send nothing for a deleted account', async () => {
      const email = uniqueEmail('deleted');
      const { user } = await createActiveUser(email);
      await prisma.user.update({ where: { id: user.id }, data: { deletedAt: new Date() } });

      const res = await signup(email);
      await settle();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(PENDING_BODY);
      expect(existingAccountEmails).toEqual([]);
      expect(codesSentTo(email)).toEqual([]);
    });

    it('should not issue a second code while the resend cooldown runs', async () => {
      const email = uniqueEmail('cooldown');
      await signupAndGetCode(email);

      const res = await signup(email);
      await settle();

      expect(res.statusCode).toBe(202);
      expect(codesSentTo(email)).toHaveLength(1);
    });

    it.each([
      ['an invalid email', { email: 'not-an-email', password: PASSWORD }, 'email'],
      ['a short password', { email: 'someone@example.com', password: 'short' }, 'password'],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, payload, field) => {
      const res = await app.inject({ method: 'POST', url: '/auth/signup', payload });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: expect.any(String),
        details: [expect.objectContaining({ field })],
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /auth/signup/verify', () => {
    it('should create the account with a verified email account and return tokens + linkedTrainers', async () => {
      const email = uniqueEmail('verify');
      const code = await signupAndGetCode(email);

      const res = await verify(email, code);

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toEqual({
        user: { id: expect.any(String) },
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
        linkedTrainers: 0,
      });
      const user = await prisma.user.findUnique({ where: { id: body.user.id }, include: { accounts: true } });
      expect(user).toMatchObject({ email, roles: [], status: 'active' });
      expect(user.accounts).toEqual([
        expect.objectContaining({ provider: EMAIL_PROVIDER, providerId: email, verifiedAt: expect.any(Date) }),
      ]);
      expect(await prisma.pendingSignup.count({ where: { email } })).toBe(0);

      const me = await app.inject({ method: 'GET', url: '/me', headers: auth(body.token.accessToken) });
      expect(me.statusCode).toBe(200);
    });

    it('should report status active in GET /me right after a self-signup without any invite', async () => {
      const email = uniqueEmail('selfsignup-me');
      const code = await signupAndGetCode(email);

      const res = await verify(email, code);

      const me = await app.inject({ method: 'GET', url: '/me', headers: auth(res.json().token.accessToken) });
      expect(me.json()).toMatchObject({ status: 'active' });
    });

    it('should use the password sent with the code, not the one from the signup request', async () => {
      const email = uniqueEmail('password-at-verify');
      // Simulates someone else re-submitting the signup form for this email:
      // only the person holding the code chooses the password.
      const code = await signupAndGetCode(email, OTHER_PASSWORD);

      expect((await verify(email, code, PASSWORD)).statusCode).toBe(201);

      expect((await login(email, PASSWORD)).statusCode).toBe(200);
      expect((await login(email, OTHER_PASSWORD)).statusCode).toBe(401);
    });

    it('should accept the email in a different case than the signup', async () => {
      const email = uniqueEmail('mixed');
      expect((await signup(email.toUpperCase())).statusCode).toBe(202);
      const code = await waitForCode(email);

      const res = await verify(email, code);

      expect(res.statusCode).toBe(201);
      const user = await prisma.user.findUnique({ where: { id: res.json().user.id } });
      expect(user.email).toBe(email);
    });

    it('should accept pending student invites for the email and report linkedTrainers', async () => {
      const trainerSignup = await signupVerified(app, { payload: { email: uniqueEmail('trainer'), password: PASSWORD } });
      const { user: trainerUser, token } = trainerSignup.json();
      const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(token.accessToken) });
      expect(become.statusCode).toBe(200);
      const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUser.id } });
      await provisionTrainerPlan(trainer.id);
      const email = uniqueEmail('invited');
      const inviteRes = await app.inject({
        method: 'POST',
        url: '/trainer/student-invites',
        headers: auth(become.json().token.accessToken),
        payload: { email },
      });
      expect(inviteRes.statusCode).toBe(201);
      sentCodes = [];

      const code = await signupAndGetCode(email);
      const res = await verify(email, code);

      expect(res.statusCode).toBe(201);
      expect(res.json().linkedTrainers).toBe(1);
      const invite = await prisma.studentInvite.findFirst({ where: { email } });
      expect(invite).toMatchObject({ status: StudentInviteStatus.ACCEPTED, studentId: res.json().user.id });
    });

    it('should mark the invited user active in the database and in GET /me', async () => {
      const trainerSignup = await signupVerified(app, { payload: { email: uniqueEmail('trainer-active'), password: PASSWORD } });
      const { user: trainerUser, token } = trainerSignup.json();
      const become = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(token.accessToken) });
      const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUser.id } });
      await provisionTrainerPlan(trainer.id);
      const email = uniqueEmail('invited-active');
      await app.inject({
        method: 'POST',
        url: '/trainer/student-invites',
        headers: auth(become.json().token.accessToken),
        payload: { email },
      });
      sentCodes = [];

      const code = await signupAndGetCode(email);
      const res = await verify(email, code);

      const user = await prisma.user.findUnique({ where: { id: res.json().user.id } });
      expect(user.status).toBe('active');
      const me = await app.inject({ method: 'GET', url: '/me', headers: auth(res.json().token.accessToken) });
      expect(me.json()).toMatchObject({ status: 'active' });
    });

    describe('indistinguishable 400 invalidCode', () => {
      const INVALID_CODE_BODY = {
        error: EmailVerificationErrorCode.INVALID_CODE,
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
        message: expect.any(String),
      };

      it('should reject a wrong code', async () => {
        const email = uniqueEmail('wrong');
        const code = await signupAndGetCode(email);
        const wrongCode = code === '000000' ? '111111' : '000000';

        const res = await verify(email, wrongCode);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject(INVALID_CODE_BODY);
        expect(await prisma.user.count({ where: { email } })).toBe(0);
      });

      it('should reject an email with no pending signup with the same body', async () => {
        const res = await verify(uniqueEmail('nobody'), '123456');

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject(INVALID_CODE_BODY);
      });

      it('should reject an email that already has an account with the same body', async () => {
        const email = uniqueEmail('has-account');
        await createActiveUser(email);

        const res = await verify(email, '123456');

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject(INVALID_CODE_BODY);
      });

      it('should reject and drop the pending signup when the email signed in with Google before verifying', async () => {
        const email = uniqueEmail('google-race');
        const code = await signupAndGetCode(email);
        await prisma.user.create({
          data: {
            email,
            roles: [],
            status: 'pending',
            accounts: { create: { provider: 'google', providerId: `google-${email}`, verifiedAt: new Date() } },
          },
        });

        const res = await verify(email, code);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject(INVALID_CODE_BODY);
        expect(await prisma.pendingSignup.count({ where: { email } })).toBe(0);
        expect(await prisma.user.count({ where: { email } })).toBe(1);
      });

      it('should reject reusing a code that already created the account', async () => {
        const email = uniqueEmail('reuse');
        const code = await signupAndGetCode(email);
        expect((await verify(email, code)).statusCode).toBe(201);

        const res = await verify(email, code);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject(INVALID_CODE_BODY);
      });
    });

    it('should create exactly one account when the same code is verified concurrently', async () => {
      const email = uniqueEmail('concurrent');
      const code = await signupAndGetCode(email);

      const responses = await Promise.all([verify(email, code), verify(email, code), verify(email, code)]);

      const statuses = responses.map((res) => res.statusCode).sort();
      expect(statuses).toEqual([201, 400, 400]);
      expect(await prisma.user.count({ where: { email } })).toBe(1);
    });

    it('should answer 400 codeExpired for an expired code', async () => {
      const email = uniqueEmail('expired');
      const code = await signupAndGetCode(email);
      await prisma.pendingSignupCode.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

      const res = await verify(email, code);

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: EmailVerificationErrorCode.CODE_EXPIRED,
        messageCode: EmailVerificationMessageCode.CODE_EXPIRED,
      });
    });

    it('should answer 429 tooManyAttempts after the attempts cap, even with the right code', async () => {
      const email = uniqueEmail('attempts');
      const code = await signupAndGetCode(email);
      const wrongCode = code === '000000' ? '111111' : '000000';
      for (let attempt = 0; attempt < EMAIL_VERIFICATION_MAX_ATTEMPTS; attempt += 1) {
        expect((await verify(email, wrongCode)).statusCode).toBe(400);
      }

      const res = await verify(email, code);

      expect(res.statusCode).toBe(429);
      expect(res.json()).toMatchObject({
        error: EmailVerificationErrorCode.TOO_MANY_ATTEMPTS,
        messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
        message: expect.any(String),
      });
      expect(await prisma.user.count({ where: { email } })).toBe(0);
    });

    it('should translate the error message to en-US when requested', async () => {
      const res = await verify(uniqueEmail('i18n'), '123456', PASSWORD, { 'app-language': 'en-US' });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Invalid verification code.');
    });

    it.each([
      ['a non-numeric code', { code: 'abcdef', password: PASSWORD }, 'code'],
      ['a missing password', { code: '123456' }, 'password'],
      ['a short password', { code: '123456', password: 'short' }, 'password'],
    ])('should answer 400 VALIDATION_ERROR for %s', async (_label, payload, field) => {
      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup/verify',
        payload: { email: 'someone@example.com', ...payload },
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        details: [expect.objectContaining({ field })],
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe('POST /auth/signup/resend', () => {
    const SENT_BODY = { sent: true };

    async function expireCooldown(email) {
      await prisma.pendingSignupCode.updateMany({
        where: { pendingSignup: { email } },
        data: { createdAt: new Date(Date.now() - EMAIL_VERIFICATION_RESEND_COOLDOWN_MS - 1000) },
      });
    }

    it('should answer 202 and send nothing for an unknown email', async () => {
      const email = uniqueEmail('unknown');

      const res = await resend(email);
      await settle();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(SENT_BODY);
      expect(sentCodes).toEqual([]);
      expect(existingAccountEmails).toEqual([]);
      expect(await prisma.pendingSignup.count()).toBe(0);
    });

    it('should email a new code after the cooldown and invalidate the previous one', async () => {
      const email = uniqueEmail('resend');
      const firstCode = await signupAndGetCode(email);
      await expireCooldown(email);

      const res = await resend(email);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(SENT_BODY);
      const secondCode = await waitForCode(email, 2);
      if (secondCode !== firstCode) {
        expect((await verify(email, firstCode)).statusCode).toBe(400);
      }
      expect((await verify(email, secondCode)).statusCode).toBe(201);
    });

    it('should answer the same 202 and send nothing inside the cooldown', async () => {
      const email = uniqueEmail('resend-cooldown');
      await signupAndGetCode(email);

      const res = await resend(email);
      await settle();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(SENT_BODY);
      expect(codesSentTo(email)).toHaveLength(1);
    });

    it('should answer the same 202 and send the "existing account" email for a registered email', async () => {
      const email = uniqueEmail('resend-taken');
      await createActiveUser(email);

      const res = await resend(email);

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(SENT_BODY);
      await waitFor(() => existingAccountEmails.length > 0);
      expect(codesSentTo(email)).toEqual([]);
    });

    it('should still answer 202 when the email provider fails', async () => {
      const email = uniqueEmail('resend-fail');
      await signupAndGetCode(email);
      await expireCooldown(email);
      emailHandler.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'));

      const res = await resend(email);
      await settle();

      expect(res.statusCode).toBe(202);
      expect(res.json()).toEqual(SENT_BODY);
      const failed = await prisma.pendingSignupCode.findFirst({ where: { sendFailedAt: { not: null } } });
      expect(failed).toMatchObject({ used: true });
    });

    it('should answer 400 VALIDATION_ERROR for an invalid email', async () => {
      const res = await resend('not-an-email');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });
  });

  // ---------------------------------------------------------------------------
  describe('stored credentials', () => {
    it('should keep logging in users created before this flow (password hash on the user row)', async () => {
      const email = uniqueEmail('legacy');
      await prisma.user.create({ data: { email, roles: [], status: 'pending', passwordHash: hashPassword(PASSWORD) } });

      expect((await login(email, PASSWORD)).statusCode).toBe(200);
    });

    it('should hash the verify password with scrypt', async () => {
      const email = uniqueEmail('scrypt');
      const code = await signupAndGetCode(email);
      const { user } = (await verify(email, code)).json();

      const stored = await prisma.user.findUnique({ where: { id: user.id } });

      expect(stored.passwordHash).toMatch(/^scrypt\$/);
      expect(verifyPassword(PASSWORD, stored.passwordHash)).toBe(true);
    });
  });
});
