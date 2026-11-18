import { describe, it, expect } from 'vitest';
import {
  defaultServiceType,
  resolvePlanOwnerColumns,
  ownerScopeWhere,
  requiredLinkSatisfied,
  buildProfessionalAssignmentLockKey,
} from '../../src/helpers/subscription-owner-helpers.js';
import {
  ServiceType,
  SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE,
  OWNER_USER_ID,
  OWNER_TRAINER_ID,
  OWNER_NUTRITIONIST_ID,
  trainerOwner,
  nutritionistOwner,
  dualOwner,
} from './subscription-owner-fixtures.js';

const STUDENT_ID = 'student-uuid-1';
const UNPROCESSABLE = 422;

// Asserts the call throws the 422 serviceTypeNotAllowed AppError with the unified contract fields.
function expectNotAllowed(call) {
  let thrown;
  try {
    call();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeDefined();
  expect(thrown).toMatchObject({
    httpStatus: UNPROCESSABLE,
    messageCode: SERVICE_TYPE_NOT_ALLOWED_MESSAGE_CODE,
    error: expect.any(String),
    message: expect.any(String),
  });
}

describe('defaultServiceType', () => {
  it('should return training for a trainer-only owner', () => {
    expect(defaultServiceType(trainerOwner())).toBe(ServiceType.TRAINING);
  });

  it('should return training for a dual-role owner', () => {
    expect(defaultServiceType(dualOwner())).toBe(ServiceType.TRAINING);
  });

  it('should return nutrition for a nutritionist-only owner', () => {
    expect(defaultServiceType(nutritionistOwner())).toBe(ServiceType.NUTRITION);
  });
});

describe('resolvePlanOwnerColumns', () => {
  describe('trainer-only owner', () => {
    it('should put a training plan on the trainer row', () => {
      expect(resolvePlanOwnerColumns(trainerOwner(), ServiceType.TRAINING)).toEqual({
        trainerId: OWNER_TRAINER_ID,
        nutritionistId: null,
      });
    });

    it('should throw 422 serviceTypeNotAllowed for a nutrition plan', () => {
      expectNotAllowed(() => resolvePlanOwnerColumns(trainerOwner(), ServiceType.NUTRITION));
    });

    it('should throw 422 serviceTypeNotAllowed for a both plan', () => {
      expectNotAllowed(() => resolvePlanOwnerColumns(trainerOwner(), ServiceType.BOTH));
    });
  });

  describe('nutritionist-only owner', () => {
    it('should put a nutrition plan on the nutritionist row', () => {
      expect(resolvePlanOwnerColumns(nutritionistOwner(), ServiceType.NUTRITION)).toEqual({
        trainerId: null,
        nutritionistId: OWNER_NUTRITIONIST_ID,
      });
    });

    it('should throw 422 serviceTypeNotAllowed for a training plan', () => {
      expectNotAllowed(() => resolvePlanOwnerColumns(nutritionistOwner(), ServiceType.TRAINING));
    });

    it('should throw 422 serviceTypeNotAllowed for a both plan', () => {
      expectNotAllowed(() => resolvePlanOwnerColumns(nutritionistOwner(), ServiceType.BOTH));
    });
  });

  describe('dual-role owner', () => {
    it('should put a training plan on the trainer row', () => {
      expect(resolvePlanOwnerColumns(dualOwner(), ServiceType.TRAINING)).toEqual({
        trainerId: OWNER_TRAINER_ID,
        nutritionistId: null,
      });
    });

    it('should put a both plan on the trainer row', () => {
      expect(resolvePlanOwnerColumns(dualOwner(), ServiceType.BOTH)).toEqual({
        trainerId: OWNER_TRAINER_ID,
        nutritionistId: null,
      });
    });

    it('should put a nutrition plan on the nutritionist row', () => {
      expect(resolvePlanOwnerColumns(dualOwner(), ServiceType.NUTRITION)).toEqual({
        trainerId: null,
        nutritionistId: OWNER_NUTRITIONIST_ID,
      });
    });
  });
});

describe('ownerScopeWhere', () => {
  it('should match only the trainer rows for a trainer-only owner', () => {
    expect(ownerScopeWhere(trainerOwner())).toEqual({ trainerId: OWNER_TRAINER_ID });
  });

  it('should match only the nutritionist rows for a nutritionist-only owner', () => {
    expect(ownerScopeWhere(nutritionistOwner())).toEqual({ nutritionistId: OWNER_NUTRITIONIST_ID });
  });

  it('should match rows of either owner row for a dual-role owner', () => {
    const where = ownerScopeWhere(dualOwner());

    expect(Object.keys(where)).toEqual(['OR']);
    expect(where.OR).toHaveLength(2);
    expect(where.OR).toEqual(
      expect.arrayContaining([{ trainerId: OWNER_TRAINER_ID }, { nutritionistId: OWNER_NUTRITIONIST_ID }]),
    );
  });
});

describe('requiredLinkSatisfied', () => {
  it.each([
    [ServiceType.TRAINING, true, false, true],
    [ServiceType.TRAINING, false, true, false],
    [ServiceType.TRAINING, false, false, false],
    [ServiceType.NUTRITION, false, true, true],
    [ServiceType.NUTRITION, true, false, false],
    [ServiceType.NUTRITION, false, false, false],
    [ServiceType.BOTH, true, false, true],
    [ServiceType.BOTH, false, true, true],
    [ServiceType.BOTH, true, true, true],
    [ServiceType.BOTH, false, false, false],
  ])('should evaluate %s with trainerLinked=%s patientLinked=%s as %s', (serviceType, trainerLinked, patientLinked, expected) => {
    expect(requiredLinkSatisfied(serviceType, { trainerLinked, patientLinked })).toBe(expected);
  });
});

describe('buildProfessionalAssignmentLockKey', () => {
  it('should be keyed by the professional user and the student', () => {
    expect(buildProfessionalAssignmentLockKey(OWNER_USER_ID, STUDENT_ID)).toBe(
      `subscription-assign:user:${OWNER_USER_ID}:${STUDENT_ID}`,
    );
  });
});
