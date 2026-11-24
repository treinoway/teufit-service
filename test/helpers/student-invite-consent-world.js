import crypto from 'node:crypto';
import { vi } from 'vitest';

const UNIQUE_VIOLATION_CODE = 'P2002';
const PENDING_STATUS = 'pending';

const COMPARATORS = Object.freeze({
  gte: (value, bound) => value !== null && value >= bound,
  gt: (value, bound) => value !== null && value > bound,
  lte: (value, bound) => value !== null && value <= bound,
  lt: (value, bound) => value !== null && value < bound,
  not: (value, bound) => !sameValue(value, bound),
  equals: (value, bound) => sameValue(value, bound),
  in: (value, bound) => bound.some((candidate) => sameValue(value, candidate)),
  notIn: (value, bound) => !bound.some((candidate) => sameValue(value, candidate)),
});

// True for a plain object (not null, not a Date, not an array).
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);
}

// Equality that compares dates by instant.
function sameValue(left, right) {
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime();
  return left === right;
}

// True when a value satisfies a Prisma-style condition: equality, comparison operators or a relation filter.
function matchesCondition(value, condition) {
  if (!isPlainObject(condition)) return sameValue(value, condition);
  if (isPlainObject(value)) return matchesWhere(value, condition.is ?? condition);
  if (value === null && 'is' in condition) return condition.is === null;
  return Object.entries(condition).every(([operator, bound]) => {
    const compare = COMPARATORS[operator];
    return compare ? compare(value, bound) : false;
  });
}

// True when a row satisfies a Prisma-style where clause (fields, relations, AND, OR, NOT).
export function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === 'OR') return condition.some((branch) => matchesWhere(row, branch));
    if (key === 'AND') return [condition].flat().every((branch) => matchesWhere(row, branch));
    if (key === 'NOT') return ![condition].flat().some((branch) => matchesWhere(row, branch));
    return matchesCondition(row[key] ?? null, condition);
  });
}

// Applies a Prisma-style data object (plain values, increment, decrement) to a stored row.
function applyData(row, data) {
  for (const [key, value] of Object.entries(data)) {
    if (isPlainObject(value) && 'increment' in value) row[key] = (row[key] ?? 0) + value.increment;
    else if (isPlainObject(value) && 'decrement' in value) row[key] = (row[key] ?? 0) - value.decrement;
    else row[key] = value;
  }
  return row;
}

// Sorts rows in place by a Prisma-style single-field orderBy.
function sortRows(rows, orderBy) {
  const [[field, direction] = []] = Object.entries([orderBy].flat()[0] ?? {});
  if (!field) return rows;
  const sign = direction === 'desc' ? -1 : 1;
  return rows.sort((left, right) => sign * (left[field] > right[field] ? 1 : left[field] < right[field] ? -1 : 0));
}

// Returns what Prisma would: scalars only, plus the relations named by select or include.
function project(row, relations, { select, include } = {}) {
  const scalars = Object.fromEntries(Object.entries(row).filter(([key]) => !(key in relations)));
  if (select) {
    return Object.fromEntries(Object.keys(select).filter((key) => select[key]).map((key) => [key, row[key] ?? null]));
  }
  const included = Object.keys(include ?? {}).filter((key) => include[key] && key in relations);
  return { ...scalars, ...Object.fromEntries(included.map((key) => [key, row[key]])) };
}

// Builds a table with the Prisma delegate methods the invite services may use; where clauses are really evaluated.
function createTable({ rows, hydrate = (row) => row, relations = {}, defaults = () => ({}), assertInsertable = () => {} }) {
  const hooks = { race: [] };
  const fireRace = () => hooks.race.splice(0).forEach((hook) => hook());
  const hydrated = () => rows.map((row) => ({ ...row, ...hydrate(row) }));
  const matching = (where) => rows.filter((row) => matchesWhere({ ...row, ...hydrate(row) }, where));
  const read = (args = {}) => {
    const found = sortRows(hydrated().filter((row) => matchesWhere(row, args.where)), args.orderBy);
    const page = found.slice(args.skip ?? 0, args.take === undefined ? undefined : (args.skip ?? 0) + args.take);
    const result = page.map((row) => project(row, relations, args));
    fireRace();
    return result;
  };
  const insert = (data) => {
    assertInsertable(data, rows);
    const row = { ...defaults(), ...data };
    rows.push(row);
    return row;
  };
  const table = {
    findMany: vi.fn(async (args) => read(args)),
    findFirst: vi.fn(async (args) => read(args)[0] ?? null),
    findUnique: vi.fn(async (args) => read({ ...args, where: flattenCompoundKey(args.where) })[0] ?? null),
    count: vi.fn(async (args = {}) => matching(args.where).length),
    create: vi.fn(async (args) => project(insert(args.data), relations, args)),
    createMany: vi.fn(async ({ data, skipDuplicates }) => insertMany([data].flat(), { insert, skipDuplicates })),
    update: vi.fn(async (args) => {
      fireRace();
      return project(applyData(requireRow(matching(flattenCompoundKey(args.where))), args.data), relations, args);
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      fireRace();
      return { count: matching(where).map((row) => applyData(row, data)).length };
    }),
    upsert: vi.fn(async (args) => {
      fireRace();
      const [existing] = matching(flattenCompoundKey(args.where));
      return project(existing ? applyData(existing, args.update) : insert(args.create), relations, args);
    }),
  };
  return { table, hooks };
}

// Turns `{ trainerId_studentId: { trainerId, studentId } }` into a flat where clause.
function flattenCompoundKey(where = {}) {
  return Object.entries(where).reduce(
    (flat, [key, value]) => (key.includes('_') && isPlainObject(value) ? { ...flat, ...value } : { ...flat, [key]: value }),
    {},
  );
}

// Returns the single matching row or rejects like Prisma does for a missing record.
function requireRow([row]) {
  if (!row) throw Object.assign(new Error('Record to update not found.'), { code: 'P2025' });
  return row;
}

// Inserts rows one by one, optionally skipping the ones that violate a unique rule.
function insertMany(items, { insert, skipDuplicates }) {
  let count = 0;
  for (const item of items) {
    try {
      insert(item);
      count += 1;
    } catch (error) {
      if (!(skipDuplicates && error.code === UNIQUE_VIOLATION_CODE)) throw error;
    }
  }
  return { count };
}

// Builds the error Prisma raises on a unique constraint violation.
function uniqueViolation() {
  return Object.assign(new Error('Unique constraint failed'), { code: UNIQUE_VIOLATION_CODE });
}

// Rejects a second pending invite of the same trainer for the same email (partial unique index).
function assertSinglePendingInvite(data, rows) {
  const status = data.status ?? PENDING_STATUS;
  const clash = rows.some((row) => row.trainerId === data.trainerId && row.email === data.email && row.status === PENDING_STATUS);
  if (status === PENDING_STATUS && clash) throw uniqueViolation();
}

// Rejects a second link of the same trainer and student (composite primary key).
function assertSingleLink(data, rows) {
  if (rows.some((row) => row.trainerId === data.trainerId && row.studentId === data.studentId)) throw uniqueViolation();
}

// Column defaults of student_invites, as the database fills them.
function inviteDefaults() {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    status: PENDING_STATUS,
    studentId: null,
    acceptedAt: null,
    revokedAt: null,
    lastSentAt: now,
    sendCount: 1,
    createdAt: now,
    requiresConsent: false,
  };
}

/**
 * In-memory Prisma stand-in for the trainer -> student invite flows: rows are really stored and filtered, so tests assert outcomes instead of query shapes.
 *
 * @param {{ users?: object[], accounts?: object[], trainers?: object[], invites?: object[], links?: object[], nutritionists?: object[], patientInvites?: object[] }} seed
 * @returns {{ prisma: object, state: object, raceInviteWith: (change: () => void) => void }} raceInviteWith runs `change` once, right after the first invite read or right before the first invite write, whichever comes first
 */
export function createInviteConsentWorld({
  users = [],
  accounts = [],
  trainers = [],
  invites = [],
  links = [],
  nutritionists = [],
  patientInvites = [],
} = {}) {
  const state = {
    users: users.map((row) => ({ ...row })),
    accounts: accounts.map((row) => ({ ...row })),
    trainers: trainers.map((row) => ({ ...row })),
    studentInvites: invites.map((row) => ({ ...inviteDefaults(), ...row })),
    trainerStudents: links.map((row) => ({ ...row })),
    nutritionists: nutritionists.map((row) => ({ ...row })),
    patientInvites: patientInvites.map((row) => ({ ...inviteDefaults(), ...row })),
    nutritionistPatients: [],
  };
  const userById = (id) => state.users.find((user) => user.id === id) ?? null;
  const trainerWithUser = (id) => {
    const trainer = state.trainers.find((row) => row.id === id) ?? null;
    return trainer ? { ...trainer, user: userById(trainer.userId) } : null;
  };

  const user = createTable({ rows: state.users });
  const account = createTable({ rows: state.accounts });
  const trainer = createTable({
    rows: state.trainers,
    relations: { user: true },
    hydrate: (row) => ({ user: userById(row.userId) }),
  });
  const studentInvite = createTable({
    rows: state.studentInvites,
    relations: { trainer: true, student: true },
    hydrate: (row) => ({ trainer: trainerWithUser(row.trainerId), student: userById(row.studentId) }),
    defaults: inviteDefaults,
    assertInsertable: assertSinglePendingInvite,
  });
  const trainerStudent = createTable({
    rows: state.trainerStudents,
    relations: { trainer: true, student: true },
    hydrate: (row) => ({ trainer: trainerWithUser(row.trainerId), student: userById(row.studentId) }),
    defaults: () => ({ activeOnPlan: true, createdAt: new Date() }),
    assertInsertable: assertSingleLink,
  });

  const nutritionist = createTable({ rows: state.nutritionists });
  const patientInvite = createTable({ rows: state.patientInvites, defaults: inviteDefaults });
  const nutritionistPatient = createTable({ rows: state.nutritionistPatients });

  const prisma = {
    $queryRaw: vi.fn(async (_strings, email) =>
      state.users
        .filter((row) => String(row.email).trim().toLowerCase() === String(email).trim().toLowerCase())
        .slice(0, 1)
        .map((row) => ({ id: row.id })),
    ),
    user: user.table,
    account: account.table,
    trainer: trainer.table,
    studentInvite: studentInvite.table,
    trainerStudent: trainerStudent.table,
    nutritionist: nutritionist.table,
    patientInvite: patientInvite.table,
    nutritionistPatient: nutritionistPatient.table,
  };
  prisma.$transaction = vi.fn(async (work) => (typeof work === 'function' ? work(prisma) : Promise.all(work)));

  return {
    prisma,
    state,
    raceInviteWith: (change) => studentInvite.hooks.race.push(change),
  };
}
