import { AppError } from '../errors/app-error.js';
import {
  AppearAs,
  CONSISTENCY_PRIVACY_TERM_VERSION,
  ConsistencyErrorCode,
  ConsistencyMessageCode,
  appearAsChoiceValues,
} from '../constants/consistency-ranking.js';

// Choice a stored row stands for: pending when absent or accepted under another term version
function appearAsOf(row) {
  if (!row || row.termVersion !== CONSISTENCY_PRIVACY_TERM_VERSION) return AppearAs.PENDING;
  return row.appearAs;
}

/**
 * How the student appears to the other participants, one choice for every championship (APP-21).
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @returns {Promise<{ appearAs: string, termVersion: string, acceptedAt: Date|null }>} appearAs is one of AppearAs; termVersion is the current one
 */
export async function getPrivacy(prisma, studentId) {
  const row = await prisma.consistencyPrivacyPref.findUnique({ where: { studentId } });
  const appearAs = appearAsOf(row);
  return {
    appearAs,
    termVersion: CONSISTENCY_PRIVACY_TERM_VERSION,
    acceptedAt: appearAs === AppearAs.PENDING ? null : row.acceptedAt,
  };
}

// 400 for a choice other than name or anonymous, or a term version other than the current one
function assertValidChoice(appearAs, termVersion) {
  if (appearAsChoiceValues.includes(appearAs) && termVersion === CONSISTENCY_PRIVACY_TERM_VERSION) return;
  throw new AppError({
    httpStatus: 400,
    error: ConsistencyErrorCode.PRIVACY_INVALID,
    messageCode: ConsistencyMessageCode.PRIVACY_INVALID,
    message: 'Choose name or anonymous under the current privacy term version',
    details: { appearAs, termVersion, currentTermVersion: CONSISTENCY_PRIVACY_TERM_VERSION },
  });
}

/**
 * Stores the student's choice with the date and the term version; storing it again only moves the date (APP-21, APP-23).
 *
 * @param {object} prisma
 * @param {string} studentId - User.id
 * @param {string} appearAs - "name" or "anonymous"
 * @param {string} termVersion - must be the current term version
 * @param {Date} [now]
 * @returns {Promise<{ appearAs: string, termVersion: string, acceptedAt: Date }>}
 */
export async function setPrivacy(prisma, studentId, appearAs, termVersion, now = new Date()) {
  assertValidChoice(appearAs, termVersion);
  const choice = { appearAs, termVersion, acceptedAt: now };
  const row = await prisma.consistencyPrivacyPref.upsert({
    where: { studentId },
    create: { studentId, ...choice },
    update: choice,
  });
  return { appearAs: row.appearAs, termVersion: row.termVersion, acceptedAt: row.acceptedAt };
}

/**
 * Choice of each student (pending when absent or outdated), keyed by student id.
 *
 * @param {object} prisma
 * @param {string[]} studentIds
 * @returns {Promise<Map<string, string>>} one of AppearAs per student
 */
export async function privacyByStudent(prisma, studentIds) {
  if (studentIds.length === 0) return new Map();
  const rows = await prisma.consistencyPrivacyPref.findMany({ where: { studentId: { in: studentIds } } });
  const stored = new Map(rows.map((row) => [row.studentId, row]));
  return new Map(studentIds.map((studentId) => [studentId, appearAsOf(stored.get(studentId))]));
}

/**
 * How many of the students appear by name, as "Aluno do time" by choice, and still have to answer (APP-36).
 *
 * @param {object} prisma
 * @param {string[]} studentIds
 * @returns {Promise<{ name: number, anonymous: number, pending: number }>}
 */
export async function privacyCountsFor(prisma, studentIds) {
  const choices = await privacyByStudent(prisma, studentIds);
  const counts = { [AppearAs.NAME]: 0, [AppearAs.ANONYMOUS]: 0, [AppearAs.PENDING]: 0 };
  for (const appearAs of choices.values()) counts[appearAs] += 1;
  return counts;
}
