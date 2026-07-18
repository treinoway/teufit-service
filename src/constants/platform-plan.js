export const PLATFORM_PLAN_TIERS = Object.freeze({
  FREE: 'FREE',
  PRO: 'PRO',
  PLATINUM: 'PLATINUM',
  DIAMOND: 'DIAMOND',
});

export const PLAN_LIMITS = Object.freeze({
  FREE: {
    studentCap: 3,
    aiActionsPerStudent: 0,
    aiActionsTrainerCap: 0,
    branding: false,
    championships: false,
  },
  PRO: {
    studentCap: 20,
    aiActionsPerStudent: 3,
    aiActionsTrainerCap: null,
    branding: true,
    championships: true,
  },
  PLATINUM: {
    studentCap: 80,
    aiActionsPerStudent: 3,
    aiActionsTrainerCap: null,
    branding: true,
    championships: true,
  },
  DIAMOND: {
    studentCap: Infinity,
    aiActionsPerStudent: Infinity,
    aiActionsTrainerCap: 1000,
    branding: true,
    championships: true,
  },
});

export const PLATFORM_PLAN_ERRORS = Object.freeze({
  STUDENT_CAP_EXCEEDED: {
    code: 'STUDENT_CAP_EXCEEDED',
    messageCode: 'platformPlan.studentCapExceeded',
    status: 403,
  },
  AI_NOT_AVAILABLE: {
    code: 'AI_NOT_AVAILABLE',
    messageCode: 'platformPlan.aiNotAvailable',
    status: 403,
  },
  AI_ACTIONS_EXCEEDED: {
    code: 'AI_ACTIONS_EXCEEDED',
    messageCode: 'platformPlan.aiActionsExceeded',
    status: 403,
  },
  BRANDING_NOT_AVAILABLE: {
    code: 'BRANDING_NOT_AVAILABLE',
    messageCode: 'platformPlan.brandingNotAvailable',
    status: 403,
  },
  CHAMPIONSHIPS_NOT_AVAILABLE: {
    code: 'CHAMPIONSHIPS_NOT_AVAILABLE',
    messageCode: 'platformPlan.championshipsNotAvailable',
    status: 403,
  },
  STUDENT_BLOCKED_ON_PLAN: {
    code: 'STUDENT_BLOCKED_ON_PLAN',
    messageCode: 'platformPlan.studentBlockedOnPlan',
    status: 403,
  },
});

export const PLAN_PRICES = Object.freeze({
  PRO: { monthly: 49.90, yearly: 479.00 },
  PLATINUM: { monthly: 99.90, yearly: 959.00 },
  DIAMOND: { monthly: 299.90, yearly: 2879.00 },
});

export const ASAAS_BILLING_TYPES = Object.freeze({
  PIX: 'PIX',
  CREDIT_CARD: 'CREDIT_CARD',
  BOLETO: 'BOLETO',
  UNDEFINED: 'UNDEFINED',
});

export const ASAAS_CYCLES = Object.freeze({
  MONTHLY: 'MONTHLY',
  YEARLY: 'YEARLY',
});

export const ASAAS_PAYMENT_STATUSES = Object.freeze({
  PENDING: 'PENDING',
  CONFIRMED: 'CONFIRMED',
  OVERDUE: 'OVERDUE',
  REFUNDED: 'REFUNDED',
});

export const PLATFORM_SUBSCRIPTION_STATUSES = Object.freeze({
  ACTIVE: 'ACTIVE',
  TRIALING: 'TRIALING',
  PAST_DUE: 'PAST_DUE',
  CANCELED: 'CANCELED',
});

export const PAST_DUE_GRACE_DAYS = 7;

export const ASAAS_WEBHOOK_ERRORS = Object.freeze({
  INVALID_SECRET: {
    code: 'UNAUTHORIZED',
    messageCode: 'webhook.invalidSecret',
    status: 401,
  },
});

export const ASAAS_WEBHOOK_EVENTS = Object.freeze({
  PAYMENT_CREATED: 'PAYMENT_CREATED',
  PAYMENT_CONFIRMED: 'PAYMENT_CONFIRMED',
  PAYMENT_RECEIVED: 'PAYMENT_RECEIVED',
  PAYMENT_OVERDUE: 'PAYMENT_OVERDUE',
  PAYMENT_REFUNDED: 'PAYMENT_REFUNDED',
  SUBSCRIPTION_CREATED: 'SUBSCRIPTION_CREATED',
  SUBSCRIPTION_DELETED: 'SUBSCRIPTION_DELETED',
  SUBSCRIPTION_UPDATED: 'SUBSCRIPTION_UPDATED',
});

export function getBillingMonth(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}
