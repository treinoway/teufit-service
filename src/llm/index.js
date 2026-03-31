import { LLM_PROVIDERS } from '../constants/ai.js'
import { AnthropicProvider } from './anthropic-provider.js'
import { GeminiProvider } from './gemini-provider.js'

/**
 * Factory function that returns the configured LLM provider instance.
 *
 * Reads LLM_PROVIDER env var (default: 'anthropic').
 * Throws if an unknown provider is specified — fail fast at startup.
 *
 * @returns {import('./llm-provider.js').LlmProvider}
 */
export function getLlmProvider() {
  const provider = process.env.LLM_PROVIDER || LLM_PROVIDERS.ANTHROPIC

  switch (provider) {
    case LLM_PROVIDERS.ANTHROPIC:
      return new AnthropicProvider()
    case LLM_PROVIDERS.GEMINI:
      return new GeminiProvider()
    default:
      throw new Error(`Unknown LLM provider: "${provider}". Valid options: ${Object.values(LLM_PROVIDERS).join(', ')}`)
  }
}
