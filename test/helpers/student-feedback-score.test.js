import { describe, expect, it } from 'vitest';
import { bandFor, pillarScores, questionScore, scoreFeedback } from '../../src/helpers/student-feedback-score.js';
import {
  StudentFeedbackBand,
  StudentFeedbackPillar,
  StudentFeedbackQuestionType,
} from '../../src/constants/student-feedback.js';

const { SCORE, STARS, OPEN } = StudentFeedbackQuestionType;

// Builds a question of the given type and pillar
function question(id, type, pillar, overrides = {}) {
  return { id, type, pillar, required: true, invertScore: false, ...overrides };
}

// Builds a numeric answer to a question
function scored(questionId, score) {
  return { questionId, score, text: null };
}

describe('questionScore', () => {
  it.each([
    [0, 0],
    [7, 70],
    [10, 100],
  ])('maps a 0-10 score of %i to %i', (score, expected) => {
    expect(questionScore(question('q', SCORE, StudentFeedbackPillar.SLEEP), scored('q', score))).toBe(expected);
  });

  it.each([
    [1, 0],
    [2, 25],
    [3, 50],
    [4, 75],
    [5, 100],
  ])('maps %i stars to %i', (stars, expected) => {
    expect(questionScore(question('q', STARS, StudentFeedbackPillar.SLEEP), scored('q', stars))).toBe(expected);
  });

  it('inverts a score question flagged invertScore', () => {
    const inverted = question('q', SCORE, StudentFeedbackPillar.ROUTINE, { invertScore: true });

    expect(questionScore(inverted, scored('q', 3))).toBe(70);
  });

  it('inverts a stars question flagged invertScore', () => {
    const inverted = question('q', STARS, StudentFeedbackPillar.ROUTINE, { invertScore: true });

    expect(questionScore(inverted, scored('q', 2))).toBe(75);
  });

  it('returns null for an open question', () => {
    const open = question('q', OPEN, StudentFeedbackPillar.REPORT);

    expect(questionScore(open, { questionId: 'q', score: null, text: 'tudo bem' })).toBeNull();
  });

  it('returns null when the question has no answer', () => {
    expect(questionScore(question('q', SCORE, StudentFeedbackPillar.SLEEP), undefined)).toBeNull();
  });

  it('returns null when the answer has no score', () => {
    expect(questionScore(question('q', SCORE, StudentFeedbackPillar.SLEEP), scored('q', null))).toBeNull();
  });
});

describe('pillarScores', () => {
  it('uses the mean of the answered questions of each pillar', () => {
    const questions = [
      question('a', SCORE, StudentFeedbackPillar.TRAINING_ADHERENCE),
      question('b', SCORE, StudentFeedbackPillar.TRAINING_ADHERENCE),
      question('c', STARS, StudentFeedbackPillar.SLEEP),
    ];

    const scores = pillarScores(questions, [scored('a', 6), scored('b', 10), scored('c', 4)]);

    expect(scores).toEqual({ [StudentFeedbackPillar.TRAINING_ADHERENCE]: 80, [StudentFeedbackPillar.SLEEP]: 75 });
  });

  it('ignores a skipped question when averaging its pillar', () => {
    const questions = [
      question('a', SCORE, StudentFeedbackPillar.HYDRATION),
      question('b', STARS, StudentFeedbackPillar.HYDRATION, { required: false }),
    ];

    expect(pillarScores(questions, [scored('a', 9)])).toEqual({ [StudentFeedbackPillar.HYDRATION]: 90 });
  });

  it('leaves out a pillar without any scored answer', () => {
    const questions = [
      question('a', SCORE, StudentFeedbackPillar.EVOLUTION),
      question('b', OPEN, StudentFeedbackPillar.REPORT),
      question('c', STARS, StudentFeedbackPillar.HYDRATION, { required: false }),
    ];

    const scores = pillarScores(questions, [scored('a', 5), { questionId: 'b', score: null, text: 'ok' }]);

    expect(scores).toEqual({ [StudentFeedbackPillar.EVOLUTION]: 50 });
  });
});

describe('bandFor', () => {
  it.each([
    [0, StudentFeedbackBand.ATTENTION],
    [49, StudentFeedbackBand.ATTENTION],
    [50, StudentFeedbackBand.STABLE],
    [74, StudentFeedbackBand.STABLE],
    [75, StudentFeedbackBand.GOOD],
    [100, StudentFeedbackBand.GOOD],
  ])('puts an index of %i in the %s band', (index, band) => {
    expect(bandFor(index)).toBe(band);
  });

  it('returns null when there is no index', () => {
    expect(bandFor(null)).toBeNull();
  });
});

describe('scoreFeedback', () => {
  const questions = [
    question('training', SCORE, StudentFeedbackPillar.TRAINING_ADHERENCE),
    question('sleep', STARS, StudentFeedbackPillar.SLEEP),
    question('routine', SCORE, StudentFeedbackPillar.ROUTINE, { invertScore: true }),
    question('evolution', SCORE, StudentFeedbackPillar.EVOLUTION),
    question('report', OPEN, StudentFeedbackPillar.REPORT, { required: false }),
  ];

  it('returns the pillar scores, the rounded mean of the scored pillars and its band', () => {
    const answers = [scored('training', 8), scored('sleep', 4), scored('routine', 3), scored('evolution', 9), { questionId: 'report', score: null, text: 'semana boa' }];

    const result = scoreFeedback(questions, answers);

    expect(result).toEqual({
      pillars: {
        [StudentFeedbackPillar.TRAINING_ADHERENCE]: 80,
        [StudentFeedbackPillar.SLEEP]: 75,
        [StudentFeedbackPillar.ROUTINE]: 70,
        [StudentFeedbackPillar.EVOLUTION]: 90,
      },
      overallIndex: 79,
      band: StudentFeedbackBand.GOOD,
    });
  });

  it('rounds the overall index half up', () => {
    const two = [question('a', SCORE, StudentFeedbackPillar.SLEEP), question('b', STARS, StudentFeedbackPillar.HYDRATION)];

    expect(scoreFeedback(two, [scored('a', 5), scored('b', 2)]).overallIndex).toBe(38);
  });

  it('weighs every scored pillar equally, whatever its number of questions', () => {
    const uneven = [
      question('a', SCORE, StudentFeedbackPillar.TRAINING_ADHERENCE),
      question('b', SCORE, StudentFeedbackPillar.TRAINING_ADHERENCE),
      question('c', SCORE, StudentFeedbackPillar.SLEEP),
    ];

    const result = scoreFeedback(uneven, [scored('a', 10), scored('b', 10), scored('c', 0)]);

    expect(result.overallIndex).toBe(50);
    expect(result.band).toBe(StudentFeedbackBand.STABLE);
  });

  it('puts a low result in the attention band', () => {
    const result = scoreFeedback(questions, [scored('training', 2), scored('sleep', 2), scored('routine', 8), scored('evolution', 3)]);

    expect(result.overallIndex).toBe(24);
    expect(result.band).toBe(StudentFeedbackBand.ATTENTION);
  });

  it('has no index and no band when nothing was scored', () => {
    const result = scoreFeedback(questions, [{ questionId: 'report', score: null, text: 'só um recado' }]);

    expect(result).toEqual({ pillars: {}, overallIndex: null, band: null });
  });
});
