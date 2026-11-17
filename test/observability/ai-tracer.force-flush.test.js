import { describe, it, expect, afterEach } from 'vitest'
import { createAiTracer, createNoopAiTracer } from '../../src/observability/ai-tracer.js'
import { tracerConfig, createMemoryExporter, runSimpleTurn } from '../helpers/ai-tracing-fixtures.js'

const FLUSH_BOUND_MS = 4000
const HUNG_TEST_TIMEOUT_MS = 8000

let activeTracer = null

afterEach(async () => {
  await activeTracer?.shutdown().catch(() => {})
  activeTracer = null
})

describe('forceFlush', () => {
  it('should export pending spans without shutting down', async () => {
    const exporter = createMemoryExporter()
    activeTracer = createAiTracer({ config: tracerConfig({ flushAt: 100, flushIntervalSeconds: 60 }), exporter })
    runSimpleTurn(activeTracer)

    await activeTracer.forceFlush()

    expect(exporter.spans.length).toBeGreaterThan(0)
  })

  it('should resolve within the bound when the export hangs', async () => {
    const exporter = createMemoryExporter()
    exporter.export = () => {}
    activeTracer = createAiTracer({ config: tracerConfig(), exporter })
    runSimpleTurn(activeTracer)
    const startedAt = Date.now()

    await activeTracer.forceFlush()

    expect(Date.now() - startedAt).toBeLessThan(FLUSH_BOUND_MS)
  }, HUNG_TEST_TIMEOUT_MS)

  it('should exist and resolve on the no-op tracer', async () => {
    await expect(createNoopAiTracer().forceFlush()).resolves.toBeUndefined()
  })
})
