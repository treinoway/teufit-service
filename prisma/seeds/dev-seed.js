// Local-dev seed: 1 trainer + 10 students with templates, protocols,
// sessions across mixed adherence buckets, and anamnesis assignments.
//
// Run via `npm run db:seed:dev` (assumes fresh DB after `db:reset` + `db:migrate`
// + `db:seed`). The composed `npm run db:reset-and-populate` does all of that.
//
// REFUSES to run when NODE_ENV=production or DATABASE_URL is non-local.

import 'dotenv/config';
import crypto from 'node:crypto';
import prismaClient from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import {
  TRAINER,
  TRAINER_DIAMOND,
  TRAINER_PLATINUM,
  STUDENTS,
  ADHERENCE_BUCKETS,
  EXERCISE_TEMPLATES,
  TRAINING_TEMPLATE_FULL_BODY,
  PROTOCOL_TRAININGS,
  EXTRA_CARDIO_TRAINING,
  TRAINING_LEVEL_CYCLE,
  SUBSCRIPTION_PLANS,
  SUBSCRIPTION_ASSIGNMENTS,
} from './dev-seed-data.js';
import { Roles } from '../../src/constants/roles.js';
import {
  TrainingStatus,
  ExerciseLogStatus,
  WorkoutSessionStatus,
  PrescriptionMode,
} from '../../src/constants/training.js';
import { PaymentStatus, SubscriptionStatus } from '../../src/constants/subscription.js';
import { computeCycleEndDate } from '../../src/helpers/subscription-helpers.js';
import {
  PLATFORM_PLAN_TIERS,
  PLATFORM_SUBSCRIPTION_STATUSES,
  getBillingMonth,
} from '../../src/constants/platform-plan.js';
import { seedPublicAnamnesis } from '../seed.js';

// ─── Guardrails ──────────────────────────────────────────────────────────────

if (process.env.NODE_ENV === 'production') {
  console.error('refusing to run dev seed in production');
  process.exit(1);
}

const dbUrl = process.env.DATABASE_URL ?? '';
if (!/(?:localhost|127\.0\.0\.1)(?::\d+)?\//.test(dbUrl)) {
  console.error(`refusing to run dev seed against non-local DATABASE_URL: ${dbUrl || '(unset)'}`);
  process.exit(1);
}

// ─── Prisma bootstrap ────────────────────────────────────────────────────────

const pool = new pg.Pool({ connectionString: dbUrl });
const { PrismaClient } = prismaClient;
const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

// ─── Deterministic RNG (LCG) ─────────────────────────────────────────────────

const SEED = 42;
let rngState = SEED >>> 0;
function rnd() {
  rngState = (Math.imul(rngState, 1664525) + 1013904223) >>> 0;
  return rngState / 0x100000000;
}
function randInt(min, max) {
  return Math.floor(rnd() * (max - min + 1)) + min;
}
function randFloat(min, max, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round((rnd() * (max - min) + min) * factor) / factor;
}
function pick(arr) {
  return arr[Math.floor(rnd() * arr.length)];
}

// ─── Password hashing (mirrors src/services/auth-service.js:108) ─────────────

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const keylen = 64;
  const N = 16384;
  const r = 8;
  const p = 1;
  const derivedKey = crypto.scryptSync(password, salt, keylen, { N, r, p });
  return `scrypt$N=${N},r=${r},p=${p}$${salt.toString('base64')}$${derivedKey.toString('base64')}`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();

function daysAgo(days, hour = 8, minuteJitter = 0) {
  const date = new Date(NOW.getTime() - days * DAY_MS);
  date.setUTCHours(hour, minuteJitter, 0, 0);
  return date;
}

function counts(label, n) {
  return `${label} (${n})`;
}

// Mirrors computeAmount in src/services/student-subscription-service.js but
// stays in plain numbers (Prisma accepts JS numbers for Decimal fields).
function computeNetAmount(price, discountPercent, discountAmount) {
  const p = Number(price);
  if (discountPercent != null) {
    return Math.max(0, Math.round((p - (p * Number(discountPercent)) / 100) * 100) / 100);
  }
  if (discountAmount != null) {
    return Math.max(0, Math.round((p - Number(discountAmount)) * 100) / 100);
  }
  return p;
}

// Spread N session offsets evenly over the last `windowDays` with jitter.
function spreadSessionOffsets(sessionCount, windowDays = 56) {
  if (sessionCount <= 0) return [];
  const step = windowDays / sessionCount;
  const offsets = [];
  for (let i = 0; i < sessionCount; i += 1) {
    const base = Math.round(step * i + step / 2);
    const jitter = randInt(-1, 1);
    offsets.push(Math.min(windowDays - 1, Math.max(1, base + jitter)));
  }
  // Most-recent first.
  return offsets.sort((a, b) => a - b);
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  // 0. Refuse to overwrite existing demo trainer.
  const existing = await prisma.user.findUnique({ where: { email: TRAINER.email } });
  if (existing) {
    throw new Error(
      `Demo trainer "${TRAINER.email}" already exists. Run \`npm run db:reset-and-populate\` instead of \`db:seed:dev\` directly.`,
    );
  }

  // 1. Ensure public anamnesis exists (creates if missing — no cross-script dependency).
  await seedPublicAnamnesis(prisma);
  const publicAnamnesis = await prisma.anamnesis.findFirst({
    where: { title: 'Anamnese Completa', isGeneral: true, deletedAt: null },
    include: {
      sections: {
        include: {
          questions: { include: { options: true } },
        },
      },
    },
  });
  if (!publicAnamnesis) {
    throw new Error('seedPublicAnamnesis ran but anamnesis still missing — check DB state.');
  }

  // 2. Trainer (FREE plan — default).
  const trainerUser = await prisma.user.create({
    data: {
      email: TRAINER.email,
      passwordHash: hashPassword(TRAINER.password),
      roles: [Roles.TRAINER],
      status: 'active',
      firstName: TRAINER.firstName,
      lastName: TRAINER.lastName,
      gender: TRAINER.gender,
      birthDate: new Date(TRAINER.birthDate),
    },
  });
  const trainer = await prisma.trainer.create({
    data: {
      userId: trainerUser.id,
      professionalDocument: TRAINER.professionalDocument,
      gymName: TRAINER.gymName,
      serviceMode: TRAINER.serviceMode,
      notes: TRAINER.notes,
      profileCompletedAt: NOW,
      firstStudentLinkedAt: NOW,
      firstProtocolCreatedAt: NOW,
    },
  });
  // Main trainer is DIAMOND so all premium features (incl. iArnold/AI) work after db:reset.
  await prisma.platformSubscription.create({
    data: {
      trainerId: trainer.id,
      tier: PLATFORM_PLAN_TIERS.DIAMOND,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
    },
  });

  // 2·admin. Admin account — ADMIN + TRAINER roles so it can manage beta invites
  // (/admin/invites) AND use the full trainer app. Bypasses the beta gate (admin
  // is exempt via hasBetaAccess). DIAMOND plan so premium features work.
  const adminUser = await prisma.user.create({
    data: {
      email: 'admin@treinoway.local',
      passwordHash: hashPassword('admin123'),
      roles: [Roles.ADMIN, Roles.TRAINER],
      status: 'active',
      firstName: 'Admin',
      lastName: 'Dev',
      gender: 'male',
      birthDate: new Date('1990-01-01'),
    },
  });
  const adminTrainer = await prisma.trainer.create({
    data: {
      userId: adminUser.id,
      serviceMode: 'online',
      profileCompletedAt: NOW,
    },
  });
  await prisma.platformSubscription.create({
    data: {
      trainerId: adminTrainer.id,
      tier: PLATFORM_PLAN_TIERS.DIAMOND,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
    },
  });

  // 2a. DIAMOND trainer — premium features, currentPeriodEnd 30 days ahead.
  const diamondTrainerUser = await prisma.user.create({
    data: {
      email: TRAINER_DIAMOND.email,
      passwordHash: hashPassword(TRAINER_DIAMOND.password),
      roles: [Roles.TRAINER],
      status: 'active',
      firstName: TRAINER_DIAMOND.firstName,
      lastName: TRAINER_DIAMOND.lastName,
      gender: TRAINER_DIAMOND.gender,
      birthDate: new Date(TRAINER_DIAMOND.birthDate),
    },
  });
  const diamondTrainer = await prisma.trainer.create({
    data: {
      userId: diamondTrainerUser.id,
      professionalDocument: TRAINER_DIAMOND.professionalDocument,
      gymName: TRAINER_DIAMOND.gymName,
      serviceMode: TRAINER_DIAMOND.serviceMode,
      notes: TRAINER_DIAMOND.notes,
      profileCompletedAt: NOW,
      firstStudentLinkedAt: NOW,
      firstProtocolCreatedAt: NOW,
    },
  });
  await prisma.platformSubscription.create({
    data: {
      trainerId: diamondTrainer.id,
      tier: PLATFORM_PLAN_TIERS.DIAMOND,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
    },
  });

  // 2b. PLATINUM trainer — 50 students for downgrade soft-block testing.
  const platinumTrainerUser = await prisma.user.create({
    data: {
      email: TRAINER_PLATINUM.email,
      passwordHash: hashPassword(TRAINER_PLATINUM.password),
      roles: [Roles.TRAINER],
      status: 'active',
      firstName: TRAINER_PLATINUM.firstName,
      lastName: TRAINER_PLATINUM.lastName,
      gender: TRAINER_PLATINUM.gender,
      birthDate: new Date(TRAINER_PLATINUM.birthDate),
    },
  });
  const platinumTrainer = await prisma.trainer.create({
    data: {
      userId: platinumTrainerUser.id,
      professionalDocument: TRAINER_PLATINUM.professionalDocument,
      gymName: TRAINER_PLATINUM.gymName,
      serviceMode: TRAINER_PLATINUM.serviceMode,
      notes: TRAINER_PLATINUM.notes,
      profileCompletedAt: NOW,
      firstStudentLinkedAt: NOW,
      firstProtocolCreatedAt: NOW,
    },
  });
  await prisma.platformSubscription.create({
    data: {
      trainerId: platinumTrainer.id,
      tier: PLATFORM_PLAN_TIERS.PLATINUM,
      status: PLATFORM_SUBSCRIPTION_STATUSES.ACTIVE,
      currentPeriodStart: NOW,
      currentPeriodEnd: new Date(NOW.getTime() + 30 * DAY_MS),
    },
  });

  // Seed 50 students for the PLATINUM trainer.
  const platinumStudentPasswordHash = hashPassword('aluno123');
  const platinumStudentIds = [];
  for (let i = 0; i < 50; i += 1) {
    const studentUser = await prisma.user.create({
      data: {
        email: `platinum_aluno${i + 1}@treinoway.local`,
        passwordHash: platinumStudentPasswordHash,
        roles: [],
        status: 'active',
        firstName: `Aluno${i + 1}`,
        lastName: 'Platinum',
        gender: i % 2 === 0 ? 'male' : 'female',
        birthDate: new Date(`${1990 + (i % 10)}-${String((i % 12) + 1).padStart(2, '0')}-15`),
      },
    });
    await prisma.trainerStudent.create({
      data: { trainerId: platinumTrainer.id, studentId: studentUser.id },
    });
    platinumStudentIds.push(studentUser.id);
  }

  // Seed a few AiUsageEvent rows for the PLATINUM trainer (5 events across 3 students this month).
  const billingMonth = getBillingMonth();
  const aiEventStudents = platinumStudentIds.slice(0, 3);
  const aiEventsPerStudent = [2, 2, 1]; // 5 total across 3 students
  for (let s = 0; s < aiEventStudents.length; s += 1) {
    for (let e = 0; e < aiEventsPerStudent[s]; e += 1) {
      await prisma.aiUsageEvent.create({
        data: {
          trainerId: platinumTrainer.id,
          studentId: aiEventStudents[s],
          action: 'generate_training',
          billingMonth,
        },
      });
    }
  }

  // 3. Students + TrainerStudent links.
  const studentPasswordHash = hashPassword('aluno123');
  const students = [];
  for (let i = 0; i < STUDENTS.length; i += 1) {
    const s = STUDENTS[i];
    const user = await prisma.user.create({
      data: {
        email: `aluno${i + 1}@treinoway.local`,
        passwordHash: studentPasswordHash,
        roles: [],
        status: 'active',
        firstName: s.firstName,
        lastName: s.lastName,
        gender: s.gender,
        birthDate: new Date(s.birthDate),
      },
    });
    await prisma.trainerStudent.create({
      data: { trainerId: trainer.id, studentId: user.id },
    });
    students.push(user);
  }

  // 4. ExerciseTemplates (15, public, owned by trainer).
  const templateByName = new Map();
  for (const tpl of EXERCISE_TEMPLATES) {
    // Library templates are identity-only — prescription lives on the junction/Exercise.
    const created = await prisma.exerciseTemplate.create({
      data: {
        trainerId: trainer.id,
        name: tpl.name,
        type: tpl.type,
        videoUrl: tpl.videoUrl ?? null,
        isPublic: true,
      },
    });
    templateByName.set(tpl.name, { ...tpl, id: created.id });
  }

  // 5. TrainingTemplate (1, public) with snapshot exercise links.
  const trainingTemplate = await prisma.trainingTemplate.create({
    data: {
      trainerId: trainer.id,
      name: TRAINING_TEMPLATE_FULL_BODY.name,
      description: TRAINING_TEMPLATE_FULL_BODY.description,
      category: TRAINING_TEMPLATE_FULL_BODY.category,
      bodySegment: TRAINING_TEMPLATE_FULL_BODY.bodySegment,
      tags: [...TRAINING_TEMPLATE_FULL_BODY.tags],
      isPublic: TRAINING_TEMPLATE_FULL_BODY.isPublic,
    },
  });
  for (let i = 0; i < TRAINING_TEMPLATE_FULL_BODY.exerciseNames.length; i += 1) {
    const tpl = templateByName.get(TRAINING_TEMPLATE_FULL_BODY.exerciseNames[i]);
    if (!tpl) continue;
    await prisma.trainingTemplateExerciseTemplate.create({
      data: {
        trainingTemplateId: trainingTemplate.id,
        exerciseTemplateId: tpl.id,
        order: i,
        // Snapshot fields
        name: tpl.name,
        type: tpl.type,
        sets: tpl.sets,
        repetitions: tpl.repetitions ?? null,
        duration: tpl.duration ?? null,
        prescriptionMode: tpl.prescriptionMode,
        hasLoad: tpl.hasLoad,
        suggestedLoad: tpl.suggestedLoad ?? null,
        restInterval: tpl.restInterval ?? null,
      },
    });
  }

  // 6. Per-student protocol → trainings → exercises.
  const protocolStartDate = daysAgo(56, 0); // 8 weeks back
  const protocolExpirationDate = daysAgo(-28, 0); // 4 weeks ahead
  const studentProtocolMap = new Map(); // studentId → { protocol, trainings: [{...t, exercises: [...]}] }

  for (let i = 0; i < students.length; i += 1) {
    const student = students[i];
    const trainingLevel = TRAINING_LEVEL_CYCLE[i % TRAINING_LEVEL_CYCLE.length];

    const protocol = await prisma.trainingProtocol.create({
      data: {
        trainerId: trainer.id,
        assigneeId: student.id,
        name: `Protocolo ${student.firstName}`,
        description: `Protocolo de demonstração para ${student.firstName}.`,
        status: TrainingStatus.ACTIVE,
        startDate: new Date(protocolStartDate.toISOString().slice(0, 10)),
        expirationDate: new Date(protocolExpirationDate.toISOString().slice(0, 10)),
        trainingLevel,
        type: 'strength',
      },
    });

    const trainingDefs = [...PROTOCOL_TRAININGS];
    if (i === 0) trainingDefs.push(EXTRA_CARDIO_TRAINING); // first student also has cardio Sat

    const trainings = [];
    for (const def of trainingDefs) {
      const training = await prisma.training.create({
        data: {
          trainingProtocolId: protocol.id,
          name: def.name,
          category: def.category,
          bodySegment: def.bodySegment,
          weekDay: def.weekDay,
          order: def.order,
        },
      });
      const exercises = [];
      for (let j = 0; j < def.exerciseNames.length; j += 1) {
        const tpl = templateByName.get(def.exerciseNames[j]);
        if (!tpl) continue;
        const ex = await prisma.exercise.create({
          data: {
            trainingId: training.id,
            exerciseTemplateId: tpl.id,
            name: tpl.name,
            type: tpl.type,
            order: j,
            sets: tpl.sets,
            repetitions: tpl.repetitions ?? null,
            duration: tpl.duration ?? null,
            prescriptionMode: tpl.prescriptionMode,
            hasLoad: tpl.hasLoad,
            suggestedLoad: tpl.suggestedLoad ?? null,
            restInterval: tpl.restInterval ?? null,
          },
        });
        exercises.push(ex);
      }
      trainings.push({ ...training, exercises });
    }
    studentProtocolMap.set(student.id, { protocol, trainings });
  }

  // 7. WorkoutSessions per adherence bucket.
  let bucketCursor = 0;
  let totalSessions = 0;
  let totalExerciseLogs = 0;
  let totalSetLogs = 0;

  for (const bucket of ADHERENCE_BUCKETS) {
    for (let b = 0; b < bucket.count; b += 1) {
      const student = students[bucketCursor];
      bucketCursor += 1;
      if (bucket.sessionCount === 0) continue;

      const { trainings } = studentProtocolMap.get(student.id);
      const offsets = spreadSessionOffsets(bucket.sessionCount, 56);

      let abandonedRemaining = bucket.abandonedCount;
      let inProgressRemaining = bucket.inProgressCount;

      for (let s = 0; s < offsets.length; s += 1) {
        const isMostRecent = s === offsets.length - 1;
        const offset = offsets[s];
        const training = pick(trainings);

        // Status: in_progress reserved for the most recent session of buckets that have one.
        let status = WorkoutSessionStatus.COMPLETED;
        if (inProgressRemaining > 0 && isMostRecent) {
          status = WorkoutSessionStatus.IN_PROGRESS;
          inProgressRemaining -= 1;
        } else if (abandonedRemaining > 0 && rnd() < 0.4) {
          status = WorkoutSessionStatus.ABANDONED;
          abandonedRemaining -= 1;
        }

        const startedAt = daysAgo(offset, randInt(6, 19), randInt(0, 59));
        const isTerminal = status !== WorkoutSessionStatus.IN_PROGRESS;
        const durationSeconds = isTerminal ? randInt(45, 90) * 60 : null;
        const finishedAt = isTerminal ? new Date(startedAt.getTime() + durationSeconds * 1000) : null;

        const session = await prisma.workoutSession.create({
          data: {
            trainingId: training.id,
            userId: student.id,
            status,
            startedAt,
            finishedAt,
            durationSeconds,
            notes: status === WorkoutSessionStatus.COMPLETED && rnd() < 0.3
              ? 'Treino tranquilo, boa execução.'
              : null,
          },
        });
        totalSessions += 1;

        const exercises = training.exercises;
        const partialCount = status === WorkoutSessionStatus.ABANDONED
          ? Math.max(1, Math.floor(exercises.length / 2))
          : status === WorkoutSessionStatus.IN_PROGRESS
            ? Math.max(1, Math.floor(exercises.length * 0.3))
            : exercises.length;

        for (let e = 0; e < exercises.length; e += 1) {
          const ex = exercises[e];
          const inRange = e < partialCount;

          let logStatus = ExerciseLogStatus.PENDING;
          if (status === WorkoutSessionStatus.COMPLETED) {
            logStatus = rnd() < 0.95 ? ExerciseLogStatus.COMPLETED : ExerciseLogStatus.SKIPPED;
          } else if (status === WorkoutSessionStatus.ABANDONED) {
            logStatus = inRange ? ExerciseLogStatus.COMPLETED : ExerciseLogStatus.PENDING;
          } else if (status === WorkoutSessionStatus.IN_PROGRESS) {
            logStatus = inRange ? ExerciseLogStatus.COMPLETED : ExerciseLogStatus.PENDING;
          }

          const exerciseLog = await prisma.exerciseLog.create({
            data: {
              workoutSessionId: session.id,
              exerciseId: ex.id,
              status: logStatus,
              order: e,
            },
          });
          totalExerciseLogs += 1;

          // Set logs only when log is COMPLETED.
          if (logStatus !== ExerciseLogStatus.COMPLETED) continue;

          const isDuration = ex.prescriptionMode === PrescriptionMode.DURATION;
          const setCount = isDuration ? 1 : (ex.sets ?? 3);
          const setRows = [];
          for (let n = 1; n <= setCount; n += 1) {
            if (isDuration) {
              setRows.push({
                exerciseLogId: exerciseLog.id,
                setNumber: n,
                duration: ex.duration ?? 600,
                rpe: randInt(5, 8),
                completed: true,
              });
            } else {
              const reps = ex.repetitions ?? { min: 8, max: 12 };
              const targetReps = randInt(reps.min, reps.max);
              const repsActual = Math.max(1, targetReps + randInt(-2, 1));
              const load = ex.hasLoad
                ? Math.max(0, randFloat((ex.suggestedLoad ?? 20) - 5, (ex.suggestedLoad ?? 20) + 5))
                : null;
              setRows.push({
                exerciseLogId: exerciseLog.id,
                setNumber: n,
                repetitions: repsActual,
                load,
                rpe: randInt(6, 9),
                restSeconds: ex.restInterval ?? 90,
                completed: true,
              });
            }
          }
          await prisma.setLog.createMany({ data: setRows });
          totalSetLogs += setRows.length;
        }
      }
    }
  }

  // 8. Anamnesis assignments + responses (first 5 students assigned, first 3 with responses).
  const anamnesisQuestions = publicAnamnesis.sections
    .flatMap((sec) => sec.questions)
    .sort((a, b) => a.order - b.order);

  for (let i = 0; i < 5; i += 1) {
    const student = students[i];
    await prisma.studentAnamnesis.create({
      data: {
        anamnesisId: publicAnamnesis.id,
        studentId: student.id,
        trainerId: trainer.id,
      },
    });

    if (i < 3) {
      const response = await prisma.anamnesisResponse.create({
        data: {
          anamnesisId: publicAnamnesis.id,
          studentId: student.id,
          submittedAt: daysAgo(randInt(3, 30), 14, randInt(0, 59)),
        },
      });

      const answerRows = anamnesisQuestions.map((q) => ({
        responseId: response.id,
        questionId: q.id,
        value: buildAnamnesisAnswerValue(q),
      }));
      if (answerRows.length) {
        await prisma.anamnesisAnswer.createMany({ data: answerRows });
      }
    }
  }

  // 9. Subscription plans + per-student subscriptions + payment cycles.
  const planByKey = new Map();
  for (const planDef of SUBSCRIPTION_PLANS) {
    const plan = await prisma.subscriptionPlan.create({
      data: {
        trainerId: trainer.id,
        name: planDef.name,
        recurrence: planDef.recurrence,
        price: planDef.price,
        discountPercent: planDef.discountPercent,
        discountAmount: planDef.discountAmount,
      },
    });
    planByKey.set(planDef.key, { ...planDef, id: plan.id });
  }

  let totalSubscriptions = 0;
  let totalPayments = 0;
  let paidPayments = 0;

  for (const assignment of SUBSCRIPTION_ASSIGNMENTS) {
    const student = students[assignment.studentIndex];
    const plan = planByKey.get(assignment.planKey);
    if (!plan) continue;

    const effectiveDiscountPercent = assignment.discountPercent ?? plan.discountPercent;
    const effectiveDiscountAmount =
      assignment.discountPercent != null ? null : (assignment.discountAmount ?? plan.discountAmount);
    const netAmount = computeNetAmount(plan.price, effectiveDiscountPercent, effectiveDiscountAmount);

    // startDate = first day of month N months ago.
    const today = new Date();
    const startDate = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth() - assignment.startMonthsAgo,
      1,
    ));

    const subscription = await prisma.studentSubscription.create({
      data: {
        trainerId: trainer.id,
        studentId: student.id,
        planId: plan.id,
        recurrence: plan.recurrence,
        price: plan.price,
        discountPercent: effectiveDiscountPercent,
        discountAmount: effectiveDiscountAmount,
        startDate,
        status: SubscriptionStatus.ACTIVE,
      },
    });
    totalSubscriptions += 1;

    // Build payment cycles from startDate forward until the cycle that contains today.
    const todayMidnight = new Date(Date.UTC(
      today.getUTCFullYear(),
      today.getUTCMonth(),
      today.getUTCDate(),
    ));
    const cycles = [];
    let cycleStart = startDate;
    while (cycleStart <= todayMidnight) {
      const cycleEnd = computeCycleEndDate(cycleStart, plan.recurrence);
      cycles.push({ start: cycleStart, end: cycleEnd });
      // Next cycle starts the day after current cycle ends.
      cycleStart = new Date(cycleEnd.getTime() + DAY_MS);
    }

    for (let idx = 0; idx < cycles.length; idx += 1) {
      const cycle = cycles[idx];
      const isPaid = idx < assignment.paidCycles;
      const paidAt = isPaid
        ? new Date(cycle.start.getTime() + randInt(0, 5) * DAY_MS)
        : null;

      await prisma.subscriptionPayment.create({
        data: {
          subscriptionId: subscription.id,
          cycleStartDate: cycle.start,
          cycleEndDate: cycle.end,
          dueDate: cycle.start,
          amount: netAmount,
          status: isPaid ? PaymentStatus.PAID : PaymentStatus.PENDING,
          paidAt,
        },
      });
      totalPayments += 1;
      if (isPaid) paidPayments += 1;
    }
  }

  // ─── Denormalize TrainerStudent hot-path fields ────────────────────────────
  // Seed bypasses service-layer hooks. Replicate the migration backfill so the
  // students list (and any other consumer) sees lastWorkoutAt / currentPrLoad /
  // currentPrAt populated after a fresh seed.
  await prisma.$executeRawUnsafe(`
    WITH last_completed AS (
      SELECT user_id, MAX(finished_at) AS last_finished
      FROM workout_sessions
      WHERE status = 'completed' AND deleted_at IS NULL AND finished_at IS NOT NULL
      GROUP BY user_id
    )
    UPDATE trainer_students ts
    SET last_workout_at = lc.last_finished
    FROM last_completed lc
    WHERE ts.student_id = lc.user_id;
  `);
  await prisma.$executeRawUnsafe(`
    WITH pr_per_student AS (
      SELECT ws.user_id, MAX(sl.load) AS max_load
      FROM set_logs sl
      JOIN exercise_logs el ON el.id = sl.exercise_log_id
      JOIN workout_sessions ws ON ws.id = el.workout_session_id
      WHERE sl.load IS NOT NULL AND sl.completed = true AND ws.deleted_at IS NULL
      GROUP BY ws.user_id
    ),
    pr_with_at AS (
      SELECT ws.user_id, pr.max_load, MAX(sl.created_at) AS pr_at
      FROM pr_per_student pr
      JOIN workout_sessions ws ON ws.user_id = pr.user_id
      JOIN exercise_logs el ON el.workout_session_id = ws.id
      JOIN set_logs sl ON sl.exercise_log_id = el.id
      WHERE sl.load = pr.max_load AND sl.completed = true AND ws.deleted_at IS NULL
      GROUP BY ws.user_id, pr.max_load
    )
    UPDATE trainer_students ts
    SET current_pr_load = p.max_load, current_pr_at = p.pr_at
    FROM pr_with_at p
    WHERE ts.student_id = p.user_id;
  `);

  // ─── Summary ───────────────────────────────────────────────────────────────
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('Dev seed complete:');
  console.log(`  ✓ ${counts('Admin', 1)} — admin@treinoway.local / admin123 [ADMIN + TRAINER, DIAMOND]`);
  console.log(`  ✓ ${counts('Trainer', 1)} — ${TRAINER.email} / ${TRAINER.password} [DIAMOND]`);
  console.log(`  ✓ DIAMOND trainer — ${TRAINER_DIAMOND.email} / ${TRAINER_DIAMOND.password}`);
  console.log(`  ✓ PLATINUM trainer — ${TRAINER_PLATINUM.email} / ${TRAINER_PLATINUM.password} (50 students, 5 AI events)`);
  console.log(`  ✓ ${counts('Students', students.length)} — aluno1@treinoway.local … aluno${students.length}@treinoway.local / aluno123`);
  console.log(`  ✓ 50 platinum students — platinum_aluno1@treinoway.local … platinum_aluno50@treinoway.local / aluno123`);
  console.log(`  ✓ ${counts('ExerciseTemplates', EXERCISE_TEMPLATES.length)} (public)`);
  console.log(`  ✓ ${counts('TrainingTemplate', 1)} — Full Body (public)`);
  console.log(`  ✓ ${counts('Protocols', students.length)}`);
  console.log(`  ✓ ${counts('WorkoutSessions', totalSessions)}, ${counts('ExerciseLogs', totalExerciseLogs)}, ${counts('SetLogs', totalSetLogs)}`);
  console.log(`  ✓ Anamnesis assignments (5) + responses (3)`);
  console.log(`  ✓ ${counts('SubscriptionPlans', SUBSCRIPTION_PLANS.length)}, ${counts('Subscriptions', totalSubscriptions)}, ${counts('Payments', totalPayments)} (${paidPayments} paid)`);
  console.log(`Done in ${elapsed}s.`);
}

function buildAnamnesisAnswerValue(question) {
  switch (question.type) {
    case 'free_text':
      return 'Resposta de demonstração gerada pelo seed.';
    case 'numeric':
      return randInt(3, 8);
    case 'dichotomous':
      return rnd() < 0.6 ? 'Sim' : 'Não';
    case 'single_choice': {
      const opt = question.options?.[0];
      return opt ? opt.text : '';
    }
    case 'multiple_choice': {
      const opt = question.options?.[0];
      return opt ? [opt.text] : [];
    }
    case 'matrix':
      return {};
    default:
      return null;
  }
}

main()
  .catch((e) => {
    console.error('dev-seed failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
