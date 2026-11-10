import { describe, it, expect } from 'vitest';
import { equivalentQuantity } from '../../src/helpers/nutrition-calc.js';
import { NutritionErrorCode, NutritionMessageCode, SwapBasis } from '../../src/constants/nutrition.js';

const HTTP_UNPROCESSABLE = 422;
const TINY_ORIGINAL_PROTEIN_G = 0.0001;
const RICH_PROTEIN_PER_100G = 90;

describe('equivalentQuantity rounded to zero', () => {
  it('should reject with 422 cannotEquate when the rounded quantity is 0', () => {
    const original = { nutrients: { kcal: 100, protein: TINY_ORIGINAL_PROTEIN_G } };
    const food = { per100g: { kcal: 100, protein: RICH_PROTEIN_PER_100G } };

    expect(() => equivalentQuantity(original, food, SwapBasis.PROTEIN)).toThrow(
      expect.objectContaining({
        httpStatus: HTTP_UNPROCESSABLE,
        error: NutritionErrorCode.SUBSTITUTE_CANNOT_EQUATE,
        messageCode: NutritionMessageCode.SUBSTITUTE_CANNOT_EQUATE,
      }),
    );
  });
});
