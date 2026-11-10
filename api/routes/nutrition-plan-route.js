import { Roles } from '../../src/constants/roles.js';
import { prisma } from '../../src/db.js';
import { authenticate, requireRole } from '../middleware/auth.js';
import { attachNutritionist } from '../middleware/nutritionist.js';
import { getOrCreatePlan, updateGoals, updateGuidance, publishPlan } from '../../src/services/nutrition-plan-service.js';
import * as menu from '../../src/services/nutrition-menu-service.js';
import { createCustomFood, updateCustomFood, deleteCustomFood } from '../../src/services/food-service.js';
import * as schema from '../schemas/nutrition-plan-route.schema.js';
import * as foodSchema from '../schemas/food-route.schema.js';

// Registers the nutritionist plan, menu and custom-food routes; handlers receive { nutritionistId, params, body }.
export async function nutritionPlanRoutes(fastify) {
  const preHandler = [authenticate, requireRole(Roles.NUTRITIONIST), attachNutritionist];

  const route = (method, url, routeSchema, handler, status = 200) =>
    fastify.route({
      method,
      url,
      preHandler,
      schema: routeSchema,
      handler: async (request, reply) => {
        const result = await handler({ nutritionistId: request.nutritionistId, params: request.params, body: request.body });
        return status === 204 ? reply.status(204).send() : reply.status(status).send(result);
      },
    });

  route('GET', '/nutritionist/patients/:patientId/plan', schema.getPlanSchema, ({ nutritionistId, params }) =>
    getOrCreatePlan(prisma, { nutritionistId, patientId: params.patientId }));
  route('PATCH', '/nutritionist/plans/:planId/goals', schema.updateGoalsSchema, ({ nutritionistId, params, body }) =>
    updateGoals(prisma, { nutritionistId, planId: params.planId, data: body }));
  route('PATCH', '/nutritionist/plans/:planId/guidance', schema.updateGuidanceSchema, ({ nutritionistId, params, body }) =>
    updateGuidance(prisma, { nutritionistId, planId: params.planId, data: body }));
  route('POST', '/nutritionist/plans/:planId/publish', schema.publishPlanSchema, ({ nutritionistId, params }) =>
    publishPlan(prisma, { nutritionistId, planId: params.planId }));

  route('POST', '/nutritionist/plans/:planId/meals', schema.createMealSchema, ({ nutritionistId, params, body }) =>
    menu.createMeal(prisma, { nutritionistId, planId: params.planId, data: body }));
  route('PUT', '/nutritionist/plans/:planId/meals/order', schema.reorderMealsSchema, ({ nutritionistId, params, body }) =>
    menu.reorderMeals(prisma, { nutritionistId, planId: params.planId, mealIds: body.mealIds }));
  route('PATCH', '/nutritionist/meals/:mealId', schema.updateMealSchema, ({ nutritionistId, params, body }) =>
    menu.updateMeal(prisma, { nutritionistId, mealId: params.mealId, data: body }));
  route('DELETE', '/nutritionist/meals/:mealId', schema.deleteMealSchema, ({ nutritionistId, params }) =>
    menu.deleteMeal(prisma, { nutritionistId, mealId: params.mealId }));

  route('POST', '/nutritionist/meals/:mealId/options', schema.addOptionSchema, ({ nutritionistId, params }) =>
    menu.addOption(prisma, { nutritionistId, mealId: params.mealId }));
  route('DELETE', '/nutritionist/meal-options/:optionId', schema.deleteOptionSchema, ({ nutritionistId, params }) =>
    menu.deleteOption(prisma, { nutritionistId, optionId: params.optionId }));

  route('POST', '/nutritionist/meal-options/:optionId/items', schema.addItemSchema, ({ nutritionistId, params, body }) =>
    menu.addItem(prisma, { nutritionistId, optionId: params.optionId, data: body }));
  route('PATCH', '/nutritionist/items/:itemId', schema.updateItemSchema, ({ nutritionistId, params, body }) =>
    menu.updateItem(prisma, { nutritionistId, itemId: params.itemId, data: body }));
  route('DELETE', '/nutritionist/items/:itemId', schema.deleteItemSchema, ({ nutritionistId, params }) =>
    menu.deleteItem(prisma, { nutritionistId, itemId: params.itemId }));

  route('POST', '/nutritionist/items/:itemId/substitutes', schema.addSubstituteSchema, ({ nutritionistId, params, body }) =>
    menu.addSubstitute(prisma, { nutritionistId, itemId: params.itemId, foodId: body.foodId }));
  route('DELETE', '/nutritionist/substitutes/:substituteId', schema.removeSubstituteSchema, ({ nutritionistId, params }) =>
    menu.removeSubstitute(prisma, { nutritionistId, substituteId: params.substituteId }));

  route('POST', '/nutritionist/foods', foodSchema.createCustomFoodSchema, ({ nutritionistId, body }) =>
    createCustomFood(prisma, { nutritionistId, data: body }), 201);
  route('PATCH', '/nutritionist/foods/:id', foodSchema.updateCustomFoodSchema, ({ nutritionistId, params, body }) =>
    updateCustomFood(prisma, { nutritionistId, foodId: params.id, data: body }));
  route('DELETE', '/nutritionist/foods/:id', foodSchema.deleteCustomFoodSchema, ({ nutritionistId, params }) =>
    deleteCustomFood(prisma, { nutritionistId, foodId: params.id }), 204);
}
