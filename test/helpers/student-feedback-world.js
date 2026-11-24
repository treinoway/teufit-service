/**
 * In-memory Prisma stand-in for the student-feedback unit tests.
 *
 * It evaluates real `where`, `select`, `include` and `orderBy` arguments over plain rows, so the tests
 * assert behaviour (what ends up stored, what comes back) instead of the exact shape of each query.
 * Transactions run the callback against the same store, without rollback.
 */

const DAY_MS = 86400000;

// To-one relation descriptor: this model holds the foreign key
function one(model, foreignKey) {
  return { kind: 'one', model, foreignKey };
}

// To-many relation descriptor: the other model holds the foreign key
function many(model, foreignKey) {
  return { kind: 'many', model, foreignKey };
}

// Reverse to-one relation descriptor: the other model holds a unique foreign key
function reverseOne(model, foreignKey) {
  return { kind: 'reverseOne', model, foreignKey };
}

export const RELATIONS = Object.freeze({
  studentFeedbackTemplate: {
    trainer: one('trainer', 'trainerId'),
    questions: many('studentFeedbackQuestion', 'templateId'),
    requests: many('studentFeedbackRequest', 'templateId'),
  },
  studentFeedbackQuestion: {
    template: one('studentFeedbackTemplate', 'templateId'),
    answers: many('studentFeedbackAnswer', 'questionId'),
  },
  studentFeedbackConfig: {
    trainer: one('trainer', 'trainerId'),
  },
  studentFeedbackRequest: {
    template: one('studentFeedbackTemplate', 'templateId'),
    trainer: one('trainer', 'trainerId'),
    student: one('user', 'studentId'),
    answers: many('studentFeedbackAnswer', 'requestId'),
  },
  studentFeedbackAnswer: {
    request: one('studentFeedbackRequest', 'requestId'),
    question: one('studentFeedbackQuestion', 'questionId'),
  },
  trainerStudent: {
    trainer: one('trainer', 'trainerId'),
    student: one('user', 'studentId'),
  },
  trainer: {
    user: one('user', 'userId'),
    students: many('trainerStudent', 'trainerId'),
    studentFeedbackConfig: reverseOne('studentFeedbackConfig', 'trainerId'),
    studentFeedbackRequests: many('studentFeedbackRequest', 'trainerId'),
    studentFeedbackTemplates: many('studentFeedbackTemplate', 'trainerId'),
  },
  user: {
    trainer: reverseOne('trainer', 'userId'),
    studentFeedbackRequests: many('studentFeedbackRequest', 'studentId'),
    dietProtocols: many('dietProtocol', 'assigneeId'),
  },
  dietProtocol: {
    assignee: one('user', 'assigneeId'),
    nutritionist: one('nutritionist', 'nutritionistId'),
  },
  nutritionist: {
    patients: many('nutritionistPatient', 'nutritionistId'),
    dietProtocols: many('dietProtocol', 'nutritionistId'),
  },
  nutritionistPatient: {
    nutritionist: one('nutritionist', 'nutritionistId'),
    patient: one('user', 'patientId'),
  },
});

const UNIQUE_KEYS = Object.freeze({
  studentFeedbackConfig: [['trainerId']],
  studentFeedbackAnswer: [['requestId', 'questionId']],
  trainerStudent: [['trainerId', 'studentId']],
});

const FIELD_OPERATORS = Object.freeze(['equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 'contains', 'startsWith', 'endsWith', 'mode']);

// Error raised when the code under test uses something this stand-in does not model
function unsupported(what) {
  return new TypeError(`student-feedback-world: ${what} is not modelled; extend test/helpers/student-feedback-world.js`);
}

// Error with the Prisma code the real client would raise
function prismaError(code, message) {
  return Object.assign(new TypeError(message), { code });
}

// Whether the value is a plain object (not a Date, array or null)
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

// Comparable form of a scalar: dates become their epoch milliseconds
function comparable(value) {
  return value instanceof Date ? value.getTime() : value;
}

// Whether two scalars are the same value, treating undefined as null
function sameScalar(left, right) {
  return comparable(left ?? null) === comparable(right ?? null);
}

// Whether a condition object is a set of field operators rather than a nested filter
function isOperatorObject(condition) {
  return isPlainObject(condition) && Object.keys(condition).every((key) => FIELD_OPERATORS.includes(key));
}

// Whether a string operator holds, honouring the insensitive mode
function matchesText(value, condition, operator) {
  if (typeof value !== 'string') return false;
  const insensitive = condition.mode === 'insensitive';
  const haystack = insensitive ? value.toLowerCase() : value;
  const needle = insensitive ? String(condition[operator]).toLowerCase() : String(condition[operator]);
  if (operator === 'contains') return haystack.includes(needle);
  return operator === 'startsWith' ? haystack.startsWith(needle) : haystack.endsWith(needle);
}

// Whether one field operator holds for the value
function matchesOperator(value, condition, operator) {
  const operand = condition[operator];
  if (operand === undefined || operator === 'mode') return true;
  if (operator === 'equals') return sameScalar(value, operand);
  if (operator === 'not') return !matchesField(value, operand);
  if (operator === 'in') return operand.some((item) => sameScalar(value, item));
  if (operator === 'notIn') return !operand.some((item) => sameScalar(value, item));
  if (['contains', 'startsWith', 'endsWith'].includes(operator)) return matchesText(value, condition, operator);
  if (value === null || value === undefined) return false;
  if (operator === 'lt') return comparable(value) < comparable(operand);
  if (operator === 'lte') return comparable(value) <= comparable(operand);
  if (operator === 'gt') return comparable(value) > comparable(operand);
  return comparable(value) >= comparable(operand);
}

// Whether a scalar field satisfies a Prisma field condition
function matchesField(value, condition) {
  if (!isPlainObject(condition)) return sameScalar(value, condition);
  if (!isOperatorObject(condition)) throw unsupported(`field filter ${JSON.stringify(condition)}`);
  return Object.keys(condition).every((operator) => matchesOperator(value, condition, operator));
}

// Whether the key is a compound unique selector such as trainerId_studentId
function isCompoundKey(key, condition) {
  return key.includes('_') && isPlainObject(condition) && key.split('_').every((part) => part in condition);
}

// Rows related to a row through a relation descriptor
function relatedRows(store, relation, row) {
  if (relation.kind === 'one') return store.table(relation.model).filter((other) => other.id === row[relation.foreignKey]);
  return store.table(relation.model).filter((other) => other[relation.foreignKey] === row.id);
}

// Whether a to-many relation filter (some / none / every) holds
function matchesManyRelation(store, relation, rows, condition) {
  return Object.entries(condition).every(([quantifier, where]) => {
    const hits = rows.filter((other) => matchesWhere(store, relation.model, other, where));
    if (quantifier === 'some') return hits.length > 0;
    if (quantifier === 'none') return hits.length === 0;
    if (quantifier === 'every') return hits.length === rows.length;
    throw unsupported(`relation quantifier ${quantifier}`);
  });
}

// Whether a to-one relation filter (plain, is, isNot, null) holds
function matchesOneRelation(store, relation, related, condition) {
  if (condition === null) return !related;
  if ('is' in condition) return matchesOneRelation(store, relation, related, condition.is);
  if ('isNot' in condition) return !matchesOneRelation(store, relation, related, condition.isNot);
  return Boolean(related) && matchesWhere(store, relation.model, related, condition);
}

// Whether a relation filter holds for the row
function matchesRelation(store, relation, row, condition) {
  const rows = relatedRows(store, relation, row);
  if (relation.kind === 'many') return matchesManyRelation(store, relation, rows, condition);
  return matchesOneRelation(store, relation, rows[0], condition);
}

// Whether a row satisfies a Prisma where clause
function matchesWhere(store, model, row, where) {
  if (!where) return true;
  return Object.entries(where).every(([key, condition]) => {
    if (condition === undefined) return true;
    if (key === 'AND') return [].concat(condition).every((item) => matchesWhere(store, model, row, item));
    if (key === 'OR') return condition.some((item) => matchesWhere(store, model, row, item));
    if (key === 'NOT') return ![].concat(condition).some((item) => matchesWhere(store, model, row, item));
    const relation = RELATIONS[model]?.[key];
    if (relation) return matchesRelation(store, relation, row, condition);
    if (isCompoundKey(key, condition)) return matchesWhere(store, model, row, condition);
    return matchesField(row[key], condition);
  });
}

// Direction multiplier of an orderBy entry value
function directionOf(order) {
  return (isPlainObject(order) ? order.sort : order) === 'desc' ? -1 : 1;
}

// Sorts rows by a Prisma orderBy (object or array of objects, scalar fields only)
function sortRows(rows, orderBy) {
  const entries = [].concat(orderBy ?? []).flatMap((item) => Object.entries(item));
  return [...rows].sort((left, right) => {
    for (const [field, order] of entries) {
      const a = comparable(left[field] ?? null);
      const b = comparable(right[field] ?? null);
      if (a !== b) return (a < b ? -1 : 1) * directionOf(order);
    }
    return 0;
  });
}

// Rows of a model after where, orderBy, skip and take
function queryRows(store, model, args = {}) {
  const filtered = store.table(model).filter((row) => matchesWhere(store, model, row, args.where));
  const sorted = sortRows(filtered, args.orderBy);
  const skipped = args.skip ? sorted.slice(args.skip) : sorted;
  return args.take === undefined ? skipped : skipped.slice(0, args.take);
}

// Value of a relation for a projected row: array, object or null
function loadRelation(store, model, row, key, args) {
  const relation = RELATIONS[model]?.[key];
  if (!relation) throw unsupported(`relation ${model}.${key}`);
  const options = args === true ? {} : args;
  const rows = relatedRows(store, relation, row);
  if (relation.kind !== 'many') return rows[0] ? project(store, relation.model, rows[0], options) : null;
  const scoped = { ...options, where: { AND: [{ [relation.foreignKey]: row.id }, options.where ?? {}] } };
  return queryRows(store, relation.model, scoped).map((other) => project(store, relation.model, other, options));
}

// Relation counts of a row for a `_count` selection
function countRelations(store, model, row, args) {
  const keys = Object.keys(args === true ? RELATIONS[model] ?? {} : args.select);
  return Object.fromEntries(keys.map((key) => [key, loadRelation(store, model, row, key, true).length]));
}

// One selected or included key of a projected row
function projectKey(store, model, row, key, args) {
  if (key === '_count') return countRelations(store, model, row, args);
  if (RELATIONS[model]?.[key]) return loadRelation(store, model, row, key, args);
  return row[key] ?? null;
}

// Copy of a row shaped by select or include
function project(store, model, row, args = {}) {
  const picked = Object.entries(args.select ?? args.include ?? {}).filter(([, value]) => value);
  const base = args.select ? {} : { ...row };
  for (const [key, value] of picked) base[key] = projectKey(store, model, row, key, value);
  return base;
}

// Applies a scalar update value, including the atomic number operations
function applyScalar(current, value) {
  if (!isPlainObject(value)) return value;
  if ('set' in value) return value.set;
  if ('increment' in value) return (current ?? 0) + value.increment;
  if ('decrement' in value) return (current ?? 0) - value.decrement;
  return value;
}

// Applies a nested write on a to-many relation
function writeManyRelation(store, relation, row, operations) {
  for (const [operation, payload] of Object.entries(operations)) {
    if (operation === 'create') [].concat(payload).forEach((data) => insertRow(store, relation.model, { ...data, [relation.foreignKey]: row.id }));
    else if (operation === 'createMany') payload.data.forEach((data) => insertRow(store, relation.model, { ...data, [relation.foreignKey]: row.id }));
    else if (operation === 'deleteMany') removeRows(store, relation.model, { AND: [{ [relation.foreignKey]: row.id }, ...[].concat(payload)] });
    else throw unsupported(`nested ${operation} on ${relation.model}`);
  }
}

// Applies a nested write on a to-one relation
function writeOneRelation(store, relation, row, operations) {
  if (relation.kind !== 'one') throw unsupported(`nested write on ${relation.model}`);
  if (operations.connect) row[relation.foreignKey] = store.table(relation.model).find((other) => matchesWhere(store, relation.model, other, operations.connect))?.id;
  else if (operations.create) row[relation.foreignKey] = insertRow(store, relation.model, operations.create).id;
  else if (operations.disconnect) row[relation.foreignKey] = null;
  else throw unsupported(`nested ${Object.keys(operations)} on ${relation.model}`);
}

// Writes data into a row: scalars directly, relations through nested writes once the row has its id
function assignData(store, model, row, data) {
  const relationWrites = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    const relation = RELATIONS[model]?.[key];
    if (!relation) row[key] = applyScalar(row[key], value);
    else if (relation.kind === 'many') relationWrites.push(() => writeManyRelation(store, relation, row, value));
    else writeOneRelation(store, relation, row, value);
  }
  relationWrites.forEach((write) => write());
}

// Whether another row already holds one of the model's unique keys of the row
function violatesUnique(store, model, row) {
  return (UNIQUE_KEYS[model] ?? []).some((fields) =>
    store.table(model).some((other) => other !== row && fields.every((field) => sameScalar(other[field], row[field]))),
  );
}

// Inserts a row with generated id and createdAt, enforcing the model's unique keys
function insertRow(store, model, data) {
  const row = { id: store.nextId(model), createdAt: store.clock() };
  assignData(store, model, row, data);
  if (violatesUnique(store, model, row)) throw prismaError('P2002', `Unique constraint failed on ${model}`);
  store.table(model).push(row);
  return row;
}

// Deletes the rows of a model matching the where clause and returns how many
function removeRows(store, model, where) {
  const rows = store.table(model);
  const kept = rows.filter((row) => !matchesWhere(store, model, row, where));
  const count = rows.length - kept.length;
  rows.splice(0, rows.length, ...kept);
  return count;
}

// First row matching a where clause, or a P2025 error
function requireRow(store, model, where) {
  const row = store.table(model).find((candidate) => matchesWhere(store, model, candidate, where));
  if (!row) throw prismaError('P2025', `No ${model} record found`);
  return row;
}

// Inserts many rows, optionally skipping the ones that break a unique key
function insertMany(store, model, { data, skipDuplicates = false }) {
  const created = [];
  for (const item of [].concat(data)) {
    try {
      created.push(insertRow(store, model, item));
    } catch (err) {
      if (!skipDuplicates || err.code !== 'P2002') throw err;
    }
  }
  return created;
}

// Prisma-like delegate of one model over the store
function createDelegate(store, model) {
  const first = (args) => queryRows(store, model, args)[0] ?? null;
  const shaped = (row, args) => (row ? project(store, model, row, args) : null);
  return {
    findUnique: async (args) => shaped(first(args), args),
    findFirst: async (args) => shaped(first(args), args),
    findUniqueOrThrow: async (args) => shaped(requireRow(store, model, args.where), args),
    findFirstOrThrow: async (args) => shaped(requireRow(store, model, args?.where), args),
    findMany: async (args) => queryRows(store, model, args).map((row) => project(store, model, row, args)),
    count: async (args) => queryRows(store, model, args).length,
    create: async (args) => shaped(insertRow(store, model, args.data), args),
    createMany: async (args) => ({ count: insertMany(store, model, args).length }),
    createManyAndReturn: async (args) => insertMany(store, model, args).map((row) => project(store, model, row, args)),
    update: async (args) => {
      const row = requireRow(store, model, args.where);
      assignData(store, model, row, args.data);
      return shaped(row, args);
    },
    updateMany: async (args) => {
      const rows = queryRows(store, model, { where: args.where });
      rows.forEach((row) => assignData(store, model, row, args.data));
      return { count: rows.length };
    },
    upsert: async (args) => {
      const existing = first({ where: args.where });
      if (existing) assignData(store, model, existing, args.update);
      return shaped(existing ?? insertRow(store, model, args.create), args);
    },
    delete: async (args) => {
      const row = requireRow(store, model, args.where);
      removeRows(store, model, { id: row.id });
      return shaped(row, args);
    },
    deleteMany: async (args) => ({ count: removeRows(store, model, args?.where) }),
    aggregate: async () => {
      throw unsupported(`${model}.aggregate`);
    },
    groupBy: async () => {
      throw unsupported(`${model}.groupBy`);
    },
  };
}

// Row store with per-model tables, sequential ids and a settable clock for createdAt
function createStore() {
  const tables = new Map();
  const counters = new Map();
  let now = new Date('2026-01-01T00:00:00Z');
  return {
    table(model) {
      if (!tables.has(model)) tables.set(model, []);
      return tables.get(model);
    },
    nextId(model) {
      counters.set(model, (counters.get(model) ?? 0) + 1);
      return `${model}-${counters.get(model)}`;
    },
    clock: () => now,
    setClock(value) {
      now = value;
    },
  };
}

// Client-level methods of the stand-in: transactions and the raw queries used for advisory locks
function clientMethods(getPrisma) {
  return {
    $transaction: async (work) => (typeof work === 'function' ? work(getPrisma()) : Promise.all(work)),
    $queryRaw: async () => [{ locked: true }],
    $queryRawUnsafe: async () => [{ locked: true }],
    $executeRaw: async () => 1,
    $executeRawUnsafe: async () => 1,
  };
}

/**
 * Builds an empty world: `prisma` is the stand-in client, `seed(model, data)` inserts a row as given (explicit ids are kept) and `rows(model)` exposes the stored rows.
 *
 * @returns {{ prisma: object, seed: (model: string, data: object) => object, rows: (model: string) => object[], setClock: (now: Date) => void }}
 */
export function createWorld() {
  const store = createStore();
  const delegates = new Map();
  let prisma = null;
  const methods = clientMethods(() => prisma);
  prisma = new Proxy(methods, {
    get(target, property) {
      if (typeof property !== 'string' || property === 'then') return undefined;
      if (property in target) return target[property];
      if (!delegates.has(property)) delegates.set(property, createDelegate(store, property));
      return delegates.get(property);
    },
  });
  return {
    prisma,
    seed: (model, data) => insertRow(store, model, data),
    rows: (model) => store.table(model),
    setClock: store.setClock,
  };
}

export const TRAINER_ID = 'trainer-1';
export const OTHER_TRAINER_ID = 'trainer-2';
export const STUDENT_ID = 'student-ana';
export const OTHER_STUDENT_ID = 'student-bruno';
export const TEMPLATE_ID = 'template-general';
export const TEMPLATE_NAME = 'Padrão TeuFit';

export const QuestionId = Object.freeze({
  TRAINING: 'q-training',
  DIET: 'q-diet',
  SLEEP: 'q-sleep',
  ROUTINE: 'q-routine',
  EVOLUTION: 'q-evolution',
  HYDRATION: 'q-hydration',
  REPORT: 'q-report',
});

// Questions of the fixture template; q-diet depends on the meal plan and q-routine is inverted
const TEMPLATE_QUESTIONS = Object.freeze([
  { id: QuestionId.TRAINING, order: 1, text: 'Como foi tua adesão aos treinos?', type: 'score', pillar: 'training_adherence', required: true, minLabel: 'Não treinei', maxLabel: 'Fiz tudo' },
  { id: QuestionId.DIET, order: 2, text: 'Como foi tua adesão à dieta?', type: 'score', pillar: 'diet_adherence', required: true, condition: 'has_meal_plan' },
  { id: QuestionId.SLEEP, order: 3, text: 'Como está teu sono?', type: 'stars', pillar: 'sleep', required: true },
  { id: QuestionId.ROUTINE, order: 4, text: 'Quão corrida foi tua rotina?', type: 'score', pillar: 'routine', required: true, invertScore: true },
  { id: QuestionId.EVOLUTION, order: 5, text: 'Como percebes tua evolução?', type: 'score', pillar: 'evolution', required: true },
  { id: QuestionId.HYDRATION, order: 6, text: 'Como foi tua hidratação?', type: 'stars', pillar: 'hydration', required: false },
  { id: QuestionId.REPORT, order: 7, text: 'Quer contar algo ao teu treinador?', helpText: 'Opcional', type: 'open', pillar: 'report', required: false },
]);

// Seeds a user row
export function seedUser(world, id, firstName, overrides = {}) {
  return world.seed('user', { id, email: `${id}@example.com`, firstName, lastName: 'Silva', username: null, avatarUrl: null, ...overrides });
}

// Seeds a trainer with its user row
export function seedTrainer(world, trainerId, firstName) {
  seedUser(world, `${trainerId}-user`, firstName);
  return world.seed('trainer', { id: trainerId, userId: `${trainerId}-user` });
}

// Seeds the trainer-student link
export function seedLink(world, { trainerId = TRAINER_ID, studentId = STUDENT_ID, createdAt, activeOnPlan = true }) {
  return world.seed('trainerStudent', { trainerId, studentId, createdAt, activeOnPlan });
}

// Seeds the general template with its questions
export function seedTemplate(world) {
  world.seed('studentFeedbackTemplate', { id: TEMPLATE_ID, trainerId: null, isGeneral: true, name: TEMPLATE_NAME, version: 1, parentId: null });
  for (const question of TEMPLATE_QUESTIONS) {
    world.seed('studentFeedbackQuestion', { helpText: null, minLabel: null, maxLabel: null, invertScore: false, condition: null, ...question, templateId: TEMPLATE_ID });
  }
}

// Seeds the trainer's feedback config; every milestone is on unless overridden
export function seedConfig(world, overrides = {}) {
  return world.seed('studentFeedbackConfig', {
    trainerId: TRAINER_ID,
    autoSendEnabled: true,
    enabledAt: new Date('2026-01-01T00:00:00Z'),
    d7: true,
    d15: true,
    d21: true,
    d30: true,
    recurring: true,
    ...overrides,
  });
}

// Seeds a feedback request; pending, without meal plan and expiring three days after sentAt unless overridden
export function seedRequest(world, { sentAt, ...overrides }) {
  return world.seed('studentFeedbackRequest', {
    trainerId: TRAINER_ID,
    studentId: STUDENT_ID,
    templateId: TEMPLATE_ID,
    milestone: 'D7',
    status: 'pending',
    hasMealPlan: false,
    sentAt,
    expiresAt: new Date(sentAt.getTime() + 3 * DAY_MS),
    reminderSentAt: null,
    submittedAt: null,
    readAt: null,
    overallIndex: null,
    band: null,
    ...overrides,
  });
}

// Seeds a published diet protocol of the student under a nutritionist whose link is active
export function seedPublishedMealPlan(world, studentId = STUDENT_ID, status = 'published') {
  world.seed('nutritionist', { id: `nutri-${studentId}`, userId: `nutri-user-${studentId}`, deletedAt: null });
  world.seed('nutritionistPatient', { nutritionistId: `nutri-${studentId}`, patientId: studentId, deletedAt: null });
  return world.seed('dietProtocol', { nutritionistId: `nutri-${studentId}`, assigneeId: studentId, status, publishedAt: new Date('2026-10-01T12:00:00Z') });
}

// World with two trainers, two students, the general template and no link, config or request
export function createFeedbackWorld() {
  const world = createWorld();
  seedTrainer(world, TRAINER_ID, 'Rafael');
  seedTrainer(world, OTHER_TRAINER_ID, 'Paula');
  seedUser(world, STUDENT_ID, 'Ana');
  seedUser(world, OTHER_STUDENT_ID, 'Bruno');
  seedTemplate(world);
  return world;
}
