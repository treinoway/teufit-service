import { ConflictAppError, NotFoundAppError } from '../errors/app-error.js';
import {
  PLAN_LIMITS,
  PLATFORM_PLAN_ERRORS,
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
  isTierUpgrade,
} from '../constants/platform-plan.js';
import { ADMIN_ACCOUNT_TYPE, ADMIN_INVITE_STATUS } from '../constants/admin-trainer-list.js';
import { InviteStatus } from '../constants/trainer-invite.js';
import { Roles } from '../constants/roles.js';
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

// Splits the search string into AND-ed whitespace-separated token filters.
function buildSearchFilters(search) {
  return (search ?? '').split(/\s+/).filter(Boolean).map(buildTokenFilter);
}

// Escapes the Postgres ILIKE wildcards so an email is matched literally.
export function escapeLikePattern(value) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

// Matches users whose email equals any of the given emails, ignoring case.
function buildEmailMatchFilter(emails) {
  return {
    OR: emails.map((email) => ({ email: { equals: escapeLikePattern(email), mode: 'insensitive' } })),
  };
}

// Lists the emails that currently have a non-expired pending invite.
async function findPendingInviteEmails(prisma) {
  // why: pending/none filters inline every pending email into the user query; cost is bounded by beta-scale pending invites.
  const invites = await prisma.trainerInvite.findMany({
    where: { status: InviteStatus.PENDING, expiresAt: { gt: new Date() } },
    select: { email: true },
    distinct: ['email'],
  });
  return invites.map((invite) => invite.email);
}

// Builds the user-level filter for the requested invite status (accepted wins over pending).
async function buildInviteStatusFilter(prisma, inviteStatus) {
  if (!inviteStatus) return null;
  const redeemedAccepted = { invitesRedeemed: { some: { status: InviteStatus.ACCEPTED } } };
  if (inviteStatus === ADMIN_INVITE_STATUS.ACCEPTED) return redeemedAccepted;

  const notAccepted = { invitesRedeemed: { none: { status: InviteStatus.ACCEPTED } } };
  const pendingEmails = await findPendingInviteEmails(prisma);
  if (inviteStatus === ADMIN_INVITE_STATUS.PENDING) {
    return pendingEmails.length === 0 ? { id: { in: [] } } : { AND: [notAccepted, buildEmailMatchFilter(pendingEmails)] };
  }
  return pendingEmails.length === 0 ? notAccepted : { AND: [notAccepted, { NOT: buildEmailMatchFilter(pendingEmails) }] };
}

// Builds the filter for the user-based list: live trainers plus users who signed up without an invite.
function buildSignupBranchFilter() {
  return {
    trainer: { is: null },
    NOT: { roles: { hasSome: [Roles.TRAINER, Roles.ADMIN, Roles.NUTRITIONIST] } },
    invitesRedeemed: { none: { status: InviteStatus.ACCEPTED } },
    trainers: { none: {} },
  };
}

// Builds the where for the user-based list (trainers and signups).
function buildUserListWhere(searchFilters, inviteFilter) {
  const liveTrainer = { trainer: { is: { deletedAt: null } } };
  const conditions = [{ OR: [liveTrainer, buildSignupBranchFilter()] }, ...searchFilters];
  if (inviteFilter) conditions.push(inviteFilter);
  return { deletedAt: null, AND: conditions };
}

// Builds the trainer-table where: live trainers/users, search tokens and the optional invite filter.
function buildTrainerListWhere(searchFilters, inviteFilter) {
  const conditions = inviteFilter ? [...searchFilters, inviteFilter] : searchFilters;
  const userFilter = { deletedAt: null };
  if (conditions.length > 0) userFilter.AND = conditions;
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

// Fetches, in one query, the accepted invites redeemed by these users and pending ones for their emails.
async function findInvitesForUsers(prisma, users) {
  if (users.length === 0) return [];
  return prisma.trainerInvite.findMany({
    where: {
      OR: [
        { status: InviteStatus.ACCEPTED, userId: { in: users.map((user) => user.userId) } },
        {
          status: InviteStatus.PENDING,
          expiresAt: { gt: new Date() },
          ...buildEmailMatchFilter(users.map((user) => user.email).filter(Boolean)),
        },
      ],
    },
    select: { email: true, userId: true, status: true, createdAt: true, expiresAt: true },
    orderBy: { createdAt: 'desc' },
  });
}

// Indexes invites (newest first) by redeemer id for accepted and by lowercased email for pending.
function indexInvites(invites) {
  const acceptedByUserId = new Map();
  const pendingByEmail = new Map();
  for (const invite of invites) {
    if (invite.status === InviteStatus.ACCEPTED && invite.userId && !acceptedByUserId.has(invite.userId)) {
      acceptedByUserId.set(invite.userId, invite);
    }
    const emailKey = invite.email.toLowerCase();
    if (invite.status === InviteStatus.PENDING && !pendingByEmail.has(emailKey)) {
      pendingByEmail.set(emailKey, invite);
    }
  }
  return { acceptedByUserId, pendingByEmail };
}

// Resolves the invite state and send date of one user from the indexed invites.
function resolveInviteState(user, { acceptedByUserId, pendingByEmail }) {
  const accepted = acceptedByUserId.get(user.userId);
  if (accepted) return { inviteStatus: ADMIN_INVITE_STATUS.ACCEPTED, inviteSentAt: accepted.createdAt.toISOString() };
  const pending = user.email ? pendingByEmail.get(user.email.toLowerCase()) : null;
  if (pending) return { inviteStatus: ADMIN_INVITE_STATUS.PENDING, inviteSentAt: pending.createdAt.toISOString() };
  return { inviteStatus: ADMIN_INVITE_STATUS.NONE, inviteSentAt: null };
}

// Maps a trainer profile (with its user identity) and active student count to the list item shape.
function toTrainerListItem({ trainerId, userId, user, subscription }, activeStudents) {
  const tier = subscription?.tier ?? FREE_TIER;

  return {
    accountType: ADMIN_ACCOUNT_TYPE.TRAINER,
    trainerId,
    userId,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    email: user.email ?? null,
    tier,
    subscriptionStatus: subscription?.status ?? null,
    hasAsaasSubscription: Boolean(subscription?.asaasSubscriptionId),
    activeStudents,
    studentCap: toApiStudentCap(tier),
  };
}

// Maps a user without trainer profile to the signup list item shape (plan fields null).
function toSignupListItem(user) {
  return {
    accountType: ADMIN_ACCOUNT_TYPE.SIGNUP,
    trainerId: null,
    userId: user.id,
    firstName: user.firstName ?? null,
    lastName: user.lastName ?? null,
    email: user.email ?? null,
    tier: null,
    subscriptionStatus: null,
    hasAsaasSubscription: false,
    activeStudents: null,
    studentCap: null,
  };
}

// Adds invite state to the base items, using a single invite lookup for the page.
async function attachInviteState(prisma, baseItems) {
  const invites = await findInvitesForUsers(prisma, baseItems);
  const index = indexInvites(invites);
  return baseItems.map((item) => ({ ...item, ...resolveInviteState(item, index) }));
}

// Lists live trainers from the trainer table (default path).
async function listTrainerTable(prisma, { searchFilters, inviteFilter, page, pageSize }) {
  const where = buildTrainerListWhere(searchFilters, inviteFilter);

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

  const activeCounts = await countActiveStudentsByTrainer(prisma, trainers.map((trainer) => trainer.id));
  const baseItems = trainers.map((trainer) =>
    toTrainerListItem(
      { trainerId: trainer.id, userId: trainer.userId, user: trainer.user, subscription: trainer.platformSubscription },
      activeCounts.get(trainer.id) ?? 0
    )
  );
  return { baseItems, total };
}

// Lists trainers and signups from the user table, ordered by user creation date.
async function listUserTable(prisma, { searchFilters, inviteFilter, page, pageSize }) {
  const where = buildUserListWhere(searchFilters, inviteFilter);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip: (page - 1) * pageSize,
      take: pageSize,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        createdAt: true,
        trainer: {
          select: { id: true, platformSubscription: { select: { tier: true, status: true, asaasSubscriptionId: true } } },
        },
      },
    }),
    prisma.user.count({ where }),
  ]);

  const trainerIds = users.filter((user) => user.trainer).map((user) => user.trainer.id);
  const activeCounts = await countActiveStudentsByTrainer(prisma, trainerIds);
  const baseItems = users.map((user) =>
    user.trainer
      ? toTrainerListItem(
          { trainerId: user.trainer.id, userId: user.id, user, subscription: user.trainer.platformSubscription },
          activeCounts.get(user.trainer.id) ?? 0
        )
      : toSignupListItem(user)
  );
  return { baseItems, total };
}

// Lists trainers (plus signups without invite on request) with plan, student usage and invite state.
export async function listTrainers(
  prisma,
  { search, page = 1, pageSize = 20, includeSignups = false, inviteStatus } = {}
) {
  const options = {
    searchFilters: buildSearchFilters(search),
    inviteFilter: await buildInviteStatusFilter(prisma, inviteStatus),
    page,
    pageSize,
  };
  const { baseItems, total } = includeSignups
    ? await listUserTable(prisma, options)
    : await listTrainerTable(prisma, options);

  return { items: await attachInviteState(prisma, baseItems), total, page, pageSize };
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
