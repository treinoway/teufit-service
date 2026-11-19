import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendDueFeedbacks } from '../../src/services/student-feedback-scheduler-service.js';
import { StudentFeedbackMilestone } from '../../src/constants/student-feedback.js';
import {
  OTHER_STUDENT_ID,
  STUDENT_ID,
  TRAINER_ID,
  createFeedbackWorld,
  seedConfig,
  seedLink,
  seedRequest,
  seedUser,
} from '../helpers/student-feedback-world.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const LINK_PAGE_SIZE = 200;
const TWO_PAGES_OF_LINKS = LINK_PAGE_SIZE + 5;
const MANY_LINKS_TIMEOUT_MS = 30000;
const REQUEST_MODEL = 'studentFeedbackRequest';
const TEMPLATE_MODEL = 'studentFeedbackTemplate';
const TEMPLATE_LOOKUP_METHODS = ['findFirst', 'findUnique', 'findMany', 'findFirstOrThrow', 'findUniqueOrThrow'];
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
// 09:00 America/Sao_Paulo seven days after the link
const D7_DUE = new Date('2026-11-08T12:00:00Z');
const NOW = new Date(D7_DUE.getTime() + HOUR_MS);
const NEXT_TICK = new Date(NOW.getTime() + HOUR_MS / 4);
// Linked the day before: no milestone reached yet
const LINKED_YESTERDAY = new Date(NOW.getTime() - DAY_MS);

// Id whose zero-padded sequence keeps the lexicographic order equal to the creation order
function sequenceId(prefix, index) {
  return `${prefix}-${String(index).padStart(4, '0')}`;
}

// Seeds `count` students linked to the main trainer with explicit ordered link ids, numbered from `from`; returns the student ids
function seedLinkedStudents(world, count, { from = 1, createdAt = LINKED_AT } = {}) {
  const studentIds = [];
  for (let index = from; index < from + count; index += 1) {
    const studentId = sequenceId('student', index);
    seedUser(world, studentId, 'Aluno');
    world.seed('trainerStudent', { id: sequenceId('link', index), trainerId: TRAINER_ID, studentId, createdAt, activeOnPlan: true });
    studentIds.push(studentId);
  }
  return studentIds;
}

// Number of stored requests per student id
function requestCountByStudent(world) {
  const counts = new Map();
  for (const row of world.rows(REQUEST_MODEL)) counts.set(row.studentId, (counts.get(row.studentId) ?? 0) + 1);
  return counts;
}

// Spies on every read method of the template delegate, so the count does not depend on which one the code uses
function spyOnTemplateLookups(world) {
  const templates = world.prisma.studentFeedbackTemplate;
  return TEMPLATE_LOOKUP_METHODS.map((method) => vi.spyOn(templates, method));
}

// Total number of calls of a list of spies
function callCount(spies) {
  return spies.reduce((total, spy) => total + spy.mock.calls.length, 0);
}

// Makes the creation of the request of one student fail while the others go through
function failCreationFor(world, studentId, failure) {
  const requests = world.prisma.studentFeedbackRequest;
  const create = requests.create;
  vi.spyOn(requests, 'create').mockImplementation(async (args) => {
    if (args.data.studentId === studentId) throw failure;
    return create(args);
  });
}

vi.setConfig({ testTimeout: MANY_LINKS_TIMEOUT_MS });

describe('student feedback scheduler review fixes', () => {
  let world;
  let emailSender;
  let logger;

  beforeEach(() => {
    world = createFeedbackWorld();
    seedConfig(world);
    emailSender = {
      sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
    };
    logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  });

  describe('paging of the links', () => {
    it('creates exactly one request and one e-mail for every due student beyond the first page', async () => {
      const studentIds = seedLinkedStudents(world, TWO_PAGES_OF_LINKS);

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: TWO_PAGES_OF_LINKS });
      const counts = requestCountByStudent(world);
      expect(counts.size).toBe(TWO_PAGES_OF_LINKS);
      expect(studentIds.every((studentId) => counts.get(studentId) === 1)).toBe(true);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(TWO_PAGES_OF_LINKS);
    });

    it('reads the links in pages of 200, each one after the last id of the previous page', async () => {
      seedLinkedStudents(world, TWO_PAGES_OF_LINKS);
      const findLinks = vi.spyOn(world.prisma.trainerStudent, 'findMany');

      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(findLinks).toHaveBeenCalledTimes(2);
      const pages = findLinks.mock.calls.map(([args]) => args);
      expect(pages.every((args) => args.take === LINK_PAGE_SIZE)).toBe(true);
      expect(pages.map((args) => args.where.id)).toEqual([undefined, { gt: sequenceId('link', LINK_PAGE_SIZE) }]);
    });

    it('reads a single page when it is not full', async () => {
      seedLinkedStudents(world, 5);
      const findLinks = vi.spyOn(world.prisma.trainerStudent, 'findMany');

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 5 });
      expect(findLinks).toHaveBeenCalledTimes(1);
    });

    it('ends on an empty second page when the links fill exactly one page', async () => {
      seedLinkedStudents(world, LINK_PAGE_SIZE);
      const findLinks = vi.spyOn(world.prisma.trainerStudent, 'findMany');

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: LINK_PAGE_SIZE });
      expect(findLinks).toHaveBeenCalledTimes(2);
    });

    it('reaches a due student on the second page when nobody on the first page is due', async () => {
      seedLinkedStudents(world, LINK_PAGE_SIZE, { createdAt: LINKED_YESTERDAY });
      const [dueStudentId] = seedLinkedStudents(world, 1, { from: LINK_PAGE_SIZE + 1 });

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      expect(world.rows(REQUEST_MODEL).map((row) => row.studentId)).toEqual([dueStudentId]);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
    });
  });

  describe('batch pre-filter', () => {
    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    it('opens no transaction on a later tick for a milestone that was already sent', async () => {
      const transaction = vi.spyOn(world.prisma, '$transaction');
      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);
      expect(transaction).toHaveBeenCalledTimes(1);

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NEXT_TICK);

      expect(result).toEqual({ created: 0 });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
    });

    it('skips a link whose student has an open request without opening a transaction', async () => {
      seedRequest(world, { milestone: StudentFeedbackMilestone.ADHOC, sentAt: new Date(NOW.getTime() - DAY_MS) });
      const transaction = vi.spyOn(world.prisma, '$transaction');

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 0 });
      expect(transaction).not.toHaveBeenCalled();
      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });

    it('opens a transaction only for the student that nothing blocks', async () => {
      seedLink(world, { studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });
      seedRequest(world, { milestone: StudentFeedbackMilestone.ADHOC, sentAt: new Date(NOW.getTime() - DAY_MS) });
      const transaction = vi.spyOn(world.prisma, '$transaction');

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 1 });
      expect(transaction).toHaveBeenCalledTimes(1);
      expect(world.rows(REQUEST_MODEL).map((row) => [row.studentId, row.milestone])).toEqual([
        [STUDENT_ID, StudentFeedbackMilestone.ADHOC],
        [OTHER_STUDENT_ID, StudentFeedbackMilestone.D7],
      ]);
    });

    it('looks the blocking requests of a whole page up with a single query', async () => {
      seedLinkedStudents(world, 5);
      const findRequests = vi.spyOn(world.prisma.studentFeedbackRequest, 'findMany');

      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(findRequests).toHaveBeenCalledTimes(1);
    });

    it('does not query the requests when no link is due', async () => {
      world.rows('trainerStudent')[0].createdAt = LINKED_YESTERDAY;
      const findRequests = vi.spyOn(world.prisma.studentFeedbackRequest, 'findMany');
      const transaction = vi.spyOn(world.prisma, '$transaction');

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 0 });
      expect(findRequests).not.toHaveBeenCalled();
      expect(transaction).not.toHaveBeenCalled();
    });

    it('creates nothing when the milestone request shows up between the pre-filter and the lock', async () => {
      seedRequest(world, { sentAt: D7_DUE, dueAt: D7_DUE });
      vi.spyOn(world.prisma.studentFeedbackRequest, 'findMany').mockResolvedValueOnce([]);

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 0 });
      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });

    it('creates nothing and sends no e-mail while another instance holds the lock of the pair', async () => {
      vi.spyOn(world.prisma, '$queryRaw').mockResolvedValue([{ locked: false }]);

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 0 });
      expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('template lookups', () => {
    it('do not grow with the number of due links of one trainer', async () => {
      const smallWorld = createFeedbackWorld();
      seedConfig(smallWorld);
      seedLinkedStudents(smallWorld, 1);
      const smallRunLookups = spyOnTemplateLookups(smallWorld);
      await sendDueFeedbacks(smallWorld.prisma, emailSender, logger, NOW);
      seedLinkedStudents(world, TWO_PAGES_OF_LINKS);
      const largeRunLookups = spyOnTemplateLookups(world);

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: TWO_PAGES_OF_LINKS });
      expect(callCount(smallRunLookups)).toBeGreaterThan(0);
      expect(callCount(largeRunLookups)).toBe(callCount(smallRunLookups));
    });

    it('do not happen when nothing is due', async () => {
      seedLinkedStudents(world, 3, { createdAt: LINKED_YESTERDAY });
      const lookups = spyOnTemplateLookups(world);

      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(callCount(lookups)).toBe(0);
    });

    it('do not happen when every due link is already blocked', async () => {
      seedLink(world, { createdAt: LINKED_AT });
      seedRequest(world, { sentAt: D7_DUE, dueAt: D7_DUE });
      const lookups = spyOnTemplateLookups(world);

      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(callCount(lookups)).toBe(0);
    });

    it('logs nothing about a missing template while nothing is due', async () => {
      world.rows(TEMPLATE_MODEL).splice(0);
      seedLinkedStudents(world, 3, { createdAt: LINKED_YESTERDAY });

      await expect(sendDueFeedbacks(world.prisma, emailSender, logger, NOW)).resolves.toEqual({ created: 0 });

      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('per-link error isolation', () => {
    it('keeps creating the requests of the other students when one creation throws, and logs the failing pair', async () => {
      const [first, failing, last] = seedLinkedStudents(world, 3);
      const failure = new TypeError('connection reset');
      failCreationFor(world, failing, failure);

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: 2 });
      expect(world.rows(REQUEST_MODEL).map((row) => row.studentId)).toEqual([first, last]);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(2);
      expect(logger.error).toHaveBeenCalledExactlyOnceWith({ err: failure, trainerId: TRAINER_ID, studentId: failing }, expect.any(String));
    });

    it('still sends the next page after a failure on the first one', async () => {
      const [failing] = seedLinkedStudents(world, LINK_PAGE_SIZE + 1);
      failCreationFor(world, failing, new TypeError('connection reset'));

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);

      expect(result).toEqual({ created: LINK_PAGE_SIZE });
      expect(requestCountByStudent(world).has(sequenceId('student', LINK_PAGE_SIZE + 1))).toBe(true);
    });

    it('creates the failed request on the next tick', async () => {
      const [failing] = seedLinkedStudents(world, 2);
      failCreationFor(world, failing, new TypeError('connection reset'));
      await sendDueFeedbacks(world.prisma, emailSender, logger, NOW);
      vi.restoreAllMocks();

      const result = await sendDueFeedbacks(world.prisma, emailSender, logger, NEXT_TICK);

      expect(result).toEqual({ created: 1 });
      expect(requestCountByStudent(world).get(failing)).toBe(1);
    });
  });
});
