import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import * as service from '../../src/services/nutritionist-patient-service.js';
import * as schema from '../schemas/nutritionist-patient-route.schema.js';

export async function nutritionistPatientRoutes(fastify) {
  // POST /nutritionist/patients — link a patient
  fastify.post(
    '/nutritionist/patients',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.linkPatientSchema,
    },
    async (request, reply) => {
      const link = await service.linkPatient(prisma, request.user.id, request.body.email, request.body);
      return reply.status(201).send(link);
    },
  );

  // GET /nutritionist/patients — list linked patients
  fastify.get(
    '/nutritionist/patients',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.listPatientsSchema,
    },
    async (request, reply) => {
      const patients = await service.listPatients(prisma, request.user.id);
      return reply.send(patients);
    },
  );

  // DELETE /nutritionist/patients/:patientId — unlink a patient
  fastify.delete(
    '/nutritionist/patients/:patientId',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.unlinkPatientSchema,
    },
    async (request, reply) => {
      const result = await service.unlinkPatient(prisma, request.user.id, request.params.patientId);
      return reply.send(result);
    },
  );

  // PUT /nutritionist/patients/:patientId/metabolic-profile — upsert metabolic profile
  fastify.put(
    '/nutritionist/patients/:patientId/metabolic-profile',
    {
      preHandler: [authenticate, requireRole(Roles.NUTRITIONIST)],
      schema: schema.upsertMetabolicProfileSchema,
    },
    async (request, reply) => {
      const profile = await service.upsertMetabolicProfile(
        prisma,
        request.user.id,
        request.params.patientId,
        request.body,
      );
      return reply.send(profile);
    },
  );
}
