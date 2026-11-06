import { AppError, NotFoundAppError, ValidationAppError } from '../errors/app-error.js';
import {
  FEEDBACK_DEFAULT_TIER,
  FEEDBACK_ERROR_CODES,
  FEEDBACK_MESSAGE_CODES,
  FEEDBACK_STATUSES,
  FEEDBACK_USER_AGENT_MAX_LENGTH,
} from '../constants/feedback.js';

const feedbackItemSelect = {
  id: true,
  category: true,
  message: true,
  pagePath: true,
  viewport: true,
  userAgent: true,
  status: true,
  createdAt: true,
  readAt: true,
  trainer: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true, email: true } },
      platformSubscription: { select: { tier: true } },
    },
  },
};

// Joins the non-empty name parts of a user into a display name.
function formatTrainerName(user) {
  return [user.firstName, user.lastName].filter(Boolean).join(' ');
}

// Maps a feedback row with its trainer relation to the admin list item shape.
function formatFeedbackItem(row) {
  return {
    id: row.id,
    category: row.category,
    message: row.message,
    pagePath: row.pagePath,
    viewport: row.viewport,
    userAgent: row.userAgent,
    status: row.status,
    createdAt: row.createdAt,
    readAt: row.readAt,
    trainer: {
      id: row.trainer.id,
      name: formatTrainerName(row.trainer.user),
      email: row.trainer.user.email,
      tier: row.trainer.platformSubscription?.tier ?? FEEDBACK_DEFAULT_TIER,
    },
  };
}

// Returns the trimmed message or throws a validation error when nothing is left.
function requireMessage(message) {
  const trimmed = message.trim();
  if (!trimmed) {
    throw new ValidationAppError({
      messageCode: FEEDBACK_MESSAGE_CODES.VALIDATION_FAILED,
      message: 'Feedback message must not be blank',
      details: [{ field: 'message', message: 'must not be blank' }],
    });
  }
  return trimmed;
}

// Truncates the user agent to its storable length, or null when absent.
function normalizeUserAgent(userAgent) {
  return userAgent ? userAgent.slice(0, FEEDBACK_USER_AGENT_MAX_LENGTH) : null;
}

// Stores a feedback entry for the trainer owned by the given user.
export async function createFeedback(prisma, userId, input, meta = {}) {
  const message = requireMessage(input.message);
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } });
  if (!trainer) {
    throw new NotFoundAppError({
      error: 'TRAINER_NOT_FOUND',
      messageCode: FEEDBACK_MESSAGE_CODES.TRAINER_NOT_FOUND,
      message: 'Trainer profile not found',
      details: {},
    });
  }

  return prisma.trainerFeedback.create({
    data: {
      trainerId: trainer.id,
      category: input.category,
      message,
      pagePath: input.pagePath ?? null,
      viewport: input.viewport ?? null,
      userAgent: normalizeUserAgent(meta.userAgent),
    },
    select: { id: true, createdAt: true },
  });
}

// Builds the Prisma where clause from the optional status/category filters.
function buildListWhere({ status, category }) {
  return {
    ...(status ? { status } : {}),
    ...(category ? { category } : {}),
  };
}

// Lists feedback newest first with trainer identity and pagination metadata.
export async function listFeedbacks(prisma, { status, category, page, pageSize }) {
  const where = buildListWhere({ status, category });
  const [rows, total] = await Promise.all([
    prisma.trainerFeedback.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
      select: feedbackItemSelect,
    }),
    prisma.trainerFeedback.count({ where }),
  ]);

  return { items: rows.map(formatFeedbackItem), total, page, pageSize };
}

// Marks a feedback entry as read or new, setting or clearing readAt.
export async function updateFeedbackStatus(prisma, id, status) {
  const existing = await prisma.trainerFeedback.findUnique({ where: { id }, select: { id: true } });
  if (!existing) {
    throw new AppError({
      httpStatus: 404,
      error: FEEDBACK_ERROR_CODES.NOT_FOUND,
      messageCode: FEEDBACK_MESSAGE_CODES.NOT_FOUND,
      message: 'Feedback not found',
      details: {},
    });
  }

  const row = await prisma.trainerFeedback.update({
    where: { id },
    data: { status, readAt: status === FEEDBACK_STATUSES.READ ? new Date() : null },
    select: feedbackItemSelect,
  });
  return formatFeedbackItem(row);
}
