import { ExerciseType } from '../constants/training.js';

/**
 * Strip diacritics and lowercase a string for keyword matching.
 *
 * @param {string} value
 * @returns {string}
 */
function normalize(value) {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

// Keyword → ExerciseType. Order matters: first matching group wins.
// Heuristic is intentionally simple; anything unmatched falls back to STRENGTH
// (the vast majority of gym-demo videos are strength exercises).
const KEYWORD_GROUPS = [
  { type: ExerciseType.STRETCHING, keywords: ['alongamento', 'along ', 'stretch'] },
  {
    type: ExerciseType.MOBILITY,
    keywords: ['mobilidade', 'mobility', 'rotacao toracica', 'maome'],
  },
  {
    type: ExerciseType.CARDIO,
    keywords: ['corrida', 'cardio', 'aerobico', 'esteira', 'bike', 'hiit', 'pular corda'],
  },
];

/**
 * Infer an ExerciseType from a (Portuguese) exercise/video title.
 * Accent- and case-insensitive. Falls back to STRENGTH when no keyword matches.
 *
 * @param {string|null|undefined} title
 * @returns {string} one of ExerciseType values
 */
export function inferExerciseType(title) {
  if (!title || typeof title !== 'string') return ExerciseType.STRENGTH;
  const normalized = normalize(title);

  for (const group of KEYWORD_GROUPS) {
    if (group.keywords.some((kw) => normalized.includes(kw))) {
      return group.type;
    }
  }

  return ExerciseType.STRENGTH;
}
