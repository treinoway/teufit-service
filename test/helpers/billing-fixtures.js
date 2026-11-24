import { prisma } from '../../src/db.js';
import {
  PaymentStatus,
  SubscriptionRecurrence,
  SubscriptionStatus,
} from '../../src/constants/subscription.js';
import { addDaysMs, formatDateOnly, todayInBusinessTz } from '../../src/helpers/date-helpers.js';
import { signupVerified } from './signup-user.js';

const PASSWORD = 'StrongPassw0rd!';
let userSequence = 0;

/** Civil day (midnight UTC) `days` away from today in the business timezone. */
export function businessDay(days = 0) {
  return addDaysMs(todayInBusinessTz(new Date()), days);
}

/** Same as businessDay, formatted as the YYYY-MM-DD string used by the API. */
export function businessDayString(days = 0) {
  return formatDateOnly(businessDay(days));
}

function uniqueEmail(prefix) {
  userSequence += 1;
  return `e2e+${prefix}-${Date.now()}-${userSequence}@example.com`;
}

export async function createTrainer(app) {
  const signupRes = await signupVerified(app, {
    method: 'POST',
    url: '/auth/signup',
    payload: { email: uniqueEmail('billing-trainer'), password: PASSWORD },
  });
  const { user, token } = signupRes.json();

  const becomeRes = await app.inject({
    method: 'PATCH',
    url: '/become-trainer',
    headers: { authorization: `Bearer ${token.accessToken}` },
  });
  const { token: trainerToken } = becomeRes.json();
  const trainer = await prisma.trainer.findUnique({ where: { userId: user.id }, select: { id: true } });

  return { userId: user.id, trainerId: trainer.id, accessToken: trainerToken.accessToken };
}

export async function createStudent(app, { firstName } = {}) {
  const signupRes = await signupVerified(app, {
    method: 'POST',
    url: '/auth/signup',
    payload: { email: uniqueEmail('billing-student'), password: PASSWORD },
  });
  const { user, token } = signupRes.json();
  if (firstName) {
    await prisma.user.update({ where: { id: user.id }, data: { firstName, lastName: 'Teste' } });
  }
  return { userId: user.id, accessToken: token.accessToken };
}

export async function linkStudent(trainerId, studentId) {
  return prisma.trainerStudent.create({ data: { trainerId, studentId } });
}

export async function createPlanViaApi(app, accessToken, overrides = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/trainer/subscription-plans',
    headers: { authorization: `Bearer ${accessToken}` },
    payload: {
      name: 'Plano Mensal',
      recurrence: SubscriptionRecurrence.MONTHLY,
      price: 100,
      ...overrides,
    },
  });
  if (res.statusCode !== 201) throw new Error(`plan creation failed: ${res.body}`);
  return res.json();
}

export async function assignPlanViaApi(app, accessToken, studentId, planId, startDate) {
  return app.inject({
    method: 'POST',
    url: `/trainer/students/${studentId}/subscriptions`,
    headers: { authorization: `Bearer ${accessToken}` },
    payload: { planId, startDate },
  });
}

/** Direct-DB plan owned by a trainer row or a nutritionist row (exactly one of the two ids). */
export async function createPlanRow({
  trainerId = null,
  nutritionistId = null,
  serviceType = 'training',
  name = 'Plano Direto',
  recurrence = SubscriptionRecurrence.MONTHLY,
  price = 100,
}) {
  return prisma.subscriptionPlan.create({
    data: { trainerId, nutritionistId, serviceType, name, recurrence, price },
  });
}

/** Direct-DB subscription owned by a trainer row or a nutritionist row (exactly one id), bypassing the assign flow. */
export async function createSubscriptionRow({
  trainerId = null,
  nutritionistId = null,
  serviceType = 'training',
  studentId,
  planId,
  startDate = businessDay(-60),
  status = SubscriptionStatus.ACTIVE,
  recurrence = SubscriptionRecurrence.MONTHLY,
  price = 100,
}) {
  return prisma.studentSubscription.create({
    data: {
      trainerId,
      nutritionistId,
      serviceType,
      studentId,
      planId,
      recurrence,
      price,
      startDate,
      status,
      ...(status === SubscriptionStatus.CANCELLED ? { cancelledAt: new Date() } : {}),
    },
  });
}

/**
 * Direct-DB payment. cycleIndex defaults to the next free index of the
 * subscription ((subscriptionId, cycleIndex) is unique); dates default to a
 * one-month cycle starting on dueDate.
 */
export async function createPaymentRow(subscriptionId, overrides = {}) {
  const cycleIndex =
    overrides.cycleIndex ?? (await prisma.subscriptionPayment.count({ where: { subscriptionId } }));
  const dueDate = overrides.dueDate ?? businessDay(0);
  return prisma.subscriptionPayment.create({
    data: {
      subscriptionId,
      cycleIndex,
      cycleStartDate: overrides.cycleStartDate ?? dueDate,
      cycleEndDate: overrides.cycleEndDate ?? addDaysMs(dueDate, 29),
      dueDate,
      amount: 100,
      status: PaymentStatus.PENDING,
      ...overrides,
    },
  });
}

export function authHeader(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}
