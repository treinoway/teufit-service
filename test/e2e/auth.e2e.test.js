import 'dotenv/config';
import crypto from 'node:crypto';
import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';
import { hashPassword } from '../../src/helpers/password.js';
import emailHandler from '../../src/config/email-handler.js';
import config from '../../config/index.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import {
  PASSWORD_RESET_MAX_ATTEMPTS,
  PasswordResetErrorCode,
  PasswordResetMessageCode,
} from '../../src/constants/password-reset.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: auth flows', () => {
  let app;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Clean database between tests to keep them isolated
    await cleanDatabase();
  });

  it('signup + /me end-to-end with JWT', async () => {
    const email = `e2e+signup-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    // Sign up the user
    const signupResponse = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });

    expect(signupResponse.statusCode).toBe(201);
    const signupBody = signupResponse.json();

    expect(signupBody).toHaveProperty('user.id');
    expect(signupBody).toHaveProperty('token.accessToken');
    expect(signupBody).toHaveProperty('refreshToken');

    const accessToken = signupBody.token.accessToken;
    const userId = signupBody.user.id;

    // Verify Account was created with provider 'email'
    const account = await prisma.account.findFirst({
      where: {
        userId,
        provider: 'email',
      },
    });

    expect(account).not.toBeNull();
    expect(account.provider).toBe('email');
    expect(account.providerId).toBe(email);

    // Call /me with the issued access token
    const meResponse = await app.inject({
      method: 'GET',
      url: '/me',
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    });

    expect(meResponse.statusCode).toBe(200);
    const meBody = meResponse.json();

    expect(meBody).toMatchObject({
      email,
      roles: expect.any(Array),
      status: 'active',
      statusLabel: expect.any(String),
      rolesLabel: expect.any(Array),
    });
    expect(meBody).not.toHaveProperty('passwordHash');
  });

  it('rejects /me without authentication', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/me',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: 'Authentication required',
    });
  });

  describe('waitlist', () => {
    it('successfully adds email to waitlist', async () => {
      const email = `waitlist-${Date.now()}@example.com`;

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();

      expect(body).toHaveProperty('id');
      expect(body.email).toBe(email.toLowerCase());
      expect(body.status).toBe('pending');

      // Verify it was stored in the database
      const waitlistEntry = await prisma.userWaitlist.findUnique({
        where: { email: email.toLowerCase() },
      });
      expect(waitlistEntry).not.toBeNull();
      expect(waitlistEntry.email).toBe(email.toLowerCase());
    });

    it('converts email to lowercase when adding to waitlist', async () => {
      const email = `WAITLIST-${Date.now()}@EXAMPLE.COM`;

      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
      });

      expect(response.statusCode).toBe(201);
      const body = response.json();
      expect(body.email).toBe(email.toLowerCase());
    });

    it('rejects duplicate email on waitlist', async () => {
      const email = `duplicate-${Date.now()}@example.com`;

      // First submission
      const firstResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
      });
      expect(firstResponse.statusCode).toBe(201);

      // Second submission with same email - use different IP to bypass rate limit
      const secondResponse = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email },
        headers: {
          'x-forwarded-for': '10.0.0.2', // Simulate different IP
        },
      });

      // Could be 409 (duplicate) or 429 (rate limited)
      // Accept both as valid since rate limiting is active
      expect([409, 429]).toContain(secondResponse.statusCode);
      
      if (secondResponse.statusCode === 409) {
        expect(secondResponse.json()).toMatchObject({
          error: 'EMAIL_ALREADY_ON_WAITLIST',
        });
      }
    });

    it('rejects invalid email format', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: { email: 'not-an-email' },
        headers: {
          'x-forwarded-for': '10.0.0.3', // Simulate different IP
        },
      });

      // Could be 400 (validation error) or 429 (rate limited)
      expect([400, 429]).toContain(response.statusCode);
    });

    it('rejects missing email', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/signup/waitlist',
        payload: {},
        headers: {
          'x-forwarded-for': '10.0.0.4', // Simulate different IP
        },
      });

      // Could be 400 (validation error) or 429 (rate limited)
      expect([400, 429]).toContain(response.statusCode);
    });

    it('respects the per-IP waitlist rate limit', async () => {
      // Use a new app instance with rate limiting enabled
      const originalNodeEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development'; // Enable rate limiting
      const freshApp = await setupApp({ logger: false });
      process.env.NODE_ENV = originalNodeEnv; // Restore original value

      try {
        const baseEmail = `rate-limit-${Date.now()}`;

        // Exhaust the configured per-window maximum
        for (let i = 0; i < config.rateLimit.auth.waitlist.max; i++) {
          const response = await freshApp.inject({
            method: 'POST',
            url: '/auth/signup/waitlist',
            payload: { email: `${baseEmail}-${i}@example.com` },
          });
          expect(response.statusCode).toBe(201);
        }

        // the next request should be rate limited
        const response = await freshApp.inject({
          method: 'POST',
          url: '/auth/signup/waitlist',
          payload: { email: `${baseEmail}-over-limit@example.com` },
        });

        expect(response.statusCode).toBe(429);
      } finally {
        await freshApp.close();
      }
    });
  });

  describe('login', () => {
    it('returns INVALID_CREDENTIALS with auth.invalidCredentials messageCode for wrong password', async () => {
      const email = `login-invalid-${Date.now()}@example.com`;
      const password = 'CorrectPassw0rd!';

      // Sign up the user first
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);

      // Attempt login with wrong password
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'app-language': 'en-US' },
        payload: { email, password: 'WrongPassw0rd!' },
      });

      expect(loginResponse.statusCode).toBe(401);
      expect(loginResponse.json()).toMatchObject({
        error: 'INVALID_CREDENTIALS',
        messageCode: 'auth.invalidCredentials',
        message: 'Invalid email or password.',
      });
    });

    it('returns INVALID_CREDENTIALS with auth.invalidCredentials messageCode for unknown email', async () => {
      const loginResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'app-language': 'en-US' },
        payload: { email: `nonexistent-${Date.now()}@example.com`, password: 'SomePassw0rd!' },
      });

      expect(loginResponse.statusCode).toBe(401);
      expect(loginResponse.json()).toMatchObject({
        error: 'INVALID_CREDENTIALS',
        messageCode: 'auth.invalidCredentials',
        message: 'Invalid email or password.',
      });
    });
  });

  describe('login without enumeration', () => {
    it('returns 401 INVALID_CREDENTIALS (not 409 PASSWORD_NOT_SET) for an OAuth-only account', async () => {
      const email = `oauth-only-${Date.now()}@example.com`;
      await prisma.user.create({ data: { email, roles: [], status: 'active', passwordHash: null } });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'app-language': 'en-US' },
        payload: { email, password: 'AnyPassw0rd!' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: 'INVALID_CREDENTIALS',
        messageCode: 'auth.invalidCredentials',
        message: 'Invalid email or password.',
      });
    });

    it('logs in regardless of the email case', async () => {
      const email = `case-login-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';
      expect((await signupVerified(app, { payload: { email, password } })).statusCode).toBe(201);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: email.toUpperCase(), password },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('login against a deleted account (USER_DELETED)', () => {
    async function seedDeletedUserWithToken(suffix) {
      const email = `login-deleted-${suffix}-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);
      const {
        user: { id: userId },
        token: { accessToken },
      } = signupResponse.json();

      const deleteResponse = await app.inject({
        method: 'DELETE',
        url: '/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });
      expect(deleteResponse.statusCode).toBe(204);

      // DELETE /me anonymizes the row (email and passwordHash nulled). Restore
      // both to model a soft-deleted account that still has its credential:
      // USER_DELETED is only revealed after the password matched.
      await prisma.user.update({ where: { id: userId }, data: { email, passwordHash: hashPassword(password) } });

      return { email, password };
    }

    it('returns 401 INVALID_CREDENTIALS (not USER_DELETED) when the password is wrong', async () => {
      const { email } = await seedDeletedUserWithToken('wrong-password');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: 'WrongPassw0rd!' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'INVALID_CREDENTIALS', messageCode: 'auth.invalidCredentials' });
    });

    it('returns the full 4-field error contract (error, messageCode, message, details) with 403 USER_DELETED', async () => {
      const { email, password } = await seedDeletedUserWithToken('403');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({
        error: 'USER_DELETED',
        messageCode: 'auth.user.deleted',
        message: expect.any(String),
        details: {},
      });
    });

    it('translates the message to pt-BR by default', async () => {
      const { email, password } = await seedDeletedUserWithToken('pt-br');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('Esta conta foi excluída.');
    });

    it('translates the message to en-US when the app-language header requests it', async () => {
      const { email, password } = await seedDeletedUserWithToken('en-us');

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'app-language': 'en-US' },
        payload: { email, password },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().message).toBe('This account has been deleted.');
    });
  });

  describe('forgot password', () => {
    it('returns generic message and creates a token when user exists', async () => {
      const email = `forgot-existing-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('message');
      // Non-prod test env exposes resetToken for manual flows.
      expect(typeof body.resetToken).toBe('string');
      expect(body.resetToken.length).toBe(6);

      const tokens = await prisma.passwordResetToken.findMany({
        where: { user: { email } },
      });
      expect(tokens.length).toBe(1);
      expect(tokens[0].used).toBe(false);
    });

    it('sends the reset email after the response, with the issued code', async () => {
      const email = `forgot-deferred-${Date.now()}@example.com`;
      expect((await signupVerified(app, { payload: { email, password: 'StrongPassw0rd!' } })).statusCode).toBe(201);
      let releaseSend;
      const sendSpy = vi
        .spyOn(emailHandler, 'sendResetPasswordEmail')
        .mockImplementation(() => new Promise((resolve) => { releaseSend = resolve; }));

      // Answers while the (stalled) email provider call has not resolved.
      const response = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });

      expect(response.statusCode).toBe(200);
      await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));
      expect(sendSpy).toHaveBeenCalledWith({ to: email, passwordToken: response.json().resetToken });
      releaseSend({ data: { id: 'email-id' } });
      sendSpy.mockRestore();
    });

    it('returns generic message and does not create a token when user does not exist', async () => {
      const email = `forgot-missing-${Date.now()}@example.com`;

      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('message');
      expect(body.resetToken).toBeUndefined();

      const tokens = await prisma.passwordResetToken.findMany({});
      expect(tokens.length).toBe(0);
    });

    it('matches case-insensitively for users registered via OAuth-style mixed case', async () => {
      const email = `forgot-case-${Date.now()}@example.com`;

      // Simulate a legacy user with mixed-case email (e.g. from OAuth).
      const created = await prisma.user.create({
        data: {
          email: email.toUpperCase(),
          passwordHash: null,
          roles: [],
          status: 'pending',
        },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email: email.toLowerCase() },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(typeof body.resetToken).toBe('string');

      const tokens = await prisma.passwordResetToken.findMany({
        where: { userId: created.id },
      });
      expect(tokens.length).toBe(1);
    });

    it('invalidates previously issued unused reset tokens when a new one is requested', async () => {
      const email = `forgot-rotate-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });
      expect(signupResponse.statusCode).toBe(201);

      // First request
      const firstResp = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });
      expect(firstResp.statusCode).toBe(200);

      // Second request invalidates the first
      const secondResp = await app.inject({
        method: 'POST',
        url: '/auth/forgot-password',
        payload: { email },
      });
      expect(secondResp.statusCode).toBe(200);

      const tokens = await prisma.passwordResetToken.findMany({
        where: { user: { email } },
        orderBy: { createdAt: 'asc' },
      });
      expect(tokens.length).toBe(2);
      // Older token marked used; newest still active
      expect(tokens[0].used).toBe(true);
      expect(tokens[1].used).toBe(false);
    });
  });

  describe('reset password with emailed code', () => {
    const PASSWORD = 'StrongPassw0rd!';
    const NEW_PASSWORD = 'BrandNewPassw0rd!';
    const WRONG_CODE = '000000';
    const FIXED_CODE = '424242';
    const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
    const uniqueEmail = (label) => `reset-${label}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;

    const forgot = (email) => app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    const reset = (payload, headers) => app.inject({ method: 'POST', url: '/auth/reset-password', payload, headers });
    const resetBody = (email, code, password = NEW_PASSWORD) => ({ email, code, password, passwordConfirmation: password });

    async function signupUser(label) {
      const email = uniqueEmail(label);
      const res = await signupVerified(app, { payload: { email, password: PASSWORD } });
      expect(res.statusCode).toBe(201);
      return { email, ...res.json() };
    }

    async function requestCode(email) {
      const res = await forgot(email);
      expect(res.statusCode).toBe(200);
      return res.json().resetToken;
    }

    const seedToken = (userId, code, overrides = {}) =>
      prisma.passwordResetToken.create({
        data: { tokenHash: sha256(code), userId, expiresAt: new Date(Date.now() + 15 * 60 * 1000), ...overrides },
      });

    const expectInvalidCode = (res) => {
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        error: PasswordResetErrorCode.INVALID_CODE,
        messageCode: PasswordResetMessageCode.INVALID_CODE,
        message: 'Código inválido ou expirado. Solicite um novo.',
      });
    };

    const tokensOf = (userId) => prisma.passwordResetToken.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });

    describe('success', () => {
      it('should reset the password, return tokens and allow login with the new password only', async () => {
        const user = await signupUser('ok');
        const code = await requestCode(user.email);

        const res = await reset(resetBody(user.email, code));

        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.user.id).toBe(user.user.id);
        expect(typeof body.token.accessToken).toBe('string');
        expect(typeof body.refreshToken).toBe('string');
        const newLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: NEW_PASSWORD } });
        const oldLogin = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: PASSWORD } });
        expect(newLogin.statusCode).toBe(200);
        expect(oldLogin.statusCode).toBe(401);
      });

      it('should accept the email in a different case', async () => {
        const user = await signupUser('case');
        const code = await requestCode(user.email);

        const res = await reset(resetBody(user.email.toUpperCase(), code));

        expect(res.statusCode).toBe(200);
      });

      it('should mark the token used and revoke every refresh token (including the one from signup)', async () => {
        const user = await signupUser('revoke');
        const code = await requestCode(user.email);

        const res = await reset(resetBody(user.email, code));

        expect(res.statusCode).toBe(200);
        const [token] = await tokensOf(user.user.id);
        expect(token.used).toBe(true);
        const refreshRes = await app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: user.refreshToken } });
        expect(refreshRes.statusCode).toBe(401);
        const stillActive = await prisma.refreshToken.findMany({ where: { userId: user.user.id, revoked: false } });
        // Only the refresh token issued by the reset itself remains active.
        expect(stillActive).toHaveLength(1);
      });

      it('should mark the email verified for a legacy unverified account', async () => {
        const email = uniqueEmail('legacy');
        const legacy = await seedLegacyUnverifiedUser(app, { email, password: PASSWORD });
        const code = await requestCode(email);

        const res = await reset(resetBody(email, code));

        expect(res.statusCode).toBe(200);
        const account = await prisma.account.findFirst({ where: { userId: legacy.userId, provider: EMAIL_PROVIDER } });
        expect(account.verifiedAt).not.toBeNull();
      });

      it('should not allow the same code to be used twice', async () => {
        const user = await signupUser('twice');
        const code = await requestCode(user.email);
        expect((await reset(resetBody(user.email, code))).statusCode).toBe(200);

        expectInvalidCode(await reset(resetBody(user.email, code, 'AnotherPassw0rd!')));
      });

      it('should succeed only once when the same code is submitted concurrently', async () => {
        const user = await signupUser('race');
        const code = await requestCode(user.email);

        const results = await Promise.all([
          reset(resetBody(user.email, code, 'RacePassw0rd!A')),
          reset(resetBody(user.email, code, 'RacePassw0rd!B')),
        ]);

        const statuses = results.map((res) => res.statusCode).sort();
        expect(statuses).toEqual([200, 400]);
        const failed = results.find((res) => res.statusCode === 400);
        expectInvalidCode(failed);
      });

      it('should only honor the newest code after a second request', async () => {
        const user = await signupUser('newest');
        vi.spyOn(crypto, 'randomInt').mockReturnValueOnce(111111).mockReturnValueOnce(222222);
        const first = await requestCode(user.email);
        const second = await requestCode(user.email);
        expect([first, second]).toEqual(['111111', '222222']);

        expectInvalidCode(await reset(resetBody(user.email, first)));
        expect((await reset(resetBody(user.email, second))).statusCode).toBe(200);
      });
    });

    describe('code bound to the email', () => {
      it('should reject a code issued for user A when used with email B, leaving both untouched', async () => {
        const userA = await signupUser('bind-a');
        const userB = await signupUser('bind-b');
        const codeA = await requestCode(userA.email);

        const res = await reset(resetBody(userB.email, codeA));

        expectInvalidCode(res);
        const [tokenA] = await tokensOf(userA.user.id);
        expect(tokenA).toMatchObject({ used: false, attempts: 0 });
        expect(await tokensOf(userB.user.id)).toHaveLength(0);
        const loginB = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: userB.email, password: PASSWORD } });
        expect(loginB.statusCode).toBe(200);
      });

      it('should reject user B email even when B has an own active code that differs', async () => {
        const userA = await signupUser('bind2-a');
        const userB = await signupUser('bind2-b');
        vi.spyOn(crypto, 'randomInt').mockReturnValueOnce(123123).mockReturnValueOnce(456456);
        const codeA = await requestCode(userA.email);
        await requestCode(userB.email);

        const res = await reset(resetBody(userB.email, codeA));

        expectInvalidCode(res);
        const [tokenB] = await tokensOf(userB.user.id);
        expect(tokenB.attempts).toBe(1);
        const [tokenA] = await tokensOf(userA.user.id);
        expect(tokenA.attempts).toBe(0);
      });
    });

    describe('attempt cap', () => {
      it('should reject the correct code after 5 wrong guesses and record exactly 5 attempts', async () => {
        const user = await signupUser('cap');
        const code = await requestCode(user.email);

        for (let guess = 0; guess < PASSWORD_RESET_MAX_ATTEMPTS; guess += 1) {
          expectInvalidCode(await reset(resetBody(user.email, WRONG_CODE)));
        }
        const res = await reset(resetBody(user.email, code));

        expectInvalidCode(res);
        const [token] = await tokensOf(user.user.id);
        expect(token.attempts).toBe(PASSWORD_RESET_MAX_ATTEMPTS);
        expect(token.used).toBe(false);
        const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: user.email, password: PASSWORD } });
        expect(login.statusCode).toBe(200);
      });

      it('should still accept the correct code on the last allowed (5th) attempt', async () => {
        const user = await signupUser('cap-last');
        const code = await requestCode(user.email);
        for (let guess = 0; guess < PASSWORD_RESET_MAX_ATTEMPTS - 1; guess += 1) {
          expectInvalidCode(await reset(resetBody(user.email, WRONG_CODE)));
        }

        const res = await reset(resetBody(user.email, code));

        expect(res.statusCode).toBe(200);
      });

      it('should reset the guess budget when a new code is issued', async () => {
        const user = await signupUser('cap-new');
        await requestCode(user.email);
        for (let guess = 0; guess < PASSWORD_RESET_MAX_ATTEMPTS; guess += 1) {
          await reset(resetBody(user.email, WRONG_CODE));
        }

        const freshCode = await requestCode(user.email);

        expect((await reset(resetBody(user.email, freshCode))).statusCode).toBe(200);
      });
    });

    describe('identical error for every failure cause', () => {
      it('should return deep-equal bodies for unknown email, wrong code, expired, used, too many attempts and deleted user', async () => {
        const responses = {};

        responses.unknownEmail = await reset(resetBody(uniqueEmail('ghost'), '123456'));

        const wrong = await signupUser('same-wrong');
        await requestCode(wrong.email);
        responses.wrongCode = await reset(resetBody(wrong.email, WRONG_CODE));

        const expired = await signupUser('same-expired');
        await seedToken(expired.user.id, '111111', { expiresAt: new Date(Date.now() - 1000) });
        responses.expired = await reset(resetBody(expired.email, '111111'));

        const used = await signupUser('same-used');
        await seedToken(used.user.id, '222222', { used: true });
        responses.used = await reset(resetBody(used.email, '222222'));

        const capped = await signupUser('same-capped');
        await seedToken(capped.user.id, '333333', { attempts: PASSWORD_RESET_MAX_ATTEMPTS });
        responses.tooManyAttempts = await reset(resetBody(capped.email, '333333'));

        const deleted = await signupUser('same-deleted');
        await seedToken(deleted.user.id, '444444');
        await prisma.user.update({ where: { id: deleted.user.id }, data: { deletedAt: new Date() } });
        responses.deletedUser = await reset(resetBody(deleted.email, '444444'));

        const noToken = await signupUser('same-none');
        responses.noToken = await reset(resetBody(noToken.email, '555555'));

        for (const [cause, res] of Object.entries(responses)) {
          expect(res.statusCode, cause).toBe(400);
          expect(res.json(), cause).toEqual(responses.unknownEmail.json());
        }
        expect(responses.unknownEmail.json()).toMatchObject({
          error: PasswordResetErrorCode.INVALID_CODE,
          messageCode: PasswordResetMessageCode.INVALID_CODE,
        });
      });

      it('should not change state for an expired, used or deleted-user attempt', async () => {
        const deleted = await signupUser('state-deleted');
        await seedToken(deleted.user.id, '444444');
        await prisma.user.update({ where: { id: deleted.user.id }, data: { deletedAt: new Date() } });
        const before = await prisma.user.findUnique({ where: { id: deleted.user.id } });

        await reset(resetBody(deleted.email, '444444'));

        const after = await prisma.user.findUnique({ where: { id: deleted.user.id } });
        expect(after.passwordHash).toBe(before.passwordHash);
        const [token] = await tokensOf(deleted.user.id);
        expect(token.used).toBe(false);
      });

      it('should translate the invalid-code message to English when requested', async () => {
        const res = await reset(resetBody(uniqueEmail('en'), '123456'), { 'app-language': 'en-US' });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          error: PasswordResetErrorCode.INVALID_CODE,
          messageCode: PasswordResetMessageCode.INVALID_CODE,
          message: 'Invalid or expired code. Request a new one.',
        });
      });
    });

    describe('tokenHash collisions (hash is no longer unique)', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('should not 500 on forgot-password when an old used row of another user has the same hash', async () => {
        const userA = await signupUser('coll-a');
        const userB = await signupUser('coll-b');
        await seedToken(userB.user.id, FIXED_CODE, { used: true });
        vi.spyOn(crypto, 'randomInt').mockReturnValue(Number(FIXED_CODE));

        const res = await forgot(userA.email);

        expect(res.statusCode).toBe(200);
        expect(res.json().resetToken).toBe(FIXED_CODE);
        expect(await prisma.passwordResetToken.count({ where: { tokenHash: sha256(FIXED_CODE) } })).toBe(2);
      });

      it('should not 500 on forgot-password when an old used row of the same user has the same hash', async () => {
        const user = await signupUser('coll-same');
        await seedToken(user.user.id, FIXED_CODE, { used: true });
        vi.spyOn(crypto, 'randomInt').mockReturnValue(Number(FIXED_CODE));

        const res = await forgot(user.email);

        expect(res.statusCode).toBe(200);
      });

      it('should reset successfully with the colliding code, resolving by the email-bound newest active row', async () => {
        const userA = await signupUser('coll-reset-a');
        const userB = await signupUser('coll-reset-b');
        await seedToken(userB.user.id, FIXED_CODE, { used: true });
        vi.spyOn(crypto, 'randomInt').mockReturnValue(Number(FIXED_CODE));
        await requestCode(userA.email);

        const res = await reset(resetBody(userA.email, FIXED_CODE));

        expect(res.statusCode).toBe(200);
        expect(res.json().user.id).toBe(userA.user.id);
        const [tokenB] = await tokensOf(userB.user.id);
        expect(tokenB.used).toBe(true);
        expect(tokenB.attempts).toBe(0);
      });
    });

    describe('forgot-password exposure and throttle', () => {
      const originalAuth = { ...config.auth };
      afterEach(() => {
        Object.assign(config.auth, originalAuth);
      });

      it('should not expose resetToken when config.auth.exposeResetTokenInResponse is false (staging/default)', async () => {
        const user = await signupUser('noexpose');
        config.auth.exposeResetTokenInResponse = false;

        const res = await forgot(user.email);

        expect(res.statusCode).toBe(200);
        expect(res.json()).not.toHaveProperty('resetToken');
        expect(await tokensOf(user.user.id)).toHaveLength(1);
      });

      it('should return the same body shape for existing and unknown emails when exposure is off', async () => {
        const user = await signupUser('noexpose-shape');
        config.auth.exposeResetTokenInResponse = false;

        const existing = await forgot(user.email);
        const unknown = await forgot(uniqueEmail('noexpose-ghost'));

        expect(existing.json()).toEqual(unknown.json());
      });

      it('should silently throttle within the cooldown: uniform 200, no new row and no email', async () => {
        const user = await signupUser('cooldown');
        config.auth.passwordResetCooldownMs = 60_000;
        const sendSpy = vi.spyOn(emailHandler, 'sendResetPasswordEmail').mockResolvedValue({ data: { id: 'email-id' } });
        const first = await forgot(user.email);
        await vi.waitFor(() => expect(sendSpy).toHaveBeenCalledTimes(1));

        const second = await forgot(user.email);

        expect(second.statusCode).toBe(200);
        expect(second.json()).toEqual({ message: first.json().message });
        expect(await tokensOf(user.user.id)).toHaveLength(1);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(sendSpy).toHaveBeenCalledTimes(1);
      });

      it('should keep the first code valid when a throttled request is ignored', async () => {
        const user = await signupUser('cooldown-valid');
        config.auth.passwordResetCooldownMs = 60_000;
        const code = await requestCode(user.email);
        await forgot(user.email);

        expect((await reset(resetBody(user.email, code))).statusCode).toBe(200);
      });

      it('should issue a new code once the cooldown has elapsed', async () => {
        const user = await signupUser('cooldown-elapsed');
        config.auth.passwordResetCooldownMs = 60_000;
        await requestCode(user.email);
        await prisma.passwordResetToken.updateMany({
          where: { userId: user.user.id },
          data: { createdAt: new Date(Date.now() - 61_000) },
        });

        const res = await forgot(user.email);

        expect(res.json().resetToken).toMatch(/^[0-9]{6}$/);
        expect(await tokensOf(user.user.id)).toHaveLength(2);
      });

      it('should silently throttle after the hourly cap even with no cooldown', async () => {
        const user = await signupUser('hourly');
        config.auth.passwordResetCooldownMs = 0;
        config.auth.passwordResetMaxPerHour = 2;
        await requestCode(user.email);
        await requestCode(user.email);

        const third = await forgot(user.email);

        expect(third.statusCode).toBe(200);
        expect(third.json()).not.toHaveProperty('resetToken');
        expect(await tokensOf(user.user.id)).toHaveLength(2);
      });

      it('should throttle per email, not globally', async () => {
        const userA = await signupUser('perEmail-a');
        const userB = await signupUser('perEmail-b');
        config.auth.passwordResetMaxPerHour = 1;
        await requestCode(userA.email);

        const res = await forgot(userB.email);

        expect(res.json().resetToken).toMatch(/^[0-9]{6}$/);
      });

      it('should purge rows older than one hour and mark prior unused rows used on issue', async () => {
        const user = await signupUser('purge');
        const old = await seedToken(user.user.id, '777777', { used: true });
        await prisma.passwordResetToken.update({
          where: { id: old.id },
          data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        });
        const recent = await seedToken(user.user.id, '888888');

        await requestCode(user.email);

        const rows = await tokensOf(user.user.id);
        expect(rows.map((row) => row.id)).not.toContain(old.id);
        expect(rows.find((row) => row.id === recent.id).used).toBe(true);
        expect(rows).toHaveLength(2);
      });

      it('should not purge rows of other users', async () => {
        const userA = await signupUser('purge-a');
        const userB = await signupUser('purge-b');
        const old = await seedToken(userB.user.id, '777777', { used: true });
        await prisma.passwordResetToken.update({
          where: { id: old.id },
          data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
        });

        await requestCode(userA.email);

        expect(await tokensOf(userB.user.id)).toHaveLength(1);
      });
    });

    describe('request validation', () => {
      it('should reject the legacy token field with 400 VALIDATION_ERROR', async () => {
        const user = await signupUser('legacy-token');
        const code = await requestCode(user.email);

        const res = await reset({ token: code, password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
      });

      it('should ignore a stray legacy token field (stripped by the schema) and never treat it as the code', async () => {
        const user = await signupUser('legacy-extra');
        const code = await requestCode(user.email);

        const res = await reset({ ...resetBody(user.email, WRONG_CODE), token: code });

        expectInvalidCode(res);
        const [token] = await tokensOf(user.user.id);
        expect(token).toMatchObject({ used: false, attempts: 1 });
      });

      it.each([
        ['email is missing', { code: '123456', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }],
        ['code is missing', { email: 'a@example.com', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }],
        ['code has 5 digits', { email: 'a@example.com', code: '12345', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }],
        ['code is not numeric', { email: 'a@example.com', code: 'abcdef', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }],
        ['password is shorter than 8 chars', { email: 'a@example.com', code: '123456', password: 'short', passwordConfirmation: 'short' }],
        ['email is malformed', { email: 'not-an-email', code: '123456', password: NEW_PASSWORD, passwordConfirmation: NEW_PASSWORD }],
      ])('should return 400 VALIDATION_ERROR when %s', async (_label, payload) => {
        const res = await reset(payload);

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
        expect(Array.isArray(res.json().details)).toBe(true);
      });

      it('should return 400 VALIDATION_ERROR with passwordReset.passwordMismatch when confirmation differs', async () => {
        const user = await signupUser('mismatch');
        const code = await requestCode(user.email);

        const res = await reset({ ...resetBody(user.email, code), passwordConfirmation: 'DifferentPassw0rd!' });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          error: 'VALIDATION_ERROR',
          messageCode: PasswordResetMessageCode.PASSWORD_MISMATCH,
        });
        const [token] = await tokensOf(user.user.id);
        expect(token).toMatchObject({ used: false, attempts: 0 });
      });

      it('should return 400 VALIDATION_ERROR on forgot-password without email', async () => {
        const res = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: {} });

        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
      });
    });
  });

  describe('change password', () => {
    it('successfully changes password with valid credentials', async () => {
      const email = `change-password-${Date.now()}@example.com`;
      const oldPassword = 'OldPassw0rd!';
      const newPassword = 'NewPassw0rd!';

      // Sign up the user
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: oldPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken }, refreshToken } = signupResponse.json();

      // Change password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: oldPassword,
          newPassword: newPassword,
          newPasswordConfirmation: newPassword,
        },
      });

      expect(changeResponse.statusCode).toBe(200);
      const changeBody = changeResponse.json();

      expect(changeBody).toHaveProperty('message', 'Password changed successfully');
      expect(changeBody).toHaveProperty('token.accessToken');
      expect(changeBody).toHaveProperty('refreshToken');

      // Verify new access token is different from original
      expect(changeBody.token.accessToken).not.toBe(accessToken);
      expect(changeBody.refreshToken).not.toBe(refreshToken);

      // Verify old password no longer works
      const loginWithOldResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: oldPassword },
      });

      expect(loginWithOldResponse.statusCode).toBe(401);

      // Verify new password works
      const loginWithNewResponse = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email, password: newPassword },
      });

      expect(loginWithNewResponse.statusCode).toBe(200);
    });

    it('rejects change password without authentication', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        payload: {
          currentPassword: 'OldPassw0rd!',
          newPassword: 'NewPassw0rd!',
          newPasswordConfirmation: 'NewPassw0rd!',
        },
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({
        error: 'Authentication required',
      });
    });

    it('rejects when current password is incorrect', async () => {
      const email = `change-password-wrong-${Date.now()}@example.com`;
      const correctPassword = 'CorrectPassw0rd!';

      // Sign up the user
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: correctPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change password with wrong current password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: 'WrongPassw0rd!',
          newPassword: 'NewPassw0rd!',
          newPasswordConfirmation: 'NewPassw0rd!',
        },
      });

      expect(changeResponse.statusCode).toBe(401);
      expect(changeResponse.json()).toMatchObject({
        error: 'INVALID_CURRENT_PASSWORD',
      });
    });

    it('rejects when new password is too weak', async () => {
      const email = `change-password-weak-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      // Sign up the user
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change to a weak password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: 'weak',
          newPasswordConfirmation: 'weak',
        },
      });

      // Fastify schema validation rejects before reaching service layer
      expect(changeResponse.statusCode).toBe(400);
    });

    it('rejects when new password confirmation does not match', async () => {
      const email = `change-password-mismatch-${Date.now()}@example.com`;
      const password = 'StrongPassw0rd!';

      // Sign up the user
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change password with mismatched confirmation
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: 'NewPassw0rd!',
          newPasswordConfirmation: 'DifferentPassw0rd!',
        },
      });

      expect(changeResponse.statusCode).toBe(400);
      expect(changeResponse.json()).toMatchObject({
        error: 'PASSWORD_MISMATCH',
      });
    });

    it('rejects when new password is same as current password', async () => {
      const email = `change-password-same-${Date.now()}@example.com`;
      const password = 'SamePassw0rd!';

      // Sign up the user
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password },
      });

      expect(signupResponse.statusCode).toBe(201);
      const { token: { accessToken } } = signupResponse.json();

      // Try to change password to the same password
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
        },
        payload: {
          currentPassword: password,
          newPassword: password,
          newPasswordConfirmation: password,
        },
      });

      expect(changeResponse.statusCode).toBe(400);
      expect(changeResponse.json().error).toBe('PASSWORD_SAME_AS_CURRENT');
    });

    it('revokes all existing refresh tokens after password change', async () => {
      const email = `change-password-revoke-${Date.now()}@example.com`;
      const oldPassword = 'OldPassw0rd!';
      const newPassword = 'NewPassw0rd!';

      // Sign up the user
      const signupResponse = await signupVerified(app, {
        method: 'POST',
        url: '/auth/signup',
        payload: { email, password: oldPassword },
      });

      expect(signupResponse.statusCode).toBe(201);
      const {
        token: { accessToken },
        refreshToken: oldRefreshToken,
        user: { id: userId }
      } = signupResponse.json();

      // Verify old refresh token exists in database
      const oldTokenRecord = await prisma.refreshToken.findFirst({
        where: { userId, revoked: false },
      });
      expect(oldTokenRecord).not.toBeNull();

      // Change password (use different IP to avoid rate limiting from previous tests)
      const changeResponse = await app.inject({
        method: 'POST',
        url: '/auth/change-password',
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-forwarded-for': '10.0.0.100',
        },
        payload: {
          currentPassword: oldPassword,
          newPassword: newPassword,
          newPasswordConfirmation: newPassword,
        },
      });

      expect(changeResponse.statusCode).toBe(200);

      // Verify old refresh token was revoked
      const revokedToken = await prisma.refreshToken.findFirst({
        where: {
          userId,
          tokenHash: oldTokenRecord.tokenHash,
        },
      });
      expect(revokedToken.revoked).toBe(true);

      // Try to use old refresh token - should fail
      const refreshResponse = await app.inject({
        method: 'POST',
        url: '/auth/refresh',
        payload: { refreshToken: oldRefreshToken },
      });

      expect(refreshResponse.statusCode).toBe(401);
    });
  });
});
