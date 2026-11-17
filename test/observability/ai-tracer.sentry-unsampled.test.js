import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as Sentry from '@sentry/node'
import { createAiTracer } from '../../src/observability/ai-tracer.js'
import { tracerConfig, createMemoryExporter, dumpAttributes, rootSpanOf, spansOfType } from '../helpers/ai-tracing-fixtures.js'

const PROMPT_MARKER = 'segredo-do-prompt-12345'
const SENTRY_FLUSH_TIMEOUT_MS = 2000
const envelopePayloads = []

// Runs a full turn that carries the marker text, inside an active (unsampled) Sentry request span.
async function runTurnInsideSentrySpan(tracer) {
  await Sentry.startSpan({ name: 'POST /trainer/ai/chat', op: 'http.server' }, async () => {
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'req-1', input: PROMPT_MARKER, promptVersion: 'v1' })
    turn.setContext({ trainerId: 'trainer-1', conversationId: 'conv-1' })
    const gen = turn.generation({ attempt: 1, model: 'm', input: { system: PROMPT_MARKER, messages: [] }, modelParameters: {} })
    gen.end({ output: [{ type: 'text', text: PROMPT_MARKER }], usage: null, stopReason: 'end_turn' })
    turn.tool({ name: 'get_student_performance', input: {} }).end({ success: true, output: {} })
    turn.end({ output: PROMPT_MARKER })
  })
}

beforeAll(() => {
  Sentry.init({
    dsn: 'https://abc@o1.ingest.invalid/1',
    tracesSampleRate: 0,
    transport: () => ({
      send: async (envelope) => {
        envelopePayloads.push(JSON.stringify(envelope[1]))
        return {}
      },
      flush: async () => true,
    }),
  })
})

afterAll(async () => {
  await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS)
})

describe('Langfuse tracing next to an unsampled Sentry request span (AC 11)', () => {
  it('should still export the Langfuse trace', async () => {
    const exporter = createMemoryExporter()
    const tracer = createAiTracer({ config: tracerConfig(), exporter })

    await runTurnInsideSentrySpan(tracer)
    await tracer.shutdown()

    expect(rootSpanOf(exporter.spans)).toBeDefined()
    expect(spansOfType(exporter.spans, 'generation')).toHaveLength(1)
    expect(spansOfType(exporter.spans, 'tool')).toHaveLength(1)
  })

  it('should give the Langfuse trace its own trace id, separate from the Sentry request', async () => {
    const exporter = createMemoryExporter()
    const tracer = createAiTracer({ config: tracerConfig(), exporter })
    let sentryTraceId = null

    await Sentry.startSpan({ name: 'POST /chat', op: 'http.server' }, async (span) => {
      sentryTraceId = span.spanContext().traceId
      const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'oi', promptVersion: 'v' })
      turn.end({ output: 'ok' })
    })
    await tracer.shutdown()

    expect(exporter.spans.every((span) => span.spanContext().traceId !== sentryTraceId)).toBe(true)
  })

  it('should leak no prompt content to Sentry', async () => {
    const tracer = createAiTracer({ config: tracerConfig(), exporter: createMemoryExporter() })

    await runTurnInsideSentrySpan(tracer)
    await tracer.shutdown()
    await Sentry.flush(SENTRY_FLUSH_TIMEOUT_MS)

    expect(envelopePayloads.join('')).not.toContain(PROMPT_MARKER)
  })

  it('should export no span when tracing is disabled, even under an active Sentry span', async () => {
    const exporter = createMemoryExporter()
    const tracer = createAiTracer({ config: tracerConfig({ enabled: false }), exporter })

    await runTurnInsideSentrySpan(tracer)
    await tracer.shutdown()

    expect(dumpAttributes(exporter.spans)).toBe('[]')
  })
})
