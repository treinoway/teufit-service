import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  countUnread,
  getStudentHistory,
  listInbox,
  markAsRead,
  sendAdhocFeedback,
} from '../../src/services/student-feedback-trainer-service.js';
import { submitFeedback } from '../../src/services/student-feedback-student-service.js';
import {
  StudentFeedbackBand,
  StudentFeedbackErrorCode,
  StudentFeedbackInboxFilter,
  StudentFeedbackMessageCode,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import {
  OTHER_STUDENT_ID,
  OTHER_TRAINER_ID,
  QuestionId,
  STUDENT_ID,
  TEMPLATE_ID,
  TRAINER_ID,
  createFeedbackWorld,
  seedLink,
  seedPublishedMealPlan,
  seedRequest,
  seedUser,
} from '../helpers/student-feedback-world.js';

const HOUR_MS = 3600000;
const DAY_MS = 24 * HOUR_MS;
const REQUEST_MODEL = 'studentFeedbackRequest';
const NOW = new Date('2026-12-01T15:00:00Z');
const LINKED_AT = new Date('2026-09-01T15:00:00Z');
const UNLINKED_STUDENT_ID = 'student-carla';
const UNKNOWN_ID = 'request-unknown';
const REPORT_TEXT = 'Senti dor no joelho no agachamento';
// Pillars 80, 75, 70 (inverted) and 90: index 79, good
const GOOD_ANSWERS = Object.freeze([
  { questionId: QuestionId.TRAINING, score: 8 },
  { questionId: QuestionId.SLEEP, score: 4 },
  { questionId: QuestionId.ROUTINE, score: 3 },
  { questionId: QuestionId.EVOLUTION, score: 9 },
  { questionId: QuestionId.REPORT, text: REPORT_TEXT },
]);
const GOOD_INDEX = 79;
// Pillars 20, 25, 20 (inverted) and 30: index 24, attention
const LOW_ANSWERS = Object.freeze([
  { questionId: QuestionId.TRAINING, score: 2 },
  { questionId: QuestionId.SLEEP, score: 2 },
  { questionId: QuestionId.ROUTINE, score: 8 },
  { questionId: QuestionId.EVOLUTION, score: 3 },
]);
const LOW_INDEX = 24;

// Instant the given number of days before NOW, at 09:00 America/Sao_Paulo
function daysAgo(days) {
  return new Date(Date.UTC(2026, 11, 1 - days, 12, 0, 0));
}

// Awaits the rejection and asserts the student-feedback error of the given key and HTTP status
async function expectFeedbackError(promise, key, httpStatus) {
  const error = await promise.then(
    () => null,
    (caught) => caught,
  );
  expect(error).not.toBeNull();
  expect(error.httpStatus).toBe(httpStatus);
  expect(error.error).toBe(StudentFeedbackErrorCode[key]);
  expect(error.messageCode).toBe(StudentFeedbackMessageCode[key]);
}

// Seeds a pending request and has its student submit the answers two hours after it was sent
async function seedAnswered(world, { answers, ...request }) {
  const row = seedRequest(world, request);
  await submitFeedback(world.prisma, row.studentId, row.id, { answers }, new Date(row.sentAt.getTime() + 2 * HOUR_MS));
  return row;
}

// Seeds the inbox scenario of the main trainer and returns its requests by name
async function seedInbox(world) {
  const anaD15 = await seedAnswered(world, { milestone: StudentFeedbackMilestone.D15, sentAt: daysAgo(6), answers: GOOD_ANSWERS });
  const brunoD7 = await seedAnswered(world, { studentId: OTHER_STUDENT_ID, sentAt: daysAgo(11), answers: LOW_ANSWERS });
  brunoD7.readAt = daysAgo(10);
  const anaD7 = seedRequest(world, { sentAt: daysAgo(14), status: StudentFeedbackStatus.EXPIRED });
  const brunoAdhoc = seedRequest(world, { studentId: OTHER_STUDENT_ID, milestone: StudentFeedbackMilestone.ADHOC, sentAt: daysAgo(1) });
  const anaOld = seedRequest(world, { milestone: StudentFeedbackMilestone.RECURRING, sentAt: daysAgo(52), status: StudentFeedbackStatus.EXPIRED });
  const otherTrainer = await seedAnswered(world, { trainerId: OTHER_TRAINER_ID, sentAt: daysAgo(5), answers: GOOD_ANSWERS });
  return { anaD15, brunoD7, anaD7, brunoAdhoc, anaOld, otherTrainer };
}

// Ids of the items of an inbox answer, in order
function idsOf(inbox) {
  return inbox.items.map((item) => item.id);
}

describe('student feedback trainer service', () => {
  let world;
  let emailSender;

  beforeEach(() => {
    world = createFeedbackWorld();
    seedLink(world, { createdAt: LINKED_AT });
    seedLink(world, { studentId: OTHER_STUDENT_ID, createdAt: LINKED_AT });
    seedLink(world, { trainerId: OTHER_TRAINER_ID, createdAt: LINKED_AT });
    emailSender = {
      sendStudentFeedbackRequestEmail: vi.fn().mockResolvedValue(undefined),
      sendStudentFeedbackReminderEmail: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('listInbox', () => {
    it('returns an empty inbox with null rates and zero counts when nothing was sent', async () => {
      const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

      expect(inbox).toEqual({
        summary: { responseRate30d: null, averageIndex: null, unansweredCount: 0, unreadCount: 0 },
        items: [],
      });
    });

    describe('with requests', () => {
      let requests;

      beforeEach(async () => {
        requests = await seedInbox(world);
      });

      it('lists only the requests of the trainer, most recently sent first', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.ALL }, NOW);

        expect(idsOf(inbox)).toEqual([requests.brunoAdhoc.id, requests.anaD15.id, requests.brunoD7.id, requests.anaD7.id, requests.anaOld.id]);
      });

      it('lists everything when no filter is given', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(inbox.items).toHaveLength(5);
      });

      it('returns an answered item with student, dates, index and band', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(inbox.items[1]).toMatchObject({
          id: requests.anaD15.id,
          student: { id: STUDENT_ID, name: 'Ana Silva', avatarUrl: null },
          milestone: StudentFeedbackMilestone.D15,
          status: StudentFeedbackStatus.ANSWERED,
          sentAt: requests.anaD15.sentAt,
          expiresAt: requests.anaD15.expiresAt,
          submittedAt: new Date(requests.anaD15.sentAt.getTime() + 2 * HOUR_MS),
          readAt: null,
          overallIndex: GOOD_INDEX,
          band: StudentFeedbackBand.GOOD,
        });
      });

      it('returns a pending item without submit date, index or band', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(inbox.items[0]).toMatchObject({
          id: requests.brunoAdhoc.id,
          student: { id: OTHER_STUDENT_ID, name: 'Bruno Silva' },
          milestone: StudentFeedbackMilestone.ADHOC,
          status: StudentFeedbackStatus.PENDING,
          submittedAt: null,
          readAt: null,
          overallIndex: null,
          band: null,
        });
      });

      it('keeps the read date of an item already read', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(inbox.items[2]).toMatchObject({ id: requests.brunoD7.id, readAt: daysAgo(10), overallIndex: LOW_INDEX, band: StudentFeedbackBand.ATTENTION });
      });

      it('filters the unread ones: answered and not yet read', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNREAD }, NOW);

        expect(idsOf(inbox)).toEqual([requests.anaD15.id]);
      });

      it('filters the unanswered ones: expired', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNANSWERED }, NOW);

        expect(idsOf(inbox)).toEqual([requests.anaD7.id, requests.anaOld.id]);
      });

      it('filters by milestone', async () => {
        const inbox = await listInbox(world.prisma, TRAINER_ID, { milestone: StudentFeedbackMilestone.D7 }, NOW);

        expect(idsOf(inbox)).toEqual([requests.brunoD7.id, requests.anaD7.id]);
      });

      it('combines the status and milestone filters', async () => {
        const unreadD7 = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNREAD, milestone: StudentFeedbackMilestone.D7 }, NOW);
        const unansweredD7 = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNANSWERED, milestone: StudentFeedbackMilestone.D7 }, NOW);

        expect(idsOf(unreadD7)).toEqual([]);
        expect(idsOf(unansweredD7)).toEqual([requests.anaD7.id]);
      });

      it('summarises the average index of the answered ones and the unanswered and unread counts', async () => {
        const { summary } = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(summary).toMatchObject({ averageIndex: Math.round((GOOD_INDEX + LOW_INDEX) / 2), unansweredCount: 2, unreadCount: 1 });
      });

      it('keeps the summary of the whole inbox whatever the filters', async () => {
        const all = await listInbox(world.prisma, TRAINER_ID, {}, NOW);
        const filtered = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNREAD, milestone: StudentFeedbackMilestone.D7 }, NOW);

        expect(filtered.summary).toEqual(all.summary);
      });

      it('shows the other trainer only its own request', async () => {
        const inbox = await listInbox(world.prisma, OTHER_TRAINER_ID, {}, NOW);

        expect(idsOf(inbox)).toEqual([requests.otherTrainer.id]);
        expect(inbox.summary).toMatchObject({ unansweredCount: 0, unreadCount: 1, averageIndex: GOOD_INDEX });
      });
    });

    describe('response rate', () => {
      it('is the share of answered among the requests sent in the last 30 days', async () => {
        await seedAnswered(world, { sentAt: daysAgo(6), answers: GOOD_ANSWERS });
        await seedAnswered(world, { studentId: OTHER_STUDENT_ID, sentAt: daysAgo(11), answers: LOW_ANSWERS });
        seedRequest(world, { sentAt: daysAgo(20), status: StudentFeedbackStatus.EXPIRED });
        seedRequest(world, { sentAt: daysAgo(40), status: StudentFeedbackStatus.EXPIRED });

        const { summary } = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(summary.responseRate30d).toBe(67);
      });

      it('is 100 when everything sent in the last 30 days was answered', async () => {
        await seedAnswered(world, { sentAt: daysAgo(6), answers: GOOD_ANSWERS });
        seedRequest(world, { sentAt: daysAgo(40), status: StudentFeedbackStatus.EXPIRED });

        const { summary } = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(summary.responseRate30d).toBe(100);
      });

      it('is 0 when nothing sent in the last 30 days was answered', async () => {
        seedRequest(world, { sentAt: daysAgo(20), status: StudentFeedbackStatus.EXPIRED });

        const { summary } = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(summary.responseRate30d).toBe(0);
        expect(summary.averageIndex).toBeNull();
      });

      it('is null when nothing was sent in the last 30 days', async () => {
        seedRequest(world, { sentAt: daysAgo(40), status: StudentFeedbackStatus.EXPIRED });

        const { summary } = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

        expect(summary.responseRate30d).toBeNull();
      });
    });
  });

  describe('countUnread', () => {
    it('is zero without requests', async () => {
      expect(await countUnread(world.prisma, TRAINER_ID)).toEqual({ count: 0 });
    });

    it('counts the answered requests of the trainer that were not read', async () => {
      await seedInbox(world);
      await seedAnswered(world, { milestone: StudentFeedbackMilestone.D21, sentAt: daysAgo(2), answers: LOW_ANSWERS });

      expect(await countUnread(world.prisma, TRAINER_ID)).toEqual({ count: 2 });
      expect(await countUnread(world.prisma, OTHER_TRAINER_ID)).toEqual({ count: 1 });
    });
  });

  describe('markAsRead', () => {
    let requests;

    beforeEach(async () => {
      requests = await seedInbox(world);
    });

    it('stamps the read date and returns it', async () => {
      const result = await markAsRead(world.prisma, TRAINER_ID, requests.anaD15.id, NOW);

      expect(result).toMatchObject({ id: requests.anaD15.id, readAt: NOW });
      expect(requests.anaD15.readAt).toEqual(NOW);
    });

    it('takes the request out of the unread count and the unread filter', async () => {
      await markAsRead(world.prisma, TRAINER_ID, requests.anaD15.id, NOW);

      expect(await countUnread(world.prisma, TRAINER_ID)).toEqual({ count: 0 });
      expect(idsOf(await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNREAD }, NOW))).toEqual([]);
    });

    it('keeps the first read date when marked again', async () => {
      await markAsRead(world.prisma, TRAINER_ID, requests.anaD15.id, NOW);

      const again = await markAsRead(world.prisma, TRAINER_ID, requests.anaD15.id, new Date(NOW.getTime() + HOUR_MS));

      expect(again).toMatchObject({ id: requests.anaD15.id, readAt: NOW });
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for the request of another trainer and leaves it unread', async () => {
      await expectFeedbackError(markAsRead(world.prisma, TRAINER_ID, requests.otherTrainer.id, NOW), 'NOT_FOUND', 404);

      expect(requests.otherTrainer.readAt).toBeNull();
    });

    it('answers STUDENT_FEEDBACK_NOT_FOUND for an unknown request', async () => {
      await expectFeedbackError(markAsRead(world.prisma, TRAINER_ID, UNKNOWN_ID, NOW), 'NOT_FOUND', 404);
    });
  });

  describe('getStudentHistory', () => {
    let requests;

    beforeEach(async () => {
      requests = await seedInbox(world);
    });

    it('returns the student and the feedbacks of this trainer, oldest first', async () => {
      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

      expect(history.student).toMatchObject({ id: STUDENT_ID, name: 'Ana Silva', avatarUrl: null });
      expect(history.feedbacks.map((feedback) => feedback.id)).toEqual([requests.anaOld.id, requests.anaD7.id, requests.anaD15.id]);
    });

    it('returns the header of each feedback', async () => {
      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

      expect(history.feedbacks[2]).toMatchObject({
        id: requests.anaD15.id,
        milestone: StudentFeedbackMilestone.D15,
        status: StudentFeedbackStatus.ANSWERED,
        sentAt: requests.anaD15.sentAt,
        expiresAt: requests.anaD15.expiresAt,
        submittedAt: new Date(requests.anaD15.sentAt.getTime() + 2 * HOUR_MS),
        readAt: null,
        overallIndex: GOOD_INDEX,
        band: StudentFeedbackBand.GOOD,
      });
    });

    it('returns the score of every scored pillar of an answered feedback', async () => {
      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

      const pillars = history.feedbacks[2].pillars.map(({ pillar, score }) => ({ pillar, score }));
      expect(pillars).toHaveLength(4);
      expect(pillars).toEqual(
        expect.arrayContaining([
          { pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, score: 80 },
          { pillar: StudentFeedbackPillar.SLEEP, score: 75 },
          { pillar: StudentFeedbackPillar.ROUTINE, score: 70 },
          { pillar: StudentFeedbackPillar.EVOLUTION, score: 90 },
        ]),
      );
    });

    it('returns the open answers with their question text and pillar', async () => {
      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

      expect(history.feedbacks[2].openAnswers).toEqual([
        expect.objectContaining({
          questionId: QuestionId.REPORT,
          question: 'Quer contar algo ao teu treinador?',
          pillar: StudentFeedbackPillar.REPORT,
          text: REPORT_TEXT,
        }),
      ]);
    });

    it('returns an unanswered feedback without index, pillars or open answers', async () => {
      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

      expect(history.feedbacks[1]).toMatchObject({
        id: requests.anaD7.id,
        status: StudentFeedbackStatus.EXPIRED,
        submittedAt: null,
        overallIndex: null,
        band: null,
        pillars: [],
        openAnswers: [],
      });
    });

    it('flags hasPending only for a student with an open request', async () => {
      const ana = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);
      const bruno = await getStudentHistory(world.prisma, TRAINER_ID, OTHER_STUDENT_ID, NOW);

      expect(ana.hasPending).toBe(false);
      expect(bruno.hasPending).toBe(true);
    });

    it('shows another trainer of the same student only the feedbacks it sent', async () => {
      const history = await getStudentHistory(world.prisma, OTHER_TRAINER_ID, STUDENT_ID, NOW);

      expect(history.feedbacks.map((feedback) => feedback.id)).toEqual([requests.otherTrainer.id]);
      expect(history.hasPending).toBe(false);
    });

    it('rejects with 404 a student who is not linked to the trainer', async () => {
      seedUser(world, UNLINKED_STUDENT_ID, 'Carla');

      const error = await getStudentHistory(world.prisma, TRAINER_ID, UNLINKED_STUDENT_ID, NOW).then(
        () => null,
        (caught) => caught,
      );

      expect(error).not.toBeNull();
      expect(error.httpStatus).toBe(404);
    });

    it('rejects with 404 the student of another trainer', async () => {
      const error = await getStudentHistory(world.prisma, OTHER_TRAINER_ID, OTHER_STUDENT_ID, NOW).then(
        () => null,
        (caught) => caught,
      );

      expect(error).not.toBeNull();
      expect(error.httpStatus).toBe(404);
    });
  });

  describe('sendAdhocFeedback', () => {
    it('creates a pending ADHOC request expiring three days later', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(world.rows(REQUEST_MODEL)[0]).toMatchObject({
        trainerId: TRAINER_ID,
        studentId: STUDENT_ID,
        templateId: TEMPLATE_ID,
        milestone: StudentFeedbackMilestone.ADHOC,
        status: StudentFeedbackStatus.PENDING,
        hasMealPlan: false,
        sentAt: NOW,
        expiresAt: new Date(NOW.getTime() + 3 * DAY_MS),
      });
    });

    it('returns the created request', async () => {
      const result = await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(result).toMatchObject({
        id: world.rows(REQUEST_MODEL)[0].id,
        milestone: StudentFeedbackMilestone.ADHOC,
        status: StudentFeedbackStatus.PENDING,
        sentAt: NOW,
        expiresAt: new Date(NOW.getTime() + 3 * DAY_MS),
      });
    });

    it('sends the request e-mail to the student', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledTimes(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).toHaveBeenCalledWith(expect.objectContaining({ to: `${STUDENT_ID}@example.com` }));
    });

    it('records the meal plan of the student', async () => {
      seedPublishedMealPlan(world, STUDENT_ID);

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(world.rows(REQUEST_MODEL)[0].hasMealPlan).toBe(true);
    });

    it('works with auto-send off, since the trainer asked for it', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(world.rows('studentFeedbackConfig').filter((row) => row.autoSendEnabled)).toHaveLength(0);
      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
    });

    it('answers STUDENT_FEEDBACK_ALREADY_PENDING when the student has a pending request of this trainer', async () => {
      seedRequest(world, { sentAt: daysAgo(1) });

      await expectFeedbackError(sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW), 'ALREADY_PENDING', 409);

      expect(world.rows(REQUEST_MODEL)).toHaveLength(1);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });

    it('answers STUDENT_FEEDBACK_ALREADY_PENDING on a second ad-hoc send in a row', async () => {
      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      await expectFeedbackError(sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, new Date(NOW.getTime() + HOUR_MS)), 'ALREADY_PENDING', 409);
    });

    it.each([StudentFeedbackStatus.ANSWERED, StudentFeedbackStatus.EXPIRED])('sends when the previous request is %s', async (status) => {
      seedRequest(world, { sentAt: daysAgo(10), status });

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(world.rows(REQUEST_MODEL)).toHaveLength(2);
    });

    it('is not blocked by the pending request of another student', async () => {
      seedRequest(world, { studentId: OTHER_STUDENT_ID, sentAt: daysAgo(1) });

      await sendAdhocFeedback(world.prisma, emailSender, TRAINER_ID, STUDENT_ID, NOW);

      expect(world.rows(REQUEST_MODEL)).toHaveLength(2);
    });

    it('rejects with 404 a student who is not linked to the trainer and creates nothing', async () => {
      const error = await sendAdhocFeedback(world.prisma, emailSender, OTHER_TRAINER_ID, OTHER_STUDENT_ID, NOW).then(
        () => null,
        (caught) => caught,
      );

      expect(error).not.toBeNull();
      expect(error.httpStatus).toBe(404);
      expect(world.rows(REQUEST_MODEL)).toHaveLength(0);
      expect(emailSender.sendStudentFeedbackRequestEmail).not.toHaveBeenCalled();
    });
  });
});
