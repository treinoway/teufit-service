import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import emailHandler from '../../src/config/email-handler.js';
import { Roles } from '../../src/constants/roles.js';
import { EMAIL_PROVIDER } from '../../src/constants/email-verification.js';
import { OAuthErrorCode, OAuthMessageCode } from '../../src/constants/oauth-security.js';
import { StudentInviteStatus } from '../../src/constants/student-invite.js';
import { PasswordResetErrorCode } from '../../src/constants/password-reset.js';
import enUS from '../../src/i18n/locales/en-US.js';
import ptBR from '../../src/i18n/locales/pt-BR.js';

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

const ATTACKER_PASSWORD = 'AttackerPassw0rd!';
const OWNER_PASSWORD = 'OwnerNewPassw0rd!';
const TRAINER_PASSWORD = 'StrongPassw0rd!';
const GOOGLE_SUBJECT = 'google-subject-hijack-0001';
const APPLE_SUBJECT = 'apple.hijack.0001';
const ADMIN_EMAIL = 'hardening-admin@example.com';
const Language = Object.freeze({ EN: 'en-US', PT: 'pt-BR' });
const OAUTH_ERROR_LOCALES = Object.freeze({
  [Language.EN]: enUS.errors[OAuthMessageCode.EMAIL_NOT_VERIFIED],
  [Language.PT]: ptBR.errors[OAuthMessageCode.EMAIL_NOT_VERIFIED],
});

e2eDescribe('e2e: email verification hardening (account pre-hijack, inbox proof)', () => {
  let app;
  let counter = 0;
  let verificationCodes;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    vi.clearAllMocks();
    verificationCodes = new Map();
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      verificationCodes.set(to.toLowerCase(), code);
    });
    vi.spyOn(emailHandler, 'sendStudentInviteEmail').mockResolvedValue(undefined);
    vi.spyOn(emailHandler, 'sendExistingUserStudentInviteEmail').mockResolvedValue(undefined);
  });

  const auth = (token) => ({ authorization: `Bearer ${token}` });

  function uniqueEmail(prefix) {
    counter += 1;
    return `e2e+${prefix}-${Date.now()}-${counter}@example.com`;
  }

  // POST /auth/signup no longer creates accounts before the inbox is proven, so
  // the unverified password account these defences target can only be a legacy
  // one (created by the old one-step signup): seed it directly.
  function signup(email, password = ATTACKER_PASSWORD) {
    return seedLegacyUnverifiedUser(app, { email, password });
  }

  const login = (email, password) =>
    app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

  const refresh = (refreshToken) =>
    app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

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

  const verifyEmail = (token, code) =>
    app.inject({ method: 'POST', url: '/auth/verify-email', headers: auth(token), payload: { code } });

  const googleMobile = (headers = {}) =>
    app.inject({ method: 'POST', url: '/auth/google/mobile', headers, payload: { idToken: 'mock-token' } });

  const appleMobile = (headers = {}) =>
    app.inject({ method: 'POST', url: '/auth/apple/mobile', headers, payload: { identityToken: 'mock-token' } });

  const googleWeb = (headers = {}) =>
    app.inject({ method: 'POST', url: '/auth/google/web', headers, payload: { idToken: 'mock-token' } });

  function mockGoogle(email, emailVerified) {
    verifyGoogleIdToken.mockResolvedValue({ subject: GOOGLE_SUBJECT, email, name: 'Owner Person', emailVerified });
    verifyFirebaseIdToken.mockResolvedValue({ subject: GOOGLE_SUBJECT, email, name: 'Owner Person', emailVerified });
  }

  function mockApple(email, emailVerified) {
    verifyAppleIdToken.mockResolvedValue({ subject: APPLE_SUBJECT, email, emailVerified, isPrivateEmail: false });
  }

  const emailAccountOf = (userId) => prisma.account.findFirst({ where: { userId, provider: EMAIL_PROVIDER } });

  async function createTrainer() {
    const { userId, accessToken } = await signup(uniqueEmail('trainer'), TRAINER_PASSWORD);
    const becomeRes = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(accessToken) });
    expect(becomeRes.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id);
    return { userId, trainerId: trainer.id, token: becomeRes.json().token.accessToken };
  }

  async function inviteStudent(trainerToken, email) {
    const res = await app.inject({
      method: 'POST',
      url: '/trainer/student-invites',
      headers: auth(trainerToken),
      payload: { email },
    });
    expect(res.statusCode).toBe(201);
    return res.json().invite;
  }

  // ---------------------------------------------------------------------------
  describe('pre-account-hijack: verified OAuth identity takes over an unverified password signup', () => {
    let victimEmail;
    let attacker;
    let attackerResetToken;
    let attackerVerificationCode;
    let googleRes;

    beforeEach(async () => {
      victimEmail = uniqueEmail('victim');
      attacker = await signup(victimEmail);
      attackerVerificationCode = verificationCodes.get(attacker.email);
      attackerResetToken = await forgotPassword(victimEmail);

      mockGoogle(victimEmail, true);
      googleRes = await googleMobile();
    });

    it('should let the real owner sign in with the verified Google identity', async () => {
      expect(googleRes.statusCode).toBe(200);
      expect(googleRes.json().user.id).toBe(attacker.userId);
      const googleAccount = await prisma.account.findFirst({
        where: { userId: attacker.userId, provider: 'google' },
      });
      expect(googleAccount.verifiedAt).not.toBeNull();
    });

    it('should clear the attacker password so password login is no longer possible', async () => {
      const res = await login(victimEmail, ATTACKER_PASSWORD);

      // OAuth-only accounts answer like a wrong password (no account enumeration).
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('INVALID_CREDENTIALS');
      const user = await prisma.user.findUnique({ where: { id: attacker.userId } });
      expect(user.passwordHash).toBeNull();
    });

    it('should revoke the attacker refresh token so it can no longer rotate', async () => {
      const res = await refresh(attacker.refreshToken);

      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('REFRESH_TOKEN_REVOKED');
    });

    it('should make the attacker outstanding password-reset code unusable', async () => {
      const res = await resetPassword(victimEmail, attackerResetToken, ATTACKER_PASSWORD);

      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe(PasswordResetErrorCode.INVALID_CODE);
      const user = await prisma.user.findUnique({ where: { id: attacker.userId } });
      expect(user.passwordHash).toBeNull();
    });

    it('should make the attacker outstanding verification code unusable', async () => {
      const res = await verifyEmail(attacker.accessToken, attackerVerificationCode);

      expect(res.statusCode).not.toBe(200);
      const openTokens = await prisma.emailVerificationToken.count({
        where: { userId: attacker.userId, used: false },
      });
      expect(openTokens).toBe(0);
      const emailAccount = await emailAccountOf(attacker.userId);
      expect(emailAccount.verifiedAt).toBeNull();
    });

    it('should keep the unverified email Account row', async () => {
      const emailAccount = await emailAccountOf(attacker.userId);

      expect(emailAccount).not.toBeNull();
      expect(emailAccount.verifiedAt).toBeNull();
    });

    it('should let the owner set a password via forgot-password + reset, marking the email Account verified', async () => {
      const ownerResetToken = await forgotPassword(victimEmail);

      const resetRes = await resetPassword(victimEmail, ownerResetToken);

      expect(resetRes.statusCode).toBe(200);
      const emailAccount = await emailAccountOf(attacker.userId);
      expect(emailAccount.verifiedAt).not.toBeNull();
      expect((await login(victimEmail, OWNER_PASSWORD)).statusCode).toBe(200);
      expect((await login(victimEmail, ATTACKER_PASSWORD)).statusCode).toBe(401);
    });
  });

  describe('verified OAuth identity attaching to a user whose password email is already verified', () => {
    it('should keep the password credential and refresh tokens', async () => {
      const email = uniqueEmail('verifiedpw');
      const user = await signup(email);
      const verifyRes = await verifyEmail(user.accessToken, verificationCodes.get(user.email));
      expect(verifyRes.statusCode).toBe(200);
      mockGoogle(email, true);

      const res = await googleMobile();

      expect(res.statusCode).toBe(200);
      expect((await login(email, ATTACKER_PASSWORD)).statusCode).toBe(200);
      expect((await refresh(user.refreshToken)).statusCode).toBe(200);
    });
  });

  // ---------------------------------------------------------------------------
  describe('unverified OAuth identity attaching to an existing user', () => {
    const providers = [
      { name: 'google mobile', provider: 'google', call: googleMobile, mock: mockGoogle },
      { name: 'apple mobile', provider: 'apple', call: appleMobile, mock: mockApple },
      { name: 'google web', provider: 'google', call: googleWeb, mock: mockGoogle },
    ];

    describe.each(providers)('$name', ({ provider, call, mock }) => {
      it.each([Language.EN, Language.PT])(
        'should reject with 403 auth.oauthEmailNotVerified and mutate nothing (app-language %s)',
        async (language) => {
          const email = uniqueEmail('unverifiedoauth');
          const user = await signup(email);
          mock(email, false);

          const res = await call({ 'app-language': language });

          expect(res.statusCode).toBe(403);
          expect(res.json()).toMatchObject({
            error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
            messageCode: OAuthMessageCode.EMAIL_NOT_VERIFIED,
            message: OAUTH_ERROR_LOCALES[language],
          });
          expect(await prisma.account.count({ where: { userId: user.userId, provider } })).toBe(0);
          const persisted = await prisma.user.findUnique({ where: { id: user.userId } });
          expect(persisted.passwordHash).not.toBeNull();
          expect((await refresh(user.refreshToken)).statusCode).toBe(200);
          expect((await login(email, ATTACKER_PASSWORD)).statusCode).toBe(200);
        },
      );

      it('should reject a brand-new email with 403 and create no User row', async () => {
        const email = uniqueEmail('newunverified');
        const usersBefore = await prisma.user.count();
        mock(email, false);

        const res = await call();

        expect(res.statusCode).toBe(403);
        expect(res.json().error).toBe(OAuthErrorCode.EMAIL_NOT_VERIFIED);
        expect(await prisma.user.findFirst({ where: { email } })).toBeNull();
        expect(await prisma.user.count()).toBe(usersBefore);
        expect(await prisma.account.count({ where: { provider } })).toBe(0);
      });

      it('should answer byte-identically for an existing email and a brand-new email', async () => {
        const existingEmail = uniqueEmail('existing');
        await signup(existingEmail);
        mock(existingEmail, false);
        const existingRes = await call();
        mock(uniqueEmail('brandnew'), false);
        const newRes = await call();

        expect(existingRes.statusCode).toBe(403);
        expect(newRes.statusCode).toBe(existingRes.statusCode);
        expect(newRes.body).toBe(existingRes.body);
        expect(existingRes.json()).toMatchObject({
          error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
          messageCode: OAuthMessageCode.EMAIL_NOT_VERIFIED,
          message: expect.any(String),
        });
      });

      it('should reject an already-linked account when the token later reports an unverified email', async () => {
        const email = uniqueEmail('linked');
        mock(email, true);
        const first = await call();
        expect([200, 201]).toContain(first.statusCode);
        const userId = first.json().user.id;
        const linkedBefore = await prisma.account.findFirst({ where: { userId, provider } });
        mock(email, false);

        const res = await call();

        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({
          error: OAuthErrorCode.EMAIL_NOT_VERIFIED,
          messageCode: OAuthMessageCode.EMAIL_NOT_VERIFIED,
        });
        const linkedAfter = await prisma.account.findFirst({ where: { userId, provider } });
        expect(linkedAfter.updatedAt?.getTime()).toBe(linkedBefore.updatedAt?.getTime());
      });
    });

    describe('apple returning login without an email claim', () => {
      it('should authenticate an already-linked account', async () => {
        const email = uniqueEmail('applereturning');
        mockApple(email, true);
        const first = await appleMobile();
        expect(first.statusCode).toBe(201);
        mockApple(undefined, undefined);

        const res = await appleMobile();

        expect(res.statusCode).toBe(200);
        expect(res.json().user.id).toBe(first.json().user.id);
      });
    });

    it('should have distinct translated messages per language', () => {
      expect(OAUTH_ERROR_LOCALES[Language.EN]).toEqual(expect.any(String));
      expect(OAUTH_ERROR_LOCALES[Language.PT]).not.toBe(OAUTH_ERROR_LOCALES[Language.EN]);
    });
  });

  // ---------------------------------------------------------------------------
  describe('password reset as inbox proof', () => {
    it('should revoke the squatter sessions of a legacy unverified account when the owner resets the password', async () => {
      const victimEmail = uniqueEmail('squatted');
      const squatter = await signup(victimEmail);
      const ownerResetToken = await forgotPassword(victimEmail);

      expect((await resetPassword(victimEmail, ownerResetToken)).statusCode).toBe(200);

      const res = await refresh(squatter.refreshToken);
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('REFRESH_TOKEN_REVOKED');
      expect((await emailAccountOf(squatter.userId)).verifiedAt).not.toBeNull();
    });

    it('should mark the email Account verified and accept pending student invites', async () => {
      const trainer = await createTrainer();
      const studentEmail = uniqueEmail('resetstudent');
      const invite = await inviteStudent(trainer.token, studentEmail);
      const student = await signup(studentEmail);
      const resetToken = await forgotPassword(studentEmail);

      const res = await resetPassword(studentEmail, resetToken);

      expect(res.statusCode).toBe(200);
      expect((await emailAccountOf(student.userId)).verifiedAt).not.toBeNull();
      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted).toMatchObject({ status: StudentInviteStatus.ACCEPTED, studentId: student.userId });
      const link = await prisma.trainerStudent.findFirst({
        where: { trainerId: trainer.trainerId, studentId: student.userId },
      });
      expect(link).not.toBeNull();
    });

    it('should create an already-verified email Account for an OAuth-only user resetting a password', async () => {
      const email = uniqueEmail('oauthonly');
      mockGoogle(email, true);
      const googleRes = await googleMobile();
      expect(googleRes.statusCode).toBe(200);
      const userId = googleRes.json().user.id;
      expect(await emailAccountOf(userId)).toBeNull();
      const resetToken = await forgotPassword(email);

      const res = await resetPassword(email, resetToken);

      expect(res.statusCode).toBe(200);
      const emailAccount = await emailAccountOf(userId);
      expect(emailAccount).toMatchObject({ providerId: email.toLowerCase() });
      expect(emailAccount.verifiedAt).not.toBeNull();
    });

    it('should leave an already verified email Account untouched', async () => {
      const user = await signup(uniqueEmail('alreadyverified'));
      await verifyEmail(user.accessToken, verificationCodes.get(user.email));
      const before = await emailAccountOf(user.userId);
      const resetToken = await forgotPassword(user.email);

      const res = await resetPassword(user.email, resetToken);

      expect(res.statusCode).toBe(200);
      const after = await emailAccountOf(user.userId);
      expect(after.verifiedAt.getTime()).toBe(before.verifiedAt.getTime());
    });

    it('should not mark verified when the reset token is invalid', async () => {
      const user = await signup(uniqueEmail('badreset'));

      const res = await resetPassword(user.email, '000000');

      expect(res.statusCode).toBe(400);
      expect((await emailAccountOf(user.userId)).verifiedAt).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  describe('trainer invite redemption as inbox proof', () => {
    async function createAdminToken() {
      const { userId } = await signup(ADMIN_EMAIL, TRAINER_PASSWORD);
      await prisma.user.update({ where: { id: userId }, data: { roles: { set: [Roles.ADMIN] } } });
      const res = await login(ADMIN_EMAIL, TRAINER_PASSWORD);
      expect(res.statusCode).toBe(200);
      return res.json().token.accessToken;
    }

    async function createTrainerInvite(adminToken, email) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/trainer-invites',
        headers: auth(adminToken),
        payload: { email },
      });
      expect(res.statusCode).toBe(201);
      return res.json().code;
    }

    const redeem = (token, code) =>
      app.inject({ method: 'POST', url: '/invite/redeem', headers: auth(token), payload: { code } });

    it('should mark the email Account verified and accept pending student invites without changing the response', async () => {
      const trainer = await createTrainer();
      const adminToken = await createAdminToken();
      const inviteeEmail = uniqueEmail('redeemee');
      const studentInvite = await inviteStudent(trainer.token, inviteeEmail);
      const invitee = await signup(inviteeEmail);
      const code = await createTrainerInvite(adminToken, inviteeEmail);

      const res = await redeem(invitee.accessToken, code);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        betaAccess: true,
        token: { accessToken: expect.any(String) },
        refreshToken: expect.any(String),
      });
      expect((await emailAccountOf(invitee.userId)).verifiedAt).not.toBeNull();
      const persisted = await prisma.studentInvite.findUnique({ where: { id: studentInvite.id } });
      expect(persisted).toMatchObject({ status: StudentInviteStatus.ACCEPTED, studentId: invitee.userId });
    });

    it('should not verify the email when the invite is bound to a different address', async () => {
      const adminToken = await createAdminToken();
      const other = await signup(uniqueEmail('redeemother'));
      const code = await createTrainerInvite(adminToken, uniqueEmail('someoneelse'));

      const res = await redeem(other.accessToken, code);

      expect(res.statusCode).toBe(403);
      expect((await emailAccountOf(other.userId)).verifiedAt).toBeNull();
    });
  });
});
