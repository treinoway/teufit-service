import { beforeEach, describe, expect, it } from 'vitest';
import { listInbox, markAsRead } from '../../src/services/student-feedback-trainer-service.js';
import {
  AVERAGE_INDEX_SAMPLE_SIZE,
  INBOX_DEFAULT_LIMIT,
  INBOX_MAX_LIMIT,
  StudentFeedbackErrorCode,
  StudentFeedbackInboxFilter,
  StudentFeedbackMessageCode,
  StudentFeedbackStatus,
} from '../../src/constants/student-feedback.js';
import { OTHER_TRAINER_ID, TRAINER_ID, createFeedbackWorld, seedRequest } from '../helpers/student-feedback-world.js';

const MINUTE_MS = 60000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const HTTP_NOT_FOUND = 404;
const NOW = new Date('2026-12-01T15:00:00Z');
const UNKNOWN_ID = 'request-unknown';
const RECENT_INDEX = 80;
const OLD_INDEX = 0;
const OLDER_THAN_THE_SAMPLE = 200;

// Instant the given number of minutes before NOW
function minutesAgo(minutes) {
  return new Date(NOW.getTime() - minutes * MINUTE_MS);
}

// Seeds `count` requests of the main trainer, one per minute going back from `startMinutesAgo`, newest first; returns the rows
function seedRequests(world, count, { startMinutesAgo = 1, ...overrides } = {}) {
  return Array.from({ length: count }, (_unused, index) => seedRequest(world, { sentAt: minutesAgo(startMinutesAgo + index), ...overrides }));
}

// Fields of an answered request that was not read yet
function answered(overallIndex) {
  return { status: StudentFeedbackStatus.ANSWERED, overallIndex, submittedAt: NOW, readAt: null };
}

describe('student feedback trainer service review fixes', () => {
  let world;

  beforeEach(() => {
    world = createFeedbackWorld();
  });

  describe('listInbox limit', () => {
    it('returns the 100 most recently sent requests when no limit is given', async () => {
      const rows = seedRequests(world, INBOX_DEFAULT_LIMIT + 1);

      const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

      expect(inbox.items.map((item) => item.id)).toEqual(rows.slice(0, INBOX_DEFAULT_LIMIT).map((row) => row.id));
    });

    it('applies the default when called without filters at all', async () => {
      seedRequests(world, INBOX_DEFAULT_LIMIT + 1);

      const inbox = await listInbox(world.prisma, TRAINER_ID, undefined, NOW);

      expect(inbox.items).toHaveLength(INBOX_DEFAULT_LIMIT);
    });

    it('returns only the most recent ones up to the limit asked', async () => {
      const rows = seedRequests(world, 10);

      const inbox = await listInbox(world.prisma, TRAINER_ID, { limit: 3 }, NOW);

      expect(inbox.items.map((item) => item.id)).toEqual(rows.slice(0, 3).map((row) => row.id));
    });

    it('accepts the maximum of 200', async () => {
      seedRequests(world, INBOX_MAX_LIMIT + 1);

      const inbox = await listInbox(world.prisma, TRAINER_ID, { limit: INBOX_MAX_LIMIT }, NOW);

      expect(inbox.items).toHaveLength(INBOX_MAX_LIMIT);
    });

    it('clamps a limit above the maximum to 200', async () => {
      seedRequests(world, INBOX_MAX_LIMIT + 1);

      const inbox = await listInbox(world.prisma, TRAINER_ID, { limit: INBOX_MAX_LIMIT * 5 }, NOW);

      expect(inbox.items).toHaveLength(INBOX_MAX_LIMIT);
    });

    it.each([
      ['zero', 0],
      ['a negative number', -5],
      ['a fraction', 2.5],
      ['a string', '3'],
      ['null', null],
    ])('falls back to the default for %s', async (_scenario, limit) => {
      seedRequests(world, INBOX_DEFAULT_LIMIT + 1);

      const inbox = await listInbox(world.prisma, TRAINER_ID, { limit }, NOW);

      expect(inbox.items).toHaveLength(INBOX_DEFAULT_LIMIT);
    });

    it('applies the limit after the filters', async () => {
      seedRequests(world, 5);
      const expired = seedRequests(world, 5, { startMinutesAgo: 10, status: StudentFeedbackStatus.EXPIRED });

      const inbox = await listInbox(world.prisma, TRAINER_ID, { status: StudentFeedbackInboxFilter.UNANSWERED, limit: 2 }, NOW);

      expect(inbox.items.map((item) => item.id)).toEqual(expired.slice(0, 2).map((row) => row.id));
    });
  });

  describe('listInbox summary', () => {
    it('counts the whole inbox, not only the items the limit returned', async () => {
      const unread = 150;
      const expired = 50;
      seedRequests(world, unread, answered(RECENT_INDEX));
      seedRequests(world, expired, { startMinutesAgo: unread + 1, status: StudentFeedbackStatus.EXPIRED });

      const inbox = await listInbox(world.prisma, TRAINER_ID, { limit: 1 }, NOW);

      expect(inbox.items).toHaveLength(1);
      expect(inbox.summary).toEqual({ responseRate30d: 75, averageIndex: RECENT_INDEX, unansweredCount: expired, unreadCount: unread });
    });

    it('averages only the 1000 most recently sent answered feedbacks', async () => {
      seedRequests(world, AVERAGE_INDEX_SAMPLE_SIZE, answered(RECENT_INDEX));
      seedRequests(world, OLDER_THAN_THE_SAMPLE, { startMinutesAgo: AVERAGE_INDEX_SAMPLE_SIZE + 1, ...answered(OLD_INDEX) });

      const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

      expect(inbox.summary.averageIndex).toBe(RECENT_INDEX);
    });

    it('still counts the answered feedbacks beyond the average sample as unread', async () => {
      seedRequests(world, AVERAGE_INDEX_SAMPLE_SIZE, answered(RECENT_INDEX));
      seedRequests(world, OLDER_THAN_THE_SAMPLE, { startMinutesAgo: AVERAGE_INDEX_SAMPLE_SIZE + 1, ...answered(OLD_INDEX) });

      const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

      expect(inbox.summary.unreadCount).toBe(AVERAGE_INDEX_SAMPLE_SIZE + OLDER_THAN_THE_SAMPLE);
    });

    it('averages everything while the answered feedbacks fit the sample', async () => {
      seedRequests(world, 3, answered(RECENT_INDEX));
      seedRequests(world, 1, { startMinutesAgo: 60 * DAY_MS / MINUTE_MS, ...answered(OLD_INDEX) });

      const inbox = await listInbox(world.prisma, TRAINER_ID, {}, NOW);

      expect(inbox.summary.averageIndex).toBe(60);
    });
  });

  describe('markAsRead', () => {
    const FIRST_READ = new Date(NOW.getTime() + HOUR_MS);
    const SECOND_READ = new Date(NOW.getTime() + 2 * HOUR_MS);

    it('keeps the first read date when two calls race', async () => {
      const [request] = seedRequests(world, 1, answered(RECENT_INDEX));

      const results = await Promise.all([
        markAsRead(world.prisma, TRAINER_ID, request.id, FIRST_READ),
        markAsRead(world.prisma, TRAINER_ID, request.id, SECOND_READ),
      ]);

      expect(request.readAt).toEqual(FIRST_READ);
      expect(results).toEqual([
        { id: request.id, readAt: FIRST_READ },
        { id: request.id, readAt: FIRST_READ },
      ]);
    });

    it('returns the first read date on a later call instead of the new one', async () => {
      const [request] = seedRequests(world, 1, { ...answered(RECENT_INDEX), readAt: FIRST_READ });

      const result = await markAsRead(world.prisma, TRAINER_ID, request.id, SECOND_READ);

      expect(result).toEqual({ id: request.id, readAt: FIRST_READ });
      expect(request.readAt).toEqual(FIRST_READ);
    });

    it.each([StudentFeedbackStatus.PENDING, StudentFeedbackStatus.EXPIRED])('does not stamp a %s request and answers a null readAt', async (status) => {
      const [request] = seedRequests(world, 1, { status });

      const result = await markAsRead(world.prisma, TRAINER_ID, request.id, FIRST_READ);

      expect(result).toEqual({ id: request.id, readAt: null });
      expect(request.readAt).toBeNull();
    });

    it('answers 404 STUDENT_FEEDBACK_NOT_FOUND for an unknown request and stamps nothing', async () => {
      const [request] = seedRequests(world, 1, answered(RECENT_INDEX));

      await expect(markAsRead(world.prisma, TRAINER_ID, UNKNOWN_ID, FIRST_READ)).rejects.toMatchObject({
        httpStatus: HTTP_NOT_FOUND,
        error: StudentFeedbackErrorCode.NOT_FOUND,
        messageCode: StudentFeedbackMessageCode.NOT_FOUND,
      });

      expect(request.readAt).toBeNull();
    });

    it('answers 404 for the answered request of another trainer and leaves it unread', async () => {
      const [request] = seedRequests(world, 1, { trainerId: OTHER_TRAINER_ID, ...answered(RECENT_INDEX) });

      await expect(markAsRead(world.prisma, TRAINER_ID, request.id, FIRST_READ)).rejects.toMatchObject({
        httpStatus: HTTP_NOT_FOUND,
        error: StudentFeedbackErrorCode.NOT_FOUND,
      });

      expect(request.readAt).toBeNull();
    });
  });
});
