import { toNumber } from './nutrition-sheet.js';
import { DEFAULT_FOOD_PORTION_GRAMS } from '../constants/nutrition.js';

// Per-100g nutrients of a Food row (missing values count as 0).
export function foodPer100g(food) {
  return {
    kcal: toNumber(food.energyKcal) ?? 0,
    protein: toNumber(food.proteinG) ?? 0,
    carbs: toNumber(food.carbohydratesG) ?? 0,
    fat: toNumber(food.totalFatG) ?? 0,
    fiber: toNumber(food.fiberG) ?? 0,
  };
}

// Default portion { label, grams } of a Food row; null when it has no serving size.
export function foodPortion(food) {
  const grams = toNumber(food.servingSizeG);
  if (grams == null) return null;
  return { label: food.servingSizeDescription ?? `${grams} g`, grams };
}

// Default quantity (g) when adding a food to a meal.
export function defaultQuantity(food) {
  return foodPortion(food)?.grams ?? DEFAULT_FOOD_PORTION_GRAMS;
}

// Maps a Food row (with foodGroup) to the Food contract object.
export function toFoodDto(food) {
  return {
    id: food.id,
    name: food.name,
    source: food.source,
    groupId: food.foodGroupId,
    groupName: food.foodGroup?.name ?? null,
    portion: foodPortion(food),
    per100g: foodPer100g(food),
  };
}

// Food row columns from the per-100g nutrients and the portion of the contract.
export function foodColumns({ per100g, portion }) {
  return {
    ...(per100g && {
      energyKcal: per100g.kcal,
      proteinG: per100g.protein,
      carbohydratesG: per100g.carbs,
      fiberG: per100g.fiber,
      totalFatG: per100g.fat,
    }),
    ...(portion && { servingSizeG: portion.grams, servingSizeDescription: portion.label }),
  };
}
