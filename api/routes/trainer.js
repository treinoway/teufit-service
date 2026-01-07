import { Roles } from '../../src/constants/roles.js';
import { updateMyTrainerProfile } from '../../src/services/trainerService.js';

/**
 * Rest-ish trainer resource routes.
 *
 * Current use:
 * - PATCH /trainer/me: onboarding/profile completion for the authenticated trainer.
 */
export async function trainerRoutes(fastify) {
  fastify.patch('/trainer/me', async (request, reply) => {
    const sessionUser = request.session.get('user');
    if (!sessionUser) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }
    if (sessionUser.role !== Roles.TRAINER) {
      return reply.status(403).send({ error: 'Forbidden' });
    }

    const body = request.body ?? {};
    const { trainer, address, socials } = body;

    try {
      const updated = await updateMyTrainerProfile({
        userId: sessionUser.id,
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
  });
}
