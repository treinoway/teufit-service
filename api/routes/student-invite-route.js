import { Roles } from '../../src/constants/roles.js';
import { StudentInviteOutcome, StudentInviteErrorCode, StudentInviteMessageCode } from '../../src/constants/student-invite.js';
import { ConflictAppError } from '../../src/errors/app-error.js';
import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  inviteStudent,
  listStudentInvites,
  resendStudentInvite,
  revokeStudentInvite,
} from '../../src/services/student-invite-service.js';
import * as schema from '../schemas/student-invite-route.schema.js';

function serializeInvite(invite) {
  return {
    id: invite.id,
    email: invite.email,
    status: invite.status,
    studentId: invite.studentId,
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
    revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null,
    lastSentAt: invite.lastSentAt.toISOString(),
    sendCount: invite.sendCount,
    createdAt: invite.createdAt.toISOString(),
    canResend: invite.canResend,
    resendAvailableAt: invite.resendAvailableAt ? invite.resendAvailableAt.toISOString() : null,
  };
}

async function requireTrainerId(userId) {
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw new ConflictAppError({
      error: StudentInviteErrorCode.TRAINER_PROFILE_MISSING,
      messageCode: StudentInviteMessageCode.TRAINER_PROFILE_MISSING,
      message: 'Trainer profile not found',
    });
  }
  return trainer.id;
}

export async function studentInviteRoutes(fastify) {
  const trainerOnly = [authenticate, requireRole(Roles.TRAINER)];

  fastify.post(
    '/trainer/student-invites',
    {
      config: { rateLimit: config.rateLimit.trainer.inviteStudent },
      preHandler: trainerOnly,
      schema: schema.inviteStudentSchema,
    },
    async (request, reply) => {
      const trainerUserId = request.user.id;
      const trainerId = await requireTrainerId(trainerUserId);

      const result = await inviteStudent(prisma, { trainerId, trainerUserId, email: request.body.email });

      if (result.outcome === StudentInviteOutcome.LINKED) {
        return reply.status(201).send({ outcome: result.outcome, student: result.student });
      }
      return reply.status(201).send({ outcome: result.outcome, invite: serializeInvite(result.invite) });
    },
  );

  fastify.get(
    '/trainer/student-invites',
    {
      preHandler: trainerOnly,
      schema: schema.listStudentInvitesSchema,
    },
    async (request, reply) => {
      const trainerId = await requireTrainerId(request.user.id);
      const { status, page, pageSize } = request.query;

      const result = await listStudentInvites(prisma, { trainerId, status, page, pageSize });

      return reply.send({
        items: result.items.map(serializeInvite),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
    },
  );

  fastify.post(
    '/trainer/student-invites/:id/resend',
    {
      config: { rateLimit: config.rateLimit.trainer.resendStudentInvite },
      preHandler: trainerOnly,
      schema: schema.resendStudentInviteSchema,
    },
    async (request, reply) => {
      const trainerUserId = request.user.id;
      const trainerId = await requireTrainerId(trainerUserId);

      const invite = await resendStudentInvite(prisma, {
        trainerId,
        trainerUserId,
        inviteId: request.params.id,
      });

      return reply.send({ invite: serializeInvite(invite) });
    },
  );

  fastify.delete(
    '/trainer/student-invites/:id',
    {
      preHandler: trainerOnly,
      schema: schema.revokeStudentInviteSchema,
    },
    async (request, reply) => {
      const trainerId = await requireTrainerId(request.user.id);

      const invite = await revokeStudentInvite(prisma, { trainerId, inviteId: request.params.id });

      return reply.send({ invite: serializeInvite(invite) });
    },
  );
}
