import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import {
  authHeader,
  businessDay,
  createPaymentRow,
  createPlanViaApi,
  createStudent,
  createSubscriptionRow,
  createTrainer,
  linkStudent,
} from '../helpers/billing-fixtures.js';
import { BillingStatus, PaymentStatus, SubscriptionStatus } from '../../src/constants/subscription.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const APP_LANGUAGE_HEADER = 'app-language';
const EN_US = 'en-US';
const PT_BR = 'pt-BR';

const BILLING_LABELS = {
  [EN_US]: {
    [BillingStatus.OVERDUE]: 'Overdue',
    [BillingStatus.DUE_SOON]: 'Due soon',
    [BillingStatus.OK]: 'Up to date',
    [BillingStatus.NONE]: 'No plan',
  },
};

e2eDescribe('e2e: GET /trainer/students billingStatus', () => {
  let app;
  let trainer;
  let planId;
  // label -> studentId
  const students = {};

  beforeAll(async () => {
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  async function seedStudent(label, { subscriptionStatus, dueInDays, paymentStatus } = {}) {
    const student = await createStudent(app, { firstName: label });
    await linkStudent(trainer.trainerId, student.userId);
    students[label] = student.userId;
    if (!subscriptionStatus) return;
    const sub = await createSubscriptionRow({
      trainerId: trainer.trainerId,
      studentId: student.userId,
      planId,
      status: subscriptionStatus,
    });
    if (dueInDays === undefined) return;
    await createPaymentRow(sub.id, {
      dueDate: businessDay(dueInDays),
      ...(paymentStatus ? { status: paymentStatus } : {}),
    });
  }

  beforeEach(async () => {
    await cleanDatabase();
    trainer = await createTrainer(app);
    ({ id: planId } = await createPlanViaApi(app, trainer.accessToken));

    await seedStudent('dueMinus3', { subscriptionStatus: SubscriptionStatus.ACTIVE, dueInDays: -3 });
    await seedStudent('dueMinus4', { subscriptionStatus: SubscriptionStatus.ACTIVE, dueInDays: -4 });
    await seedStudent('duePlus7', { subscriptionStatus: SubscriptionStatus.ACTIVE, dueInDays: 7 });
    await seedStudent('duePlus8', { subscriptionStatus: SubscriptionStatus.ACTIVE, dueInDays: 8 });
    await seedStudent('paidOverdue', {
      subscriptionStatus: SubscriptionStatus.ACTIVE,
      dueInDays: -10,
      paymentStatus: PaymentStatus.PAID,
    });
    await seedStudent('cancelledOverdue', { subscriptionStatus: SubscriptionStatus.CANCELLED, dueInDays: -10 });
    await seedStudent('noSub');
  });

  async function listStudentsRes(headers = {}) {
    return app.inject({
      method: 'GET',
      url: '/trainer/students',
      headers: { ...authHeader(trainer.accessToken), ...headers },
    });
  }

  const statusByLabel = (body) =>
    Object.fromEntries(
      Object.entries(students).map(([label, id]) => [label, body.find((s) => s.id === id).billingStatus]),
    );

  it('derives billingStatus per student at the grace and window boundaries', async () => {
    const res = await listStudentsRes();

    expect(res.statusCode).toBe(200);
    expect(statusByLabel(res.json())).toEqual({
      dueMinus3: BillingStatus.DUE_SOON,
      dueMinus4: BillingStatus.OVERDUE,
      duePlus7: BillingStatus.DUE_SOON,
      duePlus8: BillingStatus.OK,
      paidOverdue: BillingStatus.OK,
      cancelledOverdue: BillingStatus.NONE,
      noSub: BillingStatus.NONE,
    });
  });

  it('matches the dashboard counters for the same trainer', async () => {
    const listRes = await listStudentsRes();
    const dashRes = await app.inject({
      method: 'GET',
      url: '/trainer/dashboard',
      headers: authHeader(trainer.accessToken),
    });

    expect(dashRes.statusCode).toBe(200);
    const statuses = listRes.json().map((s) => s.billingStatus);
    const { expiredCount, renewingSoonCount } = dashRes.json().plans;
    expect(statuses.filter((s) => s === BillingStatus.OVERDUE).length).toBe(expiredCount);
    expect(statuses.filter((s) => s === BillingStatus.DUE_SOON).length).toBe(renewingSoonCount);
    expect(expiredCount).toBe(1);
    expect(renewingSoonCount).toBe(2);
  });

  it('returns translated billingStatusLabel with app-language en-US', async () => {
    const res = await listStudentsRes({ [APP_LANGUAGE_HEADER]: EN_US });

    for (const student of res.json()) {
      expect(student.billingStatusLabel).toBe(BILLING_LABELS[EN_US][student.billingStatus]);
    }
  });

  it('returns a non-empty billingStatusLabel by default (pt-BR)', async () => {
    const res = await listStudentsRes({ [APP_LANGUAGE_HEADER]: PT_BR });

    for (const student of res.json()) {
      expect(student.billingStatusLabel).toBeTruthy();
      expect(student.billingStatusLabel).not.toBe(BILLING_LABELS[EN_US][student.billingStatus]);
    }
  });
});
