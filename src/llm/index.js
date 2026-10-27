import { LLM_PROVIDERS } from '../constants/ai.js'
import { AnthropicProvider } from './anthropic-provider.js'
import { resolveProviderName } from './config.js'

export { checkLlmConfiguration, isLlmConfigured } from './config.js'

/**
 * Factory function that returns the configured LLM provider instance.
 *
 * Reads LLM_PROVIDER env var (default: 'anthropic'). Fails fast on anything else.
 *
 * @returns {import('./llm-provider.js').LlmProvider}
 */
export function getLlmProvider() {
  const provider = resolveProviderName()

  if (provider === LLM_PROVIDERS.ANTHROPIC) return new AnthropicProvider()

  if (provider.toLowerCase() === 'gemini') {
    throw new Error(`LLM provider "gemini" is no longer supported. Set LLM_PROVIDER=${LLM_PROVIDERS.ANTHROPIC} (the only supported provider).`)
  }
  throw new Error(`Unknown LLM provider: "${provider}". Valid options: ${Object.values(LLM_PROVIDERS).join(', ')}`)
}
