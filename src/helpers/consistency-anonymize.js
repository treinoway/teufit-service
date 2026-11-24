/**
 * What a championship participant may see of the others: names, photos and the podium, anonymized on the server (APP-40, AD-045).
 */

import { ChallengeVisibility } from '../constants/challenge.js';
import { ADULT_AGE, ANONYMOUS_DISPLAY_NAME, AppearAs } from '../constants/consistency-ranking.js';
import { shortNameOf } from './consistency-names.js';

const FULL_SCORE = 100;
const PODIUM_PLACES = 3;
const CLUB_100_MIN = 3;
const TIE_REASON = 'mesma média, mesmas semanas a 100% e mesma sequência';

// Whether the participant shows as "Aluno do time": anonymous championship, minor, or no stored choice to appear by name (AD-045)
function isHidden({ privacy, isMinor: minor, anonymousRanking }) {
  return Boolean(anonymousRanking) || Boolean(minor) || privacy !== AppearAs.NAME;
}

/**
 * Name a participant shows to the other participants: the short name, or "Aluno do time" when the most restrictive rule hides it.
 *
 * @param {{ firstName?: string|null, lastName?: string|null, username?: string|null }} user
 * @param {{ privacy: string, isMinor: boolean, anonymousRanking: boolean }} rules - privacy is one of AppearAs
 * @returns {string}
 */
export function displayNameFor(user, rules) {
  return isHidden(rules) ? ANONYMOUS_DISPLAY_NAME : shortNameOf(user).displayName;
}

/**
 * Row of the standings as another participant sees it: no id, e-mail, phone or pillars; the viewer always sees their own name.
 *
 * @param {object} row - standings row (computeChallengeStandings or frozen), with displayName and initials
 * @param {{ key: string, isMe: boolean, avatarUrl: string|null, privacy: string, isMinor: boolean, anonymousRanking: boolean }} context
 * @returns {{ key: string, displayName: string, initials: string, avatarUrl: string|null, position: number|null, average: number|null, faixa: string, streak: number, isMe: boolean }}
 */
export function peerRow(row, context) {
  const hidden = !context.isMe && isHidden(context);
  return {
    key: context.key,
    displayName: hidden ? ANONYMOUS_DISPLAY_NAME : row.displayName,
    initials: hidden ? '' : row.initials,
    avatarUrl: hidden ? null : context.avatarUrl ?? null,
    position: row.position ?? null,
    average: row.average ?? null,
    faixa: row.faixa,
    streak: row.streak,
    isMe: Boolean(context.isMe),
  };
}

// "A", "A e B" or "A, B e C"
function joinNames(names) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} e ${names[names.length - 1]}`;
}

// Sentence of each shared podium place, e.g. "Bruno C. e Lucas M. dividem o 2º: mesma média, ...", or null without ties
function tieSentenceOf(podium) {
  const sharedPositions = [...new Set(podium.filter((row) => row.shared).map((row) => row.position))];
  if (sharedPositions.length === 0) return null;
  return sharedPositions
    .map((position) => {
      const names = podium.filter((row) => row.position === position).map((row) => row.displayName);
      return `${joinNames(names)} dividem o ${position}º: ${TIE_REASON}.`;
    })
    .join(' ');
}

/**
 * Podium of the classified rows (1st to 3rd, ties repeat the place) or, with more than 3 at 100, the "Clube 100%" stack instead.
 *
 * @param {object[]} rows - classified peer rows ordered by position
 * @returns {{ podium: object[]|null, club100: { total: number, members: object[] }|null, tieSentence: string|null }}
 */
export function podiumFrom(rows) {
  const atFull = rows.filter((row) => row.average !== null && row.average >= FULL_SCORE);
  if (atFull.length > CLUB_100_MIN) return { podium: null, club100: { total: atFull.length, members: atFull }, tieSentence: null };
  const places = rows.filter((row) => row.position !== null && row.position <= PODIUM_PLACES);
  const podium = places.map((row) => ({ ...row, shared: places.filter((other) => other.position === row.position).length > 1 }));
  return { podium, club100: null, tieSentence: tieSentenceOf(podium) };
}

/**
 * "Perto de você": the student with up to 2 classified rows above and 2 below; empty when the student is not classified or alone.
 *
 * @param {object[]} rows - classified rows ordered by position
 * @param {number} meIndex - index of the student in rows, -1 when not classified
 * @returns {object[]}
 */
export function neighborsOf(rows, meIndex) {
  if (meIndex < 0 || rows.length <= 1) return [];
  return rows.slice(Math.max(0, meIndex - 2), meIndex + 3);
}

/**
 * Whether the student is under 18 on the given civil day; without a birth date the student counts as an adult (APP-42).
 *
 * @param {Date|null} birthDate - @db.Date value (midnight UTC)
 * @param {{ year: number, month: number, day: number }} today - civil day in the trainer's time zone
 * @returns {boolean}
 */
export function isMinor(birthDate, today) {
  if (!birthDate) return false;
  const adultFrom = Date.UTC(birthDate.getUTCFullYear() + ADULT_AGE, birthDate.getUTCMonth(), birthDate.getUTCDate());
  return Date.UTC(today.year, today.month - 1, today.day) < adultFrom;
}

/**
 * Visibility a student gets of a championship: a minor only sees the own week, like "Desligado" (APP-42).
 *
 * @param {string} visibility - one of ChallengeVisibility
 * @param {boolean} minor
 * @returns {string}
 */
export function effectiveVisibility(visibility, minor) {
  return minor ? ChallengeVisibility.OFF : visibility ?? ChallengeVisibility.FULL;
}

/**
 * Own championship figures the visibility lets the student see: none with "Desligado", position and band with "Só a posição" (APP-06).
 *
 * @param {{ position: number|null, total: number|null, faixa: string|null, average: number|null }} figures
 * @param {string} visibility - effective visibility
 * @returns {{ position: number|null, total: number|null, faixa: string|null, average: number|null }}
 */
export function visibleFigures(figures, visibility) {
  if (visibility === ChallengeVisibility.OFF) return { position: null, total: null, faixa: null, average: null };
  if (visibility === ChallengeVisibility.POSITION) return { ...figures, average: null };
  return figures;
}
