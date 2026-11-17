import { AppError } from '../errors/app-error.js';
import {
  ServiceType,
  SubscriptionErrorCode,
  SubscriptionMessageCode,
  SUBSCRIPTION_ASSIGNMENT_LOCK_PREFIX,
} from '../constants/subscription.js';

const UNPROCESSABLE_ENTITY = 422;

// Builds the 422 raised when the owner cannot use a service type (missing row or change of owner row).
export function serviceTypeNotAllowedError(serviceType) {
  return new AppError({
    httpStatus: UNPROCESSABLE_ENTITY,
    error: SubscriptionErrorCode.SERVICE_TYPE_NOT_ALLOWED,
    messageCode: SubscriptionMessageCode.SERVICE_TYPE_NOT_ALLOWED,
    message: 'This professional profile cannot use this service type',
    details: { serviceType },
  });
}

/**
 * Service type used when a plan is created without one: training for owners with a trainer row, otherwise nutrition.
 *
 * @param {{ trainerId: string|null }} owner
 * @returns {string}
 */
export function defaultServiceType(owner) {
  return owner.trainerId ? ServiceType.TRAINING : ServiceType.NUTRITION;
}

/**
 * Owner columns of a plan of the given service type: training and both sit on the trainer row, nutrition on the nutritionist row.
 *
 * @param {{ trainerId: string|null, nutritionistId: string|null }} owner
 * @param {string} serviceType
 * @returns {{ trainerId: string|null, nutritionistId: string|null }}
 * @throws {AppError} 422 subscription.serviceTypeNotAllowed when the owner lacks the row the type needs
 */
export function resolvePlanOwnerColumns(owner, serviceType) {
  if (serviceType === ServiceType.NUTRITION) {
    if (!owner.nutritionistId) throw serviceTypeNotAllowedError(serviceType);
    return { trainerId: null, nutritionistId: owner.nutritionistId };
  }
  if (!owner.trainerId) throw serviceTypeNotAllowedError(serviceType);
  if (serviceType === ServiceType.BOTH && !owner.nutritionistId) throw serviceTypeNotAllowedError(serviceType);
  return { trainerId: owner.trainerId, nutritionistId: null };
}

/**
 * Prisma where fragment matching rows owned by any of the owner's professional rows.
 *
 * @param {{ trainerId: string|null, nutritionistId: string|null }} owner
 * @returns {object}
 */
export function ownerScopeWhere(owner) {
  const scopes = [];
  if (owner.trainerId) scopes.push({ trainerId: owner.trainerId });
  if (owner.nutritionistId) scopes.push({ nutritionistId: owner.nutritionistId });
  return scopes.length === 1 ? scopes[0] : { OR: scopes };
}

/**
 * Whether the links a person has with the owner are enough to bill a plan of this service type.
 *
 * @param {string} serviceType
 * @param {{ trainerLinked: boolean, patientLinked: boolean }} links
 * @returns {boolean}
 */
export function requiredLinkSatisfied(serviceType, { trainerLinked, patientLinked }) {
  if (serviceType === ServiceType.TRAINING) return trainerLinked;
  if (serviceType === ServiceType.NUTRITION) return patientLinked;
  return trainerLinked || patientLinked;
}

/**
 * Key of the advisory lock serializing assign/unlink for one professional user and one student.
 *
 * @param {string} userId
 * @param {string} studentId
 * @returns {string}
 */
export function buildProfessionalAssignmentLockKey(userId, studentId) {
  return `${SUBSCRIPTION_ASSIGNMENT_LOCK_PREFIX}:user:${userId}:${studentId}`;
}
