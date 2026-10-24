import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import emailHandler from '../../src/config/email-handler.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
  STUDENT_INVITE_MAX_SENDS,
  STUDENT_INVITE_RESEND_COOLDOWN_MS,
  STUDENT_INVITE_DAILY_MAX,
  STUDENT_INVITE_DAILY_WINDOW_MS,
} from '../../src/constants/student-invite.js';
import {
  EmailVerificationErrorCode,
  EmailVerificationMessageCode,
  EMAIL_VERIFICATION_MAX_ATTEMPTS,
  EMAIL_VERIFICATION_RESEND_COOLDOWN_MS,
  EMAIL_VERIFICATION_DAILY_MAX_CODES,
  EMAIL_VERIFICATION_DAILY_WINDOW_MS,
} from '../../src/constants/email-verification.js';
import { OAuthErrorCode } from '../../src/constants/oauth-security.js';
import { StudentBlocker } from '../../src/constants/student-blocker.js';
import { PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';

vi.mock('../../src/services/google-id-token-service.js', () => ({
  verifyGoogleIdToken: vi.fn(),
}));
vi.mock('../../src/services/apple-id-token-service.js', () => ({
  verifyAppleIdToken: vi.fn(),
}));

import { verifyGoogleIdToken } from '../../src/services/google-id-token-service.js';
import { verifyAppleIdToken } from '../../src/services/apple-id-token-service.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const WRONG_CODE = '000000';
const FREE_TIER = 'FREE';
const FREE_STUDENT_CAP = 3;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function expectErrorContract(body, { error, messageCode }) {
  expect(body).toMatchObject({ error, messageCode, message: expect.any(String) });
}

e2eDescribe('e2e: student invites + email verification', () => {
  let app;
  let uniqueCounter = 0;
  // Verification codes / invite emails captured from the (stubbed) email handler.
  let verificationCodes;
  let inviteEmails;
  // Existing-user (unverified) variant invite emails: payloads and the codes they carried.
  let existingUserInviteEmails;
  let existingUserInviteCodes;

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    verificationCodes = new Map();
    inviteEmails = [];
    existingUserInviteEmails = [];
    existingUserInviteCodes = new Map();
    vi.spyOn(emailHandler, 'sendExistingUserStudentInviteEmail').mockImplementation(async (payload) => {
      existingUserInviteEmails.push(payload);
      if (payload.code) existingUserInviteCodes.set(payload.to.toLowerCase(), payload.code);
    });
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      verificationCodes.set(to.toLowerCase(), code);
    });
    vi.spyOn(emailHandler, 'sendStudentInviteEmail').mockImplementation(async (payload) => {
      inviteEmails.push(payload);
    });
  });

  function uniqueEmail(prefix) {
    uniqueCounter += 1;
    return `e2e+${prefix}-${Date.now()}-${uniqueCounter}@example.com`;
  }

  const auth = (token) => ({ authorization: `Bearer ${token}` });

  // An existing account whose email is not verified yet (only legacy accounts
  // can be in that state now: POST /auth/signup creates the user only after
  // the code is confirmed). A first verification code is issued, as the old
  // signup did.
  async function signup(email) {
    const { userId, accessToken, email: normalizedEmail } = await seedLegacyUnverifiedUser(app, { email, password: PASSWORD });
    return { userId, accessToken, email: normalizedEmail };
  }

  async function signupVerified(email) {
    const student = await signup(email);
    const res = await verifyEmail(student.accessToken, verificationCodes.get(student.email));
    expect(res.statusCode).toBe(200);
    return student;
  }

  function expectInviteResendFields(invite, { canResend, resendAvailable }) {
    expect(invite.canResend).toBe(canResend);
    if (resendAvailable) {
      expect(new Date(invite.resendAvailableAt).getTime()).toBeGreaterThan(Date.now());
    } else {
      expect(invite.resendAvailableAt).toBeNull();
    }
  }

  async function createTrainer({ tier = 'DIAMOND' } = {}) {
    const { userId, accessToken, email } = await signup(uniqueEmail('trainer'));
    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: auth(accessToken),
    });
    expect(becomeRes.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id, tier);
    return { userId, trainerId: trainer.id, email, token: becomeRes.json().token.accessToken };
  }

  function inviteStudent(token, email) {
    return app.inject({
      method: 'POST',
      url: '/trainer/student-invites',
      headers: auth(token),
      payload: { email },
    });
  }

  function listInvites(token, query = '') {
    return app.inject({ method: 'GET', url: `/trainer/student-invites${query}`, headers: auth(token) });
  }

  function resendInvite(token, id) {
    return app.inject({ method: 'POST', url: `/trainer/student-invites/${id}/resend`, headers: auth(token) });
  }

  function revokeInvite(token, id) {
    return app.inject({ method: 'DELETE', url: `/trainer/student-invites/${id}`, headers: auth(token) });
  }

  function verifyEmail(token, code) {
    return app.inject({ method: 'POST', url: '/auth/verify-email', headers: auth(token), payload: { code } });
  }

  function resendVerification(token) {
    return app.inject({ method: 'POST', url: '/auth/verify-email/resend', headers: auth(token) });
  }

  function getMe(token) {
    return app.inject({ method: 'GET', url: '/me', headers: auth(token) });
  }

  function listStudents(token) {
    return app.inject({ method: 'GET', url: '/trainer/students', headers: auth(token) });
  }

  async function createInvitedTrainerAndEmail({ tier } = {}) {
    const trainer = await createTrainer({ tier });
    const studentEmail = uniqueEmail('invitee');
    const res = await inviteStudent(trainer.token, studentEmail);
    expect(res.statusCode).toBe(201);
    return { trainer, studentEmail, invite: res.json().invite };
  }

  describe('POST /trainer/student-invites', () => {
    it('should create a pending invite for an unregistered email and send the invite email', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('new');

      const res = await inviteStudent(trainer.token, email.toUpperCase());

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body.outcome).toBe(StudentInviteOutcome.INVITED);
      expect(body.invite).toMatchObject({
        email,
        status: StudentInviteStatus.PENDING,
        studentId: null,
        acceptedAt: null,
        revokedAt: null,
        sendCount: 1,
      });
      expect(inviteEmails).toHaveLength(1);
      expect(inviteEmails[0].to).toBe(email);
      const persisted = await prisma.studentInvite.findUnique({ where: { id: body.invite.id } });
      expect(persisted.trainerId).toBe(trainer.trainerId);
    });

    it('should still return 201 when the invite email fails to send', async () => {
      emailHandler.sendStudentInviteEmail.mockRejectedValue(new Error('resend down'));
      const trainer = await createTrainer();

      const res = await inviteStudent(trainer.token, uniqueEmail('mailfail'));

      expect(res.statusCode).toBe(201);
      expect(res.json().outcome).toBe(StudentInviteOutcome.INVITED);
    });

    it('should still return 201 when Resend returns an error instead of throwing', async () => {
      emailHandler.sendStudentInviteEmail.mockResolvedValue({ data: null, error: { message: 'rejected' } });
      const trainer = await createTrainer();

      const res = await inviteStudent(trainer.token, uniqueEmail('mailerror'));

      expect(res.statusCode).toBe(201);
      expect(res.json().outcome).toBe(StudentInviteOutcome.INVITED);
    });

    it('should link a registered user immediately and return outcome linked', async () => {
      const trainer = await createTrainer();
      const student = await signupVerified(uniqueEmail('registered'));

      const res = await inviteStudent(trainer.token, student.email.toUpperCase());

      expect(res.statusCode).toBe(201);
      expect(res.json()).toMatchObject({
        outcome: StudentInviteOutcome.LINKED,
        student: { id: student.userId, email: student.email },
      });
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
      });
      expect(link).not.toBeNull();
      expect(await prisma.studentInvite.count()).toBe(0);
    });

    it('should mark a pending verified student active when the trainer links them', async () => {
      const trainer = await createTrainer();
      const student = await signupVerified(uniqueEmail('linkpending'));
      await prisma.user.update({ where: { id: student.userId }, data: { status: 'pending' } });

      const res = await inviteStudent(trainer.token, student.email);

      expect(res.json().outcome).toBe(StudentInviteOutcome.LINKED);
      const persisted = await prisma.user.findUnique({ where: { id: student.userId }, select: { status: true } });
      expect(persisted.status).toBe('active');
    });

    it('should return canResend false and a future resendAvailableAt on the created invite', async () => {
      const trainer = await createTrainer();

      const res = await inviteStudent(trainer.token, uniqueEmail('fields'));

      expectInviteResendFields(res.json().invite, { canResend: false, resendAvailable: true });
    });

    it('should mark this trainer\'s pending invite accepted when the email later belongs to a verified user linked directly', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('directaccept');
      const pending = (await inviteStudent(trainer.token, email)).json().invite;
      const student = await signup(email);
      await prisma.account.updateMany({ where: { userId: student.userId }, data: { verifiedAt: new Date() } });

      const res = await inviteStudent(trainer.token, email);

      expect(res.json().outcome).toBe(StudentInviteOutcome.LINKED);
      const persisted = await prisma.studentInvite.findUnique({ where: { id: pending.id } });
      expect(persisted).toMatchObject({
        status: StudentInviteStatus.ACCEPTED,
        studentId: student.userId,
        acceptedAt: expect.any(Date),
      });
    });

    describe('existing user with an unverified email', () => {
      it('should create a pending invite instead of linking directly', async () => {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('unverified'));

        const res = await inviteStudent(trainer.token, student.email.toUpperCase());

        expect(res.statusCode).toBe(201);
        expect(res.json().outcome).toBe(StudentInviteOutcome.INVITED);
        expect(res.json().invite).toMatchObject({ email: student.email, status: StudentInviteStatus.PENDING });
        expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(0);
        expect(existingUserInviteEmails).toHaveLength(1);
        expect(inviteEmails).toHaveLength(0);
      });

      it('should link and accept the invite once the user verifies the code', async () => {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('verifylater'));
        const invite = (await inviteStudent(trainer.token, student.email)).json().invite;

        const verifyRes = await verifyEmail(student.accessToken, verificationCodes.get(student.email));

        expect(verifyRes.json()).toEqual({ verified: true, linkedTrainers: 1 });
        const link = await prisma.trainerStudent.findUnique({
          where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
        });
        expect(link).not.toBeNull();
        const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
        expect(persisted).toMatchObject({ status: StudentInviteStatus.ACCEPTED, studentId: student.userId });
      });

      it('should mark the user active once the invite is accepted on email verification', async () => {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('activateonverify'));
        await inviteStudent(trainer.token, student.email);

        await verifyEmail(student.accessToken, verificationCodes.get(student.email));

        const persisted = await prisma.user.findUnique({ where: { id: student.userId }, select: { status: true } });
        expect(persisted.status).toBe('active');
      });

      it('should mark the user active on email verification even without any invite', async () => {
        const student = await signup(uniqueEmail('activatenoinvite'));

        await verifyEmail(student.accessToken, verificationCodes.get(student.email));

        const persisted = await prisma.user.findUnique({ where: { id: student.userId }, select: { status: true } });
        expect(persisted.status).toBe('active');
      });

      it('should keep the user pending while the email is still unverified', async () => {
        const student = await signup(uniqueEmail('stillpending'));

        const persisted = await prisma.user.findUnique({ where: { id: student.userId }, select: { status: true } });
        expect(persisted.status).toBe('pending');
      });

      it('should return 409 studentInvite.alreadyPending on a duplicate invite', async () => {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('unverdup'));
        await inviteStudent(trainer.token, student.email);

        const res = await inviteStudent(trainer.token, student.email);

        expect(res.statusCode).toBe(409);
        expectErrorContract(res.json(), {
          error: StudentInviteErrorCode.ALREADY_PENDING,
          messageCode: StudentInviteMessageCode.ALREADY_PENDING,
        });
      });

      it('should return 409 student.alreadyLinked when the unverified user is already linked to this trainer', async () => {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('unverlinked'));
        await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId: student.userId } });

        const res = await inviteStudent(trainer.token, student.email);

        expect(res.statusCode).toBe(409);
        expectErrorContract(res.json(), { error: expect.any(String), messageCode: StudentInviteMessageCode.ALREADY_LINKED });
        expect(await prisma.studentInvite.count()).toBe(0);
      });

      it('should return 422 student.accountDeactivated for a soft-deleted unverified user', async () => {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('unverdeleted'));
        await prisma.user.update({ where: { id: student.userId }, data: { deletedAt: new Date() } });

        const res = await inviteStudent(trainer.token, student.email);

        expect(res.statusCode).toBe(422);
        expectErrorContract(res.json(), {
          error: StudentInviteErrorCode.STUDENT_ACCOUNT_DEACTIVATED,
          messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
        });
      });

      describe('verification code carried by the invite email', () => {
        async function backdateVerificationTokens(userId) {
          await prisma.emailVerificationToken.updateMany({
            where: { userId },
            data: { createdAt: new Date(Date.now() - 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) },
          });
        }

        it('should email the variant with a fresh code that verifies the email and accepts the invite', async () => {
          const trainer = await createTrainer();
          const student = await signup(uniqueEmail('m1code'));
          const signupCode = verificationCodes.get(student.email);
          await backdateVerificationTokens(student.userId);

          const inviteRes = await inviteStudent(trainer.token, student.email);

          expect(inviteRes.statusCode).toBe(201);
          expect(existingUserInviteEmails).toEqual([
            { to: student.email, trainerName: expect.any(String), code: expect.stringMatching(/^\d{6}$/) },
          ]);
          const inviteCode = existingUserInviteCodes.get(student.email);
          if (inviteCode !== signupCode) {
            const staleRes = await verifyEmail(student.accessToken, signupCode);
            expect(staleRes.statusCode).toBe(400);
          }
          const verifyRes = await verifyEmail(student.accessToken, inviteCode);
          expect(verifyRes.statusCode).toBe(200);
          expect(verifyRes.json()).toEqual({ verified: true, linkedTrainers: 1 });
          const persisted = await prisma.studentInvite.findUnique({ where: { id: inviteRes.json().invite.id } });
          expect(persisted).toMatchObject({ status: StudentInviteStatus.ACCEPTED, studentId: student.userId });
        });

        it('should still return 201 and send the variant with code null when the resend cooldown blocks issuing', async () => {
          const trainer = await createTrainer();
          const student = await signup(uniqueEmail('m1cooldown'));

          const res = await inviteStudent(trainer.token, student.email);

          expect(res.statusCode).toBe(201);
          expect(existingUserInviteEmails).toEqual([
            { to: student.email, trainerName: expect.any(String), code: null },
          ]);
          expect(await prisma.emailVerificationToken.count({ where: { userId: student.userId } })).toBe(1);
        });

        it('should still return 201 and send the variant with code null when the daily code cap blocks issuing', async () => {
          const trainer = await createTrainer();
          const student = await signup(uniqueEmail('m1cap'));
          await prisma.emailVerificationToken.updateMany({
            where: { userId: student.userId },
            data: { createdAt: new Date(Date.now() - 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) },
          });
          await prisma.emailVerificationToken.createMany({
            data: Array.from({ length: EMAIL_VERIFICATION_DAILY_MAX_CODES - 1 }, (_, i) => ({
              userId: student.userId,
              tokenHash: `seed-hash-${student.userId}-${i}`,
              used: true,
              expiresAt: new Date(Date.now() + MS_PER_HOUR),
              createdAt: new Date(Date.now() - (i + 3) * MS_PER_HOUR),
            })),
          });

          const res = await inviteStudent(trainer.token, student.email);

          expect(res.statusCode).toBe(201);
          expect(existingUserInviteEmails).toEqual([
            { to: student.email, trainerName: expect.any(String), code: null },
          ]);
        });

        it.each([
          [
            'a thrown error',
            () => emailHandler.sendExistingUserStudentInviteEmail.mockRejectedValue(new Error('resend down')),
          ],
          [
            'a returned Resend error',
            () =>
              emailHandler.sendExistingUserStudentInviteEmail.mockResolvedValue({
                data: null,
                error: { message: 'rejected' },
              }),
          ],
        ])('should still return 201 and mark the issued token undelivered when the variant email fails with %s', async (_label, arrange) => {
          const trainer = await createTrainer();
          const student = await signup(uniqueEmail('m1fail'));
          await backdateVerificationTokens(student.userId);
          arrange();

          const res = await inviteStudent(trainer.token, student.email);

          expect(res.statusCode).toBe(201);
          expect(res.json().outcome).toBe(StudentInviteOutcome.INVITED);
          const failed = await prisma.emailVerificationToken.findMany({
            where: { userId: student.userId, sendFailedAt: { not: null } },
          });
          expect(failed).toHaveLength(1);
          expect(failed[0].used).toBe(true);
        });
      });
    });

    describe('per-trainer daily invite cap', () => {
      async function seedInvites(trainerId, count, createdAtFor) {
        await prisma.studentInvite.createMany({
          data: Array.from({ length: count }, (_, i) => ({
            trainerId,
            email: `seed-${i}-${Date.now()}@example.com`,
            expiresAt: new Date(Date.now() + MS_PER_DAY),
            createdAt: createdAtFor(i),
          })),
        });
      }

      it('should return 429 studentInvite.dailyLimit with retryAfterSeconds once the cap is reached', async () => {
        const trainer = await createTrainer();
        const oldestAgeMs = 2 * MS_PER_HOUR;
        await seedInvites(trainer.trainerId, STUDENT_INVITE_DAILY_MAX, (i) =>
          new Date(Date.now() - (i === STUDENT_INVITE_DAILY_MAX - 1 ? oldestAgeMs : i * 1000)),
        );

        const res = await inviteStudent(trainer.token, uniqueEmail('overdaily'));

        expect(res.statusCode).toBe(429);
        expectErrorContract(res.json(), {
          error: StudentInviteErrorCode.DAILY_LIMIT,
          messageCode: StudentInviteMessageCode.DAILY_LIMIT,
        });
        const expectedSeconds = (STUDENT_INVITE_DAILY_WINDOW_MS - oldestAgeMs) / 1000;
        expect(res.json().details.retryAfterSeconds).toBeGreaterThan(expectedSeconds - 30);
        expect(res.json().details.retryAfterSeconds).toBeLessThanOrEqual(expectedSeconds);
        expect(await prisma.studentInvite.count()).toBe(STUDENT_INVITE_DAILY_MAX);
        expect(inviteEmails).toHaveLength(0);
      });

      it('should still allow the invite when one below the cap', async () => {
        const trainer = await createTrainer();
        await seedInvites(trainer.trainerId, STUDENT_INVITE_DAILY_MAX - 1, (i) => new Date(Date.now() - i * 1000));

        const res = await inviteStudent(trainer.token, uniqueEmail('belowcap'));

        expect(res.statusCode).toBe(201);
      });

      it('should not count invites created outside the rolling window', async () => {
        const trainer = await createTrainer();
        await seedInvites(trainer.trainerId, STUDENT_INVITE_DAILY_MAX, (i) =>
          new Date(Date.now() - STUDENT_INVITE_DAILY_WINDOW_MS - (i + 1) * 1000),
        );

        const res = await inviteStudent(trainer.token, uniqueEmail('oldwindow'));

        expect(res.statusCode).toBe(201);
      });

      it('should not count invites of other trainers', async () => {
        const trainer = await createTrainer();
        const other = await createTrainer();
        await seedInvites(other.trainerId, STUDENT_INVITE_DAILY_MAX, (i) => new Date(Date.now() - i * 1000));

        const res = await inviteStudent(trainer.token, uniqueEmail('othertrainer'));

        expect(res.statusCode).toBe(201);
      });

      it('should not apply to direct links of verified users', async () => {
        const trainer = await createTrainer();
        await seedInvites(trainer.trainerId, STUDENT_INVITE_DAILY_MAX, (i) => new Date(Date.now() - i * 1000));
        const student = await signupVerified(uniqueEmail('directatcap'));

        const res = await inviteStudent(trainer.token, student.email);

        expect(res.statusCode).toBe(201);
        expect(res.json().outcome).toBe(StudentInviteOutcome.LINKED);
      });

      it('should not count resends toward the cap', async () => {
        const trainer = await createTrainer();
        await seedInvites(trainer.trainerId, STUDENT_INVITE_DAILY_MAX - 1, (i) => new Date(Date.now() - i * 1000));
        const invite = (await inviteStudent(trainer.token, uniqueEmail('resendnocount'))).json().invite;
        await prisma.studentInvite.update({
          where: { id: invite.id },
          data: { lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
        });

        const res = await resendInvite(trainer.token, invite.id);

        expect(res.statusCode).toBe(200);
      });
    });

    it('should return 409 student.alreadyLinked when inviting an already linked student', async () => {
      const trainer = await createTrainer();
      const student = await signupVerified(uniqueEmail('linked'));
      await inviteStudent(trainer.token, student.email);

      const res = await inviteStudent(trainer.token, student.email);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), { error: expect.any(String), messageCode: 'student.alreadyLinked' });
    });

    it('should return 422 student.cannotLinkSelf when the trainer invites their own email', async () => {
      const trainer = await createTrainer();

      const res = await inviteStudent(trainer.token, trainer.email);

      expect(res.statusCode).toBe(422);
      expectErrorContract(res.json(), { error: expect.any(String), messageCode: 'student.cannotLinkSelf' });
    });

    it('should return 422 student.accountDeactivated for a soft-deleted user', async () => {
      const trainer = await createTrainer();
      const student = await signup(uniqueEmail('deleted'));
      await prisma.user.update({ where: { id: student.userId }, data: { deletedAt: new Date() } });

      const res = await inviteStudent(trainer.token, student.email);

      expect(res.statusCode).toBe(422);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.STUDENT_ACCOUNT_DEACTIVATED,
        messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
      });
    });

    it('should return 409 studentInvite.alreadyPending for a duplicate pending invite', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('dup');
      await inviteStudent(trainer.token, email);

      const res = await inviteStudent(trainer.token, email.toUpperCase());

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.ALREADY_PENDING,
        messageCode: StudentInviteMessageCode.ALREADY_PENDING,
      });
      expect(await prisma.studentInvite.count()).toBe(1);
    });

    it('should allow two different trainers to invite the same email', async () => {
      const trainerA = await createTrainer();
      const trainerB = await createTrainer();
      const email = uniqueEmail('shared');

      const resA = await inviteStudent(trainerA.token, email);
      const resB = await inviteStudent(trainerB.token, email);

      expect(resA.statusCode).toBe(201);
      expect(resB.statusCode).toBe(201);
    });

    it('should allow re-inviting the same email after the previous invite was revoked', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('reinvite');
      const first = await inviteStudent(trainer.token, email);
      await revokeInvite(trainer.token, first.json().invite.id);

      const res = await inviteStudent(trainer.token, email);

      expect(res.statusCode).toBe(201);
      expect(res.json().invite.id).not.toBe(first.json().invite.id);
    });

    it('should allow re-inviting an email whose previous pending invite is time-expired', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('stale');
      const first = await inviteStudent(trainer.token, email);
      const firstId = first.json().invite.id;
      await prisma.studentInvite.update({
        where: { id: firstId },
        data: { expiresAt: new Date(Date.now() - MS_PER_DAY), sendCount: STUDENT_INVITE_MAX_SENDS },
      });

      const res = await inviteStudent(trainer.token, email);

      expect(res.statusCode).toBe(201);
      expect(res.json().invite.id).not.toBe(firstId);
      const stale = await prisma.studentInvite.findUnique({ where: { id: firstId } });
      expect(stale.status).toBe(StudentInviteStatus.EXPIRED);
    });

    it('should return 403 platformPlan.studentCapExceeded when the trainer is at the student cap', async () => {
      const trainer = await createTrainer({ tier: FREE_TIER });
      for (let i = 0; i < FREE_STUDENT_CAP; i += 1) {
        const student = await prisma.user.create({ data: { email: uniqueEmail('capfill'), roles: [], status: 'pending' } });
        await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId: student.id } });
      }

      const res = await inviteStudent(trainer.token, uniqueEmail('overcap'));

      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({
        error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
        messageCode: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.messageCode,
      });
      expect(await prisma.studentInvite.count()).toBe(0);
    });

    it('should return 400 VALIDATION_ERROR for a malformed email', async () => {
      const trainer = await createTrainer();

      const res = await inviteStudent(trainer.token, 'not-an-email');

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should return 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/trainer/student-invites', payload: { email: 'a@b.com' } });

      expect(res.statusCode).toBe(401);
    });

    it('should return 403 for a user without the trainer role', async () => {
      const student = await signup(uniqueEmail('plainuser'));

      const res = await inviteStudent(student.accessToken, uniqueEmail('x'));

      expect(res.statusCode).toBe(403);
      expect(res.json()).toHaveProperty('messageCode');
    });
  });

  describe('signup -> verify -> auto-accept flow', () => {
    it('should link the student after they sign up with email and verify the code', async () => {
      const { trainer, studentEmail, invite } = await createInvitedTrainerAndEmail();

      const student = await signup(studentEmail);
      const code = verificationCodes.get(studentEmail);
      expect(code).toMatch(/^\d{6}$/);

      const verifyRes = await verifyEmail(student.accessToken, code);

      expect(verifyRes.statusCode).toBe(200);
      expect(verifyRes.json()).toEqual({ verified: true, linkedTrainers: 1 });

      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
      });
      expect(link).toMatchObject({ activeOnPlan: true });

      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted).toMatchObject({
        status: StudentInviteStatus.ACCEPTED,
        studentId: student.userId,
        acceptedAt: expect.any(Date),
      });

      const studentsRes = await listStudents(trainer.token);
      expect(studentsRes.statusCode).toBe(200);
      expect(studentsRes.json().map((s) => s.id)).toContain(student.userId);
    });

    it('should match the invite regardless of email casing used at signup', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('casing');
      await inviteStudent(trainer.token, email.toUpperCase());

      const student = await signup(email.toUpperCase());
      await verifyEmail(student.accessToken, verificationCodes.get(email));

      expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(1);
    });

    it('should NOT link the student on signup alone (before verification)', async () => {
      const { trainer, studentEmail, invite } = await createInvitedTrainerAndEmail();

      const student = await signup(studentEmail);

      expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(0);
      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted.status).toBe(StudentInviteStatus.PENDING);
      expect((await listStudents(trainer.token)).json()).toEqual([]);
    });

    it('should accept invites from multiple trainers in one verification', async () => {
      const trainerA = await createTrainer();
      const trainerB = await createTrainer();
      const email = uniqueEmail('multi');
      await inviteStudent(trainerA.token, email);
      await inviteStudent(trainerB.token, email);

      const student = await signup(email);
      const res = await verifyEmail(student.accessToken, verificationCodes.get(email));

      expect(res.json()).toEqual({ verified: true, linkedTrainers: 2 });
      expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(2);
    });

    it('should not link a revoked invite', async () => {
      const { trainer, studentEmail, invite } = await createInvitedTrainerAndEmail();
      await revokeInvite(trainer.token, invite.id);

      const student = await signup(studentEmail);
      const res = await verifyEmail(student.accessToken, verificationCodes.get(studentEmail));

      expect(res.json()).toEqual({ verified: true, linkedTrainers: 0 });
      expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(0);
    });

    it('should flip a time-expired invite to expired instead of linking it', async () => {
      const { studentEmail, invite } = await createInvitedTrainerAndEmail();
      await prisma.studentInvite.update({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - MS_PER_DAY) },
      });

      const student = await signup(studentEmail);
      const res = await verifyEmail(student.accessToken, verificationCodes.get(studentEmail));

      expect(res.json()).toEqual({ verified: true, linkedTrainers: 0 });
      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted.status).toBe(StudentInviteStatus.EXPIRED);
      expect(await prisma.trainerStudent.count({ where: { studentId: student.userId } })).toBe(0);
    });

    it('should create the link inactive (activeOnPlan false) when the trainer filled the cap after inviting', async () => {
      const { trainer, studentEmail, invite } = await createInvitedTrainerAndEmail({ tier: FREE_TIER });
      for (let i = 0; i < FREE_STUDENT_CAP; i += 1) {
        const filler = await prisma.user.create({ data: { email: uniqueEmail('filler'), roles: [], status: 'pending' } });
        await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId: filler.id } });
      }

      const student = await signup(studentEmail);
      const res = await verifyEmail(student.accessToken, verificationCodes.get(studentEmail));

      expect(res.json()).toEqual({ verified: true, linkedTrainers: 1 });
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
      });
      expect(link.activeOnPlan).toBe(false);
      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted.status).toBe(StudentInviteStatus.ACCEPTED);
      const listed = (await listStudents(trainer.token)).json().find((s) => s.id === student.userId);
      expect(listed.blockers).toContain(StudentBlocker.BLOCKED_ON_PLAN);
    });
  });

  describe('OAuth signup auto-accept', () => {
    async function invitedTrainerAndEmail() {
      const trainer = await createTrainer();
      const email = uniqueEmail('oauth');
      await inviteStudent(trainer.token, email);
      return { trainer, email };
    }

    it('should auto-accept the invite for a new Google user with a verified email', async () => {
      const { trainer, email } = await invitedTrainerAndEmail();
      verifyGoogleIdToken.mockResolvedValue({ subject: `g-${Date.now()}`, email, name: 'G User', emailVerified: true });

      const res = await app.inject({ method: 'POST', url: '/auth/google/mobile', payload: { idToken: 'tok' } });

      expect(res.statusCode).toBe(200);
      const userId = res.json().user.id;
      expect(await prisma.trainerStudent.count({ where: { trainerId: trainer.trainerId, studentId: userId } })).toBe(1);
      const invite = await prisma.studentInvite.findFirst({ where: { email } });
      expect(invite.status).toBe(StudentInviteStatus.ACCEPTED);
      const account = await prisma.account.findFirst({ where: { userId, provider: 'google' } });
      expect(account.verifiedAt).not.toBeNull();
    });

    it('should accept invites when an existing unverified email/password user signs in with a verified Google account', async () => {
      const { trainer, email } = await invitedTrainerAndEmail();
      const { userId } = await signup(email);
      expect(await prisma.trainerStudent.count({ where: { studentId: userId } })).toBe(0);
      verifyGoogleIdToken.mockResolvedValue({ subject: `g-${Date.now()}`, email, name: 'G User', emailVerified: true });

      const res = await app.inject({ method: 'POST', url: '/auth/google/mobile', payload: { idToken: 'tok' } });

      expect(res.statusCode).toBe(200);
      expect(res.json().user.id).toBe(userId);
      expect(await prisma.trainerStudent.count({ where: { trainerId: trainer.trainerId, studentId: userId } })).toBe(1);
      const invite = await prisma.studentInvite.findFirst({ where: { email } });
      expect(invite.status).toBe(StudentInviteStatus.ACCEPTED);
    });

    it('should reject a new Google user whose email is unverified and leave the invite pending', async () => {
      const { email } = await invitedTrainerAndEmail();
      verifyGoogleIdToken.mockResolvedValue({ subject: `g-${Date.now()}`, email, name: 'G User', emailVerified: false });

      const res = await app.inject({ method: 'POST', url: '/auth/google/mobile', payload: { idToken: 'tok' } });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe(OAuthErrorCode.EMAIL_NOT_VERIFIED);
      expect(await prisma.user.findFirst({ where: { email } })).toBeNull();
      const invite = await prisma.studentInvite.findFirst({ where: { email } });
      expect(invite.status).toBe(StudentInviteStatus.PENDING);
    });

    it('should auto-accept the invite for a new Apple user with a verified email', async () => {
      const { trainer, email } = await invitedTrainerAndEmail();
      verifyAppleIdToken.mockResolvedValue({
        subject: `apple.${Date.now()}`,
        email,
        emailVerified: true,
        isPrivateEmail: false,
      });

      const res = await app.inject({ method: 'POST', url: '/auth/apple/mobile', payload: { identityToken: 'tok' } });

      expect(res.statusCode).toBe(201);
      const userId = res.json().user.id;
      expect(await prisma.trainerStudent.count({ where: { trainerId: trainer.trainerId, studentId: userId } })).toBe(1);
    });

    it('should reject a new Apple user whose email is unverified and leave the invite pending', async () => {
      const { email } = await invitedTrainerAndEmail();
      verifyAppleIdToken.mockResolvedValue({
        subject: `apple.${Date.now()}`,
        email,
        emailVerified: false,
        isPrivateEmail: false,
      });

      const res = await app.inject({ method: 'POST', url: '/auth/apple/mobile', payload: { identityToken: 'tok' } });

      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe(OAuthErrorCode.EMAIL_NOT_VERIFIED);
      expect(await prisma.user.findFirst({ where: { email } })).toBeNull();
      const invite = await prisma.studentInvite.findFirst({ where: { email } });
      expect(invite.status).toBe(StudentInviteStatus.PENDING);
    });

    it('should report emailVerified true on GET /me for a verified OAuth user', async () => {
      const email = uniqueEmail('oauthme');
      verifyGoogleIdToken.mockResolvedValue({ subject: `g-${Date.now()}`, email, name: 'G User', emailVerified: true });
      const login = await app.inject({ method: 'POST', url: '/auth/google/mobile', payload: { idToken: 'tok' } });

      const me = await getMe(login.json().token.accessToken);

      expect(me.json().emailVerified).toBe(true);
    });
  });

  describe('POST /auth/verify-email', () => {
    it('should report emailVerified false after signup and true after verification (GET /me)', async () => {
      const student = await signup(uniqueEmail('me'));

      expect((await getMe(student.accessToken)).json().emailVerified).toBe(false);

      await verifyEmail(student.accessToken, verificationCodes.get(student.email));

      expect((await getMe(student.accessToken)).json().emailVerified).toBe(true);
    });

    it('should set Account.verifiedAt on the email account', async () => {
      const student = await signup(uniqueEmail('acct'));
      const before = await prisma.account.findFirst({ where: { userId: student.userId, provider: 'email' } });
      expect(before.verifiedAt).toBeNull();

      await verifyEmail(student.accessToken, verificationCodes.get(student.email));

      const after = await prisma.account.findFirst({ where: { userId: student.userId, provider: 'email' } });
      expect(after.verifiedAt).not.toBeNull();
    });

    it('should return 400 invalidCode for a wrong code', async () => {
      const student = await signup(uniqueEmail('wrong'));

      const res = await verifyEmail(student.accessToken, WRONG_CODE);

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), {
        error: EmailVerificationErrorCode.INVALID_CODE,
        messageCode: EmailVerificationMessageCode.INVALID_CODE,
      });
      expect((await getMe(student.accessToken)).json().emailVerified).toBe(false);
    });

    it('should return 429 tooManyAttempts after the max wrong attempts, even for the correct code', async () => {
      const student = await signup(uniqueEmail('attempts'));
      const correctCode = verificationCodes.get(student.email);
      for (let i = 0; i < EMAIL_VERIFICATION_MAX_ATTEMPTS; i += 1) {
        const wrong = await verifyEmail(student.accessToken, WRONG_CODE === correctCode ? '111111' : WRONG_CODE);
        expect(wrong.statusCode).toBe(400);
      }

      const res = await verifyEmail(student.accessToken, correctCode);

      expect(res.statusCode).toBe(429);
      expectErrorContract(res.json(), {
        error: EmailVerificationErrorCode.TOO_MANY_ATTEMPTS,
        messageCode: EmailVerificationMessageCode.TOO_MANY_ATTEMPTS,
      });
      expect((await getMe(student.accessToken)).json().emailVerified).toBe(false);
    });

    it('should return 400 codeExpired once the code passed its TTL', async () => {
      const student = await signup(uniqueEmail('expired'));
      await prisma.emailVerificationToken.updateMany({
        where: { userId: student.userId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      const res = await verifyEmail(student.accessToken, verificationCodes.get(student.email));

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), {
        error: EmailVerificationErrorCode.CODE_EXPIRED,
        messageCode: EmailVerificationMessageCode.CODE_EXPIRED,
      });
    });

    it('should return 409 alreadyVerified when verifying twice', async () => {
      const student = await signup(uniqueEmail('twice'));
      const code = verificationCodes.get(student.email);
      await verifyEmail(student.accessToken, code);

      const res = await verifyEmail(student.accessToken, code);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), {
        error: EmailVerificationErrorCode.ALREADY_VERIFIED,
        messageCode: EmailVerificationMessageCode.ALREADY_VERIFIED,
      });
    });

    it('should reject a used code for a second user (codes are bound to the user)', async () => {
      const first = await signup(uniqueEmail('first'));
      const second = await signup(uniqueEmail('second'));

      const res = await verifyEmail(second.accessToken, verificationCodes.get(first.email));

      // Astronomically unlikely to collide (1 in 10^6); a collision would still be the second user's own code.
      if (verificationCodes.get(first.email) !== verificationCodes.get(second.email)) {
        expect(res.statusCode).toBe(400);
      }
    });

    it('should return 400 VALIDATION_ERROR for a non 6-digit code', async () => {
      const student = await signup(uniqueEmail('badshape'));

      const res = await verifyEmail(student.accessToken, 'abc');

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should return 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/verify-email', payload: { code: '123456' } });

      expect(res.statusCode).toBe(401);
    });

    it('should still answer signup with 202 when the verification email cannot be sent', async () => {
      emailHandler.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'));

      const res = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: { email: uniqueEmail('mailfail'), password: PASSWORD },
      });

      expect(res.statusCode).toBe(202);
    });
  });

  describe('POST /auth/verify-email/resend', () => {
    it('should return 429 resendCooldown with retryAfterSeconds right after signup', async () => {
      const student = await signup(uniqueEmail('cooldown'));

      const res = await resendVerification(student.accessToken);

      expect(res.statusCode).toBe(429);
      expectErrorContract(res.json(), {
        error: EmailVerificationErrorCode.RESEND_COOLDOWN,
        messageCode: EmailVerificationMessageCode.RESEND_COOLDOWN,
      });
      expect(res.json().details.retryAfterSeconds).toBeGreaterThan(0);
      expect(res.json().details.retryAfterSeconds).toBeLessThanOrEqual(EMAIL_VERIFICATION_RESEND_COOLDOWN_MS / 1000);
    });

    it('should send a fresh code after the cooldown and invalidate the previous code', async () => {
      const student = await signup(uniqueEmail('fresh'));
      const oldCode = verificationCodes.get(student.email);
      await prisma.emailVerificationToken.updateMany({
        where: { userId: student.userId },
        data: { createdAt: new Date(Date.now() - 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) },
      });

      const res = await resendVerification(student.accessToken);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ sent: true });
      const newCode = verificationCodes.get(student.email);
      if (newCode !== oldCode) {
        const oldRes = await verifyEmail(student.accessToken, oldCode);
        expect(oldRes.statusCode).toBe(400);
      }
      const newRes = await verifyEmail(student.accessToken, newCode);
      expect(newRes.statusCode).toBe(200);
    });

    describe('per-user daily code cap', () => {
      async function backdateTokens(userId, ageForIndex) {
        const tokens = await prisma.emailVerificationToken.findMany({
          where: { userId },
          orderBy: { createdAt: 'asc' },
        });
        for (const [index, token] of tokens.entries()) {
          await prisma.emailVerificationToken.update({
            where: { id: token.id },
            data: { createdAt: new Date(Date.now() - ageForIndex(index)) },
          });
        }
      }

      async function seedTokens(userId, count, ageForIndex) {
        await prisma.emailVerificationToken.createMany({
          data: Array.from({ length: count }, (_, i) => ({
            userId,
            tokenHash: `seed-hash-${userId}-${i}`,
            used: true,
            expiresAt: new Date(Date.now() + MS_PER_HOUR),
            createdAt: new Date(Date.now() - ageForIndex(i)),
          })),
        });
      }

      it('should return 429 emailVerification.dailyLimit with retryAfterSeconds once the cap is reached', async () => {
        const student = await signup(uniqueEmail('dailycap'));
        const oldestAgeMs = 5 * MS_PER_HOUR;
        await prisma.emailVerificationToken.updateMany({
          where: { userId: student.userId },
          data: { createdAt: new Date(Date.now() - 3 * MS_PER_HOUR) },
        });
        const seededAges = [MS_PER_HOUR, 2 * MS_PER_HOUR, 4 * MS_PER_HOUR, oldestAgeMs];
        await seedTokens(student.userId, seededAges.length, (i) => seededAges[i]);
        expect(await prisma.emailVerificationToken.count({ where: { userId: student.userId } })).toBe(
          EMAIL_VERIFICATION_DAILY_MAX_CODES,
        );

        const res = await resendVerification(student.accessToken);

        expect(res.statusCode).toBe(429);
        expectErrorContract(res.json(), {
          error: EmailVerificationErrorCode.DAILY_LIMIT,
          messageCode: EmailVerificationMessageCode.DAILY_LIMIT,
        });
        const expectedSeconds = (EMAIL_VERIFICATION_DAILY_WINDOW_MS - oldestAgeMs) / 1000;
        expect(res.json().details.retryAfterSeconds).toBeGreaterThan(expectedSeconds - 30);
        expect(res.json().details.retryAfterSeconds).toBeLessThanOrEqual(expectedSeconds);
        expect(await prisma.emailVerificationToken.count({ where: { userId: student.userId } })).toBe(
          EMAIL_VERIFICATION_DAILY_MAX_CODES,
        );
      });

      it('should count the signup-issued code toward the cap (cap-1 resends succeed, next one is refused)', async () => {
        const student = await signup(uniqueEmail('signupcounts'));
        for (let i = 0; i < EMAIL_VERIFICATION_DAILY_MAX_CODES - 1; i += 1) {
          await backdateTokens(student.userId, (index) => (index + 1) * 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS);
          const ok = await resendVerification(student.accessToken);
          expect(ok.statusCode).toBe(200);
        }
        await backdateTokens(student.userId, (index) => (index + 1) * 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS);

        const res = await resendVerification(student.accessToken);

        expect(res.statusCode).toBe(429);
        expect(res.json().messageCode).toBe(EmailVerificationMessageCode.DAILY_LIMIT);
      });

      it('should allow the resend once the older codes are outside the rolling window', async () => {
        const student = await signup(uniqueEmail('windowpass'));
        await seedTokens(student.userId, EMAIL_VERIFICATION_DAILY_MAX_CODES, (i) =>
          EMAIL_VERIFICATION_DAILY_WINDOW_MS + (i + 1) * MS_PER_HOUR,
        );
        await prisma.emailVerificationToken.updateMany({
          where: { userId: student.userId, used: false },
          data: { createdAt: new Date(Date.now() - 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) },
        });

        const res = await resendVerification(student.accessToken);

        expect(res.statusCode).toBe(200);
      });

      it('should never fail signup because of the cap or delivery (signup issues the first code)', async () => {
        emailHandler.sendEmailVerificationEmail.mockResolvedValue({ data: null, error: { message: 'rejected' } });

        const res = await app.inject({
          method: 'POST',
          url: '/auth/signup',
          payload: { email: uniqueEmail('signupsafe'), password: PASSWORD },
        });

        expect(res.statusCode).toBe(202);
      });
    });

    describe('when the email delivery fails', () => {
      async function studentWithElapsedCooldown(prefix) {
        const student = await signup(uniqueEmail(prefix));
        await prisma.emailVerificationToken.updateMany({
          where: { userId: student.userId },
          data: { createdAt: new Date(Date.now() - 2 * EMAIL_VERIFICATION_RESEND_COOLDOWN_MS) },
        });
        return student;
      }

      const failureModes = [
        ['a thrown error', () => emailHandler.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'))],
        [
          'a returned Resend error',
          () => emailHandler.sendEmailVerificationEmail.mockResolvedValue({ data: null, error: { message: 'rejected' } }),
        ],
      ];

      it.each(failureModes)('should return 502 emailVerification.sendFailed on %s and mark the new row undelivered', async (_label, arrange) => {
        const student = await studentWithElapsedCooldown('sendfail');
        arrange();

        const res = await resendVerification(student.accessToken);

        expect(res.statusCode).toBe(502);
        expectErrorContract(res.json(), {
          error: EmailVerificationErrorCode.SEND_FAILED,
          messageCode: EmailVerificationMessageCode.SEND_FAILED,
        });
        const failedRows = await prisma.emailVerificationToken.findMany({
          where: { userId: student.userId, sendFailedAt: { not: null } },
        });
        expect(failedRows).toHaveLength(1);
        expect(failedRows[0].used).toBe(true);
      });

      it('should not block an immediate retry with the cooldown after a failed send', async () => {
        const student = await studentWithElapsedCooldown('retryok');
        emailHandler.sendEmailVerificationEmail.mockRejectedValueOnce(new Error('resend down'));
        await resendVerification(student.accessToken);

        const retry = await resendVerification(student.accessToken);

        expect(retry.statusCode).toBe(200);
        expect(retry.json()).toEqual({ sent: true });
      });

      it('should not let repeated failed sends reach the daily code cap', async () => {
        const student = await studentWithElapsedCooldown('nocap');
        emailHandler.sendEmailVerificationEmail.mockRejectedValue(new Error('resend down'));
        for (let i = 0; i < EMAIL_VERIFICATION_DAILY_MAX_CODES + 2; i += 1) {
          const failed = await resendVerification(student.accessToken);
          expect(failed.statusCode).toBe(502);
        }
        emailHandler.sendEmailVerificationEmail.mockImplementation(async ({ to, code }) => {
          verificationCodes.set(to.toLowerCase(), code);
        });

        const res = await resendVerification(student.accessToken);

        expect(res.statusCode).toBe(200);
      });

      it('should not make the undelivered code verifiable', async () => {
        const student = await studentWithElapsedCooldown('unverifiable');
        let undeliveredCode;
        emailHandler.sendEmailVerificationEmail.mockImplementation(async ({ code }) => {
          undeliveredCode = code;
          throw new Error('resend down');
        });
        await resendVerification(student.accessToken);

        const res = await verifyEmail(student.accessToken, undeliveredCode);

        expect(res.statusCode).toBe(400);
        expectErrorContract(res.json(), {
          error: EmailVerificationErrorCode.INVALID_CODE,
          messageCode: EmailVerificationMessageCode.INVALID_CODE,
        });
      });

      it('should keep the previously delivered code valid when the resend fails', async () => {
        const student = await studentWithElapsedCooldown('priorvalid');
        const priorCode = verificationCodes.get(student.email);
        emailHandler.sendEmailVerificationEmail.mockRejectedValueOnce(new Error('resend down'));
        const failed = await resendVerification(student.accessToken);
        expect(failed.statusCode).toBe(502);

        const priorRes = await verifyEmail(student.accessToken, priorCode);

        expect(priorRes.statusCode).toBe(200);
        expect(priorRes.json()).toMatchObject({ verified: true });
      });

      it('should close the previous code only once a later resend is delivered', async () => {
        const student = await studentWithElapsedCooldown('priorclosed');
        const priorCode = verificationCodes.get(student.email);
        const retry = await resendVerification(student.accessToken);
        expect(retry.statusCode).toBe(200);
        const newCode = verificationCodes.get(student.email);

        const priorRes = await verifyEmail(student.accessToken, priorCode);
        expect(priorRes.statusCode).toBe(400);
        expect(priorRes.json().messageCode).toBe(EmailVerificationMessageCode.INVALID_CODE);
        const verifyRes = await verifyEmail(student.accessToken, newCode);
        expect(verifyRes.statusCode).toBe(200);
      });
    });

    it('should return 409 alreadyVerified when the email is already verified', async () => {
      const student = await signup(uniqueEmail('verified'));
      await verifyEmail(student.accessToken, verificationCodes.get(student.email));

      const res = await resendVerification(student.accessToken);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), {
        error: EmailVerificationErrorCode.ALREADY_VERIFIED,
        messageCode: EmailVerificationMessageCode.ALREADY_VERIFIED,
      });
    });

    it('should return 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: '/auth/verify-email/resend' });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /trainer/student-invites', () => {
    it('should list only the calling trainer invites with pagination metadata', async () => {
      const trainer = await createTrainer();
      const other = await createTrainer();
      await inviteStudent(trainer.token, uniqueEmail('a'));
      await inviteStudent(trainer.token, uniqueEmail('b'));
      await inviteStudent(other.token, uniqueEmail('c'));

      const res = await listInvites(trainer.token);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({ total: 2, page: 1, pageSize: expect.any(Number) });
      expect(body.items).toHaveLength(2);
    });

    it('should paginate with page and pageSize', async () => {
      const trainer = await createTrainer();
      for (let i = 0; i < 3; i += 1) await inviteStudent(trainer.token, uniqueEmail(`p${i}`));

      const res = await listInvites(trainer.token, '?page=2&pageSize=2');

      expect(res.json()).toMatchObject({ total: 3, page: 2, pageSize: 2 });
      expect(res.json().items).toHaveLength(1);
    });

    it('should filter by status', async () => {
      const trainer = await createTrainer();
      const first = await inviteStudent(trainer.token, uniqueEmail('keep'));
      const second = await inviteStudent(trainer.token, uniqueEmail('drop'));
      await revokeInvite(trainer.token, second.json().invite.id);

      const pending = (await listInvites(trainer.token, `?status=${StudentInviteStatus.PENDING}`)).json();
      const revoked = (await listInvites(trainer.token, `?status=${StudentInviteStatus.REVOKED}`)).json();

      expect(pending.items.map((i) => i.id)).toEqual([first.json().invite.id]);
      expect(revoked.items.map((i) => i.id)).toEqual([second.json().invite.id]);
    });

    it('should report a time-expired pending invite as expired, and list it under status=expired only', async () => {
      const trainer = await createTrainer();
      const created = await inviteStudent(trainer.token, uniqueEmail('stale'));
      const inviteId = created.json().invite.id;
      await prisma.studentInvite.update({
        where: { id: inviteId },
        data: { expiresAt: new Date(Date.now() - MS_PER_HOUR) },
      });

      const all = (await listInvites(trainer.token)).json();
      const expired = (await listInvites(trainer.token, `?status=${StudentInviteStatus.EXPIRED}`)).json();
      const pending = (await listInvites(trainer.token, `?status=${StudentInviteStatus.PENDING}`)).json();

      expect(all.items[0]).toMatchObject({ id: inviteId, status: StudentInviteStatus.EXPIRED });
      expect(expired.items.map((i) => i.id)).toEqual([inviteId]);
      expect(pending.items).toEqual([]);
      const stored = await prisma.studentInvite.findUnique({ where: { id: inviteId } });
      expect(stored.status).toBe(StudentInviteStatus.PENDING);
    });

    it('should expose canResend and resendAvailableAt for every invite state', async () => {
      const trainer = await createTrainer();
      const cooling = (await inviteStudent(trainer.token, uniqueEmail('cooling'))).json().invite;
      const ready = (await inviteStudent(trainer.token, uniqueEmail('ready'))).json().invite;
      const capped = (await inviteStudent(trainer.token, uniqueEmail('capped'))).json().invite;
      const revoked = (await inviteStudent(trainer.token, uniqueEmail('revokedstate'))).json().invite;
      const elapsed = new Date(Date.now() - 2 * MS_PER_HOUR);
      await prisma.studentInvite.update({ where: { id: ready.id }, data: { lastSentAt: elapsed } });
      await prisma.studentInvite.update({
        where: { id: capped.id },
        data: { lastSentAt: elapsed, sendCount: STUDENT_INVITE_MAX_SENDS },
      });
      await revokeInvite(trainer.token, revoked.id);

      const items = (await listInvites(trainer.token)).json().items;
      const byId = Object.fromEntries(items.map((item) => [item.id, item]));

      expectInviteResendFields(byId[cooling.id], { canResend: false, resendAvailable: true });
      expectInviteResendFields(byId[ready.id], { canResend: true, resendAvailable: false });
      expectInviteResendFields(byId[capped.id], { canResend: false, resendAvailable: false });
      expectInviteResendFields(byId[revoked.id], { canResend: false, resendAvailable: false });
    });

    it('should keep a time-expired pending invite resendable but report status expired', async () => {
      const trainer = await createTrainer();
      const invite = (await inviteStudent(trainer.token, uniqueEmail('staleresend'))).json().invite;
      await prisma.studentInvite.update({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - MS_PER_HOUR), lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
      });

      const item = (await listInvites(trainer.token)).json().items[0];

      expect(item.status).toBe(StudentInviteStatus.EXPIRED);
      expectInviteResendFields(item, { canResend: true, resendAvailable: false });
    });

    it('should return 400 for an unknown status value', async () => {
      const trainer = await createTrainer();

      const res = await listInvites(trainer.token, '?status=bogus');

      expect(res.statusCode).toBe(400);
      expectErrorContract(res.json(), { error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should return 403 for a non-trainer', async () => {
      const student = await signup(uniqueEmail('list403'));

      const res = await listInvites(student.accessToken);

      expect(res.statusCode).toBe(403);
    });

    it('should return 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/trainer/student-invites' });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /trainer/student-invites/:id/resend', () => {
    it('should return 429 resendCooldown with retryAfterSeconds right after the invite was sent', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();

      const res = await resendInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(429);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.RESEND_COOLDOWN,
        messageCode: StudentInviteMessageCode.RESEND_COOLDOWN,
      });
      const { retryAfterSeconds } = res.json().details;
      expect(retryAfterSeconds).toBeGreaterThan(0);
      expect(retryAfterSeconds).toBeLessThanOrEqual(STUDENT_INVITE_RESEND_COOLDOWN_MS / 1000);
    });

    it('should resend after the cooldown, incrementing sendCount and emailing again', async () => {
      const { trainer, invite, studentEmail } = await createInvitedTrainerAndEmail();
      await prisma.studentInvite.update({
        where: { id: invite.id },
        data: { lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
      });

      const res = await resendInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(200);
      expect(res.json().invite).toMatchObject({ id: invite.id, sendCount: 2, status: StudentInviteStatus.PENDING });
      expect(inviteEmails.filter((e) => e.to === studentEmail)).toHaveLength(2);
    });

    it('should return canResend false with a future resendAvailableAt after a resend', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();
      await prisma.studentInvite.update({
        where: { id: invite.id },
        data: { lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
      });

      const res = await resendInvite(trainer.token, invite.id);

      expectInviteResendFields(res.json().invite, { canResend: false, resendAvailable: true });
    });

    describe('when the email delivery fails', () => {
      async function invitedWithElapsedCooldown() {
        const setup = await createInvitedTrainerAndEmail();
        const before = await prisma.studentInvite.update({
          where: { id: setup.invite.id },
          data: { lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
        });
        return { ...setup, before };
      }

      it.each([
        ['a thrown error', () => emailHandler.sendStudentInviteEmail.mockRejectedValue(new Error('resend down'))],
        [
          'a returned Resend error',
          () => emailHandler.sendStudentInviteEmail.mockResolvedValue({ data: null, error: { message: 'rejected' } }),
        ],
      ])('should return 502 studentInvite.emailSendFailed and roll back bookkeeping on %s', async (_label, arrange) => {
        const { trainer, before } = await invitedWithElapsedCooldown();
        arrange();

        const res = await resendInvite(trainer.token, before.id);

        expect(res.statusCode).toBe(502);
        expectErrorContract(res.json(), {
          error: StudentInviteErrorCode.EMAIL_SEND_FAILED,
          messageCode: StudentInviteMessageCode.EMAIL_SEND_FAILED,
        });
        const after = await prisma.studentInvite.findUnique({ where: { id: before.id } });
        expect(after.sendCount).toBe(before.sendCount);
        expect(after.lastSentAt.getTime()).toBe(before.lastSentAt.getTime());
        expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
      });

      it('should leave a concurrently revoked invite untouched by the failed-resend rollback', async () => {
        const { trainer, before } = await invitedWithElapsedCooldown();
        emailHandler.sendStudentInviteEmail.mockImplementation(async () => {
          await prisma.studentInvite.update({
            where: { id: before.id },
            data: { status: StudentInviteStatus.REVOKED, revokedAt: new Date() },
          });
          throw new Error('resend down');
        });

        const res = await resendInvite(trainer.token, before.id);

        expect(res.statusCode).toBe(502);
        const after = await prisma.studentInvite.findUnique({ where: { id: before.id } });
        expect(after.status).toBe(StudentInviteStatus.REVOKED);
        expect(after.sendCount).toBe(before.sendCount + 1);
        expect(after.lastSentAt.getTime()).toBeGreaterThan(before.lastSentAt.getTime());
      });

      it('should let the trainer retry immediately after a failed resend (cooldown not burned)', async () => {
        const { trainer, before } = await invitedWithElapsedCooldown();
        emailHandler.sendStudentInviteEmail.mockRejectedValueOnce(new Error('resend down'));
        await resendInvite(trainer.token, before.id);

        const res = await resendInvite(trainer.token, before.id);

        expect(res.statusCode).toBe(200);
        expect(res.json().invite.sendCount).toBe(before.sendCount + 1);
      });
    });

    it('should revive a time-expired pending invite', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();
      await prisma.studentInvite.update({
        where: { id: invite.id },
        data: { expiresAt: new Date(Date.now() - MS_PER_DAY), lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
      });

      const res = await resendInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(200);
      expect(res.json().invite.status).toBe(StudentInviteStatus.PENDING);
      expect(new Date(res.json().invite.expiresAt).getTime()).toBeGreaterThan(Date.now());
    });

    it('should return 409 resendLimit once the max number of sends is reached', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();
      await prisma.studentInvite.update({
        where: { id: invite.id },
        data: { sendCount: STUDENT_INVITE_MAX_SENDS, lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
      });

      const res = await resendInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.RESEND_LIMIT,
        messageCode: StudentInviteMessageCode.RESEND_LIMIT,
      });
    });

    it('should return 409 notPending for a revoked invite', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();
      await revokeInvite(trainer.token, invite.id);

      const res = await resendInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.NOT_PENDING,
        messageCode: StudentInviteMessageCode.NOT_PENDING,
      });
    });

    it('should return 404 notFound for an invite owned by another trainer', async () => {
      const { invite } = await createInvitedTrainerAndEmail();
      const other = await createTrainer();

      const res = await resendInvite(other.token, invite.id);

      expect(res.statusCode).toBe(404);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.NOT_FOUND,
        messageCode: StudentInviteMessageCode.NOT_FOUND,
      });
    });

    it('should return 400 for a non-uuid id', async () => {
      const trainer = await createTrainer();

      const res = await resendInvite(trainer.token, 'not-a-uuid');

      expect(res.statusCode).toBe(400);
    });

    it('should return 403 for a non-trainer', async () => {
      const student = await signup(uniqueEmail('resend403'));

      const res = await resendInvite(student.accessToken, '00000000-0000-4000-8000-000000000000');

      expect(res.statusCode).toBe(403);
    });

    describe('when the invite email belongs to an existing user with an unverified email', () => {
      const TWO_MINUTES_MS = 2 * 60 * 1000;

      async function pendingInviteForUnverifiedUser() {
        const trainer = await createTrainer();
        const student = await signup(uniqueEmail('resendunverified'));
        await prisma.emailVerificationToken.updateMany({
          where: { userId: student.userId },
          data: { createdAt: new Date(Date.now() - TWO_MINUTES_MS) },
        });
        const inviteRes = await inviteStudent(trainer.token, student.email);
        expect(inviteRes.statusCode).toBe(201);
        const invite = inviteRes.json().invite;
        const firstInviteCode = existingUserInviteCodes.get(student.email);
        existingUserInviteEmails.length = 0;
        return { trainer, student, invite, firstInviteCode };
      }

      async function elapseResendWindows({ invite, student }) {
        await prisma.studentInvite.update({
          where: { id: invite.id },
          data: { lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
        });
        await prisma.emailVerificationToken.updateMany({
          where: { userId: student.userId },
          data: { createdAt: new Date(Date.now() - TWO_MINUTES_MS) },
        });
      }

      it('should send the existing-user variant with a fresh code instead of the generic email', async () => {
        const setup = await pendingInviteForUnverifiedUser();
        await elapseResendWindows(setup);

        const res = await resendInvite(setup.trainer.token, setup.invite.id);

        expect(res.statusCode).toBe(200);
        expect(existingUserInviteEmails).toEqual([
          { to: setup.student.email, trainerName: expect.any(String), code: expect.stringMatching(/^\d{6}$/) },
        ]);
        expect(inviteEmails).toHaveLength(0);
      });

      it('should close the older code once the variant is delivered and accept the invite on verification', async () => {
        const setup = await pendingInviteForUnverifiedUser();
        await elapseResendWindows(setup);
        await resendInvite(setup.trainer.token, setup.invite.id);
        const newCode = existingUserInviteCodes.get(setup.student.email);

        const staleRes = await verifyEmail(setup.student.accessToken, setup.firstInviteCode);
        const verifyRes = await verifyEmail(setup.student.accessToken, newCode);

        expect(newCode).not.toBe(setup.firstInviteCode);
        expect(staleRes.statusCode).toBe(400);
        expect(verifyRes.statusCode).toBe(200);
        expect(verifyRes.json()).toEqual({ verified: true, linkedTrainers: 1 });
      });

      it('should return 200 with the variant carrying code null when the code cooldown blocks issuing', async () => {
        const setup = await pendingInviteForUnverifiedUser();
        await prisma.studentInvite.update({
          where: { id: setup.invite.id },
          data: { lastSentAt: new Date(Date.now() - 2 * MS_PER_HOUR) },
        });
        await prisma.emailVerificationToken.updateMany({
          where: { userId: setup.student.userId },
          data: { createdAt: new Date() },
        });
        const tokensBefore = await prisma.emailVerificationToken.count({ where: { userId: setup.student.userId } });

        const res = await resendInvite(setup.trainer.token, setup.invite.id);

        expect(res.statusCode).toBe(200);
        expect(existingUserInviteEmails).toEqual([
          { to: setup.student.email, trainerName: expect.any(String), code: null },
        ]);
        expect(await prisma.emailVerificationToken.count({ where: { userId: setup.student.userId } })).toBe(tokensBefore);
      });

      it.each([
        [
          'a thrown error',
          () => emailHandler.sendExistingUserStudentInviteEmail.mockRejectedValue(new Error('resend down')),
        ],
        [
          'a returned Resend error',
          () =>
            emailHandler.sendExistingUserStudentInviteEmail.mockResolvedValue({
              data: null,
              error: { message: 'rejected' },
            }),
        ],
      ])('should return 502, roll back bookkeeping, mark the new code undelivered and keep the old code valid on %s', async (_label, arrange) => {
        const setup = await pendingInviteForUnverifiedUser();
        await elapseResendWindows(setup);
        arrange();

        const res = await resendInvite(setup.trainer.token, setup.invite.id);

        expect(res.statusCode).toBe(502);
        expectErrorContract(res.json(), {
          error: StudentInviteErrorCode.EMAIL_SEND_FAILED,
          messageCode: StudentInviteMessageCode.EMAIL_SEND_FAILED,
        });
        const persisted = await prisma.studentInvite.findUnique({ where: { id: setup.invite.id } });
        expect(persisted.sendCount).toBe(1);
        const failedRows = await prisma.emailVerificationToken.findMany({
          where: { userId: setup.student.userId, sendFailedAt: { not: null } },
        });
        expect(failedRows).toHaveLength(1);
        expect(failedRows[0].used).toBe(true);
        const verifyRes = await verifyEmail(setup.student.accessToken, setup.firstInviteCode);
        expect(verifyRes.statusCode).toBe(200);
      });
    });
  });

  describe('DELETE /trainer/student-invites/:id', () => {
    it('should revoke a pending invite and persist revokedAt', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();

      const res = await revokeInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(200);
      expect(res.json().invite).toMatchObject({
        id: invite.id,
        status: StudentInviteStatus.REVOKED,
        revokedAt: expect.any(String),
      });
      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted.status).toBe(StudentInviteStatus.REVOKED);
      expectInviteResendFields(res.json().invite, { canResend: false, resendAvailable: false });
    });

    it('should return 409 notPending when revoking twice', async () => {
      const { trainer, invite } = await createInvitedTrainerAndEmail();
      await revokeInvite(trainer.token, invite.id);

      const res = await revokeInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(409);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.NOT_PENDING,
        messageCode: StudentInviteMessageCode.NOT_PENDING,
      });
    });

    it('should return 409 notPending when the invite was already accepted', async () => {
      const { trainer, invite, studentEmail } = await createInvitedTrainerAndEmail();
      const student = await signup(studentEmail);
      await verifyEmail(student.accessToken, verificationCodes.get(studentEmail));

      const res = await revokeInvite(trainer.token, invite.id);

      expect(res.statusCode).toBe(409);
      expect(res.json().messageCode).toBe(StudentInviteMessageCode.NOT_PENDING);
    });

    it('should return 404 notFound for an unknown invite id', async () => {
      const trainer = await createTrainer();

      const res = await revokeInvite(trainer.token, '00000000-0000-4000-8000-000000000000');

      expect(res.statusCode).toBe(404);
      expectErrorContract(res.json(), {
        error: StudentInviteErrorCode.NOT_FOUND,
        messageCode: StudentInviteMessageCode.NOT_FOUND,
      });
    });

    it('should return 404 notFound for an invite owned by another trainer and leave it pending', async () => {
      const { invite } = await createInvitedTrainerAndEmail();
      const other = await createTrainer();

      const res = await revokeInvite(other.token, invite.id);

      expect(res.statusCode).toBe(404);
      const persisted = await prisma.studentInvite.findUnique({ where: { id: invite.id } });
      expect(persisted.status).toBe(StudentInviteStatus.PENDING);
    });

    it('should return 403 for a non-trainer', async () => {
      const student = await signup(uniqueEmail('del403'));

      const res = await revokeInvite(student.accessToken, '00000000-0000-4000-8000-000000000000');

      expect(res.statusCode).toBe(403);
    });
  });
});
