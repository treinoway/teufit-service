/**
 * Pure filter, search, sort and count helpers over the trainer's standings rows (AD-016).
 */

import { StandingsFilter, WeekStatus } from '../constants/consistency-ranking.js';

const FULL_SCORE = 100;
const SUMMARY_DECIMALS = 2;
const DIACRITICS = /\p{Diacritic}/gu;

const FILTER_PREDICATES = Object.freeze({
  [StandingsFilter.ALL]: () => true,
  [StandingsFilter.RISK]: (row) => row.risk !== null && row.risk !== undefined,
  [StandingsFilter.SIGNAL]: (row) => (row.signals ?? []).length > 0,
  [StandingsFilter.ENTERING]: (row) => row.entering !== null && row.entering !== undefined,
  [StandingsFilter.PAUSED]: (row) => row.pause !== null && row.pause !== undefined,
});

// Lowercase text without accents, for comparisons
function normalizeText(text) {
  return String(text ?? '').normalize('NFD').replace(DIACRITICS, '').toLowerCase();
}

// Number rounded to the summary precision
function roundSummary(value) {
  const factor = 10 ** SUMMARY_DECIMALS;
  return Math.round(value * factor) / factor;
}

// Rounded mean of numbers, or null for an empty list
function meanOf(values) {
  if (values.length === 0) return null;
  return roundSummary(values.reduce((sum, value) => sum + value, 0) / values.length);
}

// Compares rows by display name, ignoring case and accents
function byName(a, b) {
  return a.displayName.localeCompare(b.displayName, 'pt-BR', { sensitivity: 'base' });
}

// Compares rows by position (students still entering last), then by name
function byPosition(a, b) {
  const positionA = a.position ?? Number.POSITIVE_INFINITY;
  const positionB = b.position ?? Number.POSITIVE_INFINITY;
  if (positionA !== positionB) return positionA < positionB ? -1 : 1;
  return byName(a, b);
}

// Compares rows by ascending season average, then by name
function byAscendingAverage(a, b) {
  return Number(a.average) - Number(b.average) || byName(a, b);
}

/**
 * Rows that belong to the filter group.
 *
 * @param {object[]} rows
 * @param {string} filter - one of StandingsFilter
 * @returns {object[]}
 */
export function filterStandings(rows, filter) {
  return rows.filter(FILTER_PREDICATES[filter] ?? FILTER_PREDICATES[StandingsFilter.ALL]);
}

/**
 * Rows whose name contains the text, ignoring case and accents; a blank text keeps every row.
 *
 * @param {object[]} rows
 * @param {string} [q]
 * @returns {object[]}
 */
export function searchStandings(rows, q) {
  const needle = normalizeText(q).trim();
  if (needle === '') return rows;
  return rows.filter((row) => normalizeText(`${row.displayName} ${row.name ?? ''}`).includes(needle));
}

/**
 * Rows in display order: by position, or by ascending season average in the risk filter.
 *
 * @param {object[]} rows
 * @param {string} filter
 * @returns {object[]} a new array
 */
export function sortForFilter(rows, filter) {
  return [...rows].sort(filter === StandingsFilter.RISK ? byAscendingAverage : byPosition);
}

/**
 * Size of every filter group.
 *
 * @param {object[]} rows
 * @returns {Record<string, number>}
 */
export function countFilters(rows) {
  return Object.fromEntries(
    Object.values(StandingsFilter).map((filter) => [filter, filterStandings(rows, filter).length]),
  );
}

/**
 * The four summary numbers of the team: live average, last closed week average, full and valid counts, at risk and with signal.
 *
 * @param {object[]} rows - every standings row, entering students included
 * @param {Array<{ studentId: string, status: string, score: * }>} lastClosedWeek - stored results of the last closed week
 * @returns {{ teamAverage: number|null, lastClosedWeekAverage: number|null, fullLastWeek: number, validLastWeek: number, atRisk: number, withSignal: number }}
 */
export function teamSummary(rows, lastClosedWeek) {
  const studentIds = new Set(rows.map((row) => row.studentId));
  const ranked = rows.filter((row) => !FILTER_PREDICATES[StandingsFilter.ENTERING](row));
  const validScores = lastClosedWeek
    .filter((result) => studentIds.has(result.studentId) && result.status === WeekStatus.VALID)
    .map((result) => Number(result.score));
  return {
    teamAverage: meanOf(ranked.map((row) => Number(row.average))),
    lastClosedWeekAverage: meanOf(validScores),
    fullLastWeek: validScores.filter((score) => score >= FULL_SCORE).length,
    validLastWeek: validScores.length,
    atRisk: filterStandings(rows, StandingsFilter.RISK).length,
    withSignal: filterStandings(rows, StandingsFilter.SIGNAL).length,
  };
}
