import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import {
  assertCanCreateInvite,
  createInvite,
  listInvites,
  revokeInvite,
  redeemInvite,
  getInvitePreview,
} from '../../src/services/trainer-invite-service.js';
import { getUserProfileById } from '../../src/services/user-service.js';
import { issueAccessToken, issueRefreshToken } from '../../src/services/token-service.js';
import * as schema from '../schemas/trainer-invite-route.schema.js';
import config from '../../config/index.js';

function serializeInvite(invite) {
  return {
    id: invite.id,
    email: invite.email,
    status: invite.status,
    invitedByUserId: invite.invitedByUserId,
    userId: invite.userId,
    expiresAt: invite.expiresAt.toISOString(),
    acceptedAt: invite.acceptedAt ? invite.acceptedAt.toISOString() : null,
    revokedAt: invite.revokedAt ? invite.revokedAt.toISOString() : null,
    createdAt: invite.createdAt.toISOString(),
  };
}

/**
 * Public, unauthenticated invite routes. Registered separately from
 * `trainerInviteRoutes` (below) because that plugin is mounted inside
 * server.js's protected block, which adds an `onRequest` authenticate hook
 * to every route registered under it — a hook that cannot be opted out of
 * per-route. `/invite/preview` must stay reachable pre-signup, so it lives
 * in its own plugin registered in the public section of server.js instead.
 */
export async function trainerInvitePreviewRoutes(fastify) {
  fastify.get(
    '/invite/preview',
    {
      config: {
        rateLimit: config.rateLimit.invite.preview,
      },
      schema: schema.previewInviteSchema,
    },
    async (request, reply) => {
      const preview = await getInvitePreview({ code: request.query.code });

      return reply.send({
        email: preview.email,
        invitedByName: preview.invitedByName,
        expiresAt: preview.expiresAt.toISOString(),
        accountExists: preview.accountExists,
      });
    },
  );
}

export async function trainerInviteRoutes(fastify) {
  fastify.post(
    '/admin/trainer-invites',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.createInviteSchema,
    },
    async (request, reply) => {
      assertCanCreateInvite(request.user);

      const { invite, code } = await createInvite({
        actingUserId: request.user.id,
        email: request.body.email,
      });

      return reply.status(201).send({
        invite: {
          id: invite.id,
          email: invite.email,
          status: invite.status,
          expiresAt: invite.expiresAt.toISOString(),
        },
        code,
      });
    },
  );

  fastify.get(
    '/admin/trainer-invites',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.listInvitesSchema,
    },
    async (request, reply) => {
      const { status, email, page, pageSize } = request.query;
      const result = await listInvites({ status, email, page, pageSize });

      return reply.send({
        items: result.items.map(serializeInvite),
        total: result.total,
        page: result.page,
        pageSize: result.pageSize,
      });
    },
  );

  fastify.post(
    '/admin/trainer-invites/:id/revoke',
    {
      preHandler: [authenticate, requireRole(Roles.ADMIN)],
      schema: schema.revokeInviteSchema,
    },
    async (request, reply) => {
      const { invite } = await revokeInvite({ inviteId: request.params.id });
      return reply.send({ invite: serializeInvite(invite) });
    },
  );

  fastify.post(
    '/invite/redeem',
    {
      config: {
        rateLimit: config.rateLimit.user.redeemInvite,
      },
      preHandler: [authenticate],
      schema: schema.redeemInviteSchema,
    },
    async (request, reply) => {
      const userId = request.user.id;

      const { preferences } = await redeemInvite({ user: request.user, code: request.body.code });

      // Re-issue tokens exactly like /become-trainer so the new access token
      // carries the freshly granted trainer role.
      const updatedUser = await getUserProfileById(userId);
      const access = issueAccessToken({ fastify, user: updatedUser });
      const refresh = await issueRefreshToken({ user: updatedUser });

      return reply.send({
        betaAccess: updatedUser.betaAccess,
        activeProfile: preferences.activeProfile,
        token: { accessToken: access.accessToken },
        refreshToken: refresh.refreshToken,
      });
    },
  );
}
