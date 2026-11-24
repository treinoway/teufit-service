import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fastifyJwt from '@fastify/jwt';

vi.mock('../../src/db.js', () => ({ prisma: {} }));
vi.mock('../../src/services/student-invite-response-service.js', () => ({
  listInvitesForStudent: vi.fn(),
  acceptStudentInvite: vi.fn(),
  declineStudentInvite: vi.fn(),
}));
vi.mock('../../src/services/student-invite-service.js', () => ({
  inviteStudent: vi.fn(),
  listStudentInvites: vi.fn(),
  resendStudentInvite: vi.fn(),
  revokeStudentInvite: vi.fn(),
}));
vi.mock('../../src/services/trainer-service.js', () => ({
  patch: vi.fn(),
  getOneByUserId: vi.fn(),
  listStudents: vi.fn(),
  searchStudents: vi.fn(),
  getLinkedStudent: vi.fn(),
  unlinkStudent: vi.fn(),
  listTrainers: vi.fn(),
}));

import config from '../../config/index.js';
import { Roles } from '../../src/constants/roles.js';
import { UserStatus } from '../../src/constants/user-status.js';
import { normalizeErrorResponsePayload } from '../../src/errors/normalize-error.js';
import { inviteStudent } from '../../src/services/student-invite-service.js';
import { myTrainerInviteRoutes } from '../../api/routes/my-trainer-invite-route.js';
import { studentInviteRoutes } from '../../api/routes/student-invite-route.js';
import { trainerRoutes } from '../../api/routes/trainer-route.js';

const JWT_SECRET = 'registration-test-jwt-secret';
const USER_ID = '7d0f2b1c-6f0e-4a55-9f0e-0c1d2e3f4a5b';
const INVITE_ID = '3b1f8a52-4c9e-4d7a-8a55-1f2e3d4c5b6a';
const STUDENT_EMAIL = 'student@example.com';
const UNAUTHORIZED = 401;
const FORBIDDEN = 403;
const LINK_STUDENT_ROUTE = 'POST /trainer/students';
const LIST_STUDENTS_ROUTE = 'GET /trainer/students';
const MY_TRAINER_INVITE_ROUTES = [
  ['GET', '/my/trainer/invites', '/my/trainer/invites'],
  ['POST', '/my/trainer/invites/:id/accept', `/my/trainer/invites/${INVITE_ID}/accept`],
  ['POST', '/my/trainer/invites/:id/decline', `/my/trainer/invites/${INVITE_ID}/decline`],
];
const NON_TRAINER_ROLES = [
  ['no role', []],
  ['the student role', [Roles.STUDENT]],
  ['the nutritionist role', [Roles.NUTRITIONIST]],
];

// Tells whether a declared route is the HEAD twin Fastify adds to every GET route.
function isExposedHeadRoute(route) {
  return route.method === 'HEAD';
}

// Completes the legacy auth refusals into the unified error contract, as the server does.
async function completeErrorPayload(_request, reply, payload) {
  return normalizeErrorResponsePayload(payload, reply.statusCode);
}

// Builds a bare Fastify instance with the given route plugins, recording every route they declare.
async function buildAppWith(...plugins) {
  const app = Fastify({ logger: false });
  const routes = [];
  app.addHook('onRoute', (route) => {
    if (!isExposedHeadRoute(route)) routes.push(route);
  });
  // why: the auth middleware sends { error, message } and the route schemas require messageCode on error bodies.
  app.addHook('preSerialization', completeErrorPayload);
  await app.register(fastifyJwt, { secret: JWT_SECRET });
  for (const plugin of plugins) {
    await app.register(plugin);
  }
  await app.ready();
  return { app, routes };
}

// Lists the declared routes as "METHOD /url" strings.
function signaturesOf(routes) {
  return routes.map((route) => `${route.method} ${route.url}`);
}

// Finds the declared routes matching a "METHOD /url" signature.
function routesMatching(routes, signature) {
  return routes.filter((route) => `${route.method} ${route.url}` === signature);
}

// Builds the Authorization header of a user with the given roles.
function authFor(app, roles) {
  const token = app.jwt.sign({ sub: USER_ID, email: STUDENT_EMAIL, roles, status: UserStatus.ACTIVE });
  return { authorization: `Bearer ${token}` };
}

describe('route registration of the trainer invite plugins', () => {
  let app;
  let routes;

  async function load(...plugins) {
    ({ app, routes } = await buildAppWith(...plugins));
  }

  beforeEach(() => {
    app = null;
    routes = [];
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  describe('api/routes/my-trainer-invite-route.js', () => {
    beforeEach(() => load(myTrainerInviteRoutes));

    it('should register exactly the list, accept and decline routes', () => {
      const expected = MY_TRAINER_INVITE_ROUTES.map(([method, pattern]) => `${method} ${pattern}`);

      expect(signaturesOf(routes).sort()).toEqual(expected.sort());
    });

    it.each(MY_TRAINER_INVITE_ROUTES)('should answer 401 to an unauthenticated %s %s', async (method, _pattern, url) => {
      const res = await app.inject({ method, url });

      expect(res.statusCode).toBe(UNAUTHORIZED);
    });
  });

  describe('api/routes/student-invite-route.js', () => {
    beforeEach(() => load(studentInviteRoutes));

    it('should register POST /trainer/students exactly once', () => {
      expect(routesMatching(routes, LINK_STUDENT_ROUTE)).toHaveLength(1);
    });

    it('should rate limit POST /trainer/students with config.rateLimit.trainer.inviteStudent', () => {
      const [route] = routesMatching(routes, LINK_STUDENT_ROUTE);

      expect(config.rateLimit.trainer.inviteStudent).toEqual(expect.objectContaining({ max: expect.any(Number) }));
      expect(route.config.rateLimit).toBe(config.rateLimit.trainer.inviteStudent);
    });

    it.each(NON_TRAINER_ROLES)('should answer 403 to a user with %s without reaching the service', async (_label, roles) => {
      const res = await app.inject({
        method: 'POST',
        url: '/trainer/students',
        headers: authFor(app, roles),
        payload: { email: STUDENT_EMAIL },
      });

      expect(res.statusCode).toBe(FORBIDDEN);
      expect(inviteStudent).not.toHaveBeenCalled();
    });
  });

  describe('api/routes/trainer-route.js', () => {
    beforeEach(() => load(trainerRoutes));

    it('should no longer register POST /trainer/students', () => {
      expect(routesMatching(routes, LINK_STUDENT_ROUTE)).toHaveLength(0);
    });

    it('should still register GET /trainer/students', () => {
      expect(routesMatching(routes, LIST_STUDENTS_ROUTE)).toHaveLength(1);
    });
  });

  describe('api/routes/trainer-route.js together with api/routes/student-invite-route.js', () => {
    it('should load both plugins with POST /trainer/students declared a single time', async () => {
      await load(trainerRoutes, studentInviteRoutes);

      expect(routesMatching(routes, LINK_STUDENT_ROUTE)).toHaveLength(1);
      expect(routesMatching(routes, LIST_STUDENTS_ROUTE)).toHaveLength(1);
    });
  });
});
