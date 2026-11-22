import { prisma } from '../../src/db.js';
import { authenticate } from '../middleware/auth.js';
import {
  listInvitesForStudent,
  acceptStudentInvite,
  declineStudentInvite,
} from '../../src/services/student-invite-response-service.js';
import * as schema from '../schemas/my-trainer-invite-route.schema.js';

// Registers the student-app routes to answer trainer invites (any authenticated user).
export async function myTrainerInviteRoutes(fastify) {
  const preHandler = [authenticate];

  fastify.get('/my/trainer/invites', { preHandler, schema: schema.listMyTrainerInvitesSchema }, (request) =>
    listInvitesForStudent(prisma, { studentId: request.user.id }));

  fastify.post('/my/trainer/invites/:id/accept', { preHandler, schema: schema.acceptMyTrainerInviteSchema }, (request) =>
    acceptStudentInvite(prisma, { studentId: request.user.id, inviteId: request.params.id }));

  fastify.post('/my/trainer/invites/:id/decline', { preHandler, schema: schema.declineMyTrainerInviteSchema }, (request) =>
    declineStudentInvite(prisma, { studentId: request.user.id, inviteId: request.params.id }));
}
