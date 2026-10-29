import {
  trainingCategoryValues,
  bodySegmentValues,
  weekDayValues,
  genderOrdinationValues,
  trainingLevelValues,
  exerciseTypeValues,
  protocolTypeValues,
  workoutSessionStatusValues,
  exerciseLogStatusValues,
  prescriptionModeValues,
  PrescriptionMode,
  SupersetConstraints,
  SupersetMessageCode,
  SubstituteMessageCode,
} from '../constants/training.js';
import { AppError } from '../errors/app-error.js';

export function buildError(code, message, statusCode = 400) {
  return new AppError({
    httpStatus: statusCode,
    error: code,
    messageCode: `legacy.${code}`,
    message,
  });
}

export function validateWeekDay(weekDay, fieldName = 'weekDay') {
  if (weekDay && !weekDayValues.includes(weekDay)) {
    throw buildError(
      'INVALID_WEEK_DAY',
      `Invalid ${fieldName}: ${weekDay}. Valid values are: ${weekDayValues.join(', ')}`,
    );
  }
}

export function validateCategory(category) {
  if (!trainingCategoryValues.includes(category)) {
    throw buildError(
      'INVALID_CATEGORY',
      `Invalid category: ${category}. Valid values are: ${trainingCategoryValues.join(', ')}`,
    );
  }
}

export function validateBodySegment(bodySegment) {
  if (bodySegment && !bodySegmentValues.includes(bodySegment)) {
    throw buildError(
      'INVALID_BODY_SEGMENT',
      `Invalid body segment: ${bodySegment}. Valid values are: ${bodySegmentValues.join(', ')}`,
    );
  }
}

export function validateGenderOrdination(value) {
  if (value && !genderOrdinationValues.includes(value)) {
    throw buildError(
      'INVALID_GENDER_ORDINATION',
      `Invalid gender ordination: ${value}. Valid values are: ${genderOrdinationValues.join(', ')}`,
    );
  }
}

export function validateTrainingLevel(value) {
  if (value && !trainingLevelValues.includes(value)) {
    throw buildError(
      'INVALID_TRAINING_LEVEL',
      `Invalid training level: ${value}. Valid values are: ${trainingLevelValues.join(', ')}`,
    );
  }
}

export function validateExerciseType(type) {
  if (!exerciseTypeValues.includes(type)) {
    throw buildError(
      'INVALID_EXERCISE_TYPE',
      `Invalid exercise type: ${type}. Valid values are: ${exerciseTypeValues.join(', ')}`,
    );
  }
}

export function validateRepetitions(repetitions) {
  if (repetitions === undefined || repetitions === null) return;
  const { min, max } = repetitions;
  if (min !== null && (!Number.isInteger(min) || min < 1)) {
    throw buildError('INVALID_REPETITIONS', 'repetitions.min must be a positive integer or null');
  }
  if (max !== null && (!Number.isInteger(max) || max < 1)) {
    throw buildError('INVALID_REPETITIONS', 'repetitions.max must be a positive integer or null');
  }
}

export function validateProtocolType(type) {
  if (type && !protocolTypeValues.includes(type)) {
    throw buildError(
      'INVALID_PROTOCOL_TYPE',
      `Invalid protocol type: ${type}. Valid values are: ${protocolTypeValues.join(', ')}`,
    );
  }
}

export function validateWorkoutSessionStatus(status) {
  if (status && !workoutSessionStatusValues.includes(status)) {
    throw buildError(
      'INVALID_WORKOUT_SESSION_STATUS',
      `Invalid workout session status: ${status}. Valid values are: ${workoutSessionStatusValues.join(', ')}`,
    );
  }
}

export function validateExerciseLogStatus(status) {
  if (status && !exerciseLogStatusValues.includes(status)) {
    throw buildError(
      'INVALID_EXERCISE_LOG_STATUS',
      `Invalid exercise log status: ${status}. Valid values are: ${exerciseLogStatusValues.join(', ')}`,
    );
  }
}

/**
 * Validate prescriptionMode and enforce mutual exclusivity rules.
 *
 * - When mode = 'duration': duration must be present and > 0.
 * - When mode = 'reps' (or omitted): repetitions rules apply via validateRepetitions.
 * - When mode is provided but not a valid value: throws VALIDATION_ERROR.
 *
 * @param {string|undefined} mode - Prescription mode value
 * @param {object} data - Full exercise data to cross-check fields
 */
export function validatePrescriptionMode(mode, data = {}) {
  if (mode === undefined || mode === null) return;

  if (!prescriptionModeValues.includes(mode)) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: 'validation.failed',
      message: `Invalid prescriptionMode: ${mode}. Valid values are: ${prescriptionModeValues.join(', ')}`,
    });
  }

  if (mode === PrescriptionMode.DURATION) {
    const duration = data.duration;
    if (duration === undefined || duration === null || duration <= 0) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: 'duration must be a positive integer when prescriptionMode is "duration"',
      });
    }
  }

  if (mode === PrescriptionMode.REPS) {
    const repetitions = data.repetitions;
    if (repetitions === undefined || repetitions === null) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: 'validation.failed',
        message: 'repetitions must be provided when prescriptionMode is "reps"',
      });
    }
  }
}

/**
 * Infer prescriptionMode from existing exercise data when the field is null.
 * Mirrors the SQL backfill logic.
 *
 * @param {string|null|undefined} mode - Stored prescriptionMode value
 * @param {object} exercise - Exercise/template row from DB
 * @returns {string} Resolved prescriptionMode ('reps' or 'duration')
 */
export function resolvePrescriptionMode(mode, exercise = {}) {
  if (mode !== null && mode !== undefined) return mode;
  return exercise.duration !== null && exercise.duration !== undefined && exercise.repetitions === null
    ? PrescriptionMode.DURATION
    : PrescriptionMode.REPS;
}

/**
 * Apply mutual exclusivity: based on prescriptionMode, null out the opposing field.
 * Returns an object with only the fields that should be persisted.
 *
 * @param {string} mode - Resolved prescriptionMode
 * @param {object} data - Incoming data with optional repetitions and duration
 * @returns {{ repetitions: any, duration: any }} Normalized values
 */
export function applyPrescriptionModeExclusivity(mode, data) {
  if (mode === PrescriptionMode.DURATION) {
    return {
      duration: data.duration ?? null,
      repetitions: null,
    };
  }
  return {
    repetitions: data.repetitions ?? null,
    duration: null,
  };
}

/**
 * Validate that a set of exercises can form or extend a valid superset group.
 *
 * Rules enforced:
 * - Between MIN_MEMBERS and MAX_MEMBERS members.
 * - All members must belong to the same trainingId.
 * - No member may be a substitute exercise (substituteForExerciseId must be null).
 * - Members must be contiguous in the training's main `order` sequence
 *   (i.e. their order values form a consecutive block with no gaps occupied by other exercises).
 *
 * @param {object[]} memberExercises - The exercises that will form the group (full rows from DB).
 * @param {object[]} allTrainingExercises - All active (non-deleted) exercises in the training.
 * @param {string} trainingId - Expected trainingId.
 */
export function validateSupersetMembership(memberExercises, allTrainingExercises, trainingId) {
  if (memberExercises.length < SupersetConstraints.MIN_MEMBERS) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SupersetMessageCode.MIN_MEMBERS,
      message: `A superset group requires at least ${SupersetConstraints.MIN_MEMBERS} members`,
    });
  }

  if (memberExercises.length > SupersetConstraints.MAX_MEMBERS) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SupersetMessageCode.MAX_MEMBERS,
      message: `A superset group cannot have more than ${SupersetConstraints.MAX_MEMBERS} members`,
    });
  }

  for (const exercise of memberExercises) {
    if (exercise.trainingId !== trainingId) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
        message: 'All superset members must belong to the same training',
      });
    }

    if (exercise.substituteForExerciseId !== null) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
        message: 'Substitute exercises cannot belong to a superset group',
      });
    }
  }

  assertSupersetContiguity(memberExercises, allTrainingExercises);
}

/**
 * Assert that the given member exercises form a contiguous block in the training's
 * main `order` sequence (no non-member exercises in between them).
 *
 * @param {object[]} memberExercises - The exercises that form or will form the group.
 * @param {object[]} allTrainingExercises - All active exercises in the training.
 */
export function assertSupersetContiguity(memberExercises, allTrainingExercises) {
  if (memberExercises.length === 0) return;

  const memberIds = new Set(memberExercises.map((e) => e.id));
  const memberOrders = memberExercises.map((e) => e.order).sort((a, b) => a - b);
  const minOrder = memberOrders[0];
  const maxOrder = memberOrders[memberOrders.length - 1];

  // Collect all non-substitute active exercises in the order range
  const exercisesInRange = allTrainingExercises.filter(
    (e) => e.order >= minOrder && e.order <= maxOrder && e.substituteForExerciseId === null,
  );

  // Every exercise in that range must be a member of this group
  for (const exercise of exercisesInRange) {
    if (!memberIds.has(exercise.id)) {
      throw new AppError({
        httpStatus: 400,
        error: 'VALIDATION_ERROR',
        messageCode: SupersetMessageCode.MEMBERSHIP_INVALID,
        message: 'Superset members must be contiguous in the training exercise order — no non-member exercises may appear between them',
      });
    }
  }
}

/**
 * Validate that a candidate exercise can be added as a substitute for a principal exercise.
 *
 * Rules enforced:
 * - Principal and candidate must be in the same training.
 * - Principal cannot itself be a substitute (no chains).
 * - Candidate cannot belong to a superset group.
 * - Candidate cannot already be a substitute for another (or the same) principal.
 *
 * @param {object} principal - The principal Exercise DB row.
 * @param {object} candidate - The candidate substitute Exercise DB row.
 */
export function validateSubstituteConstraint(principal, candidate) {
  if (candidate.trainingId !== principal.trainingId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.SAME_TRAINING,
      message: 'The substitute exercise must belong to the same training as the principal',
    });
  }

  if (principal.substituteForExerciseId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.CANNOT_CHAIN,
      message: 'A substitute exercise cannot itself have substitutes (no chaining)',
    });
  }

  // The CANDIDATE (substitute) cannot belong to a superset group.
  // The principal CAN be in a superset: when a student swaps a bi-set member,
  // only that one slot is replaced in the session flow.
  if (candidate.supersetGroupId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.CANNOT_BE_IN_SUPERSET,
      message: 'Substitute cannot be in a superset',
    });
  }

  if (candidate.substituteForExerciseId) {
    throw new AppError({
      httpStatus: 400,
      error: 'VALIDATION_ERROR',
      messageCode: SubstituteMessageCode.ALREADY_SUBSTITUTE,
      message: 'This exercise is already a substitute for another exercise',
    });
  }
}

// Builds the 400 AppError used for every invalid bulk superset group.
function buildSupersetGroupError(messageCode, message) {
  return new AppError({ httpStatus: 400, error: 'VALIDATION_ERROR', messageCode, message });
}

// Groups array positions by client supersetGroupId, preserving first-seen group order.
function collectGroupPositions(exercises) {
  const positionsByGroup = new Map();
  exercises.forEach((exercise, position) => {
    if (!exercise.supersetGroupId) return;
    const positions = positionsByGroup.get(exercise.supersetGroupId) ?? [];
    positions.push(position);
    positionsByGroup.set(exercise.supersetGroupId, positions);
  });
  return positionsByGroup;
}

// Throws when any substitute in the payload carries superset fields.
function assertSubstitutesOutsideSupersets(exercises) {
  const offending = exercises
    .flatMap((exercise) => exercise.substitutes ?? [])
    .some((substitute) => substitute.supersetGroupId || substitute.supersetOrder !== undefined);
  if (offending) {
    throw buildSupersetGroupError(
      SupersetMessageCode.MEMBERSHIP_INVALID,
      'Substitute exercises cannot belong to a superset group',
    );
  }
}

/**
 * Validate the client-supplied superset groups (2–6 contiguous members) of one training in a bulk payload.
 *
 * @param {object[]} exercises - The training's exercise bodies, in array order.
 */
export function assertBulkSupersetGroups(exercises) {
  assertSubstitutesOutsideSupersets(exercises);

  for (const positions of collectGroupPositions(exercises).values()) {
    if (positions.length < SupersetConstraints.MIN_MEMBERS) {
      throw buildSupersetGroupError(
        SupersetMessageCode.MIN_MEMBERS,
        `A superset group requires at least ${SupersetConstraints.MIN_MEMBERS} members`,
      );
    }
    if (positions.length > SupersetConstraints.MAX_MEMBERS) {
      throw buildSupersetGroupError(
        SupersetMessageCode.MAX_MEMBERS,
        `A superset group cannot have more than ${SupersetConstraints.MAX_MEMBERS} members`,
      );
    }
    const span = positions[positions.length - 1] - positions[0] + 1;
    if (span !== positions.length) {
      throw buildSupersetGroupError(
        SupersetMessageCode.MEMBERSHIP_INVALID,
        'Superset members must be contiguous in the training exercise order — no non-member exercises may appear between them',
      );
    }
  }
}
