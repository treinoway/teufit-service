import { trainingCategoryValues, bodySegmentValues, weekDayValues } from '../constants/training.js';
import { AppError } from '../errors/app-error.js';

export function buildError(code, message, statusCode = 400) {
  return new AppError({
    httpStatus: statusCode,
    error: code,
    messageCode: `legacy.${code}`,
    message,
  });
}

export function validateWeekDays(weekDays, fieldName = 'weekDays') {
  if (!Array.isArray(weekDays)) {
    throw buildError('INVALID_WEEK_DAYS', `${fieldName} must be an array`);
  }

  const invalidDays = weekDays.filter((day) => !weekDayValues.includes(day));
  if (invalidDays.length > 0) {
    throw buildError(
      'INVALID_WEEK_DAYS',
      `Invalid week days: ${invalidDays.join(', ')}. Valid values are: ${weekDayValues.join(', ')}`,
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
