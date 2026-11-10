import { describe, expect, it } from 'vitest';
import {
  countFilters,
  filterStandings,
  searchStandings,
  sortForFilter,
  teamSummary,
} from '../../src/helpers/consistency-standings-query.js';
import { StandingsFilter, WeekStatus } from '../../src/constants/consistency-ranking.js';

const RISK = { scores: [64, 58] };
const SIGNAL = [{ type: 'quick_completion' }];
const PAUSE = { weekStart: '2026-11-09', reason: 'viagem' };
const ENTERING = { validWeeks: 1, required: 2 };

// Standings row with the fields the query helpers read
function row(studentId, displayName, overrides = {}) {
  return {
    studentId,
    displayName,
    position: 1,
    average: 90,
    risk: null,
    signals: [],
    pause: null,
    entering: null,
    ...overrides,
  };
}

// The sample team: one row per filter group, plus a healthy student
function team() {
  return [
    row('ana', 'Ana Beatriz S.', { position: 1, average: 100 }),
    row('rafael', 'Rafael D.', { position: 5, average: 61, risk: RISK }),
    row('joao', 'João V.', { position: 6, average: 55, risk: RISK, signals: SIGNAL }),
    row('marcos', 'Marcos T.', { position: 3, average: 88, pause: PAUSE }),
    row('larissa', 'Larissa M.', { position: 7, average: 68, risk: RISK }),
    row('novo', 'Novo A.', { position: null, average: 40, entering: ENTERING }),
  ];
}

// Names of the rows in order
function names(rows) {
  return rows.map((item) => item.displayName);
}

describe('filterStandings', () => {
  it('PAN-12 keeps only the selected group', () => {
    const rows = team();

    expect(names(filterStandings(rows, StandingsFilter.ALL))).toHaveLength(6);
    expect(names(filterStandings(rows, StandingsFilter.RISK))).toEqual(['Rafael D.', 'João V.', 'Larissa M.']);
    expect(names(filterStandings(rows, StandingsFilter.SIGNAL))).toEqual(['João V.']);
    expect(names(filterStandings(rows, StandingsFilter.ENTERING))).toEqual(['Novo A.']);
    expect(names(filterStandings(rows, StandingsFilter.PAUSED))).toEqual(['Marcos T.']);
  });

  it('PAN-12 returns nothing for a group with no student', () => {
    expect(filterStandings([row('ana', 'Ana')], StandingsFilter.RISK)).toEqual([]);
  });
});

describe('sortForFilter', () => {
  it('PAN-13 sorts at-risk students by ascending score', () => {
    const atRisk = filterStandings(team(), StandingsFilter.RISK);

    expect(names(sortForFilter(atRisk, StandingsFilter.RISK))).toEqual(['João V.', 'Rafael D.', 'Larissa M.']);
  });

  it('PAN-13 sorts the other filters by position with entering students last', () => {
    const sorted = sortForFilter(team().reverse(), StandingsFilter.ALL);

    expect(names(sorted)).toEqual(['Ana Beatriz S.', 'Marcos T.', 'Rafael D.', 'João V.', 'Larissa M.', 'Novo A.']);
  });

  it('PAN-13 keeps tied positions in name order', () => {
    const tied = [row('b', 'Bruno', { position: 2 }), row('l', 'Lucas', { position: 2 }), row('a', 'Alice', { position: 2 })];

    expect(names(sortForFilter(tied, StandingsFilter.ALL))).toEqual(['Alice', 'Bruno', 'Lucas']);
  });

  it('PAN-13 does not change the list it receives', () => {
    const rows = team().reverse();
    const before = names(rows);

    sortForFilter(rows, StandingsFilter.ALL);

    expect(names(rows)).toEqual(before);
  });
});

describe('searchStandings', () => {
  it('PAN-15 ignores case and accents', () => {
    const rows = team();

    expect(names(searchStandings(rows, 'JOAO'))).toEqual(['João V.']);
    expect(names(searchStandings(rows, 'joão'))).toEqual(['João V.']);
    expect(names(searchStandings(rows, 'beatriz'))).toEqual(['Ana Beatriz S.']);
  });

  it('PAN-15 matches the full name when the row carries one', () => {
    const rows = [row('ana', 'Ana Beatriz S.', { name: 'Ana Beatriz Souza' })];

    expect(names(searchStandings(rows, 'souza'))).toEqual(['Ana Beatriz S.']);
  });

  it('PAN-15 returns every row for an empty or blank search', () => {
    expect(searchStandings(team(), '')).toHaveLength(6);
    expect(searchStandings(team(), '   ')).toHaveLength(6);
    expect(searchStandings(team(), undefined)).toHaveLength(6);
  });

  it('PAN-15 returns nothing when no name contains the text', () => {
    expect(searchStandings(team(), 'zzz')).toEqual([]);
  });
});

describe('countFilters', () => {
  it('PAN-47 counts every filter', () => {
    expect(countFilters(team())).toEqual({ all: 6, risk: 3, signal: 1, entering: 1, paused: 1 });
  });

  it('PAN-47 counts zero for an empty team', () => {
    expect(countFilters([])).toEqual({ all: 0, risk: 0, signal: 0, entering: 0, paused: 0 });
  });
});

describe('teamSummary', () => {
  it('PAN-03 builds the four summary numbers', () => {
    const lastClosedWeek = [
      { studentId: 'ana', status: WeekStatus.VALID, score: 100 },
      { studentId: 'rafael', status: WeekStatus.VALID, score: 80 },
      { studentId: 'joao', status: WeekStatus.VALID, score: 100 },
      { studentId: 'marcos', status: WeekStatus.PAUSED, score: null },
      { studentId: 'larissa', status: WeekStatus.NEUTRAL, score: null },
      { studentId: 'gone', status: WeekStatus.VALID, score: 10 },
    ];

    expect(teamSummary(team(), lastClosedWeek)).toEqual({
      teamAverage: 74.4,
      lastClosedWeekAverage: 93.33,
      fullLastWeek: 2,
      validLastWeek: 3,
      atRisk: 3,
      withSignal: 1,
    });
  });

  it('PAN-03 has no last-week figures before the first closed week', () => {
    const summary = teamSummary(team(), []);

    expect(summary).toMatchObject({ lastClosedWeekAverage: null, fullLastWeek: 0, validLastWeek: 0 });
  });

  it('PAN-03 has no team average without ranked students', () => {
    const summary = teamSummary([row('novo', 'Novo', { position: null, entering: ENTERING })], []);

    expect(summary.teamAverage).toBeNull();
  });
});
