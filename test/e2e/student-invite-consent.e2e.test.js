import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { provisionTrainerPlan } from '../helpers/platform-plan.js';
import { seedLegacyUnverifiedUser } from '../helpers/legacy-user.js';
import { createTrainerWithToken, createStudentWithToken } from '../helpers/admin-users.js';
import emailHandler from '../../src/config/email-handler.js';
import { PLATFORM_PLAN_TIERS, PLATFORM_PLAN_ERRORS } from '../../src/constants/platform-plan.js';
import { StudentBlocker } from '../../src/constants/student-blocker.js';
import {
  StudentInviteStatus,
  StudentInviteOutcome,
  StudentInviteErrorCode,
  StudentInviteMessageCode,
} from '../../src/constants/student-invite.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const PASSWORD = 'StrongPassw0rd!';
const TRAINER_FIRST_NAME = 'Ana';
const TRAINER_LAST_NAME = 'Coach';
const TRAINER_NAME = `${TRAINER_FIRST_NAME} ${TRAINER_LAST_NAME}`;
const STUDENT_INVITES_URL = '/trainer/student-invites';
const MY_INVITES_URL = '/my/trainer/invites';
const UNKNOWN_INVITE_ID = '3b1f8a52-4c9e-4d7a-8a55-1f2e3d4c5b6a';
const INVALID_INVITE_ID = 'not-a-uuid';
const FREE_STUDENT_CAP = 3;
const UNVERIFIED_SENDER_INVITE_CAP = 3;
const ONE_MINUTE_MS = 60 * 1000;
const DECLINED_STATUS = 'declined';
const ACCEPTED = { status: 'accepted' };
const DECLINED = { status: DECLINED_STATUS };
const DELIVERED = { data: { id: 'email-id' } };
const INVITE_NOT_FOUND = { statusCode: 404, error: 'STUDENT_INVITE_NOT_FOUND', messageCode: 'studentInvite.notFound' };
const INVITE_NOT_PENDING = { statusCode: 409, error: 'STUDENT_INVITE_NOT_PENDING', messageCode: 'studentInvite.notPending' };
const INVITE_EXPIRED = { statusCode: 422, error: 'STUDENT_INVITE_EXPIRED', messageCode: 'studentInvite.expired' };
const EMAIL_VERIFICATION_REQUIRED = { statusCode: 403, error: 'EMAIL_VERIFICATION_REQUIRED', messageCode: 'emailVerification.required' };
const ANSWERS = ['accept', 'decline'];

// Asserts the status code and the unified error contract of a response.
function expectErrorContract(res, { statusCode, error, messageCode }) {
  expect(res.statusCode, res.body).toBe(statusCode);
  expect(res.json()).toMatchObject({ error, messageCode, message: expect.any(String) });
}

e2eDescribe('e2e: trainer invites need the consent of an existing account (answered in the student app)', () => {
  let app;
  let emailCounter = 0;
  let openAppEmails;
  let downloadEmails;
  let codeVariantEmails;
  let verificationCodes;

  const uniqueEmail = (prefix) => {
    emailCounter += 1;
    return `e2e+${prefix}-${Date.now()}-${emailCounter}@example.com`;
  };
  const auth = (token) => ({ authorization: `Bearer ${token}` });
  const invite = (trainer, email) =>
    app.inject({ method: 'POST', url: STUDENT_INVITES_URL, headers: auth(trainer.accessToken), payload: { email } });
  const listTrainerInvites = (trainer, query = '') =>
    app.inject({ method: 'GET', url: `${STUDENT_INVITES_URL}${query}`, headers: auth(trainer.accessToken) });
  const revokeInvite = (trainer, inviteId) =>
    app.inject({ method: 'DELETE', url: `${STUDENT_INVITES_URL}/${inviteId}`, headers: auth(trainer.accessToken) });
  const listTrainerStudents = (trainer) => app.inject({ method: 'GET', url: '/trainer/students', headers: auth(trainer.accessToken) });
  const listMyInvites = (user) => app.inject({ method: 'GET', url: MY_INVITES_URL, headers: auth(user.accessToken) });
  const answer = (action, user, inviteId) =>
    app.inject({ method: 'POST', url: `${MY_INVITES_URL}/${inviteId}/${action}`, headers: auth(user.accessToken), payload: {} });
  const accept = (user, inviteId) => answer('accept', user, inviteId);
  const decline = (user, inviteId) => answer('decline', user, inviteId);
  const linkCount = (studentId) => prisma.trainerStudent.count({ where: { studentId } });
  const storedInvite = (id) => prisma.studentInvite.findUnique({ where: { id } });

  async function createTrainer({ tier = PLATFORM_PLAN_TIERS.DIAMOND } = {}) {
    const trainer = await createTrainerWithToken(app, { firstName: TRAINER_FIRST_NAME, lastName: TRAINER_LAST_NAME });
    await provisionTrainerPlan(trainer.trainerId, tier);
    return trainer;
  }

  async function createUnverifiedTrainer() {
    const account = await seedLegacyUnverifiedUser(app, { email: uniqueEmail('unverified-trainer'), password: PASSWORD });
    const res = await app.inject({ method: 'PATCH', url: '/become-trainer', headers: auth(account.accessToken) });
    expect(res.statusCode).toBe(200);
    const trainer = await prisma.trainer.findUnique({ where: { userId: account.userId }, select: { id: true } });
    await provisionTrainerPlan(trainer.id, PLATFORM_PLAN_TIERS.DIAMOND);
    return { ...account, trainerId: trainer.id, accessToken: res.json().token.accessToken };
  }

  async function inviteExisting(trainer, student) {
    const res = await invite(trainer, student.email);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().invite;
  }

  async function fillStudentCap(trainer) {
    for (let filled = 0; filled < FREE_STUDENT_CAP; filled += 1) {
      const filler = await prisma.user.create({ data: { email: uniqueEmail('filler'), roles: [], status: 'pending' } });
      await prisma.trainerStudent.create({ data: { trainerId: trainer.trainerId, studentId: filler.id } });
    }
  }

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
    openAppEmails = [];
    downloadEmails = [];
    codeVariantEmails = [];
    verificationCodes = new Map();
    vi.spyOn(emailHandler, 'sendStudentInviteOpenAppEmail').mockImplementation(async (payload) => {
      openAppEmails.push(payload);
      return DELIVERED;
    });
    vi.spyOn(emailHandler, 'sendStudentInviteEmail').mockImplementation(async (payload) => {
      downloadEmails.push(payload);
      return DELIVERED;
    });
    vi.spyOn(emailHandler, 'sendExistingUserStudentInviteEmail').mockImplementation(async (payload) => {
      codeVariantEmails.push(payload);
      return DELIVERED;
    });
    vi.spyOn(emailHandler, 'sendEmailVerificationEmail').mockImplementation(async ({ to, code }) => {
      verificationCodes.set(to.toLowerCase(), code);
      return DELIVERED;
    });
  });

  describe('POST /trainer/student-invites for an e-mail that already has an account', () => {
    describe.each([
      ['a verified e-mail', () => createStudentWithToken(app)],
      ['an unverified e-mail', () => seedLegacyUnverifiedUser(app, { email: uniqueEmail('unverified'), password: PASSWORD })],
    ])('account with %s', (_label, createAccount) => {
      let trainer;
      let student;

      beforeEach(async () => {
        trainer = await createTrainer();
        student = await createAccount();
      });

      it('should answer 201 { outcome: invited, invite } without a student profile', async () => {
        const res = await invite(trainer, student.email);

        expect(res.statusCode).toBe(201);
        expect(res.json()).toMatchObject({
          outcome: StudentInviteOutcome.INVITED,
          invite: { id: expect.any(String), email: student.email, status: StudentInviteStatus.PENDING, studentId: null },
        });
        expect(res.json()).not.toHaveProperty('student');
      });

      it('should create no trainer-student link', async () => {
        await invite(trainer, student.email);

        expect(await linkCount(student.userId)).toBe(0);
        expect((await listTrainerStudents(trainer)).json()).toEqual([]);
      });

      it('should store a pending invite with requiresConsent true', async () => {
        const created = await inviteExisting(trainer, student);

        expect(await storedInvite(created.id)).toMatchObject({
          trainerId: trainer.trainerId,
          status: StudentInviteStatus.PENDING,
          requiresConsent: true,
        });
      });

      it('should send one "open the app" e-mail and no other invite e-mail', async () => {
        await invite(trainer, student.email);

        expect(openAppEmails).toEqual([{ to: student.email, trainerName: TRAINER_NAME }]);
        expect(downloadEmails).toEqual([]);
        expect(codeVariantEmails).toEqual([]);
      });

      it('should issue no verification code for the invited account', async () => {
        const codesBefore = await prisma.emailVerificationToken.count({ where: { userId: student.userId } });

        await invite(trainer, student.email);

        expect(await prisma.emailVerificationToken.count({ where: { userId: student.userId } })).toBe(codesBefore);
      });
    });

    it('should keep the invite pending when the invited user logs in again', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('login');
      const student = await seedLegacyUnverifiedUser(app, { email, password: PASSWORD });
      await prisma.account.updateMany({ where: { userId: student.userId }, data: { verifiedAt: new Date() } });
      const created = await inviteExisting(trainer, student);

      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { email: student.email, password: PASSWORD } });

      expect(login.statusCode).toBe(200);
      expect(await linkCount(student.userId)).toBe(0);
      expect((await storedInvite(created.id)).status).toBe(StudentInviteStatus.PENDING);
    });

    it('should keep the invite pending when the invited user verifies the e-mail, then show it in the app', async () => {
      const trainer = await createTrainer();
      const student = await seedLegacyUnverifiedUser(app, { email: uniqueEmail('verify'), password: PASSWORD });
      const created = await inviteExisting(trainer, student);

      const verified = await app.inject({
        method: 'POST',
        url: '/auth/verify-email',
        headers: auth(student.accessToken),
        payload: { code: verificationCodes.get(student.email) },
      });

      expect(verified.json()).toMatchObject({ verified: true, linkedTrainers: 0 });
      expect(await linkCount(student.userId)).toBe(0);
      expect((await listMyInvites(student)).json().items.map((item) => item.id)).toEqual([created.id]);
    });

    it('should keep the invite of an address without an account automatic and out of the consent flow', async () => {
      const trainer = await createTrainer();
      const email = uniqueEmail('new');

      const res = await invite(trainer, email);

      expect(res.statusCode).toBe(201);
      expect(await storedInvite(res.json().invite.id)).toMatchObject({ requiresConsent: false });
      expect(downloadEmails).toEqual([{ to: email, trainerName: TRAINER_NAME }]);
      expect(openAppEmails).toEqual([]);
    });

    it('should answer 403 emailVerification.required to the 4th invite of an unverified sender within 24 hours', async () => {
      const trainer = await createUnverifiedTrainer();
      for (let sent = 0; sent < UNVERIFIED_SENDER_INVITE_CAP; sent += 1) {
        await inviteExisting(trainer, await createStudentWithToken(app));
      }
      const fourth = await createStudentWithToken(app);

      const res = await invite(trainer, fourth.email);

      expectErrorContract(res, EMAIL_VERIFICATION_REQUIRED);
      expect(await prisma.studentInvite.count({ where: { email: fourth.email } })).toBe(0);
    });

    it('should answer 403 platformPlan.studentCapExceeded when the trainer is at the student cap', async () => {
      const trainer = await createTrainer({ tier: PLATFORM_PLAN_TIERS.FREE });
      await fillStudentCap(trainer);
      const student = await createStudentWithToken(app);

      const res = await invite(trainer, student.email);

      expectErrorContract(res, {
        statusCode: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.status,
        error: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.code,
        messageCode: PLATFORM_PLAN_ERRORS.STUDENT_CAP_EXCEEDED.messageCode,
      });
      expect(await prisma.studentInvite.count()).toBe(0);
    });

    it('should answer 409 studentInvite.alreadyPending to a second invite of the same account', async () => {
      const trainer = await createTrainer();
      const student = await createStudentWithToken(app);
      await inviteExisting(trainer, student);

      const res = await invite(trainer, student.email);

      expectErrorContract(res, {
        statusCode: 409,
        error: StudentInviteErrorCode.ALREADY_PENDING,
        messageCode: StudentInviteMessageCode.ALREADY_PENDING,
      });
    });

    it('should keep answering 422 student.cannotLinkSelf for the own e-mail of the trainer', async () => {
      const trainer = await createTrainer();

      const res = await invite(trainer, trainer.email);

      expectErrorContract(res, {
        statusCode: 422,
        error: StudentInviteErrorCode.CANNOT_LINK_SELF,
        messageCode: StudentInviteMessageCode.CANNOT_LINK_SELF,
      });
    });

    it('should keep answering 422 student.accountDeactivated for a deactivated account', async () => {
      const trainer = await createTrainer();
      const student = await createStudentWithToken(app);
      await prisma.user.update({ where: { id: student.userId }, data: { deletedAt: new Date() } });

      const res = await invite(trainer, student.email);

      expectErrorContract(res, {
        statusCode: 422,
        error: StudentInviteErrorCode.STUDENT_ACCOUNT_DEACTIVATED,
        messageCode: StudentInviteMessageCode.STUDENT_ACCOUNT_DEACTIVATED,
      });
    });

    it('should keep answering 409 student.alreadyLinked once the student accepted', async () => {
      const trainer = await createTrainer();
      const student = await createStudentWithToken(app);
      const created = await inviteExisting(trainer, student);
      expect((await accept(student, created.id)).statusCode).toBe(200);

      const res = await invite(trainer, student.email);

      expect(res.statusCode).toBe(409);
      expect(res.json().messageCode).toBe(StudentInviteMessageCode.ALREADY_LINKED);
    });
  });

  describe('POST /trainer/students (legacy direct link)', () => {
    it('should answer 202 { outcome: invited, invite } and link nothing for an existing account', async () => {
      const trainer = await createTrainer();
      const student = await createStudentWithToken(app);

      const res = await app.inject({ method: 'POST', url: '/trainer/students', headers: auth(trainer.accessToken), payload: { email: student.email } });

      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ outcome: StudentInviteOutcome.INVITED, invite: { email: student.email, status: StudentInviteStatus.PENDING } });
      expect(await linkCount(student.userId)).toBe(0);
      expect((await listMyInvites(student)).json().items).toHaveLength(1);
    });
  });

  describe(`GET ${MY_INVITES_URL}`, () => {
    let trainer;
    let student;

    beforeEach(async () => {
      trainer = await createTrainer();
      student = await createStudentWithToken(app);
    });

    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'GET', url: MY_INVITES_URL });

      expect(res.statusCode).toBe(401);
    });

    it('should list the pending invite with the trainer name and avatar', async () => {
      const created = await inviteExisting(trainer, student);

      const res = await listMyInvites(student);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({
        items: [
          {
            id: created.id,
            trainer: { firstName: TRAINER_FIRST_NAME, lastName: TRAINER_LAST_NAME, avatarUrl: null },
            createdAt: created.createdAt,
            expiresAt: created.expiresAt,
          },
        ],
      });
    });

    it('should answer empty strings for a trainer without a name', async () => {
      await prisma.user.update({ where: { id: trainer.userId }, data: { firstName: null, lastName: null } });
      await inviteExisting(trainer, student);

      const res = await listMyInvites(student);

      expect(res.json().items[0].trainer).toEqual({ firstName: '', lastName: '', avatarUrl: null });
    });

    it('should list the newest invite first', async () => {
      const otherTrainer = await createTrainer();
      const older = await inviteExisting(trainer, student);
      await prisma.studentInvite.update({ where: { id: older.id }, data: { createdAt: new Date(Date.now() - ONE_MINUTE_MS) } });
      const newer = await inviteExisting(otherTrainer, student);

      const res = await listMyInvites(student);

      expect(res.json().items.map((item) => item.id)).toEqual([newer.id, older.id]);
    });

    it('should answer no items to another user', async () => {
      await inviteExisting(trainer, student);
      const stranger = await createStudentWithToken(app);

      const res = await listMyInvites(stranger);

      expect(res.json()).toEqual({ items: [] });
    });

    it('should answer no items while the e-mail of the caller is unverified', async () => {
      await inviteExisting(trainer, student);
      await prisma.account.updateMany({ where: { userId: student.userId }, data: { verifiedAt: null } });

      const res = await listMyInvites(student);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [] });
    });

    it('should leave out an expired invite', async () => {
      const created = await inviteExisting(trainer, student);
      await prisma.studentInvite.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - ONE_MINUTE_MS) } });

      expect((await listMyInvites(student)).json()).toEqual({ items: [] });
    });

    it('should leave out a revoked invite', async () => {
      const created = await inviteExisting(trainer, student);
      expect((await revokeInvite(trainer, created.id)).statusCode).toBe(200);

      expect((await listMyInvites(student)).json()).toEqual({ items: [] });
    });

    it('should leave out the invite of a deleted trainer', async () => {
      await inviteExisting(trainer, student);
      await prisma.trainer.update({ where: { id: trainer.trainerId }, data: { deletedAt: new Date() } });
      await prisma.user.update({ where: { id: trainer.userId }, data: { deletedAt: new Date() } });

      expect((await listMyInvites(student)).json()).toEqual({ items: [] });
    });

    it('should leave out an invite that needs no consent', async () => {
      const created = await inviteExisting(trainer, student);
      await prisma.studentInvite.update({ where: { id: created.id }, data: { requiresConsent: false } });

      expect((await listMyInvites(student)).json()).toEqual({ items: [] });
    });
  });

  describe(`POST ${MY_INVITES_URL}/:id/accept`, () => {
    let trainer;
    let student;
    let created;

    beforeEach(async () => {
      trainer = await createTrainer();
      student = await createStudentWithToken(app);
      created = await inviteExisting(trainer, student);
    });

    it('should link the student, mark the invite accepted and answer { status: accepted }', async () => {
      const res = await accept(student, created.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(ACCEPTED);
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
      });
      expect(link).toMatchObject({ activeOnPlan: true });
      expect(await storedInvite(created.id)).toMatchObject({
        status: StudentInviteStatus.ACCEPTED,
        studentId: student.userId,
        acceptedAt: expect.any(Date),
      });
    });

    it('should show the student in the roster of the trainer and the invite as accepted', async () => {
      await accept(student, created.id);

      expect((await listTrainerStudents(trainer)).json()).toEqual([expect.objectContaining({ id: student.userId })]);
      expect((await listTrainerInvites(trainer, `?status=${StudentInviteStatus.ACCEPTED}`)).json().items).toEqual([
        expect.objectContaining({ id: created.id, status: StudentInviteStatus.ACCEPTED }),
      ]);
    });

    it('should mark the first-student-linked milestone of the trainer', async () => {
      await accept(student, created.id);

      const { firstStudentLinkedAt } = await prisma.trainer.findUnique({ where: { id: trainer.trainerId }, select: { firstStudentLinkedAt: true } });
      expect(firstStudentLinkedAt).toBeInstanceOf(Date);
    });

    it('should drop the invite from the list of the student', async () => {
      await accept(student, created.id);

      expect((await listMyInvites(student)).json()).toEqual({ items: [] });
    });

    it('should create the link inactive when the trainer filled the plan cap after inviting', async () => {
      await provisionTrainerPlan(trainer.trainerId, PLATFORM_PLAN_TIERS.FREE);
      await fillStudentCap(trainer);

      const res = await accept(student, created.id);

      expect(res.json()).toEqual(ACCEPTED);
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.trainerId, studentId: student.userId } },
      });
      expect(link.activeOnPlan).toBe(false);
      const listed = (await listTrainerStudents(trainer)).json().find((row) => row.id === student.userId);
      expect(listed.blockers).toContain(StudentBlocker.BLOCKED_ON_PLAN);
    });
  });

  describe(`POST ${MY_INVITES_URL}/:id/decline`, () => {
    let trainer;
    let student;
    let created;

    beforeEach(async () => {
      trainer = await createTrainer();
      student = await createStudentWithToken(app);
      created = await inviteExisting(trainer, student);
    });

    it('should mark the invite declined, link nothing and answer { status: declined }', async () => {
      const res = await decline(student, created.id);

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual(DECLINED);
      expect(await linkCount(student.userId)).toBe(0);
      expect((await storedInvite(created.id)).status).toBe(DECLINED_STATUS);
    });

    it('should report the invite as declined in the invite list of the trainer', async () => {
      await decline(student, created.id);

      const res = await listTrainerInvites(trainer, `?status=${DECLINED_STATUS}`);

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toEqual([
        expect.objectContaining({ id: created.id, status: DECLINED_STATUS, statusLabel: expect.any(String), canResend: false }),
      ]);
      expect((await listTrainerInvites(trainer, `?status=${StudentInviteStatus.PENDING}`)).json().items).toEqual([]);
    });

    it('should drop the invite from the list of the student', async () => {
      await decline(student, created.id);

      expect((await listMyInvites(student)).json()).toEqual({ items: [] });
    });

    it('should let the trainer send a new invite after a decline', async () => {
      await decline(student, created.id);

      const res = await invite(trainer, student.email);

      expect(res.statusCode).toBe(201);
      expect((await listMyInvites(student)).json().items.map((item) => item.id)).toEqual([res.json().invite.id]);
    });
  });

  describe.each(ANSWERS)(`POST ${MY_INVITES_URL}/:id/%s refusals`, (action) => {
    let trainer;
    let student;
    let created;

    beforeEach(async () => {
      trainer = await createTrainer();
      student = await createStudentWithToken(app);
      created = await inviteExisting(trainer, student);
    });

    it('should answer 401 without authentication', async () => {
      const res = await app.inject({ method: 'POST', url: `${MY_INVITES_URL}/${created.id}/${action}` });

      expect(res.statusCode).toBe(401);
    });

    it('should answer 400 validation.failed for an id that is not a uuid', async () => {
      const res = await answer(action, student, INVALID_INVITE_ID);

      expectErrorContract(res, { statusCode: 400, error: 'VALIDATION_ERROR', messageCode: 'validation.failed' });
    });

    it('should answer 404 studentInvite.notFound for an unknown id', async () => {
      const res = await answer(action, student, UNKNOWN_INVITE_ID);

      expectErrorContract(res, INVITE_NOT_FOUND);
    });

    it('should answer 404 studentInvite.notFound and change nothing for an invite addressed to another e-mail', async () => {
      const stranger = await createStudentWithToken(app);

      const res = await answer(action, stranger, created.id);

      expectErrorContract(res, INVITE_NOT_FOUND);
      expect((await storedInvite(created.id)).status).toBe(StudentInviteStatus.PENDING);
      expect(await prisma.trainerStudent.count()).toBe(0);
    });

    it('should answer 404 studentInvite.notFound and change nothing while the e-mail of the caller is unverified', async () => {
      await prisma.account.updateMany({ where: { userId: student.userId }, data: { verifiedAt: null } });

      const res = await answer(action, student, created.id);

      expectErrorContract(res, INVITE_NOT_FOUND);
      expect((await storedInvite(created.id)).status).toBe(StudentInviteStatus.PENDING);
      expect(await prisma.trainerStudent.count()).toBe(0);
    });

    it('should answer 422 studentInvite.expired and link nothing for an expired invite', async () => {
      await prisma.studentInvite.update({ where: { id: created.id }, data: { expiresAt: new Date(Date.now() - ONE_MINUTE_MS) } });

      const res = await answer(action, student, created.id);

      expectErrorContract(res, INVITE_EXPIRED);
      expect(await prisma.trainerStudent.count()).toBe(0);
    });

    it('should answer 409 studentInvite.notPending and link nothing for a revoked invite', async () => {
      expect((await revokeInvite(trainer, created.id)).statusCode).toBe(200);

      const res = await answer(action, student, created.id);

      expectErrorContract(res, INVITE_NOT_PENDING);
      expect(await prisma.trainerStudent.count()).toBe(0);
    });

    it('should answer 409 studentInvite.notPending for an invite already declined', async () => {
      expect((await decline(student, created.id)).statusCode).toBe(200);

      const res = await answer(action, student, created.id);

      expectErrorContract(res, INVITE_NOT_PENDING);
      expect(await prisma.trainerStudent.count()).toBe(0);
    });

    it('should answer 409 studentInvite.notPending for an invite already accepted and keep the link', async () => {
      expect((await accept(student, created.id)).statusCode).toBe(200);

      const res = await answer(action, student, created.id);

      expectErrorContract(res, INVITE_NOT_PENDING);
      expect(await prisma.trainerStudent.count()).toBe(1);
      expect((await storedInvite(created.id)).status).toBe(StudentInviteStatus.ACCEPTED);
    });

    it('should translate the refusal to en-US when the app asks for it', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `${MY_INVITES_URL}/${UNKNOWN_INVITE_ID}/${action}`,
        headers: { ...auth(student.accessToken), 'app-language': 'en-US' },
        payload: {},
      });

      expectErrorContract(res, INVITE_NOT_FOUND);
      expect(res.json().message).toBe('Invite not found.');
    });
  });
});
