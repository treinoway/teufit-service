import config from '../../config/index.js';
import { authenticate, requireAdmin } from '../middleware/auth.js';
import {
  getProtocolDetail,
  getSessionDetail,
  getUserOverview,
  listUserProtocols,
  listUserSessions,
  listUserStudents,
  listUserTemplates,
  listUserTrainers,
  listUsers,
} from '../../src/services/admin-manager-service.js';
import * as schema from '../schemas/admin-manager-route.schema.js';

const ADMIN_MANAGER_RATE_LIMIT_GROUP = 'admin-manager';

// Builds the route options shared by every manager route.
function managerRouteOptions(routeSchema) {
  return {
    preHandler: [authenticate, requireAdmin()],
    schema: routeSchema,
    config: { rateLimit: { ...config.rateLimit.adminManager, groupId: ADMIN_MANAGER_RATE_LIMIT_GROUP } },
  };
}

// Registers the admin-only, read-only manager (backoffice) routes on the isolated admin client.
export async function adminManagerRoutes(fastify) {
  fastify.get('/admin/manager/users', managerRouteOptions(schema.listUsersSchema), async (request, reply) => {
    const { search, kind, page, pageSize } = request.query;
    return reply.send(await listUsers(fastify.adminDb, { search, kind, page, pageSize }));
  });

  fastify.get('/admin/manager/users/:userId', managerRouteOptions(schema.getUserOverviewSchema), async (request, reply) => {
    return reply.send(await getUserOverview(fastify.adminDb, { userId: request.params.userId }));
  });

  fastify.get('/admin/manager/users/:userId/students', managerRouteOptions(schema.listUserStudentsSchema), async (request, reply) => {
    const { page, pageSize } = request.query;
    return reply.send(await listUserStudents(fastify.adminDb, { userId: request.params.userId, page, pageSize }));
  });

  fastify.get('/admin/manager/users/:userId/trainers', managerRouteOptions(schema.listUserTrainersSchema), async (request, reply) => {
    const { page, pageSize } = request.query;
    return reply.send(await listUserTrainers(fastify.adminDb, { userId: request.params.userId, page, pageSize }));
  });

  fastify.get('/admin/manager/users/:userId/protocols', managerRouteOptions(schema.listUserProtocolsSchema), async (request, reply) => {
    const { as, page, pageSize } = request.query;
    return reply.send(await listUserProtocols(fastify.adminDb, { userId: request.params.userId, as, page, pageSize }));
  });

  fastify.get('/admin/manager/protocols/:protocolId', managerRouteOptions(schema.getProtocolDetailSchema), async (request, reply) => {
    return reply.send(await getProtocolDetail(fastify.adminDb, { protocolId: request.params.protocolId }));
  });

  fastify.get('/admin/manager/users/:userId/templates', managerRouteOptions(schema.listUserTemplatesSchema), async (request, reply) => {
    const { type, page, pageSize } = request.query;
    return reply.send(await listUserTemplates(fastify.adminDb, { userId: request.params.userId, type, page, pageSize }));
  });

  fastify.get('/admin/manager/users/:userId/sessions', managerRouteOptions(schema.listUserSessionsSchema), async (request, reply) => {
    const { page, pageSize } = request.query;
    return reply.send(await listUserSessions(fastify.adminDb, { userId: request.params.userId, page, pageSize }));
  });

  fastify.get('/admin/manager/sessions/:sessionId', managerRouteOptions(schema.getSessionDetailSchema), async (request, reply) => {
    return reply.send(await getSessionDetail(fastify.adminDb, { sessionId: request.params.sessionId }));
  });
}
