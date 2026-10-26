import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import { AppError } from '../../src/errors/app-error.js';
import { getTrainerPlan } from '../../src/services/platform-plan-service.js';
import {
  createCheckout,
  cancelAtPeriodEnd,
  changeTier,
} from '../../src/services/asaas-subscription-service.js';
import {
  getPlatformPlanSchema,
  checkoutSchema,
  cancelPlanSchema,
  changePlanSchema,
} from '../schemas/platform-plan-route.schema.js';
import config from '../../config/index.js';
import { getBillingMonth } from '../../src/constants/platform-plan.js';

// Whether the request declares no body at all (explicit zero length, or no length and no chunked encoding).
function hasNoBody(headers) {
  const contentLength = headers['content-length'];
  if (contentLength !== undefined) return contentLength === '0';
  return headers['transfer-encoding'] === undefined;
}

// Drops a JSON content-type sent without a body so the bodiless cancel call is not rejected by the JSON parser.
async function ignoreEmptyJsonContentType(request) {
  // deviation: locked e2e sends content-type json with empty body
  if (hasNoBody(request.headers)) delete request.headers['content-type'];
}

export async function platformPlanRoutes(fastify) {
  // ─── GET /trainer/platform-plan ─────────────────────────────────────────────

  fastify.get(
    '/trainer/platform-plan',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getPlatformPlanSchema,
    },
    async (request, reply) => {
      const trainer = await resolveTrainer(prisma, request.user.id);
      const { tier, status, limits, subscription } = await getTrainerPlan(prisma, trainer.id);

      const billingMonth = getBillingMonth();

      const [activeStudentCount, aiUsageByStudent] = await Promise.all([
        prisma.trainerStudent.count({ where: { trainerId: trainer.id, activeOnPlan: true } }),
        prisma.aiUsageEvent.groupBy({
          by: ['studentId'],
          where: { trainerId: trainer.id, billingMonth },
          _count: { _all: true },
        }),
      ]);

      const totalAiActions = aiUsageByStudent.reduce((sum, row) => sum + row._count._all, 0);

      return reply.send({
        tier,
        status,
        currentPeriodEnd: subscription?.currentPeriodEnd ?? null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        limits: {
          studentCap: limits.studentCap === Infinity ? null : limits.studentCap,
          aiActionsPerStudent: limits.aiActionsPerStudent === Infinity ? null : limits.aiActionsPerStudent,
          aiActionsTrainerCap: limits.aiActionsTrainerCap === Infinity ? null : limits.aiActionsTrainerCap,
          branding: limits.branding,
          championships: limits.championships,
        },
        usage: {
          aiActions: {
            total: totalAiActions,
            cap: limits.aiActionsTrainerCap === Infinity ? null : limits.aiActionsTrainerCap,
            byStudent: aiUsageByStudent.map((row) => ({
              studentId: row.studentId,
              actions: row._count._all,
              cap: limits.aiActionsPerStudent === Infinity ? null : limits.aiActionsPerStudent,
            })),
          },
          students: {
            active: activeStudentCount,
            cap: limits.studentCap === Infinity ? null : limits.studentCap,
          },
        },
      });
    },
  );

  // ─── POST /trainer/platform-plan/checkout ───────────────────────────────────

  fastify.post(
    '/trainer/platform-plan/checkout',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: checkoutSchema,
      config: { rateLimit: config.rateLimit.platformPlan.checkout },
    },
    async (request, reply) => {
      const trainer = await resolveTrainer(prisma, request.user.id);
      const { tier, billingType } = request.body;

      const result = await createCheckout(
        prisma,
        config.asaas,
        fetch,
        { trainerId: trainer.id, tier, billingType },
      );

      return reply.send(result);
    },
  );

  // ─── POST /trainer/platform-plan/cancel ─────────────────────────────────────

  fastify.post(
    '/trainer/platform-plan/cancel',
    {
      onRequest: ignoreEmptyJsonContentType,
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: cancelPlanSchema,
      config: { rateLimit: config.rateLimit.platformPlan.cancel },
    },
    async (request, reply) => {
      const trainer = await resolveTrainer(prisma, request.user.id);

      const result = await cancelAtPeriodEnd(prisma, config.asaas, fetch, trainer.id);

      return reply.send(result);
    },
  );

  // ─── POST /trainer/platform-plan/change ─────────────────────────────────────

  fastify.post(
    '/trainer/platform-plan/change',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: changePlanSchema,
      config: { rateLimit: config.rateLimit.platformPlan.change },
    },
    async (request, reply) => {
      const trainer = await resolveTrainer(prisma, request.user.id);
      const { tier } = request.body;

      const result = await changeTier(prisma, config.asaas, fetch, trainer.id, tier);

      return reply.send(result);
    },
  );
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

async function resolveTrainer(prismaClient, userId) {
  const trainer = await prismaClient.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: 'TRAINER_NOT_FOUND',
      messageCode: 'trainer.notFound',
      message: 'Trainer profile not found.',
    });
  }

  return trainer;
}
