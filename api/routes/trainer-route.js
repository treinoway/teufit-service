import { Roles } from '../../src/constants/roles.js';
import { patch } from '../../src/services/trainer-service.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { patchTrainerSchema } from '../schemas/trainer-route.schema.js';

/**
 * Rest-ish trainer resource routes.
 *
 * Current use:
 * - PATCH /trainer: onboarding/profile completion for the authenticated trainer.
 */
export async function trainerRoutes(fastify) {

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
}
