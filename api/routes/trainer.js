import { Roles } from '../../src/constants/roles.js';
import { patch, getOneByUserId } from '../../src/services/trainerService.js';
import { authenticate, requireRole } from '../middleware/auth.js';

/**
 * Rest-ish trainer resource routes.
 *
 * Current use:
 * - PATCH /trainer: onboarding/profile completion for the authenticated trainer.
 */
export async function trainerRoutes(fastify) {

      // Get current user
  fastify.get('/me',  { preHandler: [authenticate, requireRole(Roles.TRAINER)] }, async (request, reply) => {
    const user = request.session.get('user');
    
    if (!user) {
      return reply.status(401).send({ error: 'Not authenticated' });
    }

    const trainer = await getOneByUserId(user.id);
    return reply.send(trainer);
  });

  fastify.patch('/trainer/', { preHandler: [authenticate, requireRole(Roles.TRAINER)] }, async (request, reply) => {

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
  });
}
