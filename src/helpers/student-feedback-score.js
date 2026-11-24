/**
 * Scoring of a student feedback: every scored answer becomes 0-100, pillars average their questions and the index averages the pillars.
 */

import { BAND_THRESHOLDS, StudentFeedbackBand, StudentFeedbackQuestionType } from '../constants/student-feedback.js';

const FULL_SCORE = 100;
const SCORE_STEP = 10;
const STAR_STEP = 25;

// Arithmetic mean of a non-empty list of numbers
function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

// 0-100 value of a raw answer before inversion, or null for a type that is not scored
function rawScore(type, score) {
  if (type === StudentFeedbackQuestionType.SCORE) return score * SCORE_STEP;
  if (type === StudentFeedbackQuestionType.STARS) return (score - 1) * STAR_STEP;
  return null;
}

/**
 * 0-100 score of one answer: score x10, stars (n-1) x25, inverted when the question says so.
 *
 * @param {{ type: string, invertScore?: boolean }} question
 * @param {{ score: number|null }|undefined} answer
 * @returns {number|null} null for open questions and unanswered ones
 */
export function questionScore(question, answer) {
  if (answer?.score === null || answer?.score === undefined) return null;
  const raw = rawScore(question.type, answer.score);
  if (raw === null) return null;
  return question.invertScore ? FULL_SCORE - raw : raw;
}

/**
 * Rounded mean score of each pillar that has at least one scored answer.
 *
 * @param {Array<{ id: string, type: string, pillar: string, invertScore?: boolean }>} questions
 * @param {Array<{ questionId: string, score: number|null }>} answers
 * @returns {Record<string, number>} pillar -> 0-100
 */
export function pillarScores(questions, answers) {
  const answerByQuestion = new Map(answers.map((answer) => [answer.questionId, answer]));
  const scoresByPillar = new Map();
  for (const question of questions) {
    const score = questionScore(question, answerByQuestion.get(question.id));
    if (score === null) continue;
    scoresByPillar.set(question.pillar, [...(scoresByPillar.get(question.pillar) ?? []), score]);
  }
  return Object.fromEntries([...scoresByPillar].map(([pillar, scores]) => [pillar, Math.round(mean(scores))]));
}

/**
 * Band of a 0-100 index: attention below 50, stable below 75, good from 75.
 *
 * @param {number|null} index
 * @returns {string|null}
 */
export function bandFor(index) {
  if (index === null || index === undefined) return null;
  if (index < BAND_THRESHOLDS.stable) return StudentFeedbackBand.ATTENTION;
  return index < BAND_THRESHOLDS.good ? StudentFeedbackBand.STABLE : StudentFeedbackBand.GOOD;
}

/**
 * Pillar scores, overall index (rounded mean of the scored pillars) and band of a set of answers.
 *
 * @param {object[]} questions
 * @param {object[]} answers
 * @returns {{ pillars: Record<string, number>, overallIndex: number|null, band: string|null }}
 */
export function scoreFeedback(questions, answers) {
  const pillars = pillarScores(questions, answers);
  const scores = Object.values(pillars);
  const overallIndex = scores.length === 0 ? null : Math.round(mean(scores));
  return { pillars, overallIndex, band: bandFor(overallIndex) };
}
