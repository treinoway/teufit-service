import { describe, it, expect, vi, afterEach } from 'vitest'
import { createAiTracer, createNoopAiTracer } from '../../src/observability/ai-tracer.js'
import {
  tracerConfig,
  createMemoryExporter,
  createLoggerDouble,
  readAttr,
  readAttrAnywhere,
  rootSpanOf,
  spansOfType,
  dumpAttributes,
  runSimpleTurn,
} from '../helpers/ai-tracing-fixtures.js'

const FOCUS_SECRET = 'Ana tem hernia de disco'
const FOCUS_TEXT = `<dados_do_aluno_em_foco>${FOCUS_SECRET}</dados_do_aluno_em_foco>`
const EMAIL = 'ana.lima@example.com'
const USAGE = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 2 }
const LANGFUSE_USAGE = { input: 10, output: 5, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 }
const SHUTDOWN_BOUND_MS = 6500
const HUNG_EXPORT_TEST_TIMEOUT_MS = 12000

const GENERATION_INPUT = { system: [{ type: 'text', text: FOCUS_TEXT }], messages: [{ role: 'user', content: `meu email ${EMAIL}` }] }

let activeTracer = null

// Runs a turn that carries the student focus block and an e-mail in input and output.
function runSensitiveTurn(tracer) {
  const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: `oi ${EMAIL}`, promptVersion: 'v' })
  turn.generation({ attempt: 1, model: 'm', input: GENERATION_INPUT, modelParameters: {} })
    .end({ output: [{ type: 'text', text: `${FOCUS_SECRET} ${EMAIL}` }], usage: null, stopReason: 'end_turn' })
  turn.end({ output: `${FOCUS_SECRET} ${EMAIL}` })
}

// Creates a tracer wired to a memory exporter and remembers it for cleanup.
function setup(configOverrides = {}, extra = {}) {
  const exporter = createMemoryExporter()
  const logger = createLoggerDouble()
  vi.spyOn(logger, 'warn')
  const tracer = createAiTracer({ config: tracerConfig(configOverrides), exporter, logger })
  activeTracer = tracer
  return { tracer, exporter, logger, ...extra }
}

// Shuts the tracer down (flushing) and returns what was exported.
async function exportedSpans(tracer, exporter) {
  await tracer.shutdown()
  return exporter.spans
}

afterEach(async () => {
  await activeTracer?.shutdown().catch(() => {})
  activeTracer = null
})

describe('createAiTracer when disabled (AC 3)', () => {
  it('should return a tracer whose turn handles never throw and export nothing', async () => {
    const exporter = createMemoryExporter()
    const tracer = createAiTracer({ config: tracerConfig({ enabled: false }), exporter })

    runSimpleTurn(tracer)
    await tracer.shutdown()

    expect(exporter.spans).toEqual([])
  })

  it('should expose the full facade on the no-op tracer', () => {
    const turn = createNoopAiTracer().startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })
    const gen = turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} })
    const tool = turn.tool({ name: 't', input: {} })

    expect([
      typeof turn.setContext, typeof turn.event, typeof turn.end, typeof turn.fail, typeof turn.abort,
      typeof gen.firstToken, typeof gen.end, typeof gen.fail, typeof tool.end,
    ]).toEqual(Array(9).fill('function'))
  })
})

describe('turn without tools (AC 4)', () => {
  it('should export one trace with a root and one generation', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer)
    const spans = await exportedSpans(tracer, exporter)

    expect({
      traceIds: new Set(spans.map((span) => span.spanContext().traceId)).size,
      generations: spansOfType(spans, 'generation').length,
    }).toEqual({ traceIds: 1, generations: 1 })
  })

  it('should carry user, session, environment and release on the exported spans', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer)
    const spans = await exportedSpans(tracer, exporter)

    expect({
      userId: readAttrAnywhere(spans, 'user.id'),
      sessionId: readAttrAnywhere(spans, 'session.id'),
      environment: readAttrAnywhere(spans, 'langfuse.environment'),
      release: readAttrAnywhere(spans, 'langfuse.release'),
    }).toEqual({ userId: 'trainer-1', sessionId: 'conv-1', environment: 'staging', release: 'sha-123' })
  })

  it('should tag a chat turn with iarnold and chat', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer, { kind: 'chat' })
    const spans = await exportedSpans(tracer, exporter)

    expect(readAttrAnywhere(spans, 'langfuse.trace.tags')).toEqual(expect.arrayContaining(['iarnold', 'chat']))
  })

  it('should tag a stream turn with iarnold and stream', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer, { kind: 'stream' })
    const spans = await exportedSpans(tracer, exporter)

    expect(readAttrAnywhere(spans, 'langfuse.trace.tags')).toEqual(expect.arrayContaining(['iarnold', 'stream']))
  })

  it('should put the request id and prompt version in the metadata', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer)
    const spans = await exportedSpans(tracer, exporter)

    expect(dumpAttributes(spans)).toContain('req-1')
    expect(dumpAttributes(spans)).toContain('abc123')
  })

  it('should record the user message as root input and the final text as root output', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer, { input: 'Crie o protocolo A', output: 'Protocolo criado' })
    const root = rootSpanOf(await exportedSpans(tracer, exporter))

    expect({
      input: readAttr(root, 'langfuse.observation.input'),
      output: readAttr(root, 'langfuse.observation.output'),
    }).toEqual({ input: 'Crie o protocolo A', output: 'Protocolo criado' })
  })

  it('should record model, input and the four usage keys on the generation', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'oi', promptVersion: 'v' })
    const gen = turn.generation({ attempt: 1, model: 'claude-test', input: { system: 'sys', messages: [] }, modelParameters: { maxTokens: 8000 } })

    gen.end({ output: [{ type: 'text', text: 'ola' }], usage: USAGE, stopReason: 'end_turn' })
    turn.end({ output: 'ola' })
    const [generation] = spansOfType(await exportedSpans(tracer, exporter), 'generation')

    expect({
      model: readAttr(generation, 'langfuse.observation.model.name'),
      usage: readAttr(generation, 'langfuse.observation.usage_details'),
      input: readAttr(generation, 'langfuse.observation.input'),
    }).toEqual({ model: 'claude-test', usage: LANGFUSE_USAGE, input: { system: 'sys', messages: [] } })
  })

  it('should record the stop reason on the generation', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer)
    const [generation] = spansOfType(await exportedSpans(tracer, exporter), 'generation')

    expect(dumpAttributes([generation])).toContain('end_turn')
  })

  it('should record the time to first token only when firstToken was called', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'stream', requestId: 'r', input: 'oi', promptVersion: 'v' })
    const streamed = turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} })
    streamed.firstToken()
    streamed.end({ output: [], usage: USAGE, stopReason: 'end_turn' })
    const silent = turn.generation({ attempt: 2, model: 'm', input: {}, modelParameters: {} })
    silent.end({ output: [], usage: USAGE, stopReason: 'end_turn' })
    turn.end({ output: 'x' })

    const generations = spansOfType(await exportedSpans(tracer, exporter), 'generation')

    expect(generations.map((g) => g.attributes['langfuse.observation.completion_start_time'] !== undefined)).toEqual([true, false])
  })

  it('should not record a failure level on a successful turn', async () => {
    const { tracer, exporter } = setup()

    runSimpleTurn(tracer)
    const spans = await exportedSpans(tracer, exporter)

    expect(spans.some((span) => readAttr(span, 'langfuse.observation.level') === 'ERROR')).toBe(false)
  })
})

describe('turn with tools (AC 5, 6)', () => {
  it('should export generation, tool, generation in order under the same root', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'desempenho', promptVersion: 'v' })
    turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} }).end({ output: [], usage: USAGE, stopReason: 'tool_use' })
    turn.tool({ name: 'get_student_performance', input: { studentId: 's1' } }).end({ success: true, output: { sessions: 2 } })
    turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} }).end({ output: [], usage: USAGE, stopReason: 'end_turn' })
    turn.end({ output: 'resumo' })

    const spans = await exportedSpans(tracer, exporter)
    const root = rootSpanOf(spans)
    const children = spans.filter((span) => span !== root)
      .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])

    expect(children.map((span) => readAttr(span, 'langfuse.observation.type'))).toEqual(['generation', 'tool', 'generation'])
    expect(children.every((span) => span.parentSpanContext.spanId === root.spanContext().spanId)).toBe(true)
  })

  it('should record tool name, input and output', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.tool({ name: 'get_student_performance', input: { studentId: 's1' } }).end({ success: true, output: { sessions: 2 } })
    turn.end({ output: 'ok' })
    const [tool] = spansOfType(await exportedSpans(tracer, exporter), 'tool')

    expect({
      name: tool.name,
      input: readAttr(tool, 'langfuse.observation.input'),
      output: readAttr(tool, 'langfuse.observation.output'),
    }).toEqual({ name: 'get_student_performance', input: { studentId: 's1' }, output: { sessions: 2 } })
  })

  it('should end a failed tool at level ERROR', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.tool({ name: 'update_protocol', input: {} }).end({ success: false, output: { error: 'nope' } })
    turn.end({ output: 'falhou' })
    const [tool] = spansOfType(await exportedSpans(tracer, exporter), 'tool')

    expect(readAttr(tool, 'langfuse.observation.level')).toBe('ERROR')
  })

  it('should end a successful tool without level ERROR', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.tool({ name: 'update_protocol', input: {} }).end({ success: true, output: {} })
    turn.end({ output: 'ok' })
    const [tool] = spansOfType(await exportedSpans(tracer, exporter), 'tool')

    expect(readAttr(tool, 'langfuse.observation.level')).not.toBe('ERROR')
  })

  it('should export a guard-blocked event with the tool name and no tool span', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} }).end({ output: [], usage: USAGE, stopReason: 'tool_use' })
    turn.event('guard-blocked', { tool: 'import_from_template' })
    turn.end({ output: 'Confirma?' })
    const spans = await exportedSpans(tracer, exporter)
    const [event] = spansOfType(spans, 'event')

    expect(event.name).toBe('guard-blocked')
    expect(dumpAttributes([event])).toContain('import_from_template')
    expect(spansOfType(spans, 'tool')).toEqual([])
  })
})

describe('retries (AC 7)', () => {
  it('should export each attempt as its own generation, the failed one at ERROR with the status', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })
    const first = turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} })
    first.fail(Object.assign(new Error('overloaded'), { status: 529 }))
    const second = turn.generation({ attempt: 2, model: 'm', input: {}, modelParameters: {} })
    second.end({ output: [], usage: USAGE, stopReason: 'end_turn' })
    turn.end({ output: 'ok' })

    const [failed, succeeded] = spansOfType(await exportedSpans(tracer, exporter), 'generation')

    expect(readAttr(failed, 'langfuse.observation.level')).toBe('ERROR')
    expect(readAttr(failed, 'langfuse.observation.status_message')).toContain('529')
    expect(readAttr(succeeded, 'langfuse.observation.level')).not.toBe('ERROR')
  })
})

describe('failed and aborted turns (AC 8)', () => {
  it('should end a failed turn at level ERROR with a status message and still export it', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.fail(Object.assign(new Error('provider timeout'), { status: 504 }))
    const root = rootSpanOf(await exportedSpans(tracer, exporter))

    expect(readAttr(root, 'langfuse.observation.level')).toBe('ERROR')
    expect(readAttr(root, 'langfuse.observation.status_message')).toContain('provider timeout')
  })

  it('should end an aborted turn at level WARNING with the aborted tag', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'stream', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.abort()
    const spans = await exportedSpans(tracer, exporter)

    expect(readAttr(rootSpanOf(spans), 'langfuse.observation.level')).toBe('WARNING')
    expect(readAttrAnywhere(spans, 'langfuse.trace.tags')).toEqual(expect.arrayContaining(['aborted']))
  })

  it('should only honour the first of end, fail and abort', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.end({ output: 'pronto' })
    turn.fail(new Error('late failure'))
    turn.abort()
    const spans = await exportedSpans(tracer, exporter)

    expect(spans).toHaveLength(1)
    expect(readAttr(spans[0], 'langfuse.observation.level')).not.toBe('ERROR')
    expect(readAttr(spans[0], 'langfuse.observation.output')).toBe('pronto')
  })
})

describe('fault isolation (AC 9)', () => {
  it('should not throw when the exporter throws', async () => {
    const { tracer, exporter } = setup()
    exporter.export = () => {
      throw new Error('exporter down')
    }

    expect(() => runSimpleTurn(tracer)).not.toThrow()
    await expect(tracer.shutdown()).resolves.not.toThrow()
  })

  it('should not throw and should warn once when a generation receives hostile usage', () => {
    const { tracer, logger } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })
    const gen = turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} })
    const hostileUsage = new Proxy({}, {
      get() {
        throw new Error('usage exploded')
      },
    })

    expect(() => gen.end({ output: [], usage: hostileUsage, stopReason: 'end_turn' })).not.toThrow()
    expect(logger.warn).toHaveBeenCalledTimes(1)
  })

  it('should keep every later call safe after startTurn received hostile input', () => {
    const { tracer } = setup()
    const hostileInput = new Proxy({}, {
      get() {
        throw new Error('input exploded')
      },
      ownKeys() {
        throw new Error('input exploded')
      },
    })

    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: hostileInput, promptVersion: 'v' })

    expect(() => {
      turn.setContext({ trainerId: 't', conversationId: 'c' })
      turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} }).end({ output: [], usage: null, stopReason: 'end_turn' })
      turn.end({ output: 'ok' })
    }).not.toThrow()
  })
})

describe('content mode (AC 10)', () => {
  it('should redact the student focus block and e-mail addresses in masked mode', async () => {
    const { tracer, exporter } = setup({ contentMode: 'masked' })

    runSensitiveTurn(tracer)
    const dump = dumpAttributes(await exportedSpans(tracer, exporter))

    expect(dump).not.toContain(EMAIL)
    expect(dump).not.toContain('hernia de disco')
    expect(dump).toContain('[redacted: student focus]')
  })

  it('should export content as is in full mode', async () => {
    const { tracer, exporter } = setup({ contentMode: 'full' })

    runSensitiveTurn(tracer)
    const dump = dumpAttributes(await exportedSpans(tracer, exporter))

    expect(dump).toContain(EMAIL)
    expect(dump).toContain('hernia de disco')
  })

  it('should export no input or output in off mode', async () => {
    const { tracer, exporter } = setup({ contentMode: 'off' })

    runSensitiveTurn(tracer)
    const spans = await exportedSpans(tracer, exporter)
    const contentKeys = spans.flatMap((span) => Object.keys(span.attributes))
      .filter((key) => /\.(input|output)$/.test(key))

    expect(contentKeys).toEqual([])
    expect(dumpAttributes(spans)).not.toContain(EMAIL)
  })

  it('should keep only opaque ids in the trace metadata', async () => {
    const { tracer, exporter } = setup({ contentMode: 'full' })
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.setContext({ trainerId: 'trainer-1', conversationId: 'conv-1', studentId: 'student-1', studentName: 'Ana Lima', email: EMAIL })
    turn.end({ output: 'ok' })
    const dump = dumpAttributes(await exportedSpans(tracer, exporter))

    expect(dump).toContain('student-1')
    expect(dump).not.toContain('Ana Lima')
    expect(dump).not.toContain(EMAIL)
  })
})

describe('shutdown (AC 12)', () => {
  it('should flush spans that were still pending', async () => {
    const { tracer, exporter } = setup({ flushAt: 100, flushIntervalSeconds: 60 })

    runSimpleTurn(tracer)
    await tracer.shutdown()

    expect(exporter.spans.length).toBeGreaterThan(0)
  })

  it('should resolve within the bound even when the export hangs', async () => {
    const { tracer, exporter } = setup()
    exporter.export = () => {}
    runSimpleTurn(tracer)
    const startedAt = Date.now()

    await tracer.shutdown()

    expect(Date.now() - startedAt).toBeLessThan(SHUTDOWN_BOUND_MS)
  }, HUNG_EXPORT_TEST_TIMEOUT_MS)
})
