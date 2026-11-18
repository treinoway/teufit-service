/**
 * Professional billing routes — the /trainer billing surface opened to any user with the trainer or
 * nutritionist role, scoped to every row the user owns (trainer + nutritionist).
 */

import { Roles } from '../../src/constants/roles.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { resolveProfessionalOwnerOrThrow } from '../../src/services/professional-owner-service.js';
import { professionalSchemas } from '../schemas/professional-route.schema.js';
import { registerSubscriptionPlanRoutes } from './subscription-plan-route.js';
import { registerStudentSubscriptionRoutes } from './student-subscription-route.js';
import { registerSubscriptionPaymentRoutes } from './subscription-payment-route.js';
import { registerFinanceRoutes } from './trainer-finance-route.js';

// Registers every /professional billing route.
export async function professionalRoutes(fastify) {
  const config = {
    prefix: '/professional',
    preHandler: [authenticate, requireRole([Roles.TRAINER, Roles.NUTRITIONIST])],
    resolveOwner: resolveProfessionalOwnerOrThrow,
    schemas: professionalSchemas,
  };

  registerSubscriptionPlanRoutes(fastify, { ...config, includeKindCounts: true });
  registerStudentSubscriptionRoutes(fastify, config);
  registerSubscriptionPaymentRoutes(fastify, config);
  registerFinanceRoutes(fastify, config);
}
