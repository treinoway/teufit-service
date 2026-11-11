import { describe, it, expect, afterEach } from 'vitest'
import { createAiTracer } from '../../src/observability/ai-tracer.js'
import { createTurnRedactor, redactTrainerRoster } from '../../src/observability/ai-trace-mask.js'
import { buildDynamicContext } from '../../src/services/ai-prompt.js'
import { tracerConfig, createMemoryExporter, readAttr, rootSpanOf, dumpAttributes } from '../helpers/ai-tracing-fixtures.js'

const EMAIL = 'ana.lima@example.com'
const FOCUS_TEXT = 'Ana tem hernia de disco'
const REF = 'student-uuid-1'
const MAX_QUEUE = 200

let activeTracer = null

// Creates a tracer on a memory exporter and remembers it for cleanup.
function setup(overrides = {}) {
  const exporter = createMemoryExporter()
  activeTracer = createAiTracer({ config: tracerConfig(overrides), exporter })
  return { tracer: activeTracer, exporter }
}

// Builds a Prisma-like error whose message embeds personal data.
function prismaLikeError() {
  return Object.assign(new Error(`Invalid invocation: email ${EMAIL} <dados_do_aluno_em_foco>${FOCUS_TEXT}</dados_do_aluno_em_foco>`), {
    name: 'PrismaClientKnownRequestError',
    code: 'P2002',
  })
}

afterEach(async () => {
  await activeTracer?.shutdown().catch(() => {})
  activeTracer = null
})

describe('error status messages (review 2)', () => {
  it.each(['masked', 'off'])('should not export the raw error message in %s mode', async (contentMode) => {
    const { tracer, exporter } = setup({ contentMode })
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })
    turn.generation({ attempt: 1, model: 'm', input: {}, modelParameters: {} }).fail(prismaLikeError())
    turn.fail(prismaLikeError())
    await tracer.shutdown()

    const dump = dumpAttributes(exporter.spans)
    expect(dump).not.toContain(EMAIL)
    expect(dump).not.toContain(FOCUS_TEXT)
    expect(dump).toContain('P2002')
  })

  it('should include only name, codes and AppError codes in masked mode', async () => {
    const { tracer, exporter } = setup({ contentMode: 'masked' })
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })
    turn.fail(Object.assign(new Error('secret text'), { name: 'AppError', httpStatus: 503, error: 'AI_SERVICE_ERROR', messageCode: 'ai.unavailable' }))
    await tracer.shutdown()

    expect(readAttr(rootSpanOf(exporter.spans), 'langfuse.observation.status_message')).toBe('AppError AI_SERVICE_ERROR ai.unavailable')
  })
})

describe('client refusals (review 6)', () => {
  it('should end a 4xx failure at WARNING', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.fail(Object.assign(new Error('plan'), { httpStatus: 403, messageCode: 'plan.limit' }))
    await tracer.shutdown()

    expect(readAttr(rootSpanOf(exporter.spans), 'langfuse.observation.level')).toBe('WARNING')
  })

  it('should keep a 5xx failure at ERROR', async () => {
    const { tracer, exporter } = setup()
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'x', promptVersion: 'v' })

    turn.fail(Object.assign(new Error('down'), { httpStatus: 503 }))
    await tracer.shutdown()

    expect(readAttr(rootSpanOf(exporter.spans), 'langfuse.observation.level')).toBe('ERROR')
  })
})

describe('trainer roster redaction (review 3)', () => {
  const context = {
    students: [{ student: { id: REF, firstName: 'Maria', lastName: 'Souza' } }],
    protocolTemplates: [],
    trainingTemplates: [],
    exerciseTemplates: [],
    activeProtocols: [{ id: 'p1', name: 'Protocolo A', assigneeId: REF, assignee: { firstName: 'Maria', lastName: 'Souza' }, trainings: [] }],
  }

  it('should redact roster and assignee names but keep the REF ids', () => {
    const redacted = redactTrainerRoster(buildDynamicContext(context))

    expect(redacted).not.toContain('Maria')
    expect(redacted).toContain(`[REF:${REF}]`)
    expect(redacted).toContain('[ASSIGNEE_REF:')
  })

  it('should redact the whole block when a roster line is not recognised', () => {
    const redacted = redactTrainerRoster('<dados_do_treinador>\nAlunos ativos:\nJoao Silva sem formato\n</dados_do_treinador>')

    expect(redacted).toBe('[redacted: trainer data]')
  })

  it('should redact the whole block when the roster header is missing', () => {
    expect(redactTrainerRoster('<dados_do_treinador>Joao</dados_do_treinador>')).toBe('[redacted: trainer data]')
  })

  it('should export no student name from a masked generation input', async () => {
    const { tracer, exporter } = setup({ contentMode: 'masked' })
    const turn = tracer.startTurn({ kind: 'chat', requestId: 'r', input: 'oi', promptVersion: 'v' })

    turn.generation({ attempt: 1, model: 'm', input: { system: [{ type: 'text', text: buildDynamicContext(context) }], messages: [] }, modelParameters: {} })
      .end({ output: [], usage: null, stopReason: 'end_turn' })
    turn.end({ output: 'ok' })
    await tracer.shutdown()

    expect(dumpAttributes(exporter.spans)).not.toContain('Maria')
  })
})

describe('createTurnRedactor secrets (review 5)', () => {
  it('should still redact learned focus text after the same block is seen twice', () => {
    const redact = createTurnRedactor()
    const block = `<dados_do_aluno_em_foco>${FOCUS_TEXT}</dados_do_aluno_em_foco>`
    redact(block)
    redact(block)

    expect(redact(`o aluno: ${FOCUS_TEXT}`)).toBe('o aluno: [redacted: student focus]')
  })
})

describe('queue bound (review 4)', () => {
  it('should restore OTEL_BSP_MAX_QUEUE_SIZE after building the tracer', () => {
    const before = process.env.OTEL_BSP_MAX_QUEUE_SIZE

    setup({ maxQueueSize: MAX_QUEUE })

    expect(process.env.OTEL_BSP_MAX_QUEUE_SIZE).toBe(before)
  })
})
