import { context, trace } from '@opentelemetry/api'
import { AlwaysOnSampler } from '@opentelemetry/sdk-trace-base'
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import { LangfuseSpanProcessor } from '@langfuse/otel'
import { startObservation, setLangfuseTracerProvider } from '@langfuse/tracing'
import { AI_TRACE, LANGFUSE_CONTENT_MODES, LANGFUSE_DEFAULTS, LANGFUSE_USAGE_KEYS } from '../constants/ai-tracing.js'
import { maskTraceData, createTurnRedactor } from './ai-trace-mask.js'

// Does nothing; the body of every no-op tracer method.
const noop = () => {}

const NOOP_GENERATION = Object.freeze({ firstToken: noop, end: noop, fail: noop })
const NOOP_TOOL = Object.freeze({ end: noop })
const NOOP_TURN = Object.freeze({
  setContext: noop,
  generation: () => NOOP_GENERATION,
  tool: () => NOOP_TOOL,
  event: noop,
  end: noop,
  fail: noop,
  abort: noop,
})

// Creates the tracer used when tracing is disabled: every call does nothing.
export function createNoopAiTracer() {
  return { startTurn: () => NOOP_TURN, forceFlush: async () => {}, shutdown: async () => {} }
}

// Builds a wrapper that runs a function and swallows (and logs) any error, returning the fallback.
function createGuard(logger) {
  return (op, fn, fallback) => (...args) => {
    try {
      return fn(...args)
    } catch (err) {
      logger?.warn?.({ op, err: err?.message }, '[AI][trace] tracing call failed')
      return fallback
    }
  }
}

// Describes an error as a short status message; the raw message (it can embed personal data) only in full mode.
function describeError(err, contentMode) {
  const parts = [err?.name, err?.status && `status ${err.status}`, err?.code, err?.error, err?.messageCode]
    .filter((part) => part && typeof part !== 'object')
  const message = contentMode === LANGFUSE_CONTENT_MODES.FULL && err?.message ? `: ${err.message}` : ''
  return `${parts.join(' ') || 'error'}${message}`.slice(0, AI_TRACE.STATUS_MESSAGE_MAX_CHARS)
}

// Tells whether an error is an expected refusal (4xx) rather than a failure of the system.
function isClientRefusal(err) {
  return typeof err?.httpStatus === 'number' && err.httpStatus < AI_TRACE.CLIENT_ERROR_BELOW_STATUS
}

// Maps the provider's normalized usage to Langfuse usage keys, or undefined when absent.
function mapUsage(usage) {
  if (!usage) return undefined
  return {
    [LANGFUSE_USAGE_KEYS.INPUT]: Number(usage.inputTokens) || 0,
    [LANGFUSE_USAGE_KEYS.OUTPUT]: Number(usage.outputTokens) || 0,
    [LANGFUSE_USAGE_KEYS.CACHE_READ]: Number(usage.cacheReadTokens) || 0,
    [LANGFUSE_USAGE_KEYS.CACHE_WRITE]: Number(usage.cacheWriteTokens) || 0,
  }
}

// Updates an observation and always ends it, even when the update throws.
function updateAndEnd(observation, buildAttributes) {
  try {
    observation.update(buildAttributes())
  } finally {
    observation.end()
  }
}

// Wraps one Langfuse generation observation in the facade handle.
function buildGeneration(observation, { guard, content, forget, contentMode }) {
  let done = false
  const settle = (buildAttributes) => {
    if (done) return
    done = true
    forget(observation)
    updateAndEnd(observation, buildAttributes)
  }
  return {
    firstToken: guard('gen.firstToken', () => observation.update({ completionStartTime: new Date() })),
    end: guard('gen.end', ({ output, usage, stopReason }) => settle(() => ({
      output: content(output),
      usageDetails: mapUsage(usage),
      metadata: { stopReason },
    }))),
    fail: guard('gen.fail', (err) => settle(() => ({ level: 'ERROR', statusMessage: describeError(err, contentMode) }))),
  }
}

// Wraps one Langfuse tool observation in the facade handle.
function buildTool(observation, { guard, content, forget }) {
  let done = false
  return {
    end: guard('tool.end', ({ success, output }) => {
      if (done) return
      done = true
      forget(observation)
      updateAndEnd(observation, () => ({
        output: content(output),
        ...(success ? {} : { level: 'ERROR', statusMessage: 'tool failed' }),
      }))
    }),
  }
}

// Starts a root observation detached from whatever span is active (Sentry's request span).
function startDetachedRoot(attributes) {
  return context.with(trace.deleteSpan(context.active()), () => startObservation(AI_TRACE.ROOT_NAME, attributes, { asType: 'span' }))
}

// Builds the per-turn filter applied to every recorded input and output.
function buildContentFilter(contentMode) {
  if (contentMode === LANGFUSE_CONTENT_MODES.OFF) return () => undefined
  if (contentMode === LANGFUSE_CONTENT_MODES.MASKED) return createTurnRedactor()
  return (value) => value
}

// Opens the trace of one turn and returns its facade handle.
function openTurn({ guard, contentMode }, { kind, requestId, input, promptVersion }) {
  const content = buildContentFilter(contentMode)
  const root = startDetachedRoot({ input: content(input), metadata: { requestId, promptVersion } })
  const tags = [AI_TRACE.TAG_APP, kind]
  root.otelSpan.setAttribute(AI_TRACE.ATTR_TAGS, tags)

  const open = new Set()
  const helpers = { guard, content, contentMode, forget: (observation) => open.delete(observation) }
  let finished = false

  const finish = (update, extraTag) => {
    if (finished) return
    finished = true
    try {
      for (const observation of open) observation.end()
      open.clear()
      if (extraTag) root.otelSpan.setAttribute(AI_TRACE.ATTR_TAGS, [...tags, extraTag])
      root.update(update)
    } finally {
      root.end()
    }
  }

  const startChild = (name, attributes, asType, build, fallback) => {
    if (finished) return fallback
    const observation = root.startObservation(name, attributes, { asType })
    open.add(observation)
    return build(observation, helpers)
  }

  return {
    setContext: guard('setContext', ({ trainerId, conversationId, studentId } = {}) => {
      if (trainerId) root.otelSpan.setAttribute(AI_TRACE.ATTR_USER_ID, String(trainerId))
      if (conversationId) root.otelSpan.setAttribute(AI_TRACE.ATTR_SESSION_ID, String(conversationId))
      if (studentId) root.update({ metadata: { studentId: String(studentId) } })
    }),
    generation: guard('generation', ({ attempt, model, input: genInput, modelParameters }) => startChild(
      AI_TRACE.GENERATION_NAME,
      { model, input: content(genInput), modelParameters, metadata: { attempt } },
      'generation',
      buildGeneration,
      NOOP_GENERATION,
    ), NOOP_GENERATION),
    tool: guard('tool', ({ name, input: toolInput }) => startChild(name, { input: content(toolInput) }, 'tool', buildTool, NOOP_TOOL), NOOP_TOOL),
    event: guard('event', (name, metadata) => {
      if (!finished) root.startObservation(name, { metadata }, { asType: 'event' })
    }),
    end: guard('end', ({ output } = {}) => finish({ output: content(output) })),
    fail: guard('fail', (err) => finish({ level: isClientRefusal(err) ? 'WARNING' : 'ERROR', statusMessage: describeError(err, contentMode) })),
    abort: guard('abort', () => finish({ level: 'WARNING', statusMessage: 'client disconnected' }, AI_TRACE.TAG_ABORTED)),
  }
}

// Runs a factory with the span queue bound set (the Langfuse processor exposes no option for it).
function withQueueSize(size, factory) {
  const previous = process.env.OTEL_BSP_MAX_QUEUE_SIZE
  // why: LangfuseSpanProcessor builds its BatchSpanProcessor internally, which reads the queue bound from this env var.
  process.env.OTEL_BSP_MAX_QUEUE_SIZE = String(size)
  try {
    return factory()
  } finally {
    if (previous === undefined) delete process.env.OTEL_BSP_MAX_QUEUE_SIZE
    else process.env.OTEL_BSP_MAX_QUEUE_SIZE = previous
  }
}

// Builds the isolated Langfuse tracer provider; Sentry's global provider is never touched.
function buildProvider(langfuse, exporter) {
  const masked = langfuse.contentMode === LANGFUSE_CONTENT_MODES.MASKED
  const processor = withQueueSize(langfuse.maxQueueSize ?? LANGFUSE_DEFAULTS.MAX_QUEUE_SIZE, () => new LangfuseSpanProcessor({
    exporter,
    publicKey: langfuse.publicKey,
    secretKey: langfuse.secretKey,
    baseUrl: langfuse.baseUrl,
    environment: langfuse.environment,
    release: langfuse.release ?? undefined,
    flushAt: langfuse.flushAt,
    flushInterval: langfuse.flushIntervalSeconds,
    mask: masked ? ({ data }) => maskTraceData(data, langfuse.contentMode) : undefined,
    mediaUploadEnabled: false,
  }))
  // why: the default parent-based sampler would drop every trace whose Sentry request span is unsampled.
  const provider = new NodeTracerProvider({ sampler: new AlwaysOnSampler(), spanProcessors: [processor] })
  // why: never provider.register(), otherwise Langfuse spans would land in Sentry's global provider.
  setLangfuseTracerProvider(provider)
  return provider
}

// Resolves when the promise settles or after the bound, whichever comes first; never rejects.
function settleWithin(promise, boundMs, onError) {
  let timer = null
  const bound = new Promise((resolve) => {
    timer = setTimeout(resolve, boundMs)
    timer.unref?.()
  })
  return Promise.race([promise.catch(onError), bound]).finally(() => clearTimeout(timer))
}

// Shuts the provider down, resolving within the bound even when the export hangs.
function shutdownWithin(provider, logger) {
  return settleWithin(provider.shutdown(), AI_TRACE.SHUTDOWN_TIMEOUT_MS, (err) => logger?.warn?.({ err: err?.message }, '[AI][trace] shutdown failed'))
}

// Creates the iArnold tracer: a no-op when disabled, otherwise an isolated Langfuse provider; never throws.
export function createAiTracer({ config, exporter, logger } = {}) {
  const langfuse = config?.langfuse
  if (!langfuse?.enabled) return createNoopAiTracer()

  let provider = null
  try {
    provider = buildProvider(langfuse, exporter)
  } catch (err) {
    logger?.warn?.({ err: err?.message }, '[AI][trace] could not start Langfuse tracing, continuing without it')
    return createNoopAiTracer()
  }

  const deps = { guard: createGuard(logger), contentMode: langfuse.contentMode }
  let closed = false
  let shutdownPromise = null

  return {
    startTurn: deps.guard('startTurn', (options) => (closed ? NOOP_TURN : openTurn(deps, options)), NOOP_TURN),
    forceFlush: () => settleWithin(
      Promise.resolve().then(() => provider.forceFlush()),
      AI_TRACE.FLUSH_TIMEOUT_MS,
      (err) => logger?.warn?.({ err: err?.message }, '[AI][trace] flush failed'),
    ),
    shutdown: () => {
      closed = true
      shutdownPromise ??= shutdownWithin(provider, logger)
      return shutdownPromise
    },
  }
}

// Wraps a generation handle so a faulty tracer can never break the model call.
function guardGeneration(generation, guard) {
  return {
    firstToken: guard('gen.firstToken', () => generation.firstToken()),
    end: guard('gen.end', (result) => generation.end(result)),
    fail: guard('gen.fail', (err) => generation.fail(err)),
  }
}

// Starts a turn on any tracer and returns a fault-isolated handle; a missing tracer yields a no-op handle.
export function startGuardedTurn(tracer, options, logger = console) {
  if (!tracer) return NOOP_TURN
  const guard = createGuard(logger)
  const turn = guard('startTurn', () => tracer.startTurn(options), null)()
  if (!turn) return NOOP_TURN
  return {
    setContext: guard('setContext', (ctx) => turn.setContext(ctx)),
    generation: guard('generation', (opts) => guardGeneration(turn.generation(opts), guard), NOOP_GENERATION),
    tool: guard('tool', (opts) => {
      const tool = turn.tool(opts)
      return { end: guard('tool.end', (result) => tool.end(result)) }
    }, NOOP_TOOL),
    event: guard('event', (name, metadata) => turn.event(name, metadata)),
    end: guard('end', (result) => turn.end(result)),
    fail: guard('fail', (err) => turn.fail(err)),
    abort: guard('abort', () => turn.abort()),
  }
}
