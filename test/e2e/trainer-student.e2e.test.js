import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { StudentBlocker } from '../../src/constants/student-blocker.js';
import { SubscriptionStatus, PaymentStatus } from '../../src/constants/subscription.js';
import { getDateOnlyAsMidnightUtc, addDaysMs } from '../../src/helpers/date-helpers.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

e2eDescribe('e2e: link student to trainer by email', () => {
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
    await cleanDatabase();
  });

  async function createTrainerWithToken() {
    const email = `e2e+trainer-${Date.now()}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);
    const { token: { accessToken: trainerToken } } = becomeRes.json();

    const trainerRecord = await prisma.trainer.findUnique({
      where: { userId },
      select: { id: true },
    });

    return { userId, trainerId: trainerRecord.id, accessToken: trainerToken, email };
  }

  async function createStudent() {
    const email = `e2e+student-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const password = 'StrongPassw0rd!';

    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId }, token: { accessToken } } = signupRes.json();

    return { userId, accessToken, email };
  }

  // ─── Readiness-blocker fixture helpers (direct Prisma — exact control over
  // status/dueDate/expirationDate boundaries, same pattern used in
  // trainer-dashboard.e2e.test.js) ────────────────────────────────────────────

  function daysFromToday(days) {
    const today = getDateOnlyAsMidnightUtc(new Date());
    return addDaysMs(today, days);
  }

  async function createProtocol(trainerId, assigneeId, overrides = {}) {
    return prisma.trainingProtocol.create({
      data: {
        trainerId,
        assigneeId,
        name: 'Protocolo E2E Readiness',
        status: 'active',
        startDate: daysFromToday(-30),
        ...overrides,
      },
    });
  }

  async function createPlan(trainerId, overrides = {}) {
    return prisma.subscriptionPlan.create({
      data: {
        trainerId,
        name: 'Plano E2E Readiness',
        recurrence: 'monthly',
        price: 100,
        ...overrides,
      },
    });
  }

  async function createSubscription(trainerId, studentId, planId, overrides = {}) {
    return prisma.studentSubscription.create({
      data: {
        trainerId,
        studentId,
        planId,
        recurrence: 'monthly',
        price: 100,
        startDate: daysFromToday(-60),
        status: SubscriptionStatus.ACTIVE,
        ...overrides,
      },
    });
  }

  async function createPayment(subscriptionId, overrides = {}) {
    return prisma.subscriptionPayment.create({
      data: {
        subscriptionId,
        cycleStartDate: daysFromToday(-30),
        cycleEndDate: daysFromToday(0),
        dueDate: daysFromToday(0),
        amount: 100,
        status: PaymentStatus.PENDING,
        ...overrides,
      },
    });
  }

  async function linkStudent(trainerToken, studentEmail) {
    const res = await app.inject({
      method: 'POST',
      url: '/trainer/students',
      headers: { authorization: `Bearer ${trainerToken}` },
      payload: { email: studentEmail },
    });
    expect(res.statusCode).toBe(201);
    return res.json();
  }

  describe('POST /trainer/students', () => {
    it('links a student and returns their basic profile', async () => {
      const { accessToken: trainerToken, userId: trainerUserId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      expect(res.statusCode).toBe(201);
      const body = res.json();
      expect(body).toMatchObject({
        id: studentId,
        email: studentEmail,
      });
      expect(body).toHaveProperty('firstName');
      expect(body).toHaveProperty('lastName');
      expect(body).toHaveProperty('avatarUrl');

      const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUserId } });
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
      });
      expect(link).not.toBeNull();
    });

    it('returns 404 when no user exists with that email', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: 'nonexistent@example.com' },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'student.notFound',
      });
    });

    it('returns 409 when student is already linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail } = await createStudent();

      const first = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });
      expect(first.statusCode).toBe(201);

      const second = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      expect(second.statusCode).toBe(409);
      expect(second.json()).toMatchObject({
        error: 'CONFLICT',
        messageCode: 'student.alreadyLinked',
      });
    });

    it('returns 422 when the trainer tries to link themselves', async () => {
      const { accessToken: trainerToken, email: trainerEmail } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: trainerEmail },
      });

      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        error: 'CANNOT_LINK_SELF',
        messageCode: 'student.cannotLinkSelf',
      });
    });

    it('returns 400 when email is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when email format is invalid', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: 'not-an-email' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 403 when the user does not have the TRAINER role', async () => {
      const { accessToken } = await createStudent();

      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { email: 'anyone@example.com' },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        payload: { email: 'anyone@example.com' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('allows the same student to be linked to multiple trainers', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();

      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const { email: studentEmail, userId: studentId } = await createStudent();

      const res1 = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken1}` },
        payload: { email: studentEmail },
      });
      expect(res1.statusCode).toBe(201);

      const res2 = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: studentEmail },
      });
      expect(res2.statusCode).toBe(201);

      const links = await prisma.trainerStudent.findMany({ where: { studentId } });
      expect(links).toHaveLength(2);
    });
  });

  describe('GET /trainer/students', () => {
    it('returns an empty array when no students are linked', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns all linked students', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: email1, userId: studentId1 } = await createStudent();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { email: email2, userId: studentId2 } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: email1 },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: email2 },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);
      const ids = body.map(s => s.id);
      expect(ids).toContain(studentId1);
      expect(ids).toContain(studentId2);
      body.forEach(s => {
        expect(s).toHaveProperty('id');
        expect(s).toHaveProperty('email');
        expect(s).toHaveProperty('firstName');
        expect(s).toHaveProperty('lastName');
        expect(s).toHaveProperty('avatarUrl');
      });
    });

    it('only returns students linked to the requesting trainer', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const { email: sharedEmail } = await createStudent();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { email: exclusiveEmail, userId: exclusiveId } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken1}` },
        payload: { email: sharedEmail },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: sharedEmail },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: exclusiveEmail },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(2);
      expect(body.map(s => s.id)).toContain(exclusiveId);
    });

    it('returns 403 when the user does not have the TRAINER role', async () => {
      const { accessToken } = await createStudent();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
      });

      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /trainer/students — readiness (ready + blockers)', () => {
    it('includes ready, blockers, and blockersLabel of matching length on every item', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      const [student] = body;
      expect(student.id).toBe(studentId);
      expect(typeof student.ready).toBe('boolean');
      expect(Array.isArray(student.blockers)).toBe(true);
      expect(Array.isArray(student.blockersLabel)).toBe(true);
      expect(student.blockersLabel).toHaveLength(student.blockers.length);
      student.blockers.forEach((code) => {
        expect(typeof code).toBe('string');
      });
    });

    it('translates blockersLabel per the app-language header for the same blocker code', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail } = await createStudent();
      // Linked but given no protocol and no subscription → no_active_protocol
      // is guaranteed to be present regardless of other fixtures.
      await linkStudent(trainerToken, studentEmail);

      const ptBrRes = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}`, 'app-language': 'pt-BR' },
      });
      const enUsRes = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}`, 'app-language': 'en-US' },
      });

      expect(ptBrRes.statusCode).toBe(200);
      expect(enUsRes.statusCode).toBe(200);

      const [ptBrStudent] = ptBrRes.json();
      const [enUsStudent] = enUsRes.json();

      expect(ptBrStudent.blockers).toContain(StudentBlocker.NO_ACTIVE_PROTOCOL);
      const blockerIndex = ptBrStudent.blockers.indexOf(StudentBlocker.NO_ACTIVE_PROTOCOL);

      expect(ptBrStudent.blockersLabel[blockerIndex]).toBe('Sem rotina ativa');
      expect(enUsStudent.blockersLabel[blockerIndex]).toBe('No active routine');
    });

    it('flags no_active_protocol and no_subscription in order for a student with neither', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.ready).toBe(false);
      expect(student.blockers).toEqual([
        StudentBlocker.NO_ACTIVE_PROTOCOL,
        StudentBlocker.NO_SUBSCRIPTION,
      ]);
    });

    it('returns ready: true and no blockers for a fully operational student', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      // Active, non-expired protocol.
      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });

      // Active subscription with no overdue payment (due date in the future).
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, {
        status: PaymentStatus.PENDING,
        dueDate: daysFromToday(10),
      });

      // activeOnPlan defaults to true on link creation for a fresh trainer
      // within their free-tier seat quota — no explicit override needed.

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.id).toBe(studentId);
      expect(student.ready).toBe(true);
      expect(student.blockers).toEqual([]);
      expect(student.blockersLabel).toEqual([]);
    });

    // This is the primary regression guard for the one trap this feature was
    // built around: the adherence query (a sibling query inside the same
    // listStudents call) intentionally excludes protocols that haven't
    // started yet via `startDate: { lt: now }`. The no_active_protocol
    // blocker check must NOT share that filter — a protocol starting
    // tomorrow means the trainer already did their part. This can only be
    // proven against a real `where` clause hitting Postgres: a mocked-Prisma
    // unit test can be made to pass regardless of which query got which
    // filter (see the unit-test comment in trainer-service.test.js for the
    // call-order-mock pitfall this replaces).
    it('does not flag no_active_protocol for a protocol starting in the future', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      // Starts tomorrow — excluded from this month's adherence window, but
      // still an active, assigned routine.
      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(1),
        expirationDate: null,
      });
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, { status: PaymentStatus.PENDING, dueDate: daysFromToday(10) });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.id).toBe(studentId);
      expect(student.blockers).not.toContain(StudentBlocker.NO_ACTIVE_PROTOCOL);
      expect(student.ready).toBe(true);
      expect(student.blockers).toEqual([]);
    });

    it('flags subscription_cancelled when the student has subscription history but nothing currently active', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });
      const plan = await createPlan(trainerId);
      await createSubscription(trainerId, studentId, plan.id, {
        status: SubscriptionStatus.CANCELLED,
        cancelledAt: new Date(),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).toEqual([StudentBlocker.SUBSCRIPTION_CANCELLED]);
    });

    it('does not flag a subscription blocker when an old cancelled subscription coexists with a current healthy active one', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });
      const plan = await createPlan(trainerId);
      // Old, cancelled subscription — history only.
      await createSubscription(trainerId, studentId, plan.id, {
        status: SubscriptionStatus.CANCELLED,
        startDate: daysFromToday(-200),
        cancelledAt: daysFromToday(-100),
      });
      // Current, healthy, active subscription.
      const activeSubscription = await createSubscription(trainerId, studentId, plan.id, {
        status: SubscriptionStatus.ACTIVE,
        startDate: daysFromToday(-60),
      });
      await createPayment(activeSubscription.id, { status: PaymentStatus.PENDING, dueDate: daysFromToday(10) });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.ready).toBe(true);
      expect(student.blockers).toEqual([]);
    });

    it('flags subscription_overdue when the active subscription has a payment past due', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, { status: PaymentStatus.PENDING, dueDate: daysFromToday(-1) });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).toEqual([StudentBlocker.SUBSCRIPTION_OVERDUE]);
    });

    it('flags blocked_on_plan when the trainer-side seat quota is not active for the student', async () => {
      const { trainerId, accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudent();

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, { status: PaymentStatus.PENDING, dueDate: daysFromToday(10) });

      // Bypass the POST /trainer/students link flow (which always sets
      // activeOnPlan: true) — this state only arises from the trainer's own
      // seat-quota enforcement, not from anything the student did.
      await prisma.trainerStudent.create({
        data: { trainerId, studentId, activeOnPlan: false },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).toEqual([StudentBlocker.BLOCKED_ON_PLAN]);
    });

    // ── Date-boundary tests: dueDate/expirationDate comparisons only exist
    // inside Prisma `where` clauses, so they are structurally impossible to
    // prove with mocked unit tests — only these E2E tests, against a real
    // Postgres row, can show whether the boundary is inclusive or exclusive.

    it('does not flag subscription_overdue when the pending payment is due today (inclusive, not yet overdue)', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, { status: PaymentStatus.PENDING, dueDate: daysFromToday(0) });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).not.toContain(StudentBlocker.SUBSCRIPTION_OVERDUE);
      expect(student.ready).toBe(true);
    });

    it('flags subscription_overdue when the pending payment was due yesterday (exclusive, past due)', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(30),
      });
      const plan = await createPlan(trainerId);
      const subscription = await createSubscription(trainerId, studentId, plan.id);
      await createPayment(subscription.id, { status: PaymentStatus.PENDING, dueDate: daysFromToday(-1) });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).toContain(StudentBlocker.SUBSCRIPTION_OVERDUE);
    });

    it('does not flag no_active_protocol when the protocol expires today (inclusive, still active)', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(0),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).not.toContain(StudentBlocker.NO_ACTIVE_PROTOCOL);
    });

    it('flags no_active_protocol when the protocol expired yesterday (exclusive, no longer active)', async () => {
      const { accessToken: trainerToken, trainerId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);

      await createProtocol(trainerId, studentId, {
        startDate: daysFromToday(-30),
        expirationDate: daysFromToday(-1),
      });

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(200);
      const [student] = res.json();
      expect(student.blockers).toContain(StudentBlocker.NO_ACTIVE_PROTOCOL);
    });
  });

  describe('GET /trainer/students/search', () => {
    it('returns linked students that match by name or email', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail1, userId: studentId1 } = await createStudent();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { email: studentEmail2, userId: studentId2 } = await createStudent();

      await prisma.user.update({
        where: { id: studentId1 },
        data: { firstName: 'Carolina', lastName: 'Almeida' },
      });
      await prisma.user.update({
        where: { id: studentId2 },
        data: { firstName: 'Bruno', lastName: 'Silva' },
      });

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail1 },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail2 },
      });

      const byName = await app.inject({
        method: 'GET',
        url: '/trainer/students/search?q=carol',
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(byName.statusCode).toBe(200);
      expect(byName.json().map(s => s.id)).toContain(studentId1);

      const byEmail = await app.inject({
        method: 'GET',
        url: `/trainer/students/search?q=${encodeURIComponent(studentEmail2.slice(0, 8))}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });
      expect(byEmail.statusCode).toBe(200);
      expect(byEmail.json().map(s => s.id)).toContain(studentId2);
    });

    it('only returns students linked to the requesting trainer', async () => {
      const { accessToken: trainerToken1 } = await createTrainerWithToken();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();
      const { email: studentEmail } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: 'GET',
        url: `/trainer/students/search?q=${encodeURIComponent(studentEmail.slice(0, 8))}`,
        headers: { authorization: `Bearer ${trainerToken1}` },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it('returns 400 when q is missing', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await app.inject({
        method: 'GET',
        url: '/trainer/students/search',
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /trainer/students/:studentId', () => {
    const getStudent = (token, studentId) =>
      app.inject({
        method: 'GET',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${token}` },
      });

    it('returns the basic profile of a linked student', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);
      await prisma.user.update({ where: { id: studentId }, data: { firstName: 'Maria', lastName: 'Silva' } });

      const res = await getStudent(trainerToken, studentId);

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toMatchObject({
        id: studentId,
        email: studentEmail,
        firstName: 'Maria',
        lastName: 'Silva',
        avatarUrl: null,
        activeOnPlan: true,
      });
      expect(Number.isNaN(Date.parse(body.linkedAt))).toBe(false);
      expect(Object.keys(body).sort()).toEqual(
        ['activeOnPlan', 'avatarUrl', 'email', 'firstName', 'id', 'lastName', 'linkedAt'],
      );
    });

    it('returns 404 student.notLinked for a student linked only to another trainer', async () => {
      const { accessToken: ownerToken } = await createTrainerWithToken();
      await new Promise((resolve) => setTimeout(resolve, 10));
      const { accessToken: otherToken } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(ownerToken, studentEmail);

      const res = await getStudent(otherToken, studentId);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ error: 'NOT_FOUND', messageCode: 'student.notLinked' });
    });

    it('returns 404 student.notLinked when the student account was deleted', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();
      await linkStudent(trainerToken, studentEmail);
      await prisma.user.update({ where: { id: studentId }, data: { deletedAt: new Date() } });

      const res = await getStudent(trainerToken, studentId);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ messageCode: 'student.notLinked' });
    });

    it('returns 403 for a user without the trainer role', async () => {
      const { accessToken: studentToken, userId: studentId } = await createStudent();

      const res = await getStudent(studentToken, studentId);

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 without a token', async () => {
      const res = await app.inject({ method: 'GET', url: '/trainer/students/00000000-0000-0000-0000-000000000000' });

      expect(res.statusCode).toBe(401);
    });

    it('returns 400 for a non-uuid studentId', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();

      const res = await getStudent(trainerToken, 'not-a-uuid');

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'VALIDATION_ERROR' });
    });
  });

  describe('DELETE /trainer/students/:studentId', () => {
    it('unlinks a student and returns 204, verifying the link is removed from the DB', async () => {
      const { accessToken: trainerToken, userId: trainerUserId } = await createTrainerWithToken();
      const { email: studentEmail, userId: studentId } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(204);

      const trainer = await prisma.trainer.findUnique({ where: { userId: trainerUserId } });
      const link = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer.id, studentId } },
      });
      expect(link).toBeNull();
    });

    it('returns 404 when the student is not linked to the trainer', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const { userId: studentId } = await createStudent();

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'student.notLinked',
      });
    });

    it('returns 404 when the studentId does not correspond to any existing user', async () => {
      const { accessToken: trainerToken } = await createTrainerWithToken();
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${nonExistentId}`,
        headers: { authorization: `Bearer ${trainerToken}` },
      });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({
        error: 'NOT_FOUND',
        messageCode: 'student.notLinked',
      });
    });

    it('does not affect other trainers\' links to the same student', async () => {
      const { accessToken: trainerToken1, userId: trainerUserId1 } = await createTrainerWithToken();
      await new Promise(resolve => setTimeout(resolve, 10));
      const { accessToken: trainerToken2 } = await createTrainerWithToken();

      const { email: studentEmail, userId: studentId } = await createStudent();

      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken1}` },
        payload: { email: studentEmail },
      });
      await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: { authorization: `Bearer ${trainerToken2}` },
        payload: { email: studentEmail },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${studentId}`,
        headers: { authorization: `Bearer ${trainerToken1}` },
      });

      expect(res.statusCode).toBe(204);

      const trainer1 = await prisma.trainer.findUnique({ where: { userId: trainerUserId1 } });
      const link1 = await prisma.trainerStudent.findUnique({
        where: { trainerId_studentId: { trainerId: trainer1.id, studentId } },
      });
      expect(link1).toBeNull();

      const allLinks = await prisma.trainerStudent.findMany({ where: { studentId } });
      expect(allLinks).toHaveLength(1);
    });

    it('returns 403 when the user does not have the TRAINER role', async () => {
      const { accessToken } = await createStudent();
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${nonExistentId}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const nonExistentId = '00000000-0000-0000-0000-000000000000';

      const res = await app.inject({
        method: 'DELETE',
        url: `/trainer/students/${nonExistentId}`,
      });

      expect(res.statusCode).toBe(401);
    });
  });
});
