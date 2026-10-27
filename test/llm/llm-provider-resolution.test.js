import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn(),
}))

import * as llm from '../../src/llm/index.js'
import { AnthropicProvider } from '../../src/llm/anthropic-provider.js'
import { LLM_PROVIDERS, AI_MODELS } from '../../src/constants/ai.js'

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..')
const NO_LONGER_SUPPORTED = /no longer supported/i

// Lists every .js file under a directory, recursively.
function listJsFiles(directory) {
  return readdirSync(directory).flatMap((entry) => {
    const fullPath = join(directory, entry)
    if (statSync(fullPath).isDirectory()) return listJsFiles(fullPath)
    return fullPath.endsWith('.js') ? [fullPath] : []
  })
}

describe('LLM provider resolution', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  describe('Anthropic-only provider set (AC 5)', () => {
    it('should expose only the Anthropic provider in LLM_PROVIDERS', () => {
      expect(Object.values(LLM_PROVIDERS)).toEqual(['anthropic'])
    })

    it('should not export any Gemini symbol from src/llm', () => {
      const geminiExports = Object.keys(llm).filter((name) => /gemini/i.test(name))

      expect(geminiExports).toEqual([])
    })

    it('should not ship the Gemini provider file', () => {
      expect(existsSync(join(PROJECT_ROOT, 'src/llm/gemini-provider.js'))).toBe(false)
    })

    it('should not declare the @google/genai dependency', () => {
      const pkg = JSON.parse(readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf8'))

      expect(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })).not.toContain('@google/genai')
    })

    it('should not mention Gemini in .env.example', () => {
      const envExample = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8')

      expect(envExample).not.toMatch(/gemini/i)
    })

    it('should not reference Gemini or @google/genai anywhere in src/ or api/ (except the boot error in src/llm/index.js)', () => {
      const offenders = [...listJsFiles(join(PROJECT_ROOT, 'src')), ...listJsFiles(join(PROJECT_ROOT, 'api'))]
        .filter((file) => !file.endsWith(join('src', 'llm', 'index.js')))
        .filter((file) => /gemini|@google\/genai/i.test(readFileSync(file, 'utf8')))
        .map((file) => file.replace(`${PROJECT_ROOT}/`, ''))

      expect(offenders).toEqual([])
    })

    it('should resolve the Anthropic provider when LLM_PROVIDER is unset', () => {
      vi.stubEnv('LLM_PROVIDER', '')

      expect(llm.getLlmProvider()).toBeInstanceOf(AnthropicProvider)
    })

    it('should resolve the Anthropic provider when LLM_PROVIDER=anthropic', () => {
      vi.stubEnv('LLM_PROVIDER', LLM_PROVIDERS.ANTHROPIC)

      expect(llm.getLlmProvider()).toBeInstanceOf(AnthropicProvider)
    })

    it('should fail with a clear error when LLM_PROVIDER=gemini', () => {
      vi.stubEnv('LLM_PROVIDER', 'gemini')

      expect(() => llm.getLlmProvider()).toThrow(NO_LONGER_SUPPORTED)
    })

    it('should name Gemini and the supported provider in the LLM_PROVIDER=gemini error', () => {
      vi.stubEnv('LLM_PROVIDER', 'gemini')

      expect(() => llm.getLlmProvider()).toThrow(/gemini.*anthropic|anthropic.*gemini/is)
    })
  })

  describe('checkLlmConfiguration (AC 4)', () => {
    it('should log an error and return false when ANTHROPIC_API_KEY is missing', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '')
      const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }

      const configured = llm.checkLlmConfiguration(logger)

      expect(configured).toBe(false)
      expect(logger.error).toHaveBeenCalledTimes(1)
    })

    it('should mention ANTHROPIC_API_KEY in the logged error', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '')
      const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }

      llm.checkLlmConfiguration(logger)

      expect(JSON.stringify(logger.error.mock.calls)).toContain('ANTHROPIC_API_KEY')
    })

    it('should return true and stay silent when ANTHROPIC_API_KEY is set', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'sk-test')
      const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }

      const configured = llm.checkLlmConfiguration(logger)

      expect(configured).toBe(true)
      expect(logger.error).not.toHaveBeenCalled()
    })

    it('should treat a whitespace-only ANTHROPIC_API_KEY as missing', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', '   ')
      const logger = { error: vi.fn(), info: vi.fn(), warn: vi.fn() }

      expect(llm.checkLlmConfiguration(logger)).toBe(false)
    })
  })

  describe('default model (AC 25)', () => {
    it('should default the Anthropic model to claude-sonnet-5-5', () => {
      expect(AI_MODELS.ANTHROPIC).toBe('claude-sonnet-5-5')
    })

    it('should align ANTHROPIC_MODEL in .env.example with the code default', () => {
      const envExample = readFileSync(join(PROJECT_ROOT, '.env.example'), 'utf8')

      expect(envExample).toMatch(/^ANTHROPIC_MODEL=claude-sonnet-5-5\s*$/m)
    })
  })
})
