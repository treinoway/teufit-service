import 'dotenv/config';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { prisma } from '../../src/db.js';
import { setupApp } from '../helpers/setup-app.js';
import { cleanDatabase } from '../helpers/db-cleanup.js';
import { signupVerified } from '../helpers/signup-user.js';

const hasDatabaseUrl = !!process.env.DATABASE_URL;
const e2eDescribe = hasDatabaseUrl ? describe : describe.skip;

const WEBHOOK_SECRET = 'test-webhook-secret-123';

e2eDescribe('e2e: asaas webhook route', () => {
  let app;

  beforeAll(async () => {
    // ASAAS_WEBHOOK_SECRET is set via vitest.config.js `test.env` (applied before any
    // module import, including config/index.js). Mutating process.env here would be a
    // no-op — config/index.js snapshots it once at import time — so WEBHOOK_SECRET
    // below must match the value configured there.
    app = await setupApp();
  });

  afterAll(async () => {
    if (app) await app.close();
  });

  beforeEach(async () => {
    await cleanDatabase();
  });

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async function createTrainerWithSubscription(tier = 'FREE', overrides = {}) {
    const email = `trainer+webhook+${Date.now()}@example.com`;

    const signupRes = await signupVerified(app, {
      method: 'POST',
      url: '/auth/signup',
      payload: { email, password: 'StrongPassw0rd!' },
    });
    expect(signupRes.statusCode).toBe(201);
    const { user: { id: userId } } = signupRes.json();

    const becomeRes = await app.inject({
      method: 'PATCH',
      url: '/become-trainer',
      headers: { authorization: `Bearer ${signupRes.json().token.accessToken}` },
    });
    expect(becomeRes.statusCode).toBe(200);

    const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
    const trainerId = trainer.id;

    await prisma.platformSubscription.upsert({
      where: { trainerId },
      create: {
        trainerId,
        tier,
        status: 'ACTIVE',
        asaasSubscriptionId: 'sub_webhook_test',
        asaasCustomerId: 'cust_webhook_test',
        ...overrides,
      },
      update: {
        tier,
        status: 'ACTIVE',
        asaasSubscriptionId: 'sub_webhook_test',
        asaasCustomerId: 'cust_webhook_test',
        ...overrides,
      },
    });

    return { userId, trainerId };
  }

  /**
   * Links `count` students to the trainer with strictly increasing createdAt
   * (index 0 = oldest). `blockedFrom` marks every link from that index on as
   * blocked by the seat quota (activeOnPlan=false).
   */
  async function linkStudents(trainerId, count, { blockedFrom = count } = {}) {
    const studentIds = [];
    for (let i = 0; i < count; i++) {
      const student = await prisma.user.create({
        data: { email: `student+cap+${i}+${Date.now()}@example.com`, roles: ['STUDENT'] },
      });
      await prisma.trainerStudent.create({
        data: {
          trainerId,
          studentId: student.id,
          activeOnPlan: i < blockedFrom,
          createdAt: new Date(Date.UTC(2026, 0, 1 + i)),
        },
      });
      studentIds.push(student.id);
    }
    return studentIds;
  }

  async function activeOnPlanByStudent(trainerId, studentIds) {
    const links = await prisma.trainerStudent.findMany({
      where: { trainerId },
      select: { studentId: true, activeOnPlan: true },
    });
    const byId = Object.fromEntries(links.map((l) => [l.studentId, l.activeOnPlan]));
    return studentIds.map((id) => byId[id]);
  }

  function webhookHeaders() {
    return {
      'content-type': 'application/json',
      'asaas-access-token': WEBHOOK_SECRET,
    };
  }

  async function sendWebhook(payload) {
    return app.inject({
      method: 'POST',
      url: '/webhooks/asaas',
      headers: webhookHeaders(),
      payload,
    });
  }

  // ─── Auth validation ───────────────────────────────────────────────────────

  describe('webhook secret validation', () => {
    it('returns 401 with wrong webhook secret', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/asaas',
        headers: {
          'content-type': 'application/json',
          'asaas-access-token': 'wrong-secret',
        },
        payload: { event: 'PAYMENT_CONFIRMED' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: 'UNAUTHORIZED',
        messageCode: 'webhook.invalidSecret',
      });
    });

    it('returns 401 with missing webhook secret header', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/asaas',
        headers: { 'content-type': 'application/json' },
        payload: { event: 'PAYMENT_CONFIRMED' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({
        error: 'UNAUTHORIZED',
        messageCode: 'webhook.invalidSecret',
      });
    });

    it('returns 200 with correct secret', async () => {
      const res = await sendWebhook({ event: 'SUBSCRIPTION_CREATED', subscription: { id: 'sub_test' } });
      expect(res.statusCode).toBe(200);
      expect(res.json().received).toBe(true);
    });
  });

  // ─── Exploit regression ────────────────────────────────────────────────────
  //
  // The original bug: the route processed the webhook body (and mutated the DB)
  // before validating the secret, so a 401 response did not guarantee the forged
  // event was ignored. Asserting statusCode === 401 alone does not prove this —
  // it would still pass even if the handler ran first and rejected afterwards.
  // This test asserts on DB state directly to prove the forged event never reached
  // handleWebhookEvent.

  describe('exploit regression: forged tier upgrade must not mutate state', () => {
    it('does not upgrade tier or record a payment when the webhook secret is missing/wrong', async () => {
      const { trainerId } = await createTrainerWithSubscription('FREE');

      const forgedPayload = {
        event: 'PAYMENT_CONFIRMED',
        payment: {
          id: 'pay_exploit_attempt_001',
          subscription: 'sub_webhook_test',
          value: 49.90,
          dueDate: '2026-05-16',
          billingType: 'PIX',
          externalReference: `tier:DIAMOND:trainer:${trainerId}`,
          status: 'CONFIRMED',
        },
      };

      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/asaas',
        headers: {
          'content-type': 'application/json',
          'asaas-access-token': 'forged-token',
        },
        payload: forgedPayload,
      });

      expect(res.statusCode).toBe(401);

      const sub = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(sub.tier).toBe('FREE');

      const payment = await prisma.platformSubscriptionPayment.findUnique({
        where: { asaasPaymentId: 'pay_exploit_attempt_001' },
      });
      expect(payment).toBeNull();
    });
  });

  // ─── Body validation ───────────────────────────────────────────────────────

  describe('body validation', () => {
    it('returns 400 when event field is missing', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/webhooks/asaas',
        headers: webhookHeaders(),
        payload: { payment: { id: 'pay-1' } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ─── PAYMENT_CONFIRMED ─────────────────────────────────────────────────────

  describe('PAYMENT_CONFIRMED', () => {
    it('flips tier to PRO and sets status=ACTIVE', async () => {
      const { trainerId } = await createTrainerWithSubscription('FREE');

      const res = await sendWebhook({
        event: 'PAYMENT_CONFIRMED',
        payment: {
          id: 'pay_confirmed_001',
          subscription: 'sub_webhook_test',
          value: 49.90,
          dueDate: '2026-05-16',
          billingType: 'PIX',
          externalReference: `tier:PRO:trainer:${trainerId}`,
          status: 'CONFIRMED',
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().received).toBe(true);

      const sub = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(sub.tier).toBe('PRO');
      expect(sub.status).toBe('ACTIVE');
      expect(sub.pastDueSince).toBeNull();

      const payment = await prisma.platformSubscriptionPayment.findUnique({
        where: { asaasPaymentId: 'pay_confirmed_001' },
      });
      expect(payment).not.toBeNull();
      expect(payment.status).toBe('CONFIRMED');
    });

    it('unblocks students blocked by the FREE cap when the payment upgrades the tier', async () => {
      const { trainerId } = await createTrainerWithSubscription('FREE');
      // FREE cap is 3: the two newest links were blocked by the quota.
      const studentIds = await linkStudents(trainerId, 5, { blockedFrom: 3 });

      const res = await sendWebhook({
        event: 'PAYMENT_CONFIRMED',
        payment: {
          id: 'pay_unblock_001',
          subscription: 'sub_webhook_test',
          value: 299.90,
          dueDate: '2026-05-16',
          billingType: 'PIX',
          externalReference: `tier:DIAMOND:trainer:${trainerId}`,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(await activeOnPlanByStudent(trainerId, studentIds)).toEqual([true, true, true, true, true]);
    });

    it('is idempotent — processing same PAYMENT_CONFIRMED twice does not cause errors', async () => {
      const { trainerId } = await createTrainerWithSubscription('FREE');

      const payload = {
        event: 'PAYMENT_CONFIRMED',
        payment: {
          id: 'pay_idem_001',
          subscription: 'sub_webhook_test',
          value: 49.90,
          dueDate: '2026-05-16',
          billingType: 'PIX',
          externalReference: `tier:PRO:trainer:${trainerId}`,
        },
      };

      const res1 = await sendWebhook(payload);
      const res2 = await sendWebhook(payload);

      expect(res1.statusCode).toBe(200);
      expect(res2.statusCode).toBe(200);

      // Tier should be PRO — not changed by second call
      const sub = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(sub.tier).toBe('PRO');
    });
  });

  // ─── PAYMENT_OVERDUE ───────────────────────────────────────────────────────

  describe('PAYMENT_OVERDUE', () => {
    it('sets subscription status=PAST_DUE', async () => {
      const { trainerId } = await createTrainerWithSubscription('PRO');

      const res = await sendWebhook({
        event: 'PAYMENT_OVERDUE',
        payment: {
          id: 'pay_overdue_001',
          subscription: 'sub_webhook_test',
          value: 49.90,
          dueDate: '2026-05-01',
          billingType: 'PIX',
        },
      });

      expect(res.statusCode).toBe(200);

      const sub = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(sub.status).toBe('PAST_DUE');
      expect(sub.pastDueSince).not.toBeNull();
    });

    it('does not immediately downgrade tier — grace period applies', async () => {
      const { trainerId } = await createTrainerWithSubscription('PRO');

      await sendWebhook({
        event: 'PAYMENT_OVERDUE',
        payment: {
          id: 'pay_overdue_002',
          subscription: 'sub_webhook_test',
          value: 49.90,
          dueDate: '2026-05-01',
          billingType: 'PIX',
        },
      });

      const sub = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      // tier stays PRO during grace period
      expect(sub.tier).toBe('PRO');
    });
  });

  // ─── SUBSCRIPTION_DELETED ──────────────────────────────────────────────────

  describe('SUBSCRIPTION_DELETED', () => {
    it('downgrades to FREE and sets status=CANCELED', async () => {
      const { trainerId } = await createTrainerWithSubscription('PLATINUM');

      const res = await sendWebhook({
        event: 'SUBSCRIPTION_DELETED',
        subscription: {
          id: 'sub_webhook_test',
          status: 'INACTIVE',
        },
      });

      expect(res.statusCode).toBe(200);

      const sub = await prisma.platformSubscription.findUnique({ where: { trainerId } });
      expect(sub.tier).toBe('FREE');
      expect(sub.status).toBe('CANCELED');
      expect(sub.asaasSubscriptionId).toBeNull();
    });

    it('blocks the newest students above the FREE cap and keeps the oldest active', async () => {
      const { trainerId } = await createTrainerWithSubscription('PLATINUM');
      const studentIds = await linkStudents(trainerId, 5);

      const res = await sendWebhook({
        event: 'SUBSCRIPTION_DELETED',
        subscription: { id: 'sub_webhook_test', status: 'INACTIVE' },
      });

      expect(res.statusCode).toBe(200);
      // FREE cap is 3 → the 2 newest links get blocked.
      expect(await activeOnPlanByStudent(trainerId, studentIds)).toEqual([true, true, true, false, false]);
    });
  });

  // ─── Unknown events ────────────────────────────────────────────────────────

  describe('Unknown event type', () => {
    it('returns 200 and does not throw for unknown event', async () => {
      const res = await sendWebhook({
        event: 'SOME_FUTURE_ASAAS_EVENT',
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().received).toBe(true);
    });
  });

  // ─── Internal error resilience ─────────────────────────────────────────────

  describe('Error resilience', () => {
    it('returns 200 even for events with missing subscription reference', async () => {
      // payment references a subscription not in our DB — should not throw
      const res = await sendWebhook({
        event: 'PAYMENT_CONFIRMED',
        payment: {
          id: 'pay_orphan_001',
          subscription: 'sub_not_in_db',
          value: 49.90,
          dueDate: '2026-05-16',
          billingType: 'PIX',
        },
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
