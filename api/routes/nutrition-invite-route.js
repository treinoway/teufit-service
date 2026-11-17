import { prisma } from '../../src/db.js';
import { authenticate } from '../middleware/auth.js';
import {
  listInvitesForPatient,
  acceptPatientInvite,
  declinePatientInvite,
} from '../../src/services/patient-invite-response-service.js';
import * as schema from '../schemas/nutrition-invite-route.schema.js';

// Registers the patient-app routes to answer nutritionist invites (any authenticated user).
export async function nutritionInviteRoutes(fastify) {
  const preHandler = [authenticate];

  fastify.get('/my/nutrition/invites', { preHandler, schema: schema.listMyInvitesSchema }, (request) =>
    listInvitesForPatient(prisma, { patientId: request.user.id }));

  fastify.post('/my/nutrition/invites/:id/accept', { preHandler, schema: schema.acceptMyInviteSchema }, (request) =>
    acceptPatientInvite(prisma, { patientId: request.user.id, inviteId: request.params.id }));

  fastify.post('/my/nutrition/invites/:id/decline', { preHandler, schema: schema.declineMyInviteSchema }, (request) =>
    declinePatientInvite(prisma, { patientId: request.user.id, inviteId: request.params.id }));
}
