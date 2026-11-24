import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import emailHandler from '../../src/config/email-handler.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';

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

const SIGNUP_PASSWORD = 'SignupPassw0rd!';
const OWNER_PASSWORD = 'OwnerNewPassw0rd!';
const FIRST_NAME = 'Mallory';
const OAUTH_SUBJECT = 'oauth-subject-prehijack-0001';
const SECOND_OAUTH_SUBJECT = 'oauth-subject-prehijack-0002';
const INVALID_CREDENTIALS = 'INVALID_CREDENTIALS';
const REFRESH_TOKEN_REVOKED = 'REFRESH_TOKEN_REVOKED';
const POLL_INTERVAL_MS = 10;
const POLL_TIMEOUT_MS = 5000;

const OAUTH_PROVIDERS = [
  { name: 'POST /auth/google/web', url: '/auth/google/web', payload: { idToken: 'mock-token' }, provider: 'google' },
  { name: 'POST /auth/google/mobile', url: '/auth/google/mobile', payload: { idToken: 'mock-token' }, provider: 'google' },
  { name: 'POST /auth/apple/mobile', url: '/auth/apple/mobile', payload: { identityToken: 'mock-token' }, provider: 'apple' },
];

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

e2eDescribe('e2e: pre-hijack guard for accounts created by POST /auth/signup/direct', () => {
  let app;
  let verificationCodes;
  let emailCounter = 0;

  const uniqueEmail = (prefix) => {
    emailCounter += 1;
    return `e2e+${prefix}-${Date.now()}-${emailCounter}@example.com`;
  };
  const auth = (token) => ({ authorization: `Bearer ${token}` });

  const login = (email, password) => app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
  const refresh = (refreshToken) => app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });
  const getMe = (token) => app.inject({ method: 'GET', url: '/me', headers: auth(token) });
  const verifyEmail = (token, code) =>
    app.inject({ method: 'POST', url: '/auth/verify-email', headers: auth(token), payload: { code } });
  const emailAccountOf = (userId) => prisma.account.findFirst({ where: { userId, provider: EMAIL_PROVIDER } });
  const waitForCode = (email) => waitFor(() => verificationCodes.get(email));

  async function signupDirect(email, password = SIGNUP_PASSWORD) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup/direct',
      payload: { email, password, firstName: FIRST_NAME },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    return { email, userId: body.user.id, accessToken: body.token.accessToken, refreshToken: body.refreshToken };
  }

  async function forgotPassword(email) {
    const res = await app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email } });
    expect(res.statusCode).toBe(200);
    return res.json().resetToken;
  }

  const resetPassword = (email, code, password = OWNER_PASSWORD) =>
    app.inject({
      method: 'POST',
      url: '/auth/reset-password',
      payload: { email, code, password, passwordConfirmation: password },
    });

  function mockOAuthIdentity(email, subject = OAUTH_SUBJECT) {
    const identity = { subject, email, name: 'Owner Person', emailVerified: true };
    verifyGoogleIdToken.mockResolvedValue(identity);
    verifyFirebaseIdToken.mockResolvedValue(identity);
    verifyAppleIdToken.mockResolvedValue({ subject, email, emailVerified: true, isPrivateEmail: false });
  }

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    verificationCodes = new Map();
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      verificationCodes.set(to.toLowerCase(), code);
      return { data: { id: 'email-id' } };
    });
  });

  describe.each(OAUTH_PROVIDERS)('(a) the owner signs in through $name while the email is still unverified', (oauth) => {
    let squatter;
    let oauthRes;

    beforeEach(async () => {
      squatter = await signupDirect(uniqueEmail('victim'));
      mockOAuthIdentity(squatter.email);
      oauthRes = await app.inject({ method: 'POST', url: oauth.url, payload: oauth.payload });
    });

    it('should sign the owner into the same account and link the provider as verified', async () => {
      expect(oauthRes.statusCode).toBe(200);
      expect(oauthRes.json().user.id).toBe(squatter.userId);
      const linked = await prisma.account.findFirst({ where: { userId: squatter.userId, provider: oauth.provider } });
      expect(linked.verifiedAt).not.toBeNull();
    });

    it('should report the account as verified in GET /me', async () => {
      const me = await getMe(oauthRes.json().token.accessToken);

      expect(me.json().emailVerified).toBe(true);
    });

    it('should stop the password set at signup from logging in', async () => {
      const res = await login(squatter.email, SIGNUP_PASSWORD);

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe(INVALID_CREDENTIALS);
    });

    it('should remove the password credential', async () => {
      const user = await prisma.user.findUnique({ where: { id: squatter.userId } });

      expect(user.passwordHash).toBeNull();
    });

    it('should revoke the refresh token issued at signup', async () => {
      const res = await refresh(squatter.refreshToken);

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe(REFRESH_TOKEN_REVOKED);
    });

    it('should revoke every refresh token issued before the sign-in, including later logins', async () => {
      const otherVictim = await signupDirect(uniqueEmail('victim'));
      const laterLogin = await login(otherVictim.email, SIGNUP_PASSWORD);
      expect(laterLogin.statusCode).toBe(200);
      mockOAuthIdentity(otherVictim.email, SECOND_OAUTH_SUBJECT);

      await app.inject({ method: 'POST', url: oauth.url, payload: oauth.payload });

      expect((await refresh(otherVictim.refreshToken)).statusCode).toBe(401);
      expect((await refresh(laterLogin.json().refreshToken)).statusCode).toBe(401);
    });

    it('should keep the refresh token issued to the owner working', async () => {
      const res = await refresh(oauthRes.json().refreshToken);

      expect(res.statusCode).toBe(200);
    });

    it('should make the verification code emailed at signup unusable', async () => {
      const code = await waitForCode(squatter.email);
      expect(code).toEqual(expect.any(String));

      const res = await verifyEmail(squatter.accessToken, code);

      expect(res.statusCode).not.toBe(200);
      expect((await emailAccountOf(squatter.userId)).verifiedAt).toBeNull();
    });
  });

  describe('(b) the owner resets the password while the email is still unverified', () => {
    let squatter;
    let resetRes;

    beforeEach(async () => {
      squatter = await signupDirect(uniqueEmail('victim'));
      const resetCode = await forgotPassword(squatter.email);
      resetRes = await resetPassword(squatter.email, resetCode);
    });

    it('should accept the reset', async () => {
      expect(resetRes.statusCode).toBe(200);
    });

    it('should stop the password set at signup from logging in', async () => {
      const res = await login(squatter.email, SIGNUP_PASSWORD);

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe(INVALID_CREDENTIALS);
    });

    it('should let the new password log in', async () => {
      const res = await login(squatter.email, OWNER_PASSWORD);

      expect(res.statusCode).toBe(200);
    });

    it('should revoke the refresh token issued at signup', async () => {
      const res = await refresh(squatter.refreshToken);

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe(REFRESH_TOKEN_REVOKED);
    });

    it('should mark the email Account verified, since the reset code proves the inbox', async () => {
      const emailAccount = await emailAccountOf(squatter.userId);

      expect(emailAccount.verifiedAt).not.toBeNull();
    });
  });

  describe('(c) the logged-in user verifies with the emailed code', () => {
    let owner;
    let verifyRes;

    beforeEach(async () => {
      owner = await signupDirect(uniqueEmail('owner'));
      const code = await waitForCode(owner.email);
      verifyRes = await verifyEmail(owner.accessToken, code);
    });

    it('should verify the email', async () => {
      expect(verifyRes.statusCode).toBe(200);
      expect((await getMe(owner.accessToken)).json().emailVerified).toBe(true);
    });

    it('should keep the password set at signup', async () => {
      const res = await login(owner.email, SIGNUP_PASSWORD);

      expect(res.statusCode).toBe(200);
    });

    it('should keep the refresh token issued at signup', async () => {
      const res = await refresh(owner.refreshToken);

      expect(res.statusCode).toBe(200);
    });
  });

  describe.each(OAUTH_PROVIDERS)('an account already verified by code later links $name', (oauth) => {
    let owner;
    let oauthRes;

    beforeEach(async () => {
      owner = await signupDirect(uniqueEmail('owner'));
      const code = await waitForCode(owner.email);
      expect((await verifyEmail(owner.accessToken, code)).statusCode).toBe(200);
      mockOAuthIdentity(owner.email);
      oauthRes = await app.inject({ method: 'POST', url: oauth.url, payload: oauth.payload });
    });

    it('should link the provider to the same account', async () => {
      expect(oauthRes.statusCode).toBe(200);
      expect(oauthRes.json().user.id).toBe(owner.userId);
    });

    it('should keep the password', async () => {
      const res = await login(owner.email, SIGNUP_PASSWORD);

      expect(res.statusCode).toBe(200);
    });

    it('should keep the refresh token issued at signup', async () => {
      const res = await refresh(owner.refreshToken);

      expect(res.statusCode).toBe(200);
    });
  });
});
