export const LANGFUSE_TEST_CONFIG = Object.freeze({
  enabled: true,
  publicKey: 'pk-test',
  secretKey: 'sk-test',
  baseUrl: 'https://langfuse.test',
  environment: 'staging',
  release: 'sha-123',
  contentMode: 'full',
  flushAt: 1,
  flushIntervalSeconds: 1,
})

// Builds a tracer config with the given langfuse overrides.
export function tracerConfig(overrides = {}) {
  return { langfuse: { ...LANGFUSE_TEST_CONFIG, ...overrides } }
}

// Creates an in-memory span exporter that records every exported OTel span.
export function createMemoryExporter() {
  const spans = []
  return {
    spans,
    export(batch, resultCallback) {
      spans.push(...batch)
      resultCallback({ code: 0 })
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  }
}

// Creates a logger double with the methods the tracer may call.
export function createLoggerDouble() {
  return { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} }
}

// Reads a span attribute, JSON-decoding it when the Langfuse exporter serialized it.
export function readAttr(span, key) {
  const value = span.attributes[key]
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

// Reads an attribute from the first span that carries it (trace-level attributes may sit on any span).
export function readAttrAnywhere(spans, key) {
  const carrier = spans.find((span) => span.attributes[key] !== undefined)
  return carrier ? readAttr(carrier, key) : undefined
}

// Finds the root span: the only one without a parent.
export function rootSpanOf(spans) {
  return spans.find((span) => !span.parentSpanContext?.spanId)
}

// Lists exported spans of one Langfuse observation type in start order.
export function spansOfType(spans, type) {
  return spans
    .filter((span) => readAttr(span, 'langfuse.observation.type') === type)
    .sort((a, b) => a.startTime[0] - b.startTime[0] || a.startTime[1] - b.startTime[1])
}

// Serializes every attribute of every span, for "this text must (not) be exported" checks.
export function dumpAttributes(spans) {
  return JSON.stringify(spans.map((span) => span.attributes))
}

// Runs one simple completed turn through a tracer: context, one generation, end.
export function runSimpleTurn(tracer, { input = 'Oi', output = 'Ola', kind = 'chat' } = {}) {
  const turn = tracer.startTurn({ kind, requestId: 'req-1', input, promptVersion: 'abc123' })
  turn.setContext({ trainerId: 'trainer-1', conversationId: 'conv-1' })
  const gen = turn.generation({ attempt: 1, model: 'claude-test', input: { system: 'sys', messages: [] }, modelParameters: { maxTokens: 8000 } })
  gen.end({ output: [{ type: 'text', text: output }], usage: null, stopReason: 'end_turn' })
  turn.end({ output })
  return turn
}
