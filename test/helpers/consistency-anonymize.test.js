import { describe, expect, it } from 'vitest';
import {
  displayNameFor,
  neighborsOf,
  peerRow,
  podiumFrom,
} from '../../src/helpers/consistency-anonymize.js';
import { shortNameOf } from '../../src/helpers/consistency-names.js';
import { ANONYMOUS_DISPLAY_NAME, AppearAs, Faixa, WeekStatus } from '../../src/constants/consistency-ranking.js';
import { faixaFor } from '../../src/services/consistency-insights-service.js';

const ME = 'camila';

// Classified row exactly as computeChallengeStandings (liveRow) returns it
function standingRow(studentId, firstName, lastName, { position, average, weeksAt100 = 0, streak = 0 }) {
  return {
    studentId,
    name: `${firstName} ${lastName}`,
    ...shortNameOf({ firstName, lastName, username: studentId }),
    position,
    eligible: true,
    faixa: faixaFor(average, true),
    average,
    validWeeks: 2,
    weeks100: weeksAt100,
    weeksAt100,
    streak,
    currentWeekScore: average,
    weekStatus: WeekStatus.VALID,
    entering: null,
    weeksMissing: 0,
  };
}

// Peer view of a row: every participant chose to appear by name unless told otherwise
function asPeer(row, overrides = {}) {
  return peerRow(row, {
    key: `k-${row.studentId}`,
    isMe: row.studentId === ME,
    avatarUrl: `https://cdn/${row.studentId}.png`,
    privacy: AppearAs.NAME,
    isMinor: false,
    anonymousRanking: false,
    ...overrides,
  });
}

// The example team: Ana 1st, Bruno and Lucas tied 2nd, then Marcos, Paula, Camila, Eduarda and Thiago
function exampleTeam() {
  return [
    standingRow('ana', 'Ana Beatriz', 'Souza', { position: 1, average: 100, weeksAt100: 3, streak: 3 }),
    standingRow('bruno', 'Bruno', 'Costa', { position: 2, average: 97.5, weeksAt100: 1, streak: 1 }),
    standingRow('lucas', 'Lucas', 'Mendes', { position: 2, average: 97.5, weeksAt100: 1, streak: 1 }),
    standingRow('marcos', 'Marcos', 'Lima', { position: 4, average: 96 }),
    standingRow('paula', 'Paula', 'Reis', { position: 5, average: 95 }),
    standingRow(ME, 'Camila', 'Rocha', { position: 6, average: 93 }),
    standingRow('eduarda', 'Eduarda', 'Nunes', { position: 7, average: 90 }),
    standingRow('thiago', 'Thiago', 'Alves', { position: 8, average: 88 }),
  ];
}

describe('consistency-anonymize', () => {
  it('APP-11 builds the podium with ties and the tie sentence', () => {
    const { podium, club100, tieSentence } = podiumFrom(exampleTeam().map((row) => asPeer(row)));

    expect(club100).toBeNull();
    expect(podium.map(({ displayName, position, shared }) => ({ displayName, position, shared }))).toEqual([
      { displayName: 'Ana Beatriz S.', position: 1, shared: false },
      { displayName: 'Bruno C.', position: 2, shared: true },
      { displayName: 'Lucas M.', position: 2, shared: true },
    ]);
    expect(tieSentence).toBe('Bruno C. e Lucas M. dividem o 2º: mesma média, mesmas semanas a 100% e mesma sequência.');
  });

  it('APP-12 swaps the podium for Clube 100% when more than 3 are at 100', () => {
    const atFull = ['ana', 'bruno', 'lucas', 'marcos'].map((id) => standingRow(id, id, 'Silva', { position: 1, average: 100 }));
    const rows = [...atFull, standingRow(ME, 'Camila', 'Rocha', { position: 5, average: 93 })].map((row) => asPeer(row));

    const exactlyThree = podiumFrom(rows.slice(1));
    const moreThanThree = podiumFrom(rows);

    expect(exactlyThree.club100).toBeNull();
    expect(exactlyThree.podium).toHaveLength(3);
    expect(moreThanThree.podium).toBeNull();
    expect(moreThanThree.tieSentence).toBeNull();
    expect(moreThanThree.club100.total).toBe(4);
    expect(moreThanThree.club100.members.map((row) => row.displayName)).toEqual(['ana S.', 'bruno S.', 'lucas S.', 'marcos S.']);
  });

  it('APP-13 returns 2 above and 2 below the student', () => {
    const rows = exampleTeam().map((row) => asPeer(row));
    const meIndex = rows.findIndex((row) => row.isMe);

    expect(neighborsOf(rows, meIndex).map((row) => row.displayName)).toEqual(['Marcos L.', 'Paula R.', 'Camila R.', 'Eduarda N.', 'Thiago A.']);
    expect(neighborsOf(rows, 0).map((row) => row.displayName)).toEqual(['Ana Beatriz S.', 'Bruno C.', 'Lucas M.']);
    expect(neighborsOf(rows, -1)).toEqual([]);
  });

  it('APP-22 shows a pending student as Aluno do time without photo', () => {
    const marcos = exampleTeam()[3];

    const seen = asPeer(marcos, { privacy: AppearAs.PENDING });

    expect(seen).toMatchObject({ displayName: ANONYMOUS_DISPLAY_NAME, initials: '', avatarUrl: null, position: 4 });
    expect(displayNameFor({ firstName: 'Marcos', lastName: 'Lima' }, { privacy: AppearAs.PENDING, isMinor: false, anonymousRanking: false }))
      .toBe('Aluno do time');
  });

  it('APP-24 keeps an anonymous student in the same position as Aluno do time', () => {
    const rows = exampleTeam();
    const named = rows.map((row) => asPeer(row));
    const withAnonymousMarcos = rows.map((row) => asPeer(row, row.studentId === 'marcos' ? { privacy: AppearAs.ANONYMOUS } : {}));

    expect(withAnonymousMarcos.map((row) => row.position)).toEqual(named.map((row) => row.position));
    expect(withAnonymousMarcos[3]).toMatchObject({ displayName: 'Aluno do time', avatarUrl: null, position: 4, average: 96, faixa: Faixa.CONSTANT });
    expect(withAnonymousMarcos[5]).toMatchObject({ displayName: 'Camila R.', isMe: true });
  });

  it('APP-40 exposes only display name, photo when allowed, position, average, band and streak', () => {
    const row = {
      ...exampleTeam()[1],
      email: 'bruno@example.com',
      phone: '+5511999999999',
      pillars: { workouts: { expected: 4, done: 4 }, cardio: { expected: 2, done: 1 } },
      seasonPillars: [{ pillar: 'cardio', adherence: 50 }],
    };

    const seen = asPeer(row);

    expect(seen).toEqual({
      key: 'k-bruno',
      displayName: 'Bruno C.',
      initials: 'BC',
      avatarUrl: 'https://cdn/bruno.png',
      position: 2,
      average: 97.5,
      faixa: Faixa.CONSTANT,
      streak: 1,
      isMe: false,
    });
    expect(JSON.stringify(seen)).not.toMatch(/bruno@example\.com|\+5511|"studentId"|"pillars"|"seasonPillars"/);
  });

  it('APP-64 hides every name and photo when the championship ranking is anonymous', () => {
    const rows = exampleTeam().map((row) => asPeer(row, { anonymousRanking: true }));

    const others = rows.filter((row) => !row.isMe);
    expect(others.every((row) => row.displayName === 'Aluno do time' && row.avatarUrl === null && row.initials === '')).toBe(true);
    expect(rows.find((row) => row.isMe)).toMatchObject({ displayName: 'Camila R.', position: 6 });
    expect(podiumFrom(rows).podium.map((row) => row.displayName)).toEqual(['Aluno do time', 'Aluno do time', 'Aluno do time']);
  });
});
