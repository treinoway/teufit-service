import { describe, it, expect } from 'vitest';
import { equivalentQuantity } from '../../src/helpers/nutrition-calc.js';
import { MAX_QUANTITY_COLUMN, NutritionErrorCode, NutritionMessageCode, SwapBasis } from '../../src/constants/nutrition.js';

const HTTP_UNPROCESSABLE = 422;
const ORIGINAL_PROTEIN_G = 30;
const TINY_PROTEIN_PER_100G = 0.0001;
const NORMAL_PROTEIN_PER_100G = 30;

// Test helper: an original item carrying only the given protein amount.
function makeOriginal(protein) {
  return { nutrients: { kcal: 100, protein } };
}

// Test helper: a substitute food with the given protein per 100 g.
function makeFood(protein) {
  return { per100g: { kcal: 100, protein } };
}

describe('equivalentQuantity quantity limit', () => {
  it('should throw 422 quantityTooLarge when the equivalent exceeds the quantity column', () => {
    expect(() => equivalentQuantity(makeOriginal(ORIGINAL_PROTEIN_G), makeFood(TINY_PROTEIN_PER_100G), SwapBasis.PROTEIN)).toThrow(
      expect.objectContaining({
        httpStatus: HTTP_UNPROCESSABLE,
        error: NutritionErrorCode.SUBSTITUTE_QUANTITY_TOO_LARGE,
        messageCode: NutritionMessageCode.SUBSTITUTE_QUANTITY_TOO_LARGE,
      }),
    );
  });

  it('should throw quantityTooLarge for the kcal basis too', () => {
    const food = { per100g: { kcal: TINY_PROTEIN_PER_100G, protein: 1 } };

    expect(() => equivalentQuantity(makeOriginal(1), food, SwapBasis.KCAL)).toThrow(
      expect.objectContaining({ error: NutritionErrorCode.SUBSTITUTE_QUANTITY_TOO_LARGE }),
    );
  });

  it('should accept a quantity exactly at the column limit', () => {
    const original = makeOriginal(MAX_QUANTITY_COLUMN / 100);
    const food = makeFood(NORMAL_PROTEIN_PER_100G / NORMAL_PROTEIN_PER_100G);

    expect(equivalentQuantity(original, food, SwapBasis.PROTEIN)).toBe(MAX_QUANTITY_COLUMN);
  });

  it('should not report quantityTooLarge for a normal quantity', () => {
    const quantity = equivalentQuantity(makeOriginal(ORIGINAL_PROTEIN_G), makeFood(NORMAL_PROTEIN_PER_100G), SwapBasis.PROTEIN);

    expect(quantity).toBe(100);
  });
});
