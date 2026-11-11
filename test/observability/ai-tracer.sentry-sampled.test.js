import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Sentry from '@sentry/node'
import { createAiTracer } from '../../src/observability/ai-tracer.js'
import { tracerConfig, createMemoryExporter } from '../helpers/ai-tracing-fixtures.js'

const PROMPT_MARKER = 'segredo-do-prompt-67890'
const SENTRY_FLUSH_TIMEOUT_MS = 2000
const LANGFUSE_ATTRIBUTE_PREFIX = 'langfuse.'
const transactions = []

// Runs a full turn inside a sampled Sentry request span, with a Sentry child span started inside the tool.
async function runTurnInsideSampledSentrySpan(tracer) {
  await Sentry.startSpan({ name: 'POST /trainer/ai/chat', op: 'http.server' }, async () => {
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'req-1', input: PROMPT_MARKER, promptVersion: 'v1' })
    turn.generation({ attempt: 1, model: 'm', input: { system: PROMPT_MARKER }, modelParameters: {} })
      .end({ output: [{ type: 'text', text: PROMPT_MARKER }], usage: null, stopReason: 'end_turn' })
    const tool = turn.tool({ name: 'get_student_performance', input: {} })
    await Sentry.startSpan({ name: 'pg-query-inside-tool' }, async () => {})
    tool.end({ success: true, output: {} })
    turn.end({ output: PROMPT_MARKER })
  })
}

beforeAll(() => {
  Sentry.init({
    dsn: 'https://abc@o1.ingest.invalid/1',
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => {
        for (const item of envelope[1]) {
          if (item[0].type === 'transaction') transactions.push(item[1])
        }
        return {}
      },
      flush: async () => true,
    }),
  })
})

afterAll(async () => {
  await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS)
})

describe('Langfuse tracing next to a sampled Sentry request span (AC 11)', () => {
  it('should export the Langfuse trace and keep Sentry child spans in the Sentry transaction only', async () => {
    const exporter = createMemoryExporter()
    const tracer = createAiTracer({ config: tracerConfig(), exporter })

    await runTurnInsideSampledSentrySpan(tracer)
    await tracer.shutdown()
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS)

    expect(exporter.spans.length).toBeGreaterThan(0)
    expect(transactions).toHaveLength(1)
    expect(transactions[0].spans.map((span) => span.description)).toContain('pg-query-inside-tool')
  })

  it('should put no Langfuse span and no prompt text in the Sentry transaction', async () => {
    const exporter = createMemoryExporter()
    const tracer = createAiTracer({ config: tracerConfig(), exporter })
    transactions.length = 0

    await runTurnInsideSampledSentrySpan(tracer)
    await tracer.shutdown()
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS)

    const sentrySpanIds = new Set(transactions.flatMap((t) => (t.spans ?? []).map((span) => span.span_id)))
    const langfuseSpanIds = exporter.spans.map((span) => span.spanContext().spanId)
    const sentryDump = JSON.stringify(transactions)
    expect(langfuseSpanIds.some((id) => sentrySpanIds.has(id))).toBe(false)
    expect(sentryDump).not.toContain(PROMPT_MARKER)
    expect(sentryDump).not.toContain(LANGFUSE_ATTRIBUTE_PREFIX)
  })
})
