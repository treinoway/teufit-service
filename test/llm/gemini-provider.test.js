import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the Google GenAI SDK before importing the provider
const geminiGenerateContent = vi.fn()
const geminiGenerateContentStream = vi.fn()

vi.mock('@google/genai', () => ({
  GoogleGenAI: vi.fn(),
}))

import { GoogleGenAI } from '@google/genai'
import { GeminiProvider } from '../../src/llm/gemini-provider.js'

// Minimal Gemini response shape
function makeGeminiResponse(text = 'response text') {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
        finishReason: 'STOP',
      },
    ],
  }
}

describe('GeminiProvider', () => {
  let provider

  beforeEach(() => {
    vi.clearAllMocks()
    GoogleGenAI.mockImplementation(function () {
      this.models = {
        generateContent: geminiGenerateContent,
        generateContentStream: geminiGenerateContentStream,
      }
    })
    provider = new GeminiProvider()
  })

  // ---------------------------------------------------------------------------
  // _resolveSystemInstruction
  // ---------------------------------------------------------------------------

  describe('_resolveSystemInstruction', () => {
    it('returns a plain string unchanged', () => {
      expect(provider._resolveSystemInstruction('You are helpful')).toBe('You are helpful')
    })

    it('joins block array texts with a newline when system is an array', () => {
      const blocks = [
        { type: 'text', text: 'Static rules' },
        { type: 'text', text: 'Dynamic context' },
      ]
      const result = provider._resolveSystemInstruction(blocks)
      expect(result).toBe('Static rules\nDynamic context')
    })

    it('discards cache_control metadata from blocks', () => {
      const blocks = [
        { type: 'text', text: 'Cached block', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Uncached block' },
      ]
      const result = provider._resolveSystemInstruction(blocks)
      expect(result).toBe('Cached block\nUncached block')
      expect(result).not.toContain('cache_control')
      expect(result).not.toContain('ephemeral')
    })

    it('handles a single-block array', () => {
      const blocks = [{ type: 'text', text: 'Only block', cache_control: { type: 'ephemeral' } }]
      expect(provider._resolveSystemInstruction(blocks)).toBe('Only block')
    })
  })

  // ---------------------------------------------------------------------------
  // chat()
  // ---------------------------------------------------------------------------

  describe('chat()', () => {
    const baseParams = {
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 512,
    }

    it('calls generateContent with flattened system string when system is an array', async () => {
      geminiGenerateContent.mockResolvedValue(makeGeminiResponse())

      const systemBlocks = [
        { type: 'text', text: 'Static rules', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Dynamic context' },
      ]

      await provider.chat({ ...baseParams, system: systemBlocks })

      const callArgs = geminiGenerateContent.mock.calls[0][0]
      expect(callArgs.config.systemInstruction).toBe('Static rules\nDynamic context')
    })

    it('calls generateContent with system string unchanged when system is a plain string', async () => {
      geminiGenerateContent.mockResolvedValue(makeGeminiResponse())

      await provider.chat({ ...baseParams, system: 'plain system' })

      const callArgs = geminiGenerateContent.mock.calls[0][0]
      expect(callArgs.config.systemInstruction).toBe('plain system')
    })
  })

  // ---------------------------------------------------------------------------
  // chatStream()
  // ---------------------------------------------------------------------------

  describe('chatStream()', () => {
    const baseParams = {
      tools: [],
      messages: [{ role: 'user', content: 'Stream me' }],
      maxTokens: 256,
    }

    it('calls generateContentStream with flattened system string when system is an array', async () => {
      // Mock an async iterable stream that yields one chunk
      const chunk = makeGeminiResponse('hello')
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield chunk
        },
      }
      geminiGenerateContentStream.mockResolvedValue(mockStream)

      const systemBlocks = [
        { type: 'text', text: 'Block one', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Block two' },
      ]

      // Drain the generator
       
      for await (const _chunk of provider.chatStream({ ...baseParams, system: systemBlocks })) { /* drain */ }

      const callArgs = geminiGenerateContentStream.mock.calls[0][0]
      expect(callArgs.config.systemInstruction).toBe('Block one\nBlock two')
    })

    it('calls generateContentStream with system string unchanged when system is a plain string', async () => {
      const chunk = makeGeminiResponse('hello')
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield chunk
        },
      }
      geminiGenerateContentStream.mockResolvedValue(mockStream)

       
      for await (const _chunk of provider.chatStream({ ...baseParams, system: 'plain string' })) { /* drain */ }

      const callArgs = geminiGenerateContentStream.mock.calls[0][0]
      expect(callArgs.config.systemInstruction).toBe('plain string')
    })
  })

  describe('usage normalization', () => {
    const baseParams = {
      system: 'sys',
      tools: [],
      messages: [{ role: 'user', content: 'Hello' }],
      maxTokens: 256,
    }

    const usageMetadata = {
      promptTokenCount: 120,
      candidatesTokenCount: 40,
      thoughtsTokenCount: 10,
      cachedContentTokenCount: 20,
    }

    const normalizedUsage = {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 0,
    }

    it('chat() maps usageMetadata to the normalized usage object', async () => {
      geminiGenerateContent.mockResolvedValue({ ...makeGeminiResponse(), usageMetadata })

      const response = await provider.chat(baseParams)

      expect(response.usage).toEqual(normalizedUsage)
    })

    it('chat() treats absent cache and thoughts counters as 0', async () => {
      geminiGenerateContent.mockResolvedValue({
        ...makeGeminiResponse(),
        usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 5 },
      })

      const response = await provider.chat(baseParams)

      expect(response.usage).toEqual({
        inputTokens: 15,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    })

    it('chat() returns usage null when usageMetadata is absent', async () => {
      geminiGenerateContent.mockResolvedValue(makeGeminiResponse())

      const response = await provider.chat(baseParams)

      expect(response.usage).toBeNull()
    })

    it('chatStream() complete event carries usage from the last chunk', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield makeGeminiResponse('hel')
          yield { ...makeGeminiResponse('lo'), usageMetadata }
        },
      }
      geminiGenerateContentStream.mockResolvedValue(mockStream)

      let complete = null
      for await (const chunk of provider.chatStream(baseParams)) {
        if (chunk.type === 'complete') complete = chunk
      }

      expect(complete.response.usage).toEqual(normalizedUsage)
    })

    it('chatStream() complete event has usage null when no chunk carries usageMetadata', async () => {
      const mockStream = {
        [Symbol.asyncIterator]: async function* () {
          yield makeGeminiResponse('hello')
        },
      }
      geminiGenerateContentStream.mockResolvedValue(mockStream)

      let complete = null
      for await (const chunk of provider.chatStream(baseParams)) {
        if (chunk.type === 'complete') complete = chunk
      }

      expect(complete.response.usage).toBeNull()
    })
  })
})
