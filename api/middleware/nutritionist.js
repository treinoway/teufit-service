import { prisma } from '../../src/db.js';
import { ConflictAppError } from '../../src/errors/app-error.js';
import { NutritionErrorCode, NutritionMessageCode } from '../../src/constants/nutrition.js';

// Nutritionist profile id of a user, or null when the user has none (or it was soft-deleted).
export async function findNutritionistId(userId) {
  const nutritionist = await prisma.nutritionist.findFirst({ where: { userId, deletedAt: null }, select: { id: true } });
  return nutritionist ? nutritionist.id : null;
}

// preHandler that resolves request.nutritionistId (409 when the profile row is missing).
export async function attachNutritionist(request) {
  const nutritionistId = await findNutritionistId(request.user.id);
  if (!nutritionistId) {
    throw new ConflictAppError({
      error: NutritionErrorCode.NUTRITIONIST_PROFILE_MISSING,
      messageCode: NutritionMessageCode.NUTRITIONIST_PROFILE_MISSING,
      message: 'Nutritionist profile not found',
    });
  }
  request.nutritionistId = nutritionistId;
}
