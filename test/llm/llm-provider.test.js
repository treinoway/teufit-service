import { describe, it, expect } from 'vitest'
import { LlmProvider } from '../../src/llm/llm-provider.js'

describe('LlmProvider base class', () => {
  it('should require subclasses to implement chat', async () => {
    await expect(new LlmProvider().chat({ signal: new AbortController().signal })).rejects.toThrow(/must be implemented/)
  })

  it('should require subclasses to implement chatStream', async () => {
    const stream = new LlmProvider().chatStream({ signal: new AbortController().signal })

    await expect(stream.next()).rejects.toThrow(/must be implemented/)
  })

  it('should require subclasses to implement buildToolResultMessages', () => {
    expect(() => new LlmProvider().buildToolResultMessages([], [])).toThrow(/must be implemented/)
  })
})
