import { Roles } from '../../src/constants/roles.js';
import { prisma } from '../../src/db.js';
import config from '../../config/index.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { attachNutritionist } from '../middleware/nutritionist.js';
import { listPatients, unlinkPatient } from '../../src/services/nutritionist-patient-service.js';
import {
  invitePatient,
  listPatientInvites,
  resendPatientInvite,
  revokePatientInvite,
} from '../../src/services/patient-invite-service.js';
import { getSheet, upsertSheet } from '../../src/services/nutrition-sheet-service.js';
import { getOverview } from '../../src/services/nutrition-overview-service.js';
import { listTrainingActivities } from '../../src/services/nutrition-training-activities-service.js';
import * as schema from '../schemas/nutritionist-patient-route.schema.js';

// Serializes an invite row to the Invite contract.
function serializeInvite(invite) {
  return {
    id: invite.id,
    email: invite.email,
    status: invite.status,
    expiresAt: invite.expiresAt.toISOString(),
    lastSentAt: invite.lastSentAt.toISOString(),
    sendCount: invite.sendCount,
    createdAt: invite.createdAt.toISOString(),
    canResend: invite.canResend,
    resendAvailableAt: invite.resendAvailableAt ? invite.resendAvailableAt.toISOString() : null,
  };
}

// Registers the nutritionist patient, invite, sheet and overview routes.
export async function nutritionistPatientRoutes(fastify) {
  const nutritionistOnly = [authenticate, requireRole(Roles.NUTRITIONIST), attachNutritionist];

  fastify.post(
    '/nutritionist/patient-invites',
    { config: { rateLimit: config.rateLimit.nutritionist.invitePatient }, preHandler: nutritionistOnly, schema: schema.invitePatientSchema },
    async (request, reply) => {
      const result = await invitePatient(prisma, {
        nutritionistId: request.nutritionistId,
        nutritionistUserId: request.user.id,
        email: request.body.email,
      });
      return reply.status(201).send({ outcome: result.outcome, invite: serializeInvite(result.invite) });
    },
  );

  fastify.get(
    '/nutritionist/patient-invites',
    { preHandler: nutritionistOnly, schema: schema.listPatientInvitesSchema },
    async (request) => {
      const { items } = await listPatientInvites(prisma, { nutritionistId: request.nutritionistId, status: request.query.status });
      return { items: items.map(serializeInvite) };
    },
  );

  fastify.post(
    '/nutritionist/patient-invites/:id/resend',
    { config: { rateLimit: config.rateLimit.nutritionist.resendPatientInvite }, preHandler: nutritionistOnly, schema: schema.resendPatientInviteSchema },
    async (request) => {
      const invite = await resendPatientInvite(prisma, {
        nutritionistId: request.nutritionistId,
        nutritionistUserId: request.user.id,
        inviteId: request.params.id,
      });
      return serializeInvite(invite);
    },
  );

  fastify.delete(
    '/nutritionist/patient-invites/:id',
    { preHandler: nutritionistOnly, schema: schema.revokePatientInviteSchema },
    async (request, reply) => {
      await revokePatientInvite(prisma, { nutritionistId: request.nutritionistId, inviteId: request.params.id });
      return reply.status(204).send();
    },
  );

  fastify.get('/nutritionist/patients', { preHandler: nutritionistOnly, schema: schema.listPatientsSchema }, async (request) => ({
    items: await listPatients(prisma, { nutritionistId: request.nutritionistId }),
  }));

  fastify.delete(
    '/nutritionist/patients/:patientId',
    { preHandler: nutritionistOnly, schema: schema.unlinkPatientSchema },
    async (request, reply) => {
      await unlinkPatient(prisma, {
        nutritionistId: request.nutritionistId,
        patientId: request.params.patientId,
        userId: request.user.id,
      });
      return reply.status(204).send();
    },
  );

  fastify.get(
    '/nutritionist/patients/:patientId/sheet',
    { preHandler: nutritionistOnly, schema: schema.getSheetSchema },
    (request) => getSheet(prisma, { nutritionistId: request.nutritionistId, patientId: request.params.patientId }),
  );

  fastify.put(
    '/nutritionist/patients/:patientId/sheet',
    { preHandler: nutritionistOnly, schema: schema.putSheetSchema },
    (request) =>
      upsertSheet(prisma, { nutritionistId: request.nutritionistId, patientId: request.params.patientId, data: request.body }),
  );

  fastify.get(
    '/nutritionist/patients/:patientId/overview',
    { preHandler: nutritionistOnly, schema: schema.getOverviewSchema },
    (request) => getOverview(prisma, { nutritionistId: request.nutritionistId, patientId: request.params.patientId }),
  );

  fastify.get(
    '/nutritionist/patients/:patientId/training-activities',
    { preHandler: nutritionistOnly, schema: schema.trainingActivitiesSchema },
    (request) =>
      listTrainingActivities(prisma, { nutritionistId: request.nutritionistId, patientId: request.params.patientId }),
  );
}
