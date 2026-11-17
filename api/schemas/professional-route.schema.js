import {
  createPlanSchema,
  listPlansSchema,
  getPlanByIdSchema,
  updatePlanSchema,
  archivePlanSchema,
  unarchivePlanSchema,
} from './subscription-plan-route.schema.js';
import {
  assignPlanSchema,
  listSubscriptionsByStudentSchema,
  getActiveSubscriptionByStudentSchema,
  listSubscriptionsSchema,
  getSubscriptionByIdSchema,
  cancelSubscriptionSchema,
} from './student-subscription-route.schema.js';
import {
  createPaymentSchema,
  listPaymentsBySubscriptionSchema,
  updatePaymentSchema,
  markPaymentPaidSchema,
  markPaymentPendingSchema,
  deletePaymentSchema,
  voidPaymentSchema,
  listPaymentsByStudentSchema,
} from './subscription-payment-route.schema.js';
import { getFinanceOverviewSchema, getFinanceSummarySchema } from './trainer-finance-route.schema.js';
import { serviceTypeValues } from '../../src/constants/subscription.js';

const NULLABLE_UUID = { type: 'string', format: 'uuid', nullable: true };
const KIND_COUNTS_SCHEMA = {
  type: 'object',
  description: 'Active subscribers split by kind: linked to the caller as trainer student, otherwise patient',
  properties: { students: { type: 'integer' }, patients: { type: 'integer' } },
};

// Applies a visitor to every plain object nested in a JSON-schema fragment.
function visitObjects(node, visitor) {
  if (Array.isArray(node)) {
    node.forEach((item) => visitObjects(item, visitor));
    return;
  }
  if (node === null || typeof node !== 'object') return;
  visitor(node);
  Object.values(node).forEach((child) => visitObjects(child, visitor));
}

// Makes trainerId nullable and adds nullable nutritionistId on every owner-carrying object.
function openOwnerFields(node) {
  const properties = node.properties;
  if (!properties?.trainerId) return;
  properties.trainerId = { ...NULLABLE_UUID };
  properties.nutritionistId = { ...NULLABLE_UUID };
}

// Adds the optional serviceType to a plan request body.
function addServiceTypeToBody(schema) {
  schema.body.properties.serviceType = {
    type: 'string',
    enum: serviceTypeValues,
    description: 'What the plan bills. Defaults to training for trainers and nutrition for nutritionist-only users',
  };
}

// Rewrites the /trainer path mentions of a schema text to /professional.
function retitle(text) {
  return text?.replaceAll('/trainer/', '/professional/');
}

// Clones a /trainer billing schema into its /professional twin (nullable owners, professional tag).
function toProfessionalSchema(schema, { mutate } = {}) {
  const cloned = structuredClone(schema);
  cloned.tags = ['professional-billing'];
  cloned.summary = retitle(cloned.summary);
  if (cloned.description) cloned.description = retitle(cloned.description);
  visitObjects(cloned.response, openOwnerFields);
  mutate?.(cloned);
  return cloned;
}

// Adds activeSubscriptionCountByKind to the plan items of a list schema.
function addKindCounts(schema) {
  schema.response[200].items.properties.activeSubscriptionCountByKind = KIND_COUNTS_SCHEMA;
}

export const professionalSchemas = Object.freeze({
  createPlan: toProfessionalSchema(createPlanSchema, { mutate: addServiceTypeToBody }),
  listPlans: toProfessionalSchema(listPlansSchema, { mutate: addKindCounts }),
  getPlanById: toProfessionalSchema(getPlanByIdSchema),
  updatePlan: toProfessionalSchema(updatePlanSchema, { mutate: addServiceTypeToBody }),
  archivePlan: toProfessionalSchema(archivePlanSchema),
  unarchivePlan: toProfessionalSchema(unarchivePlanSchema),
  assignPlan: toProfessionalSchema(assignPlanSchema),
  listSubscriptionsByStudent: toProfessionalSchema(listSubscriptionsByStudentSchema),
  getActiveSubscriptionByStudent: toProfessionalSchema(getActiveSubscriptionByStudentSchema),
  listSubscriptions: toProfessionalSchema(listSubscriptionsSchema),
  getSubscriptionById: toProfessionalSchema(getSubscriptionByIdSchema),
  cancelSubscription: toProfessionalSchema(cancelSubscriptionSchema),
  createPayment: toProfessionalSchema(createPaymentSchema),
  listPaymentsBySubscription: toProfessionalSchema(listPaymentsBySubscriptionSchema),
  updatePayment: toProfessionalSchema(updatePaymentSchema),
  markPaymentPaid: toProfessionalSchema(markPaymentPaidSchema),
  markPaymentPending: toProfessionalSchema(markPaymentPendingSchema),
  deletePayment: toProfessionalSchema(deletePaymentSchema),
  voidPayment: toProfessionalSchema(voidPaymentSchema),
  listPaymentsByStudent: toProfessionalSchema(listPaymentsByStudentSchema),
  getFinanceOverview: toProfessionalSchema(getFinanceOverviewSchema),
  getFinanceSummary: toProfessionalSchema(getFinanceSummarySchema),
});
