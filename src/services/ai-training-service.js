import { prisma } from "../db.js";
import { AppError } from "../errors/app-error.js";
import { AI_TOOLS, AI_ERRORS, AI_LIMITS, AI_RETRY, AI_MODELS, AI_MESSAGE_CODES, AI_INTERACTION_LOG, TRAINER_TIME_ZONE } from "../constants/ai.js";
import { SubscriptionMessageCode } from "../constants/subscription.js";
import { createTurnUsageMeter } from "./ai-token-usage-service.js";
import { writeInteractionLog } from "./ai-interaction-log-service.js";
import * as studentDashboardService from "./student-dashboard-service.js";
import { assertCanUseAi, recordAiAction } from "./platform-plan-service.js";
import {
  validateCategory,
  validateWeekDay,
  validateBodySegment,
  validateExerciseType,
  validateRepetitions,
  validateGenderOrdination,
  validateTrainingLevel,
  validateProtocolType,
  resolvePrescriptionMode,
} from "../helpers/training-validators.js";
import { PrescriptionMode, prescriptionModeValues } from "../constants/training.js";
import { importFromTemplate, updateProtocol } from "./training-protocol-service.js";
import { createExerciseTemplate, updateExerciseTemplate } from "./exercise-template-service.js";
import { maybeMarkFirstProtocolCreated } from "./trainer-onboarding-service.js";
import { updateProtocolTemplate } from "./training-protocol-template-service.js";
import { updateTrainingTemplate } from "./training-template-service.js";
import { updateTraining } from "./training-service.js";
import { updateExercise } from "./exercise-service.js";

import { TOOLS } from "./ai-tool-definitions.js";
import { buildSystemPrompt, sanitizeUserMessage, wrapUserInput } from "./ai-prompt.js";
import { isExplicitConfirmation, lastAssistantAskedForConfirmation } from "../helpers/ai-confirmation.js";
import { translate } from "../i18n/index.js";
import { getLlmProvider } from "../llm/index.js";
import { isLlmConfigured, resolveProviderName } from "../llm/config.js";
import { withDeadlockRetry } from "../helpers/db-retry.js";

const CONVERSATION_TITLE_MAX_LENGTH = 100;

// Resolves the active LLM model identifier for interaction and token-usage logging.
function resolveActiveModelId() {
  return process.env.ANTHROPIC_MODEL || AI_MODELS.ANTHROPIC;
}

// --- Context builder ---

// Most recently updated first, id as a unique tiebreaker so the order is deterministic.
const RECENT_FIRST = [{ updatedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }, { id: "asc" }];

// Resolves the trainer id of a user, or throws a 404 when the user has no trainer profile.
async function resolveTrainerId(userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: AI_ERRORS.CONTEXT_BUILD_FAILED,
      messageCode: AI_MESSAGE_CODES.TRAINER_NOT_FOUND,
      message: "Trainer profile not found",
    });
  }

  return trainer.id;
}

// Builds the trainer data snapshot injected in the system prompt; knownTrainerId skips the lookup.
async function buildTrainerContext(userId, knownTrainerId) {
  const trainer = { id: knownTrainerId ?? (await resolveTrainerId(userId)) };

  const [
    students,
    protocolTemplates,
    trainingTemplates,
    activeProtocols,
    exerciseTemplates,
  ] = await Promise.all([
    prisma.trainerStudent.findMany({
      where: { trainerId: trainer.id, activeOnPlan: true },
      select: {
        student: { select: { id: true, firstName: true, lastName: true } },
      },
      orderBy: [{ lastWorkoutAt: { sort: "desc", nulls: "last" } }, { id: "asc" }],
      take: AI_LIMITS.MAX_CONTEXT_STUDENTS,
    }),
    prisma.trainingProtocolTemplate.findMany({
      where: { trainerId: trainer.id, deletedAt: null, isExample: false },
      select: { id: true, name: true, description: true },
      orderBy: RECENT_FIRST,
      take: AI_LIMITS.MAX_CONTEXT_PROTOCOL_TEMPLATES,
    }),
    prisma.trainingTemplate.findMany({
      where: {
        deletedAt: null,
        isExample: false,
        OR: [{ trainerId: trainer.id }, { isPublic: true }],
      },
      select: { id: true, name: true, category: true },
      orderBy: RECENT_FIRST,
      take: AI_LIMITS.MAX_CONTEXT_TRAINING_TEMPLATES,
    }),
    prisma.trainingProtocol.findMany({
      where: { trainerId: trainer.id, deletedAt: null, status: "active" },
      select: {
        id: true,
        name: true,
        assigneeId: true,
        assignee: { select: { firstName: true, lastName: true } },
        trainings: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            weekDay: true,
            exercises: {
              where: { deletedAt: null },
              select: {
                id: true,
                name: true,
                sets: true,
                repetitions: true,
                duration: true,
                prescriptionMode: true,
                hasLoad: true,
                suggestedLoad: true,
                restInterval: true,
              },
              take: AI_LIMITS.MAX_CONTEXT_EXERCISES_PER_TRAINING,
              orderBy: [{ order: 'asc' }, { id: 'asc' }],
            },
          },
          take: AI_LIMITS.MAX_CONTEXT_TRAININGS_PER_PROTOCOL,
          orderBy: [{ order: 'asc' }, { id: 'asc' }],
        },
      },
      orderBy: RECENT_FIRST,
      take: AI_LIMITS.MAX_CONTEXT_ACTIVE_PROTOCOLS,
    }),
    // Only own exercise templates — createTrainingTemplate only allows linking trainer-owned templates
    prisma.exerciseTemplate.findMany({
      where: { trainerId: trainer.id, deletedAt: null },
      select: { id: true, name: true, type: true },
      orderBy: RECENT_FIRST,
      take: AI_LIMITS.MAX_CONTEXT_EXERCISE_TEMPLATES,
    }),
  ]);

  return {
    trainerId: trainer.id,
    students,
    protocolTemplates,
    trainingTemplates,
    activeProtocols,
    exerciseTemplates,
  };
}

// Read-only tools bypass the first-turn enforcement guard because they do not mutate state.
const READ_ONLY_TOOLS = new Set([AI_TOOLS.GET_STUDENT_PERFORMANCE]);

// --- Audit logging ---

const PII_FIELDS = new Set(['assigneeId', 'name', 'notes', 'description', 'email']);

/**
 * Strip PII-bearing fields from a tool input before logging.
 * Keeps structural fields: IDs of templates, counts, booleans, dates.
 * Free-text and person-identifying fields are replaced with a placeholder.
 */
function sanitizeToolInput(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return {};

  const sanitized = {};
  for (const [key, value] of Object.entries(toolInput)) {
    if (PII_FIELDS.has(key)) {
      sanitized[key] = '[REDACTED]';
    } else if (Array.isArray(value)) {
      sanitized[key] = `[array:${value.length}]`;
    } else if (value !== null && typeof value === 'object') {
      sanitized[key] = sanitizeToolInput(value);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// Describes an unexpected error without its message: Prisma messages embed the argument values (PII).
function describeUnexpectedError(err) {
  return { name: err?.name, code: err?.code, metaKeys: Object.keys(err?.meta ?? {}) };
}

function logAiAction(userId, toolName, toolInput, result) {
  const logData = {
    userId,
    tool: toolName,
    input: sanitizeToolInput(toolInput),
    success: result.success,
    durationMs: result.durationMs,
  };
  if (!result.success) logData.error = result.error;
  console.info(`AI tool executed: ${toolName}`, JSON.stringify(logData));
}

/**
 * Summarize a tool result for the LLM's second call.
 * The full Prisma response can be huge (nested relations, UUIDs, timestamps).
 * The model only needs a short summary to generate a human-friendly response.
 */
function summarizeToolResult(toolResult) {
  if (!toolResult.success) {
    return {
      success: false,
      error: toolResult.error,
      message: toolResult.message,
    };
  }

  const data = toolResult.data;
  if (!data) return { success: true };

  // Protocol template with trainings
  if (data.trainings && Array.isArray(data.trainings)) {
    return {
      success: true,
      name: data.name,
      type: data.type,
      trainingsCount: data.trainings.length,
      trainings: data.trainings.map((t) => ({
        name: t.trainingTemplate?.name || t.name,
        weekDay: t.weekDay,
        exercisesCount: t.trainingTemplate?.trainingTemplateExerciseTemplates?.length ?? null,
        exercises: t.trainingTemplate?.trainingTemplateExerciseTemplates?.map((e) => ({
          name: e.name || e.exerciseTemplate?.name || "exercício",
          sets: e.sets ?? null,
          repetitions: e.repetitions ?? null,
          restInterval: e.restInterval ?? null,
          hasLoad: e.hasLoad ?? null,
          suggestedLoad: e.suggestedLoad ?? null,
        })) ?? [],
      })),
    };
  }

  // Training template with exercises
  if (
    data.trainingTemplateExerciseTemplates &&
    Array.isArray(data.trainingTemplateExerciseTemplates)
  ) {
    return {
      success: true,
      name: data.name,
      category: data.category,
      exercisesCount: data.trainingTemplateExerciseTemplates.length,
      exercises: data.trainingTemplateExerciseTemplates.map((e) => ({
        name: e.name || e.exerciseTemplate?.name || "exercício",
        sets: e.sets ?? null,
        repetitions: e.repetitions ?? null,
        restInterval: e.restInterval ?? null,
        hasLoad: e.hasLoad ?? null,
        suggestedLoad: e.suggestedLoad ?? null,
      })),
    };
  }

  // AI performance snapshot (student dashboard data for iArnold)
  if (data.sessionCounts && typeof data.sessionCounts === 'object') {
    return {
      success: true,
      studentId: data.studentId,
      studentName: data.studentName,
      window: data.window,
      sessionCounts: data.sessionCounts,
      totalSessions: data.totalSessions,
      completionRate: data.completionRate,
      lastSessionAt: data.lastSessionAt,
      currentProtocol: data.currentProtocol,
      topExercises: (data.topExercises ?? []).map((e) => ({
        exerciseId: e.exerciseId,
        name: e.name,
        hasLoad: e.hasLoad,
        sessionCount: e.sessionCount,
        lastPerformedAt: e.lastPerformedAt,
        latestMaxLoad: e.latestMaxLoad,
        latestAvgLoad: e.latestAvgLoad,
        latestTotalVolume: e.latestTotalVolume,
        maxLoadDelta: e.maxLoadDelta,
        maxLoadDeltaPct: e.maxLoadDeltaPct,
      })),
    };
  }

  // Single entity (exercise template, protocol import, etc.)
  return {
    success: true,
    name: data.name,
    id: data.id,
  };
}

/**
 * Heuristic to detect whether the last assistant message in the conversation
 * history described specific exercises to the trainer.
 *
 * Returns true when the text contains patterns that strongly indicate a list of
 * named exercises was presented — e.g. two or more bullet-point lines, a
 * comma-separated exercise list after the word "exercícios", or explicit
 * set/rep notation (e.g. "3x10", "3 séries de 10").
 *
 * The check is intentionally conservative: false positives (warning when none
 * is needed) are less harmful than false negatives (no warning when exercises
 * were promised), but we also don't want to annoy trainers who explicitly asked
 * for an empty training.
 */
export function didPreviousAssistantMessageListExercises(conversationHistory) {
  if (!Array.isArray(conversationHistory) || conversationHistory.length === 0) {
    return false;
  }

  // Find the last assistant message in the history (may be a plain text entry
  // or a reconstructed provider-specific entry — we look at string content).
  let lastAssistantText = null;
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const msg = conversationHistory[i];
    if (msg.role === "assistant") {
      // content may be a string or an array of blocks (provider-specific)
      if (typeof msg.content === "string") {
        lastAssistantText = msg.content;
      } else if (Array.isArray(msg.content)) {
        // Collect all text blocks
        lastAssistantText = msg.content
          .filter((b) => b.type === "text")
          .map((b) => b.text || "")
          .join(" ");
      }
      break;
    }
  }

  if (!lastAssistantText) {
    return false;
  }

  const text = lastAssistantText;

  // Heuristic 1: two or more bullet-point lines (-, •, *, or numbered list)
  const bulletLines = text
    .split("\n")
    .filter((line) => /^\s*[-•*]\s+\S/.test(line) || /^\s*\d+[.)]\s+\S/.test(line));
  if (bulletLines.length >= 2) {
    return true;
  }

  // Heuristic 2: explicit set/rep notation (e.g. "3x10", "3 séries", "3 series")
  if (/\b\d+\s*[xX×]\s*\d+\b/.test(text) || /\b\d+\s*s[eé]ries?\b/i.test(text)) {
    return true;
  }

  // Heuristic 3: the word "exercícios" (or "exercicios") followed by a
  // comma-separated list of at least two items on the same or next line
  const exerciciosMatch = text.match(
    /exerc[ií]cios?[^.!?\n]*[:]\s*([^\n.!?]+)/i,
  );
  if (exerciciosMatch) {
    const listPart = exerciciosMatch[1];
    const items = listPart.split(/,/).filter((s) => s.trim().length > 0);
    if (items.length >= 2) {
      return true;
    }
  }

  return false;
}

/**
 * Checks whether a successful tool result created at least one training without exercises.
 * Only relevant for tools that create trainings; add_exercises_to_training always adds some.
 *
 * @param {string} toolName
 * @param {object} toolResult
 * @param {object} summary - result of summarizeToolResult()
 */
function resultHasEmptyTrainings(toolName, toolResult, summary) {
  if (toolName === AI_TOOLS.CREATE_TRAINING_TEMPLATE) {
    return (summary.exercisesCount ?? 0) === 0;
  }

  if (toolName === AI_TOOLS.ADD_TRAINING_TO_PROTOCOL) {
    const created = Array.isArray(toolResult.data) ? toolResult.data : [];
    return created.some((training) => (training.exercises?.length ?? 0) === 0);
  }

  if (toolName === AI_TOOLS.CREATE_PROTOCOL_TEMPLATE && Array.isArray(summary.trainings)) {
    return summary.trainings.some((t) => (t.exercisesCount ?? 0) === 0);
  }

  return false;
}

/**
 * Build a human-friendly response from a tool result.
 * Used as fallback when the LLM second call returns empty text,
 * or as the primary response to avoid the second call entirely.
 *
 * @param {string} toolName
 * @param {object} toolResult
 * @param {Array} [conversationHistory] - history BEFORE the current tool turn,
 *   used to detect if the assistant promised exercises that are now missing.
 */
function buildToolResultMessage(toolName, toolResult, conversationHistory = []) {
  if (!toolResult.success) {
    return `Não foi possível executar a ação: ${toolResult.message || "erro desconhecido"}.`;
  }

  const data = toolResult.data;
  const summary = summarizeToolResult(toolResult);

  let baseMessage;
  switch (toolName) {
    case AI_TOOLS.IMPORT_FROM_TEMPLATE:
      baseMessage = `Protocolo "${data?.name || "novo"}" criado com sucesso!`;
      break;

    case AI_TOOLS.CREATE_EXERCISE_TEMPLATE:
      baseMessage = `Exercício "${data?.name || "novo"}" criado na sua biblioteca.`;
      break;

    case AI_TOOLS.CREATE_TRAINING_TEMPLATE: {
      const exCount = summary.exercisesCount || 0;
      const exList = summary.exercises?.map((e) => e.name).join(", ") || "";
      const exText = exCount > 0 ? ` com ${exCount} exercícios: ${exList}` : "";
      baseMessage = `Treino "${data?.name || "novo"}"${exText} criado na sua biblioteca.`;
      break;
    }

    case AI_TOOLS.CREATE_PROTOCOL_TEMPLATE: {
      const trCount = summary.trainingsCount || 0;
      const trList =
        summary.trainings
          ?.map((t) => {
            const day = t.weekDay ? ` (${t.weekDay})` : "";
            return `${t.name}${day}`;
          })
          .join(", ") || "";
      const trText = trCount > 0 ? ` com ${trCount} treinos: ${trList}` : "";
      baseMessage = `Rotina "${data?.name || "nova"}"${trText} criada na sua biblioteca!`;
      break;
    }

    case AI_TOOLS.ADD_TRAINING_TO_PROTOCOL: {
      const count = Array.isArray(data) ? data.length : 1;
      baseMessage = `${count} treino(s) adicionado(s) ao protocolo com sucesso!`;
      break;
    }

    case AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE:
      baseMessage = `Template "${data?.name || 'protocolo'}" atualizado com sucesso!`;
      break;

    case AI_TOOLS.UPDATE_TRAINING_TEMPLATE:
      baseMessage = `Template de treino "${data?.name || 'treino'}" atualizado com sucesso!`;
      break;

    case AI_TOOLS.UPDATE_EXERCISE_TEMPLATE:
      baseMessage = `Exercício "${data?.name || 'exercício'}" atualizado na sua biblioteca.`;
      break;

    case AI_TOOLS.UPDATE_PROTOCOL:
      baseMessage = `Protocolo "${data?.name || 'protocolo'}" atualizado com sucesso!`;
      break;

    case AI_TOOLS.UPDATE_TRAINING:
      baseMessage = `Treino "${data?.name || 'treino'}" atualizado com sucesso!`;
      break;

    case AI_TOOLS.UPDATE_EXERCISE:
      baseMessage = `Exercício "${data?.name || 'exercício'}" atualizado com sucesso!`;
      break;

    case AI_TOOLS.ADD_EXERCISES_TO_TRAINING: {
      const count = Array.isArray(data) ? data.length : 1;
      baseMessage = `${count} exercício(s) adicionado(s) ao treino com sucesso!`;
      break;
    }

    case AI_TOOLS.REORDER_EXERCISES_IN_TRAINING: {
      const names = (data?.exercises ?? []).map((e) => e.name).join(', ');
      baseMessage = `Exercícios reordenados: ${names || 'concluído'}.`;
      break;
    }

    case AI_TOOLS.GET_STUDENT_PERFORMANCE: {
      // Deterministic fallback paragraph used when the second LLM call returns empty text.
      // The primary path is a second LLM call that interprets this data.
      const snap = toolResult.data;
      if (!snap) {
        baseMessage = "Consulta de desempenho realizada, mas nenhum dado foi retornado.";
        break;
      }
      const studentName = snap.studentName || "Aluno";
      const windowDays = snap.window?.days;
      const window = windowDays ? `(últimos ${windowDays} dias)` : "";
      const completed = snap.sessionCounts?.completed ?? 0;
      const scheduled =
        snap.totalSessions ??
        Object.values(snap.sessionCounts ?? {}).reduce((sum, count) => sum + count, 0);
      const rateStr =
        typeof snap.completionRate === "number"
          ? ` — ${(snap.completionRate * 100).toFixed(0)}% de adesão`
          : "";
      const lastSession = snap.lastSessionAt
        ? ` Último treino: ${new Date(snap.lastSessionAt).toLocaleDateString("pt-BR", { timeZone: TRAINER_TIME_ZONE })}.`
        : "";
      const topEx = (snap.topExercises ?? []).slice(0, 3);
      const topExStr =
        topEx.length > 0
          ? ` Exercícios mais realizados: ${topEx.map((e) => e.name).join(", ")}.`
          : "";
      baseMessage = `${studentName} ${window}: ${completed} de ${scheduled} sessões concluídas${rateStr}.${lastSession}${topExStr}`.replace(/\s{2,}/g, " ");
      break;
    }

    default:
      baseMessage = "Ação executada com sucesso!";
  }

  // Post-execution consistency check: if the previous assistant message
  // listed exercises but the result contains no exercises, warn the trainer.
  // Uses the already-computed summary to avoid a second summarizeToolResult call.
  if (
    toolResult.success &&
    resultHasEmptyTrainings(toolName, toolResult, summary) &&
    didPreviousAssistantMessageListExercises(conversationHistory)
  ) {
    const trainingName = data?.name || "este treino";
    baseMessage +=
      `\n\nAtenção: criei "${trainingName}", mas os exercícios que mencionei não foram incluídos. Me diga os exercícios novamente que adiciono.`;
  }

  return baseMessage;
}

// --- AI prescription mode helpers ---

/**
 * Sanitize LLM-emitted prescriptionMode: validates against known values, defaults to 'reps'.
 */
function sanitizeAiPrescriptionMode(mode) {
  if (mode && prescriptionModeValues.includes(mode)) return mode;
  return PrescriptionMode.REPS;
}

/**
 * Apply mutual exclusivity for AI-generated exercise fields.
 * Returns { repetitions, duration } with the non-applicable field nulled.
 */
function resolveAiExerciseFields(resolvedMode, ex) {
  if (resolvedMode === PrescriptionMode.DURATION) {
    return { repetitions: null, duration: ex.duration ?? null };
  }
  return { repetitions: ex.repetitions ?? null, duration: null };
}

// --- Tool executor ---

// LLM sometimes passes [TYPE_REF:uuid] wrapper tags instead of raw UUIDs in tool arguments.
// This happens when the model reads the reference tag literally from context strings rather
// than extracting just the id — historically triggered the reorder_exercises_in_training bug
// where exerciseIds were passed as ["[EXERCISE_REF:abc-123]", ...] instead of ["abc-123", ...].
// Strips the wrapper and returns the inner value; passes through raw ids and null/undefined untouched.
const REF_TAG_PATTERN = /^\[[A-Z_]+:(.+)\]$/;

function unwrapRefTag(value) {
  if (value == null) return value;
  const trimmed = String(value).trim();
  const match = REF_TAG_PATTERN.exec(trimmed);
  return match ? match[1] : trimmed;
}

// Sanitize all *Id (scalar) and *Ids (array) fields at any depth in a tool input so that wrapped
// ref tags are stripped before reaching service validators. Applied globally because every *Id field
// is a raw UUID by contract — tags belong only in context strings, never in tool arguments.
function sanitizeToolInputIds(input) {
  if (Array.isArray(input)) return input.map(sanitizeToolInputIds);
  if (!input || typeof input !== 'object') return input;
  const sanitized = { ...input };
  for (const key of Object.keys(sanitized)) {
    const value = sanitized[key];
    if (key.endsWith('Id') && typeof value === 'string') {
      sanitized[key] = unwrapRefTag(value);
    } else if (key.endsWith('Ids') && Array.isArray(value)) {
      sanitized[key] = value.map((item) => (typeof item === 'string' ? unwrapRefTag(item) : sanitizeToolInputIds(item)));
    } else if (value && typeof value === 'object') {
      sanitized[key] = sanitizeToolInputIds(value);
    }
  }
  return sanitized;
}

async function executeTool(userId, toolName, toolInput) {
  const startTime = Date.now();

  try {
    let result;
    // Strip any [TYPE_REF:id] wrappers the LLM may have passed in *Id/*Ids fields
    const input = sanitizeToolInputIds(toolInput);

    switch (toolName) {
      case AI_TOOLS.IMPORT_FROM_TEMPLATE: {
        result = await importFromTemplate(
          userId,
          input.templateId,
          input.assigneeId,
          {
            name: input.name,
            startDate: input.startDate,
            expirationDate: input.expirationDate,
          },
        );
        break;
      }

      case AI_TOOLS.CREATE_EXERCISE_TEMPLATE: {
        result = await createExerciseTemplate(userId, input);
        break;
      }

      case AI_TOOLS.CREATE_TRAINING_TEMPLATE: {
        // Batch: create all exercise templates + training template in a single transaction
        const trainer = await prisma.trainer.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!trainer) {
          throw new AppError({
            httpStatus: 404,
            error: "TRAINER_PROFILE_MISSING",
            messageCode: "legacy.TRAINER_PROFILE_MISSING",
            message: "Trainer profile not found",
          });
        }

        const inlineExercises = input.exercises || [];
        const existingIds = input.exerciseTemplateIds || [];

        // Validate all exercises upfront before any DB writes
        for (const ex of inlineExercises) {
          validateExerciseType(ex.type);
          if (ex.repetitions) validateRepetitions(ex.repetitions);
        }
        if (input.category) validateCategory(input.category);
        if (input.bodySegment) validateBodySegment(input.bodySegment);

        // SECURITY: Verify all referenced exercise templates belong to this trainer
        if (existingIds.length > 0) {
          const ownedExerciseTemplates = await prisma.exerciseTemplate.findMany({
            where: { id: { in: existingIds }, trainerId: trainer.id },
            select: { id: true },
          });
          if (ownedExerciseTemplates.length !== existingIds.length) {
            throw new AppError({
              httpStatus: 403,
              error: AI_ERRORS.EXERCISE_TEMPLATE_NOT_OWNED,
              messageCode: AI_MESSAGE_CODES.EXERCISE_TEMPLATE_NOT_OWNED,
              message: "One or more exercise templates do not belong to this trainer",
            });
          }
        }

        // Fetch existing exercise templates upfront so we can snapshot their fields
        let existingTemplatesForSnapshot = [];
        if (existingIds.length > 0) {
          existingTemplatesForSnapshot = await prisma.exerciseTemplate.findMany({
            where: { id: { in: existingIds }, trainerId: trainer.id },
          });
        }
        const existingTemplateSnapshotById = Object.fromEntries(
          existingTemplatesForSnapshot.map((t) => [t.id, t]),
        );

        result = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
          // Batch create exercise templates; collect full data for snapshot
          const createdExerciseSnapshots = [];
          if (inlineExercises.length > 0) {
            for (const ex of inlineExercises) {
              // ExerciseTemplate carries only identity — no prescription fields
              const created = await tx.exerciseTemplate.create({
                data: {
                  trainerId: trainer.id,
                  name: ex.name,
                  type: ex.type,
                  videoUrl: ex.videoUrl ?? null,
                  isPublic: false,
                },
              });
              createdExerciseSnapshots.push(created);
            }
          }

          // Build junction rows: existing ids first, then newly created.
          // Prescription for existing-by-ID templates defaults to null because the
          // library template no longer carries prescription — set it when building
          // the template, not from a stale library snapshot.
          const existingJunctionRows = existingIds.map((id) => {
            const t = existingTemplateSnapshotById[id];
            return {
              exerciseTemplateId: id,
              name: t.name,
              type: t.type,
              videoUrl: t.videoUrl ?? null,
              gifUrl: t.gifUrl ?? null,
              sets: null,
              repetitions: null,
              duration: null,
              prescriptionMode: resolvePrescriptionMode(null, {}),
              hasLoad: false,
              suggestedLoad: null,
              restInterval: null,
              notes: null,
            };
          });
          // Prescription for inline exercises comes from the AI-provided spec (ex),
          // matched by index to the created template snapshot.
          const createdJunctionRows = createdExerciseSnapshots.map((t, index) => {
            const ex = inlineExercises[index];
            const resolvedMode = sanitizeAiPrescriptionMode(ex.prescriptionMode);
            const { repetitions, duration } = resolveAiExerciseFields(resolvedMode, ex);
            return {
              exerciseTemplateId: t.id,
              name: t.name,
              type: t.type,
              videoUrl: t.videoUrl ?? null,
              gifUrl: t.gifUrl ?? null,
              sets: ex.sets ?? null,
              repetitions,
              duration,
              prescriptionMode: resolvedMode,
              hasLoad: ex.hasLoad ?? false,
              suggestedLoad: ex.suggestedLoad ?? null,
              restInterval: ex.restInterval ?? null,
              notes: ex.notes ?? null,
            };
          });
          const allJunctionRows = [...existingJunctionRows, ...createdJunctionRows].map(
            (row, index) => ({ ...row, order: index }),
          );

          // Create training template with linked exercises
          const trainingTemplate = await tx.trainingTemplate.create({
            data: {
              trainerId: trainer.id,
              name: input.name,
              category: input.category,
              description: input.description || null,
              bodySegment: input.bodySegment || null,
              tags: [],
              isPublic: false,
              ...(allJunctionRows.length > 0 && {
                trainingTemplateExerciseTemplates: {
                  create: allJunctionRows,
                },
              }),
            },
            include: {
              trainingTemplateExerciseTemplates: {
                include: {
                  exerciseTemplate: {
                    select: { id: true, name: true, type: true },
                  },
                },
                orderBy: { order: "asc" },
              },
            },
          });

          return trainingTemplate;
        }));
        break;
      }

      case AI_TOOLS.CREATE_PROTOCOL_TEMPLATE: {
        // Batch cascade: create all exercise templates → training templates → protocol template
        // in a single transaction for atomicity and performance
        const trainer = await prisma.trainer.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!trainer) {
          throw new AppError({
            httpStatus: 404,
            error: "TRAINER_PROFILE_MISSING",
            messageCode: "legacy.TRAINER_PROFILE_MISSING",
            message: "Trainer profile not found",
          });
        }

        // Validate all data upfront
        if (input.genderOrdination) {
          validateGenderOrdination(input.genderOrdination);
        }
        if (input.trainingLevel) {
          validateTrainingLevel(input.trainingLevel);
        }
        if (input.type) {
          validateProtocolType(input.type);
        }
        for (const training of input.trainings || []) {
          if (training.category) validateCategory(training.category);
          if (training.bodySegment) validateBodySegment(training.bodySegment);
          for (const ex of training.exercises || []) {
            validateExerciseType(ex.type);
            if (ex.repetitions) validateRepetitions(ex.repetitions);
          }
        }

        result = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
          const resolvedTrainings = [];

          for (const training of input.trainings || []) {
            if (training.trainingTemplateId) {
              // SECURITY: Verify the referenced training template belongs to this trainer
              const ownedTrainingTemplate = await tx.trainingTemplate.findFirst({
                where: { id: training.trainingTemplateId, trainerId: trainer.id },
                select: { id: true },
              });
              if (!ownedTrainingTemplate) {
                throw new AppError({
                  httpStatus: 403,
                  error: AI_ERRORS.TRAINING_TEMPLATE_NOT_OWNED,
                  messageCode: AI_MESSAGE_CODES.TRAINING_TEMPLATE_NOT_OWNED,
                  message: "Training template does not belong to this trainer",
                });
              }
              resolvedTrainings.push({
                trainingTemplateId: training.trainingTemplateId,
                weekDay: training.weekDay || null,
                order: training.order ?? resolvedTrainings.length,
              });
              continue;
            }

            const existingExIds = training.exerciseTemplateIds || [];

            // SECURITY: Verify all referenced exercise templates belong to this trainer
            if (existingExIds.length > 0) {
              const owned = await tx.exerciseTemplate.findMany({
                where: { id: { in: existingExIds }, trainerId: trainer.id },
                select: { id: true },
              });
              if (owned.length !== existingExIds.length) {
                throw new AppError({
                  httpStatus: 403,
                  error: AI_ERRORS.EXERCISE_TEMPLATE_NOT_OWNED,
                  messageCode: AI_MESSAGE_CODES.EXERCISE_TEMPLATE_NOT_OWNED,
                  message: "One or more exercise templates do not belong to this trainer",
                });
              }
            }

            // Fetch existing exercise templates for snapshot data
            let existingExSnapshots = [];
            if (existingExIds.length > 0) {
              existingExSnapshots = await tx.exerciseTemplate.findMany({
                where: { id: { in: existingExIds }, trainerId: trainer.id },
              });
            }

            // Batch create inline exercise templates (identity only — no prescription)
            const inlineExerciseSpecs = training.exercises || [];
            const exerciseSnapshots = [];
            for (const ex of inlineExerciseSpecs) {
              const created = await tx.exerciseTemplate.create({
                data: {
                  trainerId: trainer.id,
                  name: ex.name,
                  type: ex.type,
                  videoUrl: ex.videoUrl ?? null,
                  isPublic: false,
                },
              });
              exerciseSnapshots.push(created);
            }

            // Build junction rows: inline first, then existing-by-ID (order is sequential, no gaps).
            // Prescription for inline exercises comes from the AI spec (inlineExerciseSpecs),
            // matched by index. Prescription for existing-by-ID templates defaults to null.
            const inlineJunctionRows = exerciseSnapshots.map((t, index) => {
              const ex = inlineExerciseSpecs[index];
              const resolvedMode = sanitizeAiPrescriptionMode(ex.prescriptionMode);
              const { repetitions, duration } = resolveAiExerciseFields(resolvedMode, ex);
              return {
                exerciseTemplateId: t.id,
                order: index,
                name: t.name,
                type: t.type,
                videoUrl: t.videoUrl ?? null,
                gifUrl: t.gifUrl ?? null,
                sets: ex.sets ?? null,
                repetitions,
                duration,
                prescriptionMode: resolvedMode,
                hasLoad: ex.hasLoad ?? false,
                suggestedLoad: ex.suggestedLoad ?? null,
                restInterval: ex.restInterval ?? null,
                notes: ex.notes ?? null,
              };
            });
            const existingJunctionRows = existingExSnapshots.map((t, index) => ({
              exerciseTemplateId: t.id,
              order: exerciseSnapshots.length + index,
              name: t.name,
              type: t.type,
              videoUrl: t.videoUrl ?? null,
              gifUrl: t.gifUrl ?? null,
              sets: null,
              repetitions: null,
              duration: null,
              prescriptionMode: resolvePrescriptionMode(null, {}),
              hasLoad: false,
              suggestedLoad: null,
              restInterval: null,
              notes: null,
            }));
            const allJunctionRows = [...inlineJunctionRows, ...existingJunctionRows];

            // Create training template
            const createdTraining = await tx.trainingTemplate.create({
              data: {
                trainerId: trainer.id,
                name: training.name,
                category: training.category,
                description: training.description || null,
                bodySegment: training.bodySegment || null,
                tags: [],
                isPublic: false,
                ...(allJunctionRows.length > 0 && {
                  trainingTemplateExerciseTemplates: {
                    create: allJunctionRows,
                  },
                }),
              },
            });

            resolvedTrainings.push({
              trainingTemplateId: createdTraining.id,
              weekDay: training.weekDay || null,
              order: training.order ?? resolvedTrainings.length,
            });
          }

          // Create protocol template
          const protocol = await tx.trainingProtocolTemplate.create({
            data: {
              trainerId: trainer.id,
              name: input.name,
              description: input.description || null,
              defaultDurationWeeks: input.defaultDurationWeeks ?? null,
              genderOrdination: input.genderOrdination || null,
              trainingLevel: input.trainingLevel || null,
              type: input.type || null,
              ...(resolvedTrainings.length > 0 && {
                trainings: {
                  create: resolvedTrainings.map((t) => ({
                    trainingTemplateId: t.trainingTemplateId,
                    weekDay: t.weekDay,
                    order: t.order,
                  })),
                },
              }),
            },
            include: {
              trainings: {
                include: {
                  trainingTemplate: {
                    select: {
                      id: true,
                      name: true,
                      category: true,
                      trainingTemplateExerciseTemplates: {
                        select: {
                          name: true,
                          sets: true,
                          repetitions: true,
                          duration: true,
                          restInterval: true,
                          hasLoad: true,
                          suggestedLoad: true,
                          exerciseTemplate: {
                            select: { id: true, name: true, type: true },
                          },
                        },
                        orderBy: { order: "asc" },
                      },
                    },
                  },
                },
                orderBy: { order: "asc" },
              },
            },
          });

          return protocol;
        }));

        await maybeMarkFirstProtocolCreated({ trainerId: trainer.id });
        break;
      }

      case AI_TOOLS.ADD_TRAINING_TO_PROTOCOL: {
        // IMPORTANT: Do NOT call createTraining/createExercise service functions —
        // they import the prisma singleton and would ignore the `tx` context.
        // Use tx directly for real atomicity, same pattern as importFromTemplate.
        const trainer = await prisma.trainer.findUnique({
          where: { userId },
          select: { id: true },
        });

        if (!trainer) {
          throw new AppError({
            httpStatus: 404,
            error: "TRAINER_PROFILE_MISSING",
            messageCode: "legacy.TRAINER_PROFILE_MISSING",
            message: "Trainer profile not found",
          });
        }

        if (!input.trainings?.length) {
          throw new AppError({
            httpStatus: 400,
            error: "VALIDATION_ERROR",
            messageCode: "validation.failed",
            message: "At least one training is required",
          });
        }

        const protocol = await prisma.trainingProtocol.findUnique({
          where: { id: input.protocolId },
          select: { id: true, trainerId: true, deletedAt: true },
        });

        if (!protocol || protocol.deletedAt) {
          throw new AppError({
            httpStatus: 404,
            error: "PROTOCOL_NOT_FOUND",
            messageCode: "legacy.PROTOCOL_NOT_FOUND",
            message: "Protocol not found",
          });
        }

        if (protocol.trainerId !== trainer.id) {
          throw new AppError({
            httpStatus: 403,
            error: "FORBIDDEN_NOT_PROTOCOL_OWNER",
            messageCode: "legacy.FORBIDDEN_NOT_PROTOCOL_OWNER",
            message: "You do not own this protocol",
          });
        }

        result = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
          const createdTrainings = [];
          const { _max: maxTraining } = await tx.training.aggregate({
            where: { trainingProtocolId: input.protocolId, deletedAt: null },
            _max: { order: true },
          });
          const firstOrder = (maxTraining?.order ?? -1) + 1;

          for (const [trainingIndex, training] of input.trainings.entries()) {
            validateCategory(training.category);
            if (training.weekDay) validateWeekDay(training.weekDay);
            if (training.bodySegment) validateBodySegment(training.bodySegment);

            const createdTraining = await tx.training.create({
              data: {
                name: training.name,
                category: training.category,
                bodySegment: training.bodySegment || null,
                description: training.description || null,
                weekDay: training.weekDay || null,
                order: firstOrder + trainingIndex,
                notes: training.notes || null,
                trainingProtocolId: input.protocolId,
              },
            });

            const createdExercises = [];
            if (training.exercises?.length) {
              for (const [index, exercise] of training.exercises.entries()) {
                validateExerciseType(exercise.type);
                if (exercise.repetitions)
                  validateRepetitions(exercise.repetitions);

                const resolvedMode = sanitizeAiPrescriptionMode(exercise.prescriptionMode);
                const { repetitions, duration } = resolveAiExerciseFields(resolvedMode, exercise);

                const createdExercise = await tx.exercise.create({
                  data: {
                    name: exercise.name,
                    type: exercise.type,
                    // Sequential order by position; without it Prisma's @default(0)
                    // makes every exercise share order=0 and breaks execution ordering.
                    order: exercise.order ?? index,
                    sets: exercise.sets || null,
                    repetitions,
                    duration,
                    prescriptionMode: resolvedMode,
                    hasLoad: exercise.hasLoad ?? false,
                    suggestedLoad: exercise.suggestedLoad || null,
                    restInterval: exercise.restInterval || null,
                    notes: exercise.notes || null,
                    trainingId: createdTraining.id,
                  },
                });
                createdExercises.push(createdExercise);
              }
            }

            createdTrainings.push({ ...createdTraining, exercises: createdExercises });
          }

          return createdTrainings;
        }));

        break;
      }

      case AI_TOOLS.UPDATE_PROTOCOL_TEMPLATE: {
        const fields = ['name', 'description', 'defaultDurationWeeks', 'genderOrdination', 'trainingLevel', 'type'];
        const data = Object.fromEntries(fields.filter(f => input[f] !== undefined).map(f => [f, input[f]]));
        result = await updateProtocolTemplate(userId, input.templateId, data);
        break;
      }

      case AI_TOOLS.UPDATE_TRAINING_TEMPLATE: {
        const fields = ['name', 'description', 'category', 'bodySegment'];
        const data = Object.fromEntries(fields.filter(f => input[f] !== undefined).map(f => [f, input[f]]));
        result = await updateTrainingTemplate(userId, input.templateId, data);
        break;
      }

      case AI_TOOLS.UPDATE_EXERCISE_TEMPLATE: {
        const fields = ['name', 'type', 'videoUrl'];
        const data = Object.fromEntries(fields.filter(f => input[f] !== undefined).map(f => [f, input[f]]));
        result = await updateExerciseTemplate(userId, input.templateId, data);
        break;
      }

      case AI_TOOLS.UPDATE_PROTOCOL: {
        const fields = ['name', 'description', 'status', 'startDate', 'expirationDate'];
        const data = Object.fromEntries(fields.filter(f => input[f] !== undefined).map(f => [f, input[f]]));
        result = await updateProtocol(userId, input.protocolId, data);
        break;
      }

      case AI_TOOLS.UPDATE_TRAINING: {
        const fields = ['name', 'description', 'category', 'bodySegment', 'weekDay', 'order', 'notes'];
        const data = Object.fromEntries(fields.filter(f => input[f] !== undefined).map(f => [f, input[f]]));
        result = await updateTraining(userId, input.trainingId, data);
        break;
      }

      case AI_TOOLS.UPDATE_EXERCISE: {
        const fields = ['name', 'type', 'prescriptionMode', 'sets', 'repetitions', 'duration', 'hasLoad', 'suggestedLoad', 'restInterval', 'notes'];
        const data = Object.fromEntries(fields.filter(f => input[f] !== undefined).map(f => [f, input[f]]));
        result = await updateExercise(userId, input.exerciseId, data);
        break;
      }

      case AI_TOOLS.REORDER_EXERCISES_IN_TRAINING: {
        // Tool temporarily disabled — see schema comment above.
        throw new AppError({
          httpStatus: 400,
          error: AI_ERRORS.TOOL_DISABLED,
          messageCode: AI_MESSAGE_CODES.TOOL_DISABLED,
          message: 'reorder_exercises_in_training is temporarily disabled. Ask the trainer to reorder exercises manually in the workout screen.',
        });
      }

      case AI_TOOLS.ADD_EXERCISES_TO_TRAINING: {
        const trainer = await prisma.trainer.findUnique({
          where: { userId },
          select: { id: true },
        });
        if (!trainer) {
          throw new AppError({
            httpStatus: 404,
            error: "TRAINER_PROFILE_MISSING",
            messageCode: "legacy.TRAINER_PROFILE_MISSING",
            message: "Trainer profile not found",
          });
        }

        if (!input.exercises?.length) {
          throw new AppError({
            httpStatus: 400,
            error: "VALIDATION_ERROR",
            messageCode: "validation.failed",
            message: "At least one exercise is required",
          });
        }

        // Verify the training exists and belongs to this trainer (via protocol ownership)
        const training = await prisma.training.findUnique({
          where: { id: input.trainingId },
          select: { id: true, deletedAt: true, trainingProtocol: { select: { trainerId: true } } },
        });

        if (!training || training.deletedAt) {
          throw new AppError({
            httpStatus: 404,
            error: "TRAINING_NOT_FOUND",
            messageCode: "legacy.TRAINING_NOT_FOUND",
            message: "Training not found",
          });
        }

        if (training.trainingProtocol.trainerId !== trainer.id) {
          throw new AppError({
            httpStatus: 403,
            error: "FORBIDDEN_NOT_PROTOCOL_OWNER",
            messageCode: "legacy.FORBIDDEN_NOT_PROTOCOL_OWNER",
            message: "You do not own this training's protocol",
          });
        }

        result = await withDeadlockRetry(() => prisma.$transaction(async (tx) => {
          const created = [];
          const { _max: maxExercise } = await tx.exercise.aggregate({
            where: { trainingId: input.trainingId, deletedAt: null },
            _max: { order: true },
          });
          const firstOrder = (maxExercise?.order ?? -1) + 1;

          for (const [index, exercise] of input.exercises.entries()) {
            validateExerciseType(exercise.type);
            if (exercise.repetitions) validateRepetitions(exercise.repetitions);

            const resolvedMode = sanitizeAiPrescriptionMode(exercise.prescriptionMode);
            const { repetitions, duration } = resolveAiExerciseFields(resolvedMode, exercise);

            const ex = await tx.exercise.create({
              data: {
                name: exercise.name,
                type: exercise.type,
                order: firstOrder + index,
                sets: exercise.sets || null,
                repetitions,
                duration,
                prescriptionMode: resolvedMode,
                hasLoad: exercise.hasLoad ?? false,
                suggestedLoad: exercise.suggestedLoad || null,
                restInterval: exercise.restInterval || null,
                notes: exercise.notes || null,
                trainingId: input.trainingId,
              },
            });
            created.push(ex);
          }
          return created;
        }));
        break;
      }

      case AI_TOOLS.GET_STUDENT_PERFORMANCE: {
        const snapshot = await studentDashboardService.buildAiPerformanceSnapshot(
          userId,
          input.studentId,
          {
            windowDays: input.windowDays ?? 90,
            includeExerciseProgression: input.includeExerciseProgression !== false,
          },
        );
        result = snapshot;
        break;
      }

      default:
        return {
          success: false,
          error: "UNKNOWN_TOOL",
          message: `Tool desconhecida: ${toolName}`,
        };
    }

    logAiAction(userId, toolName, toolInput, {
      success: true,
      durationMs: Date.now() - startTime,
    });

    return { success: true, data: result };
  } catch (err) {
    logAiAction(userId, toolName, toolInput, {
      success: false,
      error: err instanceof AppError ? err.message : err?.name,
      durationMs: Date.now() - startTime,
    });

    if (err instanceof AppError) {
      return {
        success: false,
        error: err.error,
        messageCode: err.messageCode,
        message: err.message,
      };
    }

    console.error(`[AI] Unexpected failure in tool ${toolName}:`, describeUnexpectedError(err));
    return {
      success: false,
      error: AI_ERRORS.TOOL_EXECUTION_FAILED,
      message: "Erro inesperado ao executar a ação",
    };
  }
}

// --- Conversation persistence helpers ---

// Repairs turns saved by the old parallel writer, where a tool_result could sort before its tool_use.
function reorderLegacyToolTurns(messages) {
  const ordered = [...messages];
  for (let i = 0; i < ordered.length - 1; i++) {
    const next = ordered[i + 1];
    if (ordered[i].role === "tool_result" && next.role === "assistant" && next.rawContent) {
      [ordered[i], ordered[i + 1]] = [next, ordered[i]];
      i++;
    }
  }
  return ordered;
}

// Ensures a saved tool turn answers every tool_use id, in order, so the provider never rejects the replay.
function completeToolResults(assistantRawContent, savedResults) {
  const toolUseIds = (Array.isArray(assistantRawContent) ? assistantRawContent : [])
    .filter((block) => block?.type === "tool_use")
    .map((block) => block.id);
  if (toolUseIds.length === 0) return savedResults;

  return toolUseIds.map(
    (id) =>
      savedResults.find((result) => result.toolCallId === id) ?? {
        toolCallId: id,
        content: JSON.stringify({ success: false, error: "ONE_ACTION_PER_TURN", message: "Ação não executada: uma ação por turno" }),
      },
  );
}

// Wraps a user turn in <user_input> (stripping smuggled tags) so replayed turns stay untrusted data.
function toHistoryEntry(msg) {
  const content = msg.role === "user" ? wrapUserInput(msg.content) : msg.content;
  return { role: msg.role, content };
}

async function loadConversationHistory(conversationId, userId) {
  const windowSize = AI_LIMITS.MAX_HISTORY_ITEMS * 2;

  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    include: {
      messages: {
        orderBy: { createdAt: "desc" },
        take: windowSize,
      },
    },
  });

  if (!conversation || conversation.userId !== userId) {
    throw new AppError({
      httpStatus: 404,
      error: AI_ERRORS.CONVERSATION_NOT_FOUND,
      messageCode: AI_MESSAGE_CODES.CONVERSATION_NOT_FOUND,
      message: "Conversation not found",
    });
  }

  // Reverse to chronological order after DESC fetch
  const messages = reorderLegacyToolTurns(conversation.messages.slice().reverse());

  // Drop leading tool_result messages that have no preceding assistant turn
  // (can appear when truncation cuts mid-pair). This prevents Anthropic 400s.
  let startIndex = 0;
  while (startIndex < messages.length && messages[startIndex].role === "tool_result") {
    startIndex++;
  }
  const orderedMessages = messages.slice(startIndex);

  const provider = getLlmProvider();
  const history = [];
  // Tracks the rawContent of the last assistant message that had tool calls,
  // so the immediately following tool_result record can reconstruct the pair.
  let pendingAssistantRawContent = null;

  for (const msg of orderedMessages) {
    if (msg.role === "tool_result") {
      if (pendingAssistantRawContent !== null) {
        // Replace the plain assistant entry that was just pushed with the
        // proper provider-specific tool_use + tool_result message pair.
        history.pop();
        const toolResults = completeToolResults(
          pendingAssistantRawContent,
          Array.isArray(msg.rawContent) ? msg.rawContent : [],
        );
        const pair = provider.buildToolResultMessages(
          pendingAssistantRawContent,
          toolResults,
        );
        history.push(...pair);
        pendingAssistantRawContent = null;
      }
      // No matching assistant rawContent (e.g., legacy records) — skip silently
      continue;
    }

    // Reset pending state on any non-tool_result message
    pendingAssistantRawContent = null;

    if (msg.role === "assistant" && msg.rawContent) {
      // Push the assistant message with plain text content for now.
      // If the next message is a tool_result, this entry will be replaced by
      // the reconstructed pair via pendingAssistantRawContent above.
      history.push({ role: msg.role, content: msg.content });
      pendingAssistantRawContent = msg.rawContent;
    } else {
      history.push(toHistoryEntry(msg));
    }
  }

  return { conversation, history };
}

async function createConversation(userId) {
  return prisma.aiConversation.create({
    data: { userId },
  });
}

// Bumps the conversation's updatedAt; sets the title (first message) when one is given.
async function touchConversation(conversationId, titleSource) {
  await prisma.aiConversation.update({
    where: { id: conversationId },
    data: {
      updatedAt: new Date(),
      ...(titleSource && { title: titleSource.slice(0, CONVERSATION_TITLE_MAX_LENGTH) }),
    },
  });
}

async function saveUserMessage(conversationId, content) {
  return prisma.aiMessage.create({
    data: { conversationId, role: "user", content },
  });
}

async function saveAssistantMessage(conversationId, content, toolCalls, rawContent) {
  return prisma.aiMessage.create({
    data: {
      conversationId,
      role: "assistant",
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      rawContent: rawContent ?? undefined,
    },
  });
}

/**
 * Save a tool_result turn as a synthetic DB record.
 * role "tool_result" is a project-internal marker — it is never sent directly to
 * the LLM. loadConversationHistory() uses it together with the preceding
 * assistant rawContent to rebuild the proper provider-specific message pair via
 * buildToolResultMessages().
 */
async function saveToolResultMessage(conversationId, toolResults) {
  return prisma.aiMessage.create({
    data: {
      conversationId,
      role: "tool_result",
      // Human-readable summary stored in content so the DB record is inspectable
      content: toolResults.map((r) => r.content).join("\n"),
      rawContent: toolResults,
    },
  });
}

// --- Shared conversation setup ---

// Tells whether the newest saved row is this same user message with no reply after it (a retry).
function isUnansweredRetry(conversation, message) {
  const newest = conversation.messages?.[0];
  return newest?.role === "user" && newest.content === message;
}

// Loads or creates the conversation, builds the trainer context and saves the user message (once on retries).
async function setupConversation(userId, { message, conversationId }, knownTrainerId) {
  let conversation;
  let conversationHistory = [];
  let isNewConversation = false;
  let needsTitle = false;
  let isRetryOfUnanswered = false;

  if (conversationId) {
    const loaded = await loadConversationHistory(conversationId, userId);
    conversation = loaded.conversation;
    conversationHistory = loaded.history;
    isRetryOfUnanswered = isUnansweredRetry(conversation, message);
    if (isRetryOfUnanswered) conversationHistory = conversationHistory.slice(0, -1);
    needsTitle = !conversation.title;
  }

  const context = await buildTrainerContext(userId, knownTrainerId);

  if (!conversation) {
    conversation = await createConversation(userId);
    conversationId = conversation.id;
    isNewConversation = true;
    needsTitle = true;
  }

  if (!isRetryOfUnanswered) await saveUserMessage(conversationId, message);

  return { conversationId, conversationHistory, isNewConversation, needsTitle, context };
}

function isRetryableLlmError(err) {
  return AI_RETRY.RETRYABLE_STATUSES.has(err.status);
}

// Builds the AppError for a failed provider call, logging the provider details server-side only.
function buildLlmError(err) {
  console.error(
    "LLM provider error:",
    JSON.stringify({
      status: err.status,
      message: err.message,
      type: err.type,
      code: err.code,
    }),
  );
  if (err.status === 429) {
    return new AppError({
      httpStatus: 429,
      error: AI_ERRORS.RATE_LIMITED,
      messageCode: AI_MESSAGE_CODES.RATE_LIMITED,
      message: "AI service temporarily unavailable. Please try again later.",
    });
  }
  if (err.timedOut) {
    return new AppError({
      httpStatus: 504,
      error: AI_ERRORS.TIMEOUT,
      messageCode: AI_MESSAGE_CODES.TIMEOUT,
      message: "The AI service took too long to respond. Please try again.",
    });
  }
  if (err.status === 529) {
    return new AppError({
      httpStatus: 529,
      error: AI_ERRORS.OVERLOADED,
      messageCode: AI_MESSAGE_CODES.OVERLOADED,
      message: "AI service is temporarily overloaded. Please try again in a moment.",
    });
  }
  return new AppError({
    httpStatus: 502,
    error: AI_ERRORS.MODEL_ERROR,
    messageCode: AI_MESSAGE_CODES.MODEL_ERROR,
    message: "AI service temporarily unavailable. Please try again later.",
  });
}

// Appends a confirmation request to the model's text unless it already asks for one.
function withConfirmationRequest(modelText) {
  const text = modelText || "";
  return /confirm/i.test(text) ? text : `${text}\n\nVocê confirma a execução?`;
}

/**
 * Server-side guard for write tools. Returns the text to reply with instead of executing, or
 * null to allow. Write tools need a prior exchange (first turn) and an explicit confirmation in
 * the trainer's last message; read-only tools and a single call per turn are always allowed.
 */
function checkEnforcementBlocked(response, conversationHistory, message) {
  const toolCall = response.toolCalls[0];

  if (response.toolCalls.length > 1) {
    return (
      (response.text || "") +
      "\n\nVou executar uma ação por vez. Confirme para prosseguir."
    );
  }

  if (toolCall && READ_ONLY_TOOLS.has(toolCall.name)) return null;

  const confirmed =
    conversationHistory.length >= 2 &&
    lastAssistantAskedForConfirmation(conversationHistory) &&
    isExplicitConfirmation(message);
  if (!confirmed) {
    return withConfirmationRequest(response.text);
  }
  return null;
}

// --- Prompt security helpers ---

export { sanitizeUserMessage };

// --- Main agentic loop (one engine for chat and stream) ---

const EMPTY_RESPONSE_TEXT = "Desculpe, não consegui gerar uma resposta. Tente reformular seu pedido.";
const REFUSAL_RESPONSE_TEXT = "Não consegui ajudar com esse pedido. Tente reformulá-lo.";

// Sleeps for the given number of milliseconds.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Backoff delay for a 1-based attempt number.
function backoffDelayMs(attempt) {
  return AI_RETRY.BASE_DELAY_MS * 2 ** (attempt - 1);
}

// Fails fast with a 503 when the AI provider is not configured, before any write.
function assertAiAvailable() {
  if (isLlmConfigured()) return;
  throw new AppError({
    httpStatus: 503,
    error: AI_ERRORS.UNAVAILABLE,
    messageCode: AI_MESSAGE_CODES.UNAVAILABLE,
    message: "AI assistant is not available",
  });
}

// Builds the error raised when a model reply was cut off by the token limit.
function responseTooLongError() {
  return new AppError({
    httpStatus: 422,
    error: AI_ERRORS.RESPONSE_TOO_LONG,
    messageCode: AI_MESSAGE_CODES.RESPONSE_TOO_LONG,
    message: "The assistant response was too long. Try splitting the request into smaller parts.",
  });
}

// Verifies the student is linked to the trainer, or throws a 404.
async function assertStudentOwned(trainerId, studentId) {
  const link = await prisma.trainerStudent.findUnique({
    where: { trainerId_studentId: { trainerId, studentId } },
    select: { studentId: true },
  });

  if (!link) {
    throw new AppError({
      httpStatus: 404,
      error: "STUDENT_NOT_LINKED",
      messageCode: SubscriptionMessageCode.STUDENT_NOT_LINKED,
      message: "Student is not linked to this trainer",
    });
  }
}

// Yields provider chunks for one model call, via the streaming or the single-shot API.
async function* modelChunks(provider, params, streaming) {
  if (streaming) {
    yield* provider.chatStream(params);
    return;
  }
  yield { type: "complete", response: await provider.chat(params) };
}

// Tells whether a model reply carries nothing usable (no text, no tool call).
function isEmptyModelResponse(response, streamedAny) {
  return (
    response.stopReason === "end_turn" &&
    !response.text &&
    response.toolCalls.length === 0 &&
    !streamedAny
  );
}

/**
 * Runs one model call with the single retry layer: transient provider errors and empty replies
 * are retried with backoff; once text has been streamed a failure is final.
 * Yields text_delta chunks followed by one { type: "result", response }.
 */
async function* callModel(provider, params, { streaming, meter, signal }) {
  for (let attempt = 1; attempt <= AI_RETRY.MAX_ATTEMPTS; attempt++) {
    let streamedAny = false;
    let response = null;

    try {
      for await (const chunk of modelChunks(provider, params, streaming)) {
        if (chunk.type === "text_delta") {
          streamedAny = true;
          yield chunk;
        } else if (chunk.type === "complete") {
          response = meter.track(chunk.response);
        }
      }
    } catch (err) {
      const retryable =
        !signal?.aborted && !streamedAny && attempt < AI_RETRY.MAX_ATTEMPTS && isRetryableLlmError(err);
      if (!retryable) throw err;
      console.warn(
        `[AI] Transient LLM error (status=${err.status}), retrying in ${backoffDelayMs(attempt)}ms (attempt ${attempt}/${AI_RETRY.MAX_ATTEMPTS})`,
      );
      await sleep(backoffDelayMs(attempt));
      continue;
    }

    if (!response) {
      throw Object.assign(new Error("LLM call completed without a final response"), { status: 502 });
    }

    if (isEmptyModelResponse(response, streamedAny) && attempt < AI_RETRY.MAX_ATTEMPTS) {
      console.warn(
        `[AI] Empty LLM response, retrying in ${backoffDelayMs(attempt)}ms (attempt ${attempt}/${AI_RETRY.MAX_ATTEMPTS})`,
      );
      await sleep(backoffDelayMs(attempt));
      continue;
    }

    yield { type: "result", response };
    return;
  }
}

/**
 * Runs a model call and forwards its text deltas as turn events.
 * With tolerateFailure a failed call resolves to { response: null } instead of throwing.
 * Every streamed chunk is also pushed to `sink` so callers can recover partial text.
 */
async function* modelTurn(provider, params, options) {
  const sink = options.sink ?? [];
  let response = null;

  try {
    for await (const chunk of callModel(provider, params, options)) {
      if (chunk.type === "text_delta") {
        sink.push(chunk.content);
        yield { event: "text_delta", data: { content: chunk.content } };
      } else {
        response = chunk.response;
      }
    }
  } catch (err) {
    if (!options.tolerateFailure) throw err;
    console.error("[AI] Follow-up LLM call failed, using deterministic fallback:", err?.message);
    return { response: null, text: sink.join("") };
  }

  return { response, text: sink.join("") || response.text || "" };
}

// Maps a raw model-call failure to the error the turn should raise.
function toTurnError(err, signal) {
  if (err instanceof AppError || err?.aborted || signal?.aborted) return err;
  return buildLlmError(err);
}

/**
 * Extract the student user ID from a tool input, if the tool operated on a student.
 * Tools use either `studentId` or `assigneeId` to reference the student.
 * Returns null for tools that have no student scope.
 */
function resolveToolStudentId(toolInput) {
  const sanitized = sanitizeToolInputIds(toolInput);
  return sanitized.studentId ?? sanitized.assigneeId ?? null;
}

// Finds the assignee of the student-assigned protocol/training/exercise a tool input points at.
async function lookupAssigneeByTarget(trainerId, ids) {
  if (ids.exerciseId) {
    const row = await prisma.exercise.findFirst({
      where: { id: ids.exerciseId, deletedAt: null, training: { trainingProtocol: { trainerId } } },
      select: { training: { select: { trainingProtocol: { select: { assigneeId: true } } } } },
    });
    return row?.training?.trainingProtocol?.assigneeId ?? null;
  }
  if (ids.trainingId) {
    const row = await prisma.training.findFirst({
      where: { id: ids.trainingId, deletedAt: null, trainingProtocol: { trainerId } },
      select: { trainingProtocol: { select: { assigneeId: true } } },
    });
    return row?.trainingProtocol?.assigneeId ?? null;
  }
  if (ids.protocolId) {
    const row = await prisma.trainingProtocol.findFirst({
      where: { id: ids.protocolId, trainerId, deletedAt: null },
      select: { assigneeId: true },
    });
    return row?.assigneeId ?? null;
  }
  return null;
}

/**
 * Resolves the student a tool call acts on: studentId/assigneeId directly, otherwise through the
 * protocol, training or exercise it targets. Templates have no student. A failed lookup is logged
 * and treated as "no student" (the tool still enforces ownership on its own).
 */
async function resolveToolTargetStudentId(trainerId, toolInput) {
  const direct = resolveToolStudentId(toolInput);
  if (direct) return direct;
  try {
    return await lookupAssigneeByTarget(trainerId, sanitizeToolInputIds(toolInput) ?? {});
  } catch (err) {
    console.error("[AI] Could not resolve the student targeted by the tool call:", describeUnexpectedError(err));
    return null;
  }
}

// Loads the latest submitted anamnesis the student answered for a form THIS trainer linked to them.
async function loadStudentAnamnesis(trainerId, studentId) {
  const [latest] = await prisma.anamnesisResponse.findMany({
    where: {
      studentId,
      submittedAt: { not: null },
      anamnesis: { deletedAt: null, studentAnamneses: { some: { studentId, trainerId } } },
    },
    orderBy: { submittedAt: "desc" },
    take: 1,
    select: {
      submittedAt: true,
      answers: { select: { value: true, question: { select: { text: true } } } },
    },
  });
  return latest ?? null;
}

// Runs a context loader, logging and swallowing failures so the turn still works without it.
async function loadOptionalContext(label, loader) {
  try {
    return await loader();
  } catch (err) {
    console.error(`[AI] Could not load ${label} for the student context:`, describeUnexpectedError(err));
    return null;
  }
}

// Loads anamnesis and performance for the student the request is about (ownership already checked).
async function loadStudentFocus(userId, trainerId, studentId) {
  const [anamnesis, performance] = await Promise.all([
    loadOptionalContext("anamnesis", () => loadStudentAnamnesis(trainerId, studentId)),
    loadOptionalContext("performance", () =>
      studentDashboardService.buildAiPerformanceSnapshot(userId, studentId, {
        windowDays: AI_LIMITS.CONTEXT_PERFORMANCE_WINDOW_DAYS,
        includeExerciseProgression: false,
      }),
    ),
  ]);
  return { studentId, anamnesis, performance };
}

// Records a finished turn in the interaction log without ever failing the turn.
function logInteraction(turn, fields) {
  Promise.resolve(
    writeInteractionLog(prisma, {
      trainerId: turn.trainerId,
      conversationId: turn.conversationId,
      userMessage: turn.message,
      model: resolveActiveModelId(),
      usage: turn.meter.usage(),
      latencyMs: Date.now() - turn.startedAt,
      ...fields,
    }),
  ).catch(() => {});
}

// Persists the final assistant text, bumps the conversation and logs the turn.
async function completeTurn(turn, text, toolOutcome = null) {
  await saveAssistantMessage(turn.conversationId, text, []);
  await touchConversation(turn.conversationId, turn.needsTitle ? turn.message : null);

  logInteraction(turn, {
    studentId: toolOutcome ? toolOutcome.studentId : null,
    action: toolOutcome ? toolOutcome.toolCall.name : "chat",
    toolCall: toolOutcome ? toolOutcome.toolCall : null,
    responseText: text,
    status: toolOutcome && !toolOutcome.toolResult.success
      ? AI_INTERACTION_LOG.STATUS_ERROR
      : AI_INTERACTION_LOG.STATUS_SUCCESS,
    errorCode: toolOutcome && !toolOutcome.toolResult.success ? (toolOutcome.toolResult.error ?? null) : null,
  });
}

// Translates the progress text shown while a tool runs.
function toolStatusLabel(toolName, language) {
  return translate("ai.toolStatus", toolName, language, {
    fallbackValue: translate("ai.status", "executing", language),
  });
}

/**
 * Executes the model's tool call, persists the tool turn in order and yields the final text.
 * The final assistant message and the log are written even if the consumer stops early.
 */
async function* runToolCall(turn, { userId, provider, params, response, callOptions }) {
  const toolCall = response.toolCalls[0];
  const isReadOnly = READ_ONLY_TOOLS.has(toolCall.name);
  const toolStudentId = await resolveToolTargetStudentId(turn.trainerId, toolCall.input);

  if (!isReadOnly && toolStudentId && toolStudentId !== turn.studentId) {
    await assertCanUseAi(prisma, turn.trainerId, toolStudentId);
  }

  yield { event: "status", data: { message: `${toolStatusLabel(toolCall.name, turn.language)}...` } };

  const startExec = Date.now();
  const toolResult = await executeTool(userId, toolCall.name, toolCall.input);
  console.info(
    `[AI] Tool ${toolCall.name} done: success=${toolResult.success}, duration=${Date.now() - startExec}ms`,
  );

  if (toolResult.success && !isReadOnly) {
    try {
      await recordAiAction(prisma, turn.trainerId, toolStudentId, toolCall.name);
    } catch (recordErr) {
      console.error("[AI] Failed to record AI action (non-critical):", recordErr.message);
    }
  }

  const actionsExecuted = [{ tool: toolCall.name, success: toolResult.success, data: toolResult.data }];
  const summarizedResult = JSON.stringify(summarizeToolResult(toolResult));

  await saveAssistantMessage(turn.conversationId, response.text || "", actionsExecuted, response.rawContent);
  await saveToolResultMessage(turn.conversationId, [{ toolCallId: toolCall.id, content: summarizedResult }]);

  const deterministicText = () => buildToolResultMessage(toolCall.name, toolResult, turn.history);
  const partialText = [];
  let finalText = null;
  let completed = false;

  const finalize = async () => {
    if (completed) return;
    completed = true;
    await completeTurn(turn, finalText ?? (partialText.join("") || deterministicText()), { toolCall, toolResult, studentId: toolStudentId });
  };

  try {
    if (isReadOnly) {
      const toolResultMessages = provider.buildToolResultMessages(response.rawContent, [
        { toolCallId: toolCall.id, content: summarizedResult },
      ]);
      const followUp = yield* modelTurn(
        provider,
        { ...params, messages: [...params.messages, ...toolResultMessages] },
        { ...callOptions, tolerateFailure: true, sink: partialText },
      );
      finalText = followUp.text || deterministicText();
      if (!followUp.text) yield { event: "text_delta", data: { content: finalText } };
    } else {
      finalText = deterministicText();
      yield { event: "text_delta", data: { content: finalText } };
    }

    await finalize();
    yield {
      event: "done",
      data: { conversationId: turn.conversationId, message: finalText, actionsExecuted },
    };
  } finally {
    await finalize();
  }
}

/**
 * The single turn engine behind processAiChat and processAiChatStream.
 * Order: availability, trainer, student ownership, plan gate, then conversation setup, so a
 * refused turn never writes. Yields status / text_delta events and a final done event.
 */
async function* runTurn(userId, { message, conversationId, studentId = null }, { signal, meter, streaming, language }) {
  assertAiAvailable();
  const trainerId = await resolveTrainerId(userId);
  if (studentId) await assertStudentOwned(trainerId, studentId);
  await assertCanUseAi(prisma, trainerId, studentId ?? null);
  const studentFocus = studentId ? await loadStudentFocus(userId, trainerId, studentId) : null;

  const setup = await setupConversation(userId, { message, conversationId }, trainerId);
  const turn = {
    trainerId,
    studentId,
    message,
    meter,
    conversationId: setup.conversationId,
    needsTitle: setup.needsTitle,
    history: setup.conversationHistory,
    startedAt: Date.now(),
    language,
  };
  meter.setContext({ trainerId, conversationId: turn.conversationId });

  try {
    yield* runModelTurn(userId, turn, setup, studentFocus, { signal, streaming });
  } catch (err) {
    throw withConversationId(err, turn.conversationId);
  }
}

// Attaches the conversation id to a failed turn so the client can retry in the same conversation.
function withConversationId(err, conversationId) {
  if (err instanceof AppError) err.details = { ...err.details, conversationId };
  if (err && typeof err === "object") err.conversationId = conversationId;
  return err;
}

// Runs the model part of a turn once the conversation exists: prompt, model call, tool call, reply.
async function* runModelTurn(userId, turn, setup, studentFocus, { signal, streaming }) {
  const { message, meter } = turn;
  yield { event: "status", data: { message: `${translate("ai.status", "analyzing", turn.language)}...` } };

  const provider = getLlmProvider();
  const params = {
    system: buildSystemPrompt(setup.context, studentFocus),
    tools: TOOLS,
    messages: [
      ...setup.conversationHistory,
      { role: "user", content: wrapUserInput(message) },
    ],
    maxTokens: AI_LIMITS.MAX_TOKENS,
    signal,
  };
  const callOptions = { streaming, meter, signal };

  let first;
  try {
    first = yield* modelTurn(provider, params, callOptions);
  } catch (err) {
    throw toTurnError(err, signal);
  }
  const { response } = first;

  console.info(
    `[AI] LLM response: stopReason=${response.stopReason}, toolCalls=${response.toolCalls.length}, textLength=${first.text.length}`,
  );

  if (response.stopReason === "max_tokens") throw responseTooLongError();

  if (response.stopReason === "tool_use" && response.toolCalls.length > 0) {
    const blockedText = checkEnforcementBlocked(response, setup.conversationHistory, message);
    if (blockedText === null) {
      yield* runToolCall(turn, { userId, provider, params, response, callOptions });
      return;
    }
    await completeTurn(turn, blockedText);
    yield { event: "done", data: { conversationId: turn.conversationId, message: blockedText, actionsExecuted: [] } };
    return;
  }

  const fallbackText = response.stopReason === "refusal" ? REFUSAL_RESPONSE_TEXT : EMPTY_RESPONSE_TEXT;
  const responseText = first.text || fallbackText;
  await completeTurn(turn, responseText);
  yield { event: "done", data: { conversationId: turn.conversationId, message: responseText, actionsExecuted: [] } };
}

// Runs one non-streaming chat turn and records its summed token usage, even when it fails.
export async function processAiChat(userId, args, { signal, language } = {}) {
  const meter = createTurnUsageMeter();
  try {
    let result = null;
    for await (const event of runTurn(userId, args, { signal, meter, streaming: false, language })) {
      if (event.event === "done") result = event.data;
    }
    return result;
  } finally {
    await meter.flush(prisma, { provider: resolveProviderName(), model: resolveActiveModelId() });
  }
}

// Runs one streaming turn and records its summed token usage, even when the client aborts.
export async function* processAiChatStream(userId, args, { signal, language } = {}) {
  const meter = createTurnUsageMeter();
  try {
    yield* runTurn(userId, args, { signal, meter, streaming: true, language });
  } finally {
    await meter.flush(prisma, { provider: resolveProviderName(), model: resolveActiveModelId() });
  }
}

// --- Conversation management ---

export async function listConversations(userId) {
  const trainer = await prisma.trainer.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (!trainer) {
    throw new AppError({
      httpStatus: 404,
      error: AI_ERRORS.CONTEXT_BUILD_FAILED,
      messageCode: AI_MESSAGE_CODES.TRAINER_NOT_FOUND,
      message: "Trainer profile not found",
    });
  }

  return prisma.aiConversation.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    select: { id: true, title: true, createdAt: true, updatedAt: true },
  });
}

export async function getConversation(userId, conversationId) {
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: {
      id: true,
      userId: true,
      title: true,
      createdAt: true,
      updatedAt: true,
      messages: {
        where: { role: { not: 'tool_result' } },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          conversationId: true,
          role: true,
          content: true,
          toolCalls: true,
          createdAt: true,
        },
      },
    },
  });

  if (!conversation || conversation.userId !== userId) {
    throw new AppError({
      httpStatus: 404,
      error: AI_ERRORS.CONVERSATION_NOT_FOUND,
      messageCode: AI_MESSAGE_CODES.CONVERSATION_NOT_FOUND,
      message: "Conversation not found",
    });
  }

  return conversation;
}

export async function deleteConversation(userId, conversationId) {
  const conversation = await prisma.aiConversation.findUnique({
    where: { id: conversationId },
    select: { userId: true },
  });

  if (!conversation || conversation.userId !== userId) {
    throw new AppError({
      httpStatus: 404,
      error: AI_ERRORS.CONVERSATION_NOT_FOUND,
      messageCode: AI_MESSAGE_CODES.CONVERSATION_NOT_FOUND,
      message: "Conversation not found",
    });
  }

  await withDeadlockRetry(() => prisma.$transaction([
    prisma.aiMessage.deleteMany({ where: { conversationId } }),
    prisma.aiConversation.delete({ where: { id: conversationId } }),
  ]));
}

// Export internal functions for testing
export { buildTrainerContext, executeTool, setupConversation, unwrapRefTag, sanitizeToolInputIds };
