import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import { AppError } from '../../src/errors/app-error.js';
import {
  upsertConfigByUserId,
  getConfigByUserId,
} from '../../src/services/gamification-config-service.js';
import {
  awardManualBonus,
  getStudentPointHistory,
  getStudentPointSummary,
} from '../../src/services/gamification-service.js';
import {
  GamificationErrorCode,
  GamificationMessageCode,
} from '../../src/constants/gamification.js';
import {
  upsertConfigSchema,
  getConfigSchema,
  getStudentPointHistorySchema,
  getMyPointHistorySchema,
  getMyPointSummarySchema,
  awardBonusSchema,
  getTrainerRankingGoneSchema,
  getMyRankingGoneSchema,
} from '../schemas/gamification-route.schema.js';

export async function gamificationRoutes(fastify) {
  // ─── Trainer: config ──────────────────────────────────────────────────────

  fastify.put(
    '/trainer/gamification/config',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: upsertConfigSchema,
    },
    async (request, reply) => {
      const config = await upsertConfigByUserId({
        prisma,
        userId: request.user.id,
        data: request.body,
      });
      return reply.send(config);
    },
  );

  fastify.get(
    '/trainer/gamification/config',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getConfigSchema,
    },
    async (request, reply) => {
      const config = await getConfigByUserId({ prisma, userId: request.user.id });
      return reply.send(config);
    },
  );

  // ─── Trainer: student point history (scoped to challengeId) ──────────────

  fastify.get(
    '/trainer/students/:studentId/points',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getStudentPointHistorySchema,
    },
    async (request, reply) => {
      const trainer = await prisma.trainer.findUnique({
        where: { userId: request.user.id },
        select: { id: true },
      });

      if (!trainer) {
        throw new AppError({
          httpStatus: 404,
          error: GamificationErrorCode.TRAINER_PROFILE_MISSING,
          messageCode: GamificationMessageCode.TRAINER_PROFILE_MISSING,
          message: 'Trainer profile not found',
        });
      }

      // Verify the challenge belongs to this trainer and the student is a participant
      const challenge = await prisma.challenge.findUnique({
        where: { id: request.query.challengeId },
        select: { trainerId: true },
      });

      if (!challenge || challenge.trainerId !== trainer.id) {
        throw new AppError({
          httpStatus: 404,
          error: 'CHALLENGE_NOT_FOUND',
          messageCode: 'challenge.notFound',
          message: 'Challenge not found',
        });
      }

      const participant = await prisma.challengeParticipant.findUnique({
        where: {
          challengeId_studentId: {
            challengeId: request.query.challengeId,
            studentId: request.params.studentId,
          },
        },
      });

      if (!participant) {
        throw new AppError({
          httpStatus: 404,
          error: GamificationErrorCode.STUDENT_NOT_TRAINEE,
          messageCode: GamificationMessageCode.STUDENT_NOT_TRAINEE,
          message: 'Student is not a participant in this challenge',
        });
      }

      const result = await getStudentPointHistory({
        prisma,
        studentId: request.params.studentId,
        challengeId: request.query.challengeId,
        page: request.query.page,
        limit: request.query.limit,
      });

      return reply.send(result);
    },
  );

  // ─── Trainer: manual bonus (scoped to challengeId) ────────────────────────

  fastify.post(
    '/trainer/challenges/:challengeId/students/:studentId/bonus',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: awardBonusSchema,
    },
    async (request, reply) => {
      const transaction = await awardManualBonus({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.challengeId,
        studentId: request.params.studentId,
        points: request.body.points,
        reason: request.body.reason ?? null,
      });

      return reply.status(201).send(transaction);
    },
  );

  // ─── Deprecated: global ranking endpoints (410 Gone) ─────────────────────

  fastify.get(
    '/trainer/ranking',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getTrainerRankingGoneSchema,
    },
    async (request, reply) => {
      return reply.status(410).send({
        error: GamificationErrorCode.GLOBAL_RANKING_REMOVED,
        messageCode: GamificationMessageCode.GLOBAL_RANKING_REMOVED,
        message: 'The global trainer ranking has been removed. Use challenge rankings instead.',
        details: {},
      });
    },
  );

  fastify.get(
    '/my/ranking',
    {
      preHandler: [authenticate],
      schema: getMyRankingGoneSchema,
    },
    async (request, reply) => {
      return reply.status(410).send({
        error: GamificationErrorCode.GLOBAL_RANKING_REMOVED,
        messageCode: GamificationMessageCode.GLOBAL_RANKING_REMOVED,
        message: 'The global ranking has been removed. Use challenge rankings instead.',
        details: {},
      });
    },
  );

  // ─── Student: own point history (scoped to challengeId) ───────────────────

  fastify.get(
    '/my/points',
    {
      preHandler: [authenticate],
      schema: getMyPointHistorySchema,
    },
    async (request, reply) => {
      // Verify the student is a participant in this challenge
      const participant = await prisma.challengeParticipant.findUnique({
        where: {
          challengeId_studentId: {
            challengeId: request.query.challengeId,
            studentId: request.user.id,
          },
        },
      });

      if (!participant) {
        throw new AppError({
          httpStatus: 404,
          error: GamificationErrorCode.STUDENT_NOT_TRAINEE,
          messageCode: GamificationMessageCode.STUDENT_NOT_TRAINEE,
          message: 'You are not a participant in this challenge',
        });
      }

      const result = await getStudentPointHistory({
        prisma,
        studentId: request.user.id,
        challengeId: request.query.challengeId,
        page: request.query.page,
        limit: request.query.limit,
      });

      return reply.send(result);
    },
  );

  fastify.get(
    '/my/points/summary',
    {
      preHandler: [authenticate],
      schema: getMyPointSummarySchema,
    },
    async (request, reply) => {
      // Verify the student is a participant in this challenge
      const participant = await prisma.challengeParticipant.findUnique({
        where: {
          challengeId_studentId: {
            challengeId: request.query.challengeId,
            studentId: request.user.id,
          },
        },
      });

      if (!participant) {
        throw new AppError({
          httpStatus: 404,
          error: GamificationErrorCode.STUDENT_NOT_TRAINEE,
          messageCode: GamificationMessageCode.STUDENT_NOT_TRAINEE,
          message: 'You are not a participant in this challenge',
        });
      }

      const summary = await getStudentPointSummary({
        prisma,
        studentId: request.user.id,
        challengeId: request.query.challengeId,
      });

      return reply.send(summary);
    },
  );
}
