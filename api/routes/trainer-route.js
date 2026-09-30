import { Roles } from '../../src/constants/roles.js';
import { patch, getOneByUserId, linkStudentByEmail, listStudents, searchStudents, getLinkedStudent, unlinkStudent, listTrainers } from '../../src/services/trainer-service.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  getTrainerSchema,
  patchTrainerSchema,
  linkStudentSchema,
  listStudentsSchema,
  listTrainersSchema,
  searchStudentsSchema,
  getLinkedStudentSchema,
  unlinkStudentSchema,
} from '../schemas/trainer-route.schema.js';
import { prisma } from '../../src/db.js';
import config from '../../config/index.js';

/**
 * Rest-ish trainer resource routes.
 *
 * Current use:
 * - PATCH /trainer: onboarding/profile completion for the authenticated trainer.
 * - POST /trainer/students: link a student to the trainer by email.
 */
export async function trainerRoutes(fastify) {

  fastify.get(
    '/trainers',
    {
      preHandler: [authenticate],
      schema: listTrainersSchema,
    },
    async (_request, reply) => {
      const trainers = await listTrainers();
      return reply.send(trainers);
    },
  );

  fastify.get(
    '/trainer',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getTrainerSchema,
    },
    async (request, reply) => {
      const profile = await getOneByUserId(request.user.id);
      return reply.send(profile);
    },
  );

  fastify.patch(
    '/trainer',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: patchTrainerSchema,
    },
    async (request, reply) => {

    const body = request.body ?? {};
    const { trainer, address, socials } = body;

    try {
      const updated = await patch({
        userId: request.user.id,
        trainer,
        address,
        socials,
      });

      return reply.send(updated);
    } catch (error) {
      if (error?.code === 'NO_UPDATES') {
        return reply.status(400).send({ error: 'No updates provided' });
      }
      if (error?.code === 'TRAINER_PROFILE_MISSING') {
        return reply.status(409).send({ error: 'Trainer profile missing' });
      }

      fastify.log.error(error);
      return reply.status(500).send({ error: 'Failed to update trainer profile' });
    }
    },
  );

  fastify.get(
    '/trainer/students',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listStudentsSchema,
    },
    async (request, reply) => {
      const trainerRecord = await prisma.trainer.findUnique({
        where: { userId: request.user.id },
        select: { id: true },
      });

      if (!trainerRecord) {
        return reply.status(409).send({
          error: 'TRAINER_PROFILE_MISSING',
          messageCode: 'trainer.profileMissing',
          message: 'Trainer profile not found',
        });
      }

      const students = await listStudents({ trainerId: trainerRecord.id });
      return reply.send(students);
    },
  );

  fastify.get(
    '/trainer/students/search',
    {
      config: { rateLimit: config.rateLimit.trainer.searchStudents },
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: searchStudentsSchema,
    },
    async (request, reply) => {
      const trainerRecord = await prisma.trainer.findUnique({
        where: { userId: request.user.id },
        select: { id: true },
      });

      if (!trainerRecord) {
        return reply.status(409).send({
          error: 'TRAINER_PROFILE_MISSING',
          messageCode: 'trainer.profileMissing',
          message: 'Trainer profile not found',
        });
      }

      const { q, limit } = request.query;
      const students = await searchStudents({
        trainerId: trainerRecord.id,
        query: q,
        limit,
      });

      return reply.send(students);
    },
  );

  fastify.post(
    '/trainer/students',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: linkStudentSchema,
    },
    async (request, reply) => {
      const { email } = request.body;
      const trainerUserId = request.user.id;

      const trainerRecord = await prisma.trainer.findUnique({
        where: { userId: trainerUserId },
        select: { id: true },
      });

      if (!trainerRecord) {
        return reply.status(409).send({
          error: 'TRAINER_PROFILE_MISSING',
          messageCode: 'trainer.profileMissing',
          message: 'Trainer profile not found',
        });
      }

      const student = await linkStudentByEmail({
        trainerId: trainerRecord.id,
        trainerUserId,
        email,
      });

      return reply.status(201).send(student);
    },
  );

  fastify.get(
    '/trainer/students/:studentId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getLinkedStudentSchema,
    },
    async (request, reply) => {
      const student = await getLinkedStudent({
        trainerUserId: request.user.id,
        studentId: request.params.studentId,
      });
      return reply.send(student);
    },
  );

  fastify.delete(
    '/trainer/students/:studentId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: unlinkStudentSchema,
    },
    async (request, reply) => {
      const { studentId } = request.params;
      const trainerUserId = request.user.id;

      const trainerRecord = await prisma.trainer.findUnique({
        where: { userId: trainerUserId },
        select: { id: true },
      });

      if (!trainerRecord) {
        return reply.status(409).send({
          error: 'TRAINER_PROFILE_MISSING',
          messageCode: 'trainer.profileMissing',
          message: 'Trainer profile not found',
        });
      }

      await unlinkStudent({ trainerId: trainerRecord.id, studentId });

      return reply.status(204).send();
    },
  );
}
