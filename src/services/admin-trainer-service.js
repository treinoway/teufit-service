import { ConflictAppError, NotFoundAppError } from '../errors/app-error.js';
import {
  PLAN_LIMITS,
  PLATFORM_PLAN_ERRORS,
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
  isTierUpgrade,
} from '../constants/platform-plan.js';
import {
  getTrainerPlan,
  enforceStudentCapAfterDowngrade,
  reactivateStudentsUpToCap,
} from './platform-plan-service.js';

const FREE_TIER = PLATFORM_PLAN_TIERS.FREE;

// Converts a plan cap into its API form (Infinity becomes null = unlimited).
function toApiStudentCap(tier) {
  const { studentCap } = PLAN_LIMITS[tier];
  return studentCap === Infinity ? null : studentCap;
}

// Builds the filter for one search token, matched against first name, last name or email.
function buildTokenFilter(token) {
  const contains = { contains: token, mode: 'insensitive' };
  return { OR: [{ firstName: contains }, { lastName: contains }, { email: contains }] };
}

// Builds the trainer list filter: live trainers/users, plus AND-ed whitespace-separated search tokens.
function buildListWhere(search) {
  const tokens = (search ?? '').split(/\s+/).filter(Boolean);
  const userFilter = { deletedAt: null };
  if (tokens.length > 0) userFilter.AND = tokens.map(buildTokenFilter);
  return { deletedAt: null, user: userFilter };
}

// Counts students active on the plan for each of the given trainers.
async function countActiveStudentsByTrainer(prisma, trainerIds) {
  if (trainerIds.length === 0) return new Map();

  const groups = await prisma.trainerStudent.groupBy({
    by: ['trainerId'],
    where: { trainerId: { in: trainerIds }, activeOnPlan: true },
    _count: { _all: true },
  });
  return new Map(groups.map((group) => [group.trainerId, group._count._all]));
}

// Maps a trainer row and its active student count to the list item shape.
function toTrainerListItem(trainer, activeStudents) {
  const subscription = trainer.platformSubscription;
  const tier = subscription?.tier ?? FREE_TIER;

  return {
    trainerId: trainer.id,
    userId: trainer.userId,
    firstName: trainer.user.firstName ?? null,
    lastName: trainer.user.lastName ?? null,
    email: trainer.user.email ?? null,
    tier,
    subscriptionStatus: subscription?.status ?? null,
    hasAsaasSubscription: Boolean(subscription?.asaasSubscriptionId),
    activeStudents,
    studentCap: toApiStudentCap(tier),
  };
}

// Lists trainers with their plan and student usage, paginated and searchable.
export async function listTrainers(prisma, { search, page = 1, pageSize = 20 } = {}) {
  const where = buildListWhere(search);

  const [trainers, total] = await Promise.all([
    prisma.trainer.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        user: { select: { firstName: true, lastName: true, email: true } },
        platformSubscription: { select: { tier: true, status: true, asaasSubscriptionId: true } },
      },
    }),
    prisma.trainer.count({ where }),
  ]);

  const activeCounts = await countActiveStudentsByTrainer(
    prisma,
    trainers.map((trainer) => trainer.id)
  );
  const items = trainers.map((trainer) => toTrainerListItem(trainer, activeCounts.get(trainer.id) ?? 0));

  return { items, total, page, pageSize };
}

// Persists the admin-chosen tier without touching Asaas, creating the row when missing.
function upsertTier(prisma, trainerId, tier) {
  return prisma.platformSubscription.upsert({
    where: { trainerId },
    create: { trainerId, tier, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE },
    update: { tier, status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE, pastDueSince: null },
  });
}

// Applies the student-cap side effect that matches the direction of the tier change.
async function applyCapSideEffects(prisma, trainerId, previousTier, tier) {
  if (isTierUpgrade(previousTier, tier)) {
    await reactivateStudentsUpToCap(prisma, trainerId);
  } else {
    await enforceStudentCapAfterDowngrade(prisma, trainerId);
  }
}

// Builds the change response from the persisted subscription and current active student count.
async function buildChangeResult(prisma, { trainerId, previousTier, tier, subscription, changed }) {
  const activeStudents = await prisma.trainerStudent.count({
    where: { trainerId, activeOnPlan: true },
  });

  return {
    trainerId,
    previousTier,
    tier,
    changed,
    subscriptionStatus: subscription?.status ?? PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
    hasAsaasSubscription: Boolean(subscription?.asaasSubscriptionId),
    activeStudents,
    studentCap: toApiStudentCap(tier),
  };
}

// Rejects BETA for trainers that still pay through Asaas, which would keep billing them.
function assertBetaAllowed(tier, subscription) {
  if (tier !== PLATFORM_PLAN_TIERS.BETA || !subscription?.asaasSubscriptionId) return;
  const { code, messageCode } = PLATFORM_PLAN_ERRORS.BETA_WITH_PAID_SUBSCRIPTION;
  throw new ConflictAppError({
    error: code,
    messageCode,
    message: 'Cannot set BETA on a trainer with an active paid subscription.',
    details: {},
  });
}

// Admin override of a trainer's plan tier (DB only, no billing provider call).
export async function setTrainerTier(prisma, { trainerId, tier }) {
  const trainer = await prisma.trainer.findUnique({
    where: { id: trainerId },
    select: { id: true, userId: true, deletedAt: true, user: { select: { deletedAt: true } } },
  });
  if (!trainer || trainer.deletedAt || trainer.user?.deletedAt) {
    throw new NotFoundAppError({ message: 'Trainer not found', details: {} });
  }

  const { tier: previousTier, subscription: currentSubscription } = await getTrainerPlan(prisma, trainerId);
  if (previousTier === tier) {
    return buildChangeResult(prisma, {
      trainerId,
      previousTier,
      tier,
      subscription: currentSubscription,
      changed: false,
    });
  }

  assertBetaAllowed(tier, currentSubscription);

  const subscription = await upsertTier(prisma, trainerId, tier);
  await applyCapSideEffects(prisma, trainerId, previousTier, tier);

  return buildChangeResult(prisma, { trainerId, previousTier, tier, subscription, changed: true });
}
