/**
 * Consistency Ranking Routes (student)
 *
 * GET /my/consistency-ranking          - live week, highlighted championship, "+N" and the privacy choice
 * PUT /my/consistency-ranking/privacy  - how the student appears to the other participants
 *
 * Auth: authenticate; every read is scoped to the authenticated student
 */

import { authenticate } from '../middleware/auth.js';
import { prisma } from '../../src/db.js';
import { setPrivacy } from '../../src/services/consistency-privacy-service.js';
import { getStudentOverview } from '../../src/services/consistency-student-overview-service.js';
import {
  getMyConsistencyOverviewSchema,
  putMyConsistencyPrivacySchema,
} from '../schemas/my-consistency-ranking-route.schema.js';

// Registers the student consistency ranking routes
export async function myConsistencyRankingRoutes(fastify) {
  fastify.get(
    '/my/consistency-ranking',
    { preHandler: [authenticate], schema: getMyConsistencyOverviewSchema },
    async (request, reply) => reply.send(await getStudentOverview(prisma, request.user.id)),
  );

  fastify.put(
    '/my/consistency-ranking/privacy',
    { preHandler: [authenticate], schema: putMyConsistencyPrivacySchema },
    async (request, reply) => {
      const { appearAs, termVersion } = request.body;
      return reply.send(await setPrivacy(prisma, request.user.id, appearAs, termVersion));
    },
  );
}
