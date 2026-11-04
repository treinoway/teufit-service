import { prisma } from '../../src/db.js';
import { authenticate } from '../middleware/auth.js';
import * as service from '../../src/services/nutrition-today-service.js';
import * as schema from '../schemas/nutrition-today-route.schema.js';

// Registers the patient-app nutrition routes (any authenticated user).
export async function nutritionTodayRoutes(fastify) {
  const preHandler = [authenticate];

  fastify.get('/my/nutrition/today', { preHandler, schema: schema.getTodaySchema }, (request) =>
    service.getToday(prisma, { patientId: request.user.id, date: request.query.date }));

  fastify.put('/my/nutrition/days/:date/meals/:mealId', { preHandler, schema: schema.putMealSchema }, (request) =>
    service.setMealLog(prisma, {
      patientId: request.user.id,
      date: request.params.date,
      mealId: request.params.mealId,
      body: request.body,
    }));

  fastify.delete('/my/nutrition/days/:date/meals/:mealId', { preHandler, schema: schema.deleteMealSchema }, (request) =>
    service.undoMealLog(prisma, { patientId: request.user.id, date: request.params.date, mealId: request.params.mealId }));

  fastify.put('/my/nutrition/days/:date/items/:itemId/swap', { preHandler, schema: schema.putSwapSchema }, (request) =>
    service.setSwap(prisma, {
      patientId: request.user.id,
      date: request.params.date,
      itemId: request.params.itemId,
      substituteId: request.body.substituteId,
    }));

  fastify.delete('/my/nutrition/days/:date/items/:itemId/swap', { preHandler, schema: schema.deleteSwapSchema }, (request) =>
    service.undoSwap(prisma, { patientId: request.user.id, date: request.params.date, itemId: request.params.itemId }));

  fastify.post('/my/nutrition/days/:date/water', { preHandler, schema: schema.postWaterSchema }, (request) =>
    service.addWater(prisma, { patientId: request.user.id, date: request.params.date, ml: request.body.ml }));
}
