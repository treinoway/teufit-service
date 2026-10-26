import { getBillingMonth } from '../constants/platform-plan.js'

const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

// Creates a summing accumulator for the normalized usage of several LLM calls.
export function createUsageAccumulator() {
  const sums = Object.fromEntries(USAGE_FIELDS.map((field) => [field, 0]))
  let seen = false

  return {
    add(usage) {
      if (!usage) return
      seen = true
      for (const field of USAGE_FIELDS) sums[field] += usage[field] ?? 0
    },
    hasUsage: () => seen,
    totals: () => ({ ...sums }),
  }
}

// Writes one AiTokenUsage row for a finished turn; never throws.
export async function recordTokenUsage(
  prisma,
  { trainerId, studentId, conversationId, provider, model, usage, llmCalls },
) {
  try {
    await prisma.aiTokenUsage.create({
      data: {
        trainerId,
        studentId: studentId ?? null,
        conversationId: conversationId ?? null,
        provider,
        model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cacheReadTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        llmCalls,
        billingMonth: getBillingMonth(),
      },
    })
  } catch (err) {
    console.error('[AI] Failed to record token usage (non-critical):', err.message)
  }
}

// Creates a per-turn meter that sums usage across every LLM call and flushes one row.
export function createTurnUsageMeter() {
  const accumulator = createUsageAccumulator()
  let llmCalls = 0
  let context = null

  return {
    setContext(next) {
      context = next
    },
    track(response) {
      llmCalls += 1
      accumulator.add(response?.usage)
      return response
    },
    usage: () => (accumulator.hasUsage() ? accumulator.totals() : null),
    async flush(prisma, { provider, model }) {
      if (!context || !accumulator.hasUsage()) return
      await recordTokenUsage(prisma, {
        ...context,
        provider,
        model,
        usage: accumulator.totals(),
        llmCalls,
      })
    },
  }
}
