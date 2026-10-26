/**
 * AI Interaction Log Service
 *
 * Writes one AiInteractionLog row per iArnold turn (both success and error paths).
 *
 * PRIVACY NOTE: userMessage and responseText may contain student personal data.
 * This service is designed for BETA-ONLY high-fidelity capture. Before any
 * production rollout, enforce a data retention policy (e.g. purge rows older
 * than 90 days via a scheduled job). Do NOT log API keys, secrets, or raw tokens.
 *
 * BEST-EFFORT: all writes are wrapped in try/catch so that a logging failure
 * never breaks the user-facing AI flow.
 *
 * Gate: set AI_INTERACTION_LOG_ENABLED=false in environment to disable entirely.
 * Default is ON (beta mode).
 */

import { AI_INTERACTION_LOG } from '../constants/ai.js'

/**
 * Returns true when the feature flag is enabled.
 * Default ON — explicitly set AI_INTERACTION_LOG_ENABLED=false to disable.
 */
export function isInteractionLogEnabled() {
  const flag = process.env[AI_INTERACTION_LOG.ENV_FLAG]
  // Any value other than the string "false" (case-insensitive) is treated as enabled.
  return flag === undefined || flag.toLowerCase() !== 'false'
}

/**
 * Truncate a string to MAX_TEXT_LENGTH to prevent unbounded DB rows.
 * Returns null for null/undefined input.
 *
 * @param {string | null | undefined} text
 * @returns {string | null}
 */
function truncate(text) {
  if (text == null) return null
  return text.length > AI_INTERACTION_LOG.MAX_TEXT_LENGTH
    ? text.slice(0, AI_INTERACTION_LOG.MAX_TEXT_LENGTH)
    : text
}

/**
 * Build a compact toolsUsed summary array from the tool call executed in this turn.
 * We capture name + a short args summary (NOT full payloads) to keep rows small
 * and avoid echoing PII-bearing fields like assigneeId or notes verbatim.
 *
 * @param {{ name: string, input: object } | null} toolCall
 * @returns {Array<{ name: string, argsSummary: string }> | null}
 */
function buildToolsUsedSummary(toolCall) {
  if (!toolCall) return null

  // Summarise the input: only emit non-PII scalar fields and array lengths.
  // Free-text fields (name, notes, description, assigneeId) are omitted or replaced.
  const PII_KEYS = new Set(['name', 'notes', 'description', 'assigneeId', 'studentId', 'email'])
  const summaryParts = []
  for (const [key, value] of Object.entries(toolCall.input ?? {})) {
    if (PII_KEYS.has(key)) {
      // omit — contains PII or personally identifiable reference
      continue
    } else if (Array.isArray(value)) {
      summaryParts.push(`${key}[${value.length}]`)
    } else if (value !== null && typeof value === 'object') {
      summaryParts.push(`${key}:{...}`)
    } else {
      summaryParts.push(`${key}=${value}`)
    }
  }

  return [
    {
      name: toolCall.name,
      argsSummary: summaryParts.join(', '),
    },
  ]
}

/**
 * Extract token counts from the normalized LLM response object.
 * AnthropicProvider attaches usage via the raw response (logged in _logUsage),
 * but does not forward it through the normalized facade. We attach it ourselves
 * by reading the usage object off the raw Anthropic/Gemini response when available.
 *
 * Callers pass a `usage` object that may come from different shapes:
 *   Anthropic: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
 *   Gemini:    { promptTokenCount, candidatesTokenCount }
 *
 * @param {object | null | undefined} usage
 * @returns {{ inputTokens: number | null, outputTokens: number | null }}
 */
export function extractTokenCounts(usage) {
  if (!usage || typeof usage !== 'object') {
    return { inputTokens: null, outputTokens: null }
  }
  if ('inputTokens' in usage || 'outputTokens' in usage) {
    return {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    }
  }
  // Anthropic shape
  if ('input_tokens' in usage || 'output_tokens' in usage) {
    return {
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
    }
  }
  // Gemini shape
  if ('promptTokenCount' in usage || 'candidatesTokenCount' in usage) {
    return {
      inputTokens: usage.promptTokenCount ?? null,
      outputTokens: usage.candidatesTokenCount ?? null,
    }
  }
  return { inputTokens: null, outputTokens: null }
}

/**
 * Write one AiInteractionLog row. Best-effort — never throws.
 *
 * @param {object} prisma - Prisma client (injected, not a singleton import)
 * @param {object} params
 * @param {string}        params.trainerId      - Trainer's UUID (from context)
 * @param {string | null} params.studentId      - Student UUID when tool had student scope
 * @param {string | null} params.conversationId - Conversation UUID
 * @param {string}        params.action         - Action label (same taxonomy as AiUsageEvent)
 * @param {string | null} params.userMessage    - The trainer's raw message (PII: truncated)
 * @param {{ name: string, input: object } | null} params.toolCall - Tool called this turn
 * @param {string | null} params.responseText   - Final assistant text (PII: truncated)
 * @param {string | null} params.model          - Model identifier (e.g. "claude-sonnet-4-6")
 * @param {object | null} params.usage          - Raw usage object from provider response
 * @param {number | null} params.latencyMs      - End-to-end latency in milliseconds
 * @param {'success' | 'error'} params.status   - Outcome
 * @param {string | null} params.errorCode      - AppError.error code on failure
 */
export async function writeInteractionLog(prisma, params) {
  if (!isInteractionLogEnabled()) return

  const {
    trainerId,
    studentId = null,
    conversationId = null,
    action,
    userMessage = null,
    toolCall = null,
    responseText = null,
    model = null,
    usage = null,
    latencyMs = null,
    status,
    errorCode = null,
  } = params

  const { inputTokens, outputTokens } = extractTokenCounts(usage)

  try {
    await prisma.aiInteractionLog.create({
      data: {
        trainerId,
        studentId: studentId ?? null,
        conversationId: conversationId ?? null,
        action,
        // PRIVACY: truncated — may contain student PII. Beta-only capture.
        userMessage: truncate(userMessage),
        toolsUsed: buildToolsUsedSummary(toolCall),
        // PRIVACY: truncated — may contain student PII. Beta-only capture.
        responseText: truncate(responseText),
        model: model ?? null,
        inputTokens: inputTokens ?? null,
        outputTokens: outputTokens ?? null,
        latencyMs: latencyMs ?? null,
        status,
        errorCode: errorCode ?? null,
      },
    })
  } catch (err) {
    // Logging must never break the user flow — warn and continue.
    console.warn('[AI][interaction-log] Failed to write interaction log (non-critical):', err?.message)
  }
}
