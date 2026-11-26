import { beforeEach, describe, expect, it } from 'vitest';
import { getStudentHistory } from '../../src/services/student-feedback-trainer-service.js';
import { saveDraft, submitFeedback } from '../../src/services/student-feedback-student-service.js';
import {
  StudentFeedbackBand,
  StudentFeedbackMilestone,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
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
  seedConfig,
  seedLink,
  seedRequest,
} from '../helpers/student-feedback-world.js';

const HOUR_MS = 3600000;
const SCORE_MAX = 10;
const STARS_MAX = 5;
// Sunday 2026-11-01 12:00 in Sao Paulo (UTC-3)
const LINKED_AT = new Date('2026-11-01T15:00:00Z');
const REPORT_TEXT = 'Senti dor no joelho no agachamento';
const SLEEP_NOTE_TEXT = 'Acordei várias vezes';
const TRAINING_TEXT = 'Como foi tua adesão aos treinos?';
const SLEEP_TEXT = 'Como está teu sono?';
const ROUTINE_TEXT = 'Quão corrida foi tua rotina?';
const EVOLUTION_TEXT = 'Como percebes tua evolução?';
const REPORT_QUESTION_TEXT = 'Quer contar algo ao teu treinador?';
const TIRED_TEXT = 'Acordaste cansado?';
const TIRED_QUESTION_ID = 'q-sleep-tired';
const SLEEP_NOTE_QUESTION_ID = 'q-sleep-note';
const NAPS_QUESTION_ID = 'q-sleep-naps';
// Pillars 80, 50, 20 (inverted) and 90: index 60, stable
const MIXED_ANSWERS = Object.freeze([
  { questionId: QuestionId.TRAINING, score: 8 },
  { questionId: QuestionId.SLEEP, score: 3 },
  { questionId: QuestionId.ROUTINE, score: 8 },
  { questionId: QuestionId.EVOLUTION, score: 9 },
  { questionId: QuestionId.REPORT, text: REPORT_TEXT },
]);
const MIXED_INDEX = 60;

// 09:00 America/Sao_Paulo (12:00 UTC) of the day the given number of days after the link day
function nineAmOnDay(days) {
  return new Date(Date.UTC(2026, 10, 1 + days, 12, 0, 0));
}

// Three hours after the send hour of the day the given number of days after the link day
function afternoonOfDay(days) {
  return new Date(nineAmOnDay(days).getTime() + 3 * HOUR_MS);
}

// Seeds a pending request and has its student submit the answers two hours after it was sent
async function seedAnswered(world, { answers, ...request }) {
  const row = seedRequest(world, request);
  await submitFeedback(world.prisma, row.studentId, row.id, { answers }, new Date(row.sentAt.getTime() + 2 * HOUR_MS));
  return row;
}

// Seeds an extra question on the fixture template
function seedQuestion(world, question) {
  return world.seed('studentFeedbackQuestion', { helpText: null, minLabel: null, maxLabel: null, invertScore: false, condition: null, required: false, templateId: TEMPLATE_ID, ...question });
}

// Item of the given pillar among the pillars of a feedback
function pillarOf(feedback, pillar) {
  return feedback.pillars.find((item) => item.pillar === pillar);
}

// The history as it was before autoSend and the pillar band and answers existed
function legacyShapeOf(history) {
  const { autoSend: _autoSend, ...rest } = history;
  return {
    ...rest,
    feedbacks: history.feedbacks.map((feedback) => ({ ...feedback, pillars: feedback.pillars.map(({ pillar, score }) => ({ pillar, score })) })),
  };
}

describe('student feedback history: auto-send status and readable pillars', () => {
  let world;

  beforeEach(() => {
    world = createFeedbackWorld();
  });

  describe('autoSend', () => {
    const NOW = afternoonOfDay(8);

    describe('with the student active on the plan', () => {
      beforeEach(() => {
        seedLink(world, { createdAt: LINKED_AT });
      });

      it('is disabled without a next milestone when the trainer has no config row', async () => {
        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: false, next: null });
      });

      it('is disabled without a next milestone when auto-send is off', async () => {
        seedConfig(world, { autoSendEnabled: false, enabledAt: null });

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: false, next: null });
      });

      it('is enabled with the next milestone and its due instant when auto-send is on', async () => {
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: true, next: { milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) } });
      });

      it('returns the due instant as a Date', async () => {
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend.next.dueAt).toBeInstanceOf(Date);
      });

      it('skips the milestones the config has toggled off', async () => {
        seedConfig(world, { d15: false, d21: false });

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: true, next: { milestone: StudentFeedbackMilestone.D30, dueAt: nineAmOnDay(30) } });
      });

      it('names the recurring milestone after day 30', async () => {
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, afternoonOfDay(31));

        expect(history.autoSend).toEqual({ enabled: true, next: { milestone: StudentFeedbackMilestone.RECURRING, dueAt: nineAmOnDay(60) } });
      });

      it('moves to the following milestone once the current one fell due', async () => {
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, nineAmOnDay(15));

        expect(history.autoSend.next).toEqual({ milestone: StudentFeedbackMilestone.D21, dueAt: nineAmOnDay(21) });
      });

      it('stays enabled without a next milestone when no enabled milestone remains', async () => {
        seedConfig(world, { recurring: false });

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, afternoonOfDay(31));

        expect(history.autoSend).toEqual({ enabled: true, next: null });
      });

      it('stays enabled without a next milestone when every milestone is toggled off', async () => {
        seedConfig(world, { d7: false, d15: false, d21: false, d30: false, recurring: false });

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: true, next: null });
      });

      it('ignores the config of another trainer', async () => {
        seedConfig(world, { trainerId: OTHER_TRAINER_ID });

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: false, next: null });
      });

      it('counts the days from the link of this trainer, not from the link of another trainer of the student', async () => {
        seedLink(world, { trainerId: OTHER_TRAINER_ID, createdAt: new Date('2026-06-01T15:00:00Z') });
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend.next).toEqual({ milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) });
      });

      it('counts the days from the link of each student', async () => {
        seedLink(world, { studentId: OTHER_STUDENT_ID, createdAt: nineAmOnDay(5) });
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, OTHER_STUDENT_ID, NOW);

        expect(history.autoSend.next).toEqual({ milestone: StudentFeedbackMilestone.D7, dueAt: nineAmOnDay(12) });
      });

      it('comes with the feedbacks already sent', async () => {
        seedConfig(world);
        const sent = seedRequest(world, { sentAt: nineAmOnDay(7), status: StudentFeedbackStatus.EXPIRED });

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.feedbacks.map((feedback) => feedback.id)).toEqual([sent.id]);
        expect(history.autoSend).toEqual({ enabled: true, next: { milestone: StudentFeedbackMilestone.D15, dueAt: nineAmOnDay(15) } });
      });
    });

    describe('with the student blocked on the plan', () => {
      beforeEach(() => {
        seedLink(world, { createdAt: LINKED_AT, activeOnPlan: false });
      });

      it('stays enabled without a next milestone, since the cron never sends to that student', async () => {
        seedConfig(world);

        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: true, next: null });
      });

      it('is disabled without a next milestone when auto-send is off', async () => {
        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history.autoSend).toEqual({ enabled: false, next: null });
      });
    });
  });

  describe('pillars of an answered feedback', () => {
    const NOW = afternoonOfDay(20);
    let answered;

    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    describe('with one scored question per pillar', () => {
      beforeEach(async () => {
        answered = await seedAnswered(world, { milestone: StudentFeedbackMilestone.D15, sentAt: nineAmOnDay(15), answers: MIXED_ANSWERS });
      });

      it('keeps the pillar and the score of every scored pillar', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(feedback.pillars.map(({ pillar, score }) => ({ pillar, score }))).toEqual([
          { pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, score: 80 },
          { pillar: StudentFeedbackPillar.EVOLUTION, score: 90 },
          { pillar: StudentFeedbackPillar.ROUTINE, score: 20 },
          { pillar: StudentFeedbackPillar.SLEEP, score: 50 },
        ]);
      });

      it.each([
        [StudentFeedbackPillar.TRAINING_ADHERENCE, StudentFeedbackBand.GOOD],
        [StudentFeedbackPillar.EVOLUTION, StudentFeedbackBand.GOOD],
        [StudentFeedbackPillar.ROUTINE, StudentFeedbackBand.ATTENTION],
        [StudentFeedbackPillar.SLEEP, StudentFeedbackBand.STABLE],
      ])('gives the %s pillar the band of its own score: %s', async (pillar, band) => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, pillar).band).toBe(band);
      });

      it('returns the raw answer of a score question with the maximum of its scale', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.TRAINING_ADHERENCE).answers).toEqual([
          { questionId: QuestionId.TRAINING, question: TRAINING_TEXT, type: StudentFeedbackQuestionType.SCORE, value: 8, max: SCORE_MAX, inverted: false },
        ]);
      });

      it('returns the raw answer of a stars question with the maximum of its scale', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.SLEEP).answers).toEqual([
          { questionId: QuestionId.SLEEP, question: SLEEP_TEXT, type: StudentFeedbackQuestionType.STARS, value: 3, max: STARS_MAX, inverted: false },
        ]);
      });

      it('returns the answer of an inverted question as the student gave it, flagged as inverted', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.ROUTINE)).toEqual({
          pillar: StudentFeedbackPillar.ROUTINE,
          score: 20,
          band: StudentFeedbackBand.ATTENTION,
          answers: [{ questionId: QuestionId.ROUTINE, question: ROUTINE_TEXT, type: StudentFeedbackQuestionType.SCORE, value: 8, max: SCORE_MAX, inverted: true }],
        });
      });

      it('returns the whole history: every field it had before plus the new ones', async () => {
        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(history).toEqual({
          student: { id: STUDENT_ID, name: 'Ana Silva', avatarUrl: null },
          hasPending: false,
          autoSend: { enabled: false, next: null },
          feedbacks: [
            {
              id: answered.id,
              milestone: StudentFeedbackMilestone.D15,
              status: StudentFeedbackStatus.ANSWERED,
              sentAt: nineAmOnDay(15),
              expiresAt: nineAmOnDay(18),
              submittedAt: new Date(nineAmOnDay(15).getTime() + 2 * HOUR_MS),
              readAt: null,
              overallIndex: MIXED_INDEX,
              band: StudentFeedbackBand.STABLE,
              pillars: [
                {
                  pillar: StudentFeedbackPillar.TRAINING_ADHERENCE,
                  score: 80,
                  band: StudentFeedbackBand.GOOD,
                  answers: [{ questionId: QuestionId.TRAINING, question: TRAINING_TEXT, type: StudentFeedbackQuestionType.SCORE, value: 8, max: SCORE_MAX, inverted: false }],
                },
                {
                  pillar: StudentFeedbackPillar.EVOLUTION,
                  score: 90,
                  band: StudentFeedbackBand.GOOD,
                  answers: [{ questionId: QuestionId.EVOLUTION, question: EVOLUTION_TEXT, type: StudentFeedbackQuestionType.SCORE, value: 9, max: SCORE_MAX, inverted: false }],
                },
                {
                  pillar: StudentFeedbackPillar.ROUTINE,
                  score: 20,
                  band: StudentFeedbackBand.ATTENTION,
                  answers: [{ questionId: QuestionId.ROUTINE, question: ROUTINE_TEXT, type: StudentFeedbackQuestionType.SCORE, value: 8, max: SCORE_MAX, inverted: true }],
                },
                {
                  pillar: StudentFeedbackPillar.SLEEP,
                  score: 50,
                  band: StudentFeedbackBand.STABLE,
                  answers: [{ questionId: QuestionId.SLEEP, question: SLEEP_TEXT, type: StudentFeedbackQuestionType.STARS, value: 3, max: STARS_MAX, inverted: false }],
                },
              ],
              openAnswers: [{ questionId: QuestionId.REPORT, question: REPORT_QUESTION_TEXT, pillar: StudentFeedbackPillar.REPORT, text: REPORT_TEXT }],
            },
          ],
        });
      });

      it('leaves every field that existed before exactly as it was', async () => {
        const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

        expect(legacyShapeOf(history)).toEqual({
          student: { id: STUDENT_ID, name: 'Ana Silva', avatarUrl: null },
          hasPending: false,
          feedbacks: [
            {
              id: answered.id,
              milestone: StudentFeedbackMilestone.D15,
              status: StudentFeedbackStatus.ANSWERED,
              sentAt: nineAmOnDay(15),
              expiresAt: nineAmOnDay(18),
              submittedAt: new Date(nineAmOnDay(15).getTime() + 2 * HOUR_MS),
              readAt: null,
              overallIndex: MIXED_INDEX,
              band: StudentFeedbackBand.STABLE,
              pillars: [
                { pillar: StudentFeedbackPillar.TRAINING_ADHERENCE, score: 80 },
                { pillar: StudentFeedbackPillar.EVOLUTION, score: 90 },
                { pillar: StudentFeedbackPillar.ROUTINE, score: 20 },
                { pillar: StudentFeedbackPillar.SLEEP, score: 50 },
              ],
              openAnswers: [{ questionId: QuestionId.REPORT, question: REPORT_QUESTION_TEXT, pillar: StudentFeedbackPillar.REPORT, text: REPORT_TEXT }],
            },
          ],
        });
      });
    });

    describe('band boundaries', () => {
      it.each([
        [2, 25, StudentFeedbackBand.ATTENTION],
        [3, 50, StudentFeedbackBand.STABLE],
        [4, 75, StudentFeedbackBand.GOOD],
      ])('puts a sleep of %i stars (score %i) in the %s band', async (stars, score, band) => {
        const answers = MIXED_ANSWERS.map((answer) => (answer.questionId === QuestionId.SLEEP ? { ...answer, score: stars } : answer));
        await seedAnswered(world, { sentAt: nineAmOnDay(15), answers });

        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.SLEEP)).toMatchObject({ score, band });
      });
    });

    describe('with several questions in one pillar', () => {
      beforeEach(async () => {
        seedQuestion(world, { id: SLEEP_NOTE_QUESTION_ID, order: 8, text: 'Algo sobre teu sono?', type: StudentFeedbackQuestionType.OPEN, pillar: StudentFeedbackPillar.SLEEP });
        seedQuestion(world, { id: NAPS_QUESTION_ID, order: 9, text: 'Como foram teus cochilos?', type: StudentFeedbackQuestionType.STARS, pillar: StudentFeedbackPillar.SLEEP });
        seedQuestion(world, { id: TIRED_QUESTION_ID, order: 0, text: TIRED_TEXT, type: StudentFeedbackQuestionType.SCORE, pillar: StudentFeedbackPillar.SLEEP, invertScore: true });
        const answers = [
          { questionId: QuestionId.SLEEP, score: 4 },
          { questionId: SLEEP_NOTE_QUESTION_ID, text: SLEEP_NOTE_TEXT },
          { questionId: TIRED_QUESTION_ID, score: 4 },
          ...MIXED_ANSWERS.filter((answer) => answer.questionId !== QuestionId.SLEEP),
        ];
        answered = await seedAnswered(world, { sentAt: nineAmOnDay(15), answers });
      });

      it('lists the scored answers of the pillar in question order', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.SLEEP).answers).toEqual([
          { questionId: TIRED_QUESTION_ID, question: TIRED_TEXT, type: StudentFeedbackQuestionType.SCORE, value: 4, max: SCORE_MAX, inverted: true },
          { questionId: QuestionId.SLEEP, question: SLEEP_TEXT, type: StudentFeedbackQuestionType.STARS, value: 4, max: STARS_MAX, inverted: false },
        ]);
      });

      it('leaves the open answer of the pillar out of its answers and keeps it among the open answers', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        const sleep = pillarOf(feedback, StudentFeedbackPillar.SLEEP);
        expect(sleep.answers.map((answer) => answer.questionId)).not.toContain(SLEEP_NOTE_QUESTION_ID);
        expect(sleep.answers.map((answer) => answer.type)).not.toContain(StudentFeedbackQuestionType.OPEN);
        expect(feedback.openAnswers.map((answer) => answer.questionId)).toContain(SLEEP_NOTE_QUESTION_ID);
      });

      it('leaves a scored question the student did not answer out of the answers', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.SLEEP).answers.map((answer) => answer.questionId)).not.toContain(NAPS_QUESTION_ID);
      });

      it('bands the pillar by its mean score, not by one of its answers', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(pillarOf(feedback, StudentFeedbackPillar.SLEEP)).toMatchObject({ score: 68, band: StudentFeedbackBand.STABLE });
      });

      it('gives every pillar a band and at least one answer, each answer of that pillar only', async () => {
        const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

        expect(feedback.pillars).toHaveLength(4);
        expect(feedback.pillars.map((item) => item.answers?.length)).toEqual([1, 1, 1, 2]);
        expect(feedback.pillars.map((item) => item.band)).toEqual([
          StudentFeedbackBand.GOOD,
          StudentFeedbackBand.GOOD,
          StudentFeedbackBand.ATTENTION,
          StudentFeedbackBand.STABLE,
        ]);
      });
    });
  });

  describe('feedbacks that were not answered', () => {
    const NOW = afternoonOfDay(20);

    beforeEach(() => {
      seedLink(world, { createdAt: LINKED_AT });
    });

    it('keeps the pillars of an expired feedback empty', async () => {
      seedRequest(world, { sentAt: nineAmOnDay(7), status: StudentFeedbackStatus.EXPIRED });

      const [feedback] = (await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW)).feedbacks;

      expect(feedback.pillars).toEqual([]);
    });

    it('keeps the pillars of a pending feedback empty even with a saved draft', async () => {
      const pending = seedRequest(world, { milestone: StudentFeedbackMilestone.D15, sentAt: nineAmOnDay(19) });
      await saveDraft(world.prisma, STUDENT_ID, pending.id, { answers: [{ questionId: QuestionId.TRAINING, score: 8 }] }, NOW);

      const history = await getStudentHistory(world.prisma, TRAINER_ID, STUDENT_ID, NOW);

      expect(history.feedbacks[0].pillars).toEqual([]);
      expect(history.hasPending).toBe(true);
      expect(history).toHaveProperty('autoSend');
    });
  });
});
