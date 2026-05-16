// Static catalog for the local-dev seed. Determines what gets written
// every run. RNG-driven variation lives in dev-seed.js.

export const TRAINER = Object.freeze({
  email: 'trainer@treinoway.local',
  password: 'trainer123',
  firstName: 'José',
  lastName: 'Demo',
  gender: 'male',
  birthDate: '1985-03-15',
  professionalDocument: 'CREF-DEMO-001',
  gymName: 'Academia Demo',
  serviceMode: 'hybrid',
  notes: 'Conta de demonstração para desenvolvimento local.',
});

// 10 students. Order matters — buckets in dev-seed.js index by position.
export const STUDENTS = Object.freeze([
  { firstName: 'Ana',      lastName: 'Souza',     gender: 'female', birthDate: '1992-04-22' },
  { firstName: 'Bruno',    lastName: 'Oliveira',  gender: 'male',   birthDate: '1988-09-10' },
  { firstName: 'Carla',    lastName: 'Santos',    gender: 'female', birthDate: '1995-12-03' },
  { firstName: 'Diego',    lastName: 'Pereira',   gender: 'male',   birthDate: '2000-07-18' },
  { firstName: 'Elisa',    lastName: 'Lima',      gender: 'female', birthDate: '1990-02-25' },
  { firstName: 'Felipe',   lastName: 'Costa',     gender: 'male',   birthDate: '1986-06-14' },
  { firstName: 'Gabriela', lastName: 'Almeida',   gender: 'female', birthDate: '1998-11-30' },
  { firstName: 'Hugo',     lastName: 'Ribeiro',   gender: 'male',   birthDate: '1993-08-05' },
  { firstName: 'Isabela',  lastName: 'Carvalho',  gender: 'female', birthDate: '2001-03-12' },
  { firstName: 'João',     lastName: 'Fernandes', gender: 'male',   birthDate: '1989-10-27' },
]);

// Adherence buckets — must sum to 10 students.
export const ADHERENCE_BUCKETS = Object.freeze([
  { label: 'high',    count: 2, sessionCount: 22, abandonedCount: 1, inProgressCount: 0 },
  { label: 'medium',  count: 3, sessionCount: 14, abandonedCount: 2, inProgressCount: 0 },
  { label: 'low',     count: 3, sessionCount: 7,  abandonedCount: 1, inProgressCount: 1 },
  { label: 'inactive',count: 2, sessionCount: 0,  abandonedCount: 0, inProgressCount: 0 },
]);

// 15 exercise templates owned by the demo trainer (isPublic: true).
// All strength entries use prescriptionMode='reps'; cardio uses 'duration'.
export const EXERCISE_TEMPLATES = Object.freeze([
  { name: 'Supino Reto',           type: 'strength', prescriptionMode: 'reps',     sets: 4, repetitions: { min: 8,  max: 12 }, hasLoad: true,  suggestedLoad: 60, restInterval: 120 },
  { name: 'Agachamento Livre',     type: 'strength', prescriptionMode: 'reps',     sets: 4, repetitions: { min: 6,  max: 10 }, hasLoad: true,  suggestedLoad: 80, restInterval: 180 },
  { name: 'Levantamento Terra',    type: 'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 5,  max: 8  }, hasLoad: true,  suggestedLoad: 100,restInterval: 180 },
  { name: 'Remada Curvada',        type: 'strength', prescriptionMode: 'reps',     sets: 4, repetitions: { min: 8,  max: 12 }, hasLoad: true,  suggestedLoad: 50, restInterval: 90  },
  { name: 'Desenvolvimento Militar',type:'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 8,  max: 10 }, hasLoad: true,  suggestedLoad: 35, restInterval: 90  },
  { name: 'Rosca Direta',          type: 'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 10, max: 12 }, hasLoad: true,  suggestedLoad: 20, restInterval: 60  },
  { name: 'Tríceps Pulley',        type: 'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 10, max: 15 }, hasLoad: true,  suggestedLoad: 25, restInterval: 60  },
  { name: 'Leg Press',             type: 'strength', prescriptionMode: 'reps',     sets: 4, repetitions: { min: 10, max: 15 }, hasLoad: true,  suggestedLoad: 150,restInterval: 120 },
  { name: 'Cadeira Extensora',     type: 'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 12, max: 15 }, hasLoad: true,  suggestedLoad: 40, restInterval: 60  },
  { name: 'Mesa Flexora',          type: 'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 12, max: 15 }, hasLoad: true,  suggestedLoad: 35, restInterval: 60  },
  { name: 'Stiff',                 type: 'strength', prescriptionMode: 'reps',     sets: 3, repetitions: { min: 10, max: 12 }, hasLoad: true,  suggestedLoad: 50, restInterval: 90  },
  { name: 'Pull Down',             type: 'strength', prescriptionMode: 'reps',     sets: 4, repetitions: { min: 8,  max: 12 }, hasLoad: true,  suggestedLoad: 55, restInterval: 90  },
  { name: 'Esteira',               type: 'cardio',   prescriptionMode: 'duration', sets: null, repetitions: null, duration: 1200, hasLoad: false, suggestedLoad: null, restInterval: null },
  { name: 'Bike',                  type: 'cardio',   prescriptionMode: 'duration', sets: null, repetitions: null, duration: 1500, hasLoad: false, suggestedLoad: null, restInterval: null },
  { name: 'Elíptico',              type: 'cardio',   prescriptionMode: 'duration', sets: null, repetitions: null, duration: 900,  hasLoad: false, suggestedLoad: null, restInterval: null },
]);

// Single public training template — references exercise templates by name.
export const TRAINING_TEMPLATE_FULL_BODY = Object.freeze({
  name: 'Full Body',
  description: 'Treino completo cobrindo padrões de movimento principais (push, pull, lower).',
  category: 'strength',
  bodySegment: 'full_body',
  isPublic: true,
  tags: ['demo', 'full-body'],
  exerciseNames: ['Agachamento Livre', 'Supino Reto', 'Remada Curvada', 'Desenvolvimento Militar', 'Stiff', 'Rosca Direta'],
});

// Per-student protocol structure (3 trainings/week + occasional cardio).
export const PROTOCOL_TRAININGS = Object.freeze([
  {
    name: 'Treino A — Push',
    category: 'strength',
    bodySegment: 'upper',
    weekDay: 'monday',
    order: 0,
    exerciseNames: ['Supino Reto', 'Desenvolvimento Militar', 'Tríceps Pulley', 'Rosca Direta'],
  },
  {
    name: 'Treino B — Pull',
    category: 'strength',
    bodySegment: 'upper',
    weekDay: 'wednesday',
    order: 1,
    exerciseNames: ['Remada Curvada', 'Pull Down', 'Levantamento Terra', 'Rosca Direta'],
  },
  {
    name: 'Treino C — Legs',
    category: 'strength',
    bodySegment: 'lower',
    weekDay: 'friday',
    order: 2,
    exerciseNames: ['Agachamento Livre', 'Leg Press', 'Cadeira Extensora', 'Mesa Flexora', 'Stiff'],
  },
]);

// Extra cardio training appended to one student's protocol for variation.
export const EXTRA_CARDIO_TRAINING = Object.freeze({
  name: 'Cardio Sábado',
  category: 'cardio',
  bodySegment: null,
  weekDay: 'saturday',
  order: 3,
  exerciseNames: ['Esteira', 'Bike'],
});

// Training level rotation (cycles through students).
export const TRAINING_LEVEL_CYCLE = Object.freeze(['beginner', 'intermediate', 'advanced']);

// ─── Subscription Plans & Assignments ────────────────────────────────────────
// 4 plans + 7 active assignments (3 students left without a plan so the
// empty state is exercisable). Mixed recurrences, discounts, and payment
// statuses (paid / pending / overdue) so Financeiro dashboard has real data.

export const SUBSCRIPTION_PLANS = Object.freeze([
  { key: 'mensal_standard', name: 'Mensal Standard', recurrence: 'monthly',    price: 150,  discountPercent: null, discountAmount: null },
  { key: 'mensal_premium',  name: 'Mensal Premium',  recurrence: 'monthly',    price: 250,  discountPercent: 10,   discountAmount: null },
  { key: 'trimestral',      name: 'Trimestral',      recurrence: 'quarterly',  price: 405,  discountPercent: null, discountAmount: 30  },
  { key: 'anual_vip',       name: 'Anual VIP',       recurrence: 'annual',     price: 1500, discountPercent: 15,   discountAmount: null },
]);

// Per-student assignment. studentIndex matches STUDENTS array position (0-based).
// startMonthsAgo: how long ago the subscription started.
// paidCycles: number of past cycles to mark as PAID (rest stay PENDING).
// If paidCycles < totalCycles - 1, the older pending cycles will appear as
// "Atrasado" on the dashboard (derived client-side from cycleEndDate < today).
export const SUBSCRIPTION_ASSIGNMENTS = Object.freeze([
  { studentIndex: 0, planKey: 'mensal_standard', startMonthsAgo: 6, paidCycles: 5, discountPercent: null, discountAmount: null },
  { studentIndex: 1, planKey: 'mensal_premium',  startMonthsAgo: 4, paidCycles: 2, discountPercent: null, discountAmount: null },
  { studentIndex: 2, planKey: 'trimestral',      startMonthsAgo: 6, paidCycles: 1, discountPercent: null, discountAmount: null },
  { studentIndex: 3, planKey: 'mensal_standard', startMonthsAgo: 3, paidCycles: 3, discountPercent: null, discountAmount: null },
  { studentIndex: 4, planKey: 'anual_vip',       startMonthsAgo: 2, paidCycles: 1, discountPercent: null, discountAmount: null },
  { studentIndex: 5, planKey: 'mensal_premium',  startMonthsAgo: 5, paidCycles: 3, discountPercent: 20,   discountAmount: null }, // override discount
  { studentIndex: 6, planKey: 'mensal_standard', startMonthsAgo: 1, paidCycles: 0, discountPercent: null, discountAmount: null },
]);
