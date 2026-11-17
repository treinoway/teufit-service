import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import {
  createChallenge,
  listChallenges,
  getChallenge,
  updateChallenge,
  cancelChallenge,
  deleteChallenge,
  listParticipants,
  addParticipants,
  removeParticipant,
  previewParticipants,
  listStudentChallenges,
  getStudentChallenge,
} from '../../src/services/challenge-service.js';
import {
  getChallengeRankingForTrainer,
  getChallengeRankingForStudent,
} from '../../src/services/challenge-ranking-service.js';
import { getChallengeConsistency } from '../../src/services/challenge-consistency-service.js';
import { requestEarlyClose } from '../../src/services/challenge-close-service.js';
import {
  createChallengeSchema,
  listChallengesSchema,
  getChallengeSchema,
  updateChallengeSchema,
  cancelChallengeSchema,
  deleteChallengeSchema,
  getChallengeRankingSchema,
  listParticipantsSchema,
  addParticipantsSchema,
  removeParticipantSchema,
  previewParticipantsSchema,
  listMyChallengesSchema,
  getMyChallengSchema,
  getMyChallengeRankingSchema,
  closeChallengeSchema,
  getChallengeConsistencySchema,
} from '../schemas/challenge-route.schema.js';

export async function challengeRoutes(fastify) {
  // ─── Trainer: CRUD ────────────────────────────────────────────────────────

  fastify.post(
    '/trainer/challenges',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: createChallengeSchema,
    },
    async (request, reply) => {
      const challenge = await createChallenge({
        prisma,
        trainerUserId: request.user.id,
        data: request.body,
      });
      return reply.status(201).send(challenge);
    },
  );

  fastify.get(
    '/trainer/challenges',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listChallengesSchema,
    },
    async (request, reply) => {
      const challenges = await listChallenges({
        prisma,
        trainerUserId: request.user.id,
        status: request.query.status ?? null,
      });
      return reply.send(challenges);
    },
  );

  fastify.get(
    '/trainer/challenges/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getChallengeSchema,
    },
    async (request, reply) => {
      const challenge = await getChallenge({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send(challenge);
    },
  );

  fastify.patch(
    '/trainer/challenges/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: updateChallengeSchema,
    },
    async (request, reply) => {
      const challenge = await updateChallenge({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
        data: request.body,
      });
      return reply.send(challenge);
    },
  );

  fastify.post(
    '/trainer/challenges/:id/cancel',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: cancelChallengeSchema,
    },
    async (request, reply) => {
      const challenge = await cancelChallenge({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send(challenge);
    },
  );

  fastify.delete(
    '/trainer/challenges/:id',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: deleteChallengeSchema,
    },
    async (request, reply) => {
      await deleteChallenge({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.status(204).send();
    },
  );

  fastify.post(
    '/trainer/challenges/:id/close',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: closeChallengeSchema,
    },
    async (request, reply) => {
      const { closesAt } = await requestEarlyClose(prisma, request.user.id, request.params.id);
      const challenge = await getChallenge({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send({ ...challenge, closesAt });
    },
  );

  fastify.get(
    '/trainer/challenges/:id/consistency',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getChallengeConsistencySchema,
    },
    async (request, reply) => {
      const standings = await getChallengeConsistency(prisma, request.user.id, request.params.id);
      return reply.send(standings);
    },
  );

  // ─── Trainer: ranking + participants ──────────────────────────────────────

  fastify.get(
    '/trainer/challenges/:id/ranking',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: getChallengeRankingSchema,
    },
    async (request, reply) => {
      const ranking = await getChallengeRankingForTrainer({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send(ranking);
    },
  );

  fastify.get(
    '/trainer/challenges/:id/participants',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: listParticipantsSchema,
    },
    async (request, reply) => {
      const participants = await listParticipants({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send(participants);
    },
  );

  fastify.post(
    '/trainer/challenges/:id/participants',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: addParticipantsSchema,
    },
    async (request, reply) => {
      const result = await addParticipants({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
        studentIds: request.body.studentIds,
      });
      return reply.send(result);
    },
  );

  fastify.delete(
    '/trainer/challenges/:id/participants/:studentId',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: removeParticipantSchema,
    },
    async (request, reply) => {
      await removeParticipant({
        prisma,
        trainerUserId: request.user.id,
        challengeId: request.params.id,
        studentId: request.params.studentId,
      });
      return reply.status(204).send();
    },
  );

  // ─── Trainer: preview participants ────────────────────────────────────────

  fastify.post(
    '/trainer/challenges/preview-participants',
    {
      preHandler: [authenticate, requireRole(Roles.TRAINER)],
      schema: previewParticipantsSchema,
    },
    async (request, reply) => {
      const studentIds = await previewParticipants({
        prisma,
        trainerUserId: request.user.id,
        mode: request.body.mode,
        filter: request.body.filter ?? null,
        studentIds: request.body.studentIds ?? null,
      });
      return reply.send({ studentIds, count: studentIds.length });
    },
  );

  // ─── Student: challenges ──────────────────────────────────────────────────

  fastify.get(
    '/my/challenges',
    {
      preHandler: [authenticate],
      schema: listMyChallengesSchema,
    },
    async (request, reply) => {
      const challenges = await listStudentChallenges({
        prisma,
        studentId: request.user.id,
        trainerId: request.query.trainerId ?? null,
        status: request.query.status ?? null,
      });
      return reply.send(challenges);
    },
  );

  fastify.get(
    '/my/challenges/:id',
    {
      preHandler: [authenticate],
      schema: getMyChallengSchema,
    },
    async (request, reply) => {
      const challenge = await getStudentChallenge({
        prisma,
        studentId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send(challenge);
    },
  );

  fastify.get(
    '/my/challenges/:id/ranking',
    {
      preHandler: [authenticate],
      schema: getMyChallengeRankingSchema,
    },
    async (request, reply) => {
      const result = await getChallengeRankingForStudent({
        prisma,
        studentId: request.user.id,
        challengeId: request.params.id,
      });
      return reply.send(result);
    },
  );
}
