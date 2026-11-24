import { LLM_PROVIDERS, LLM_EFFORTS } from '../constants/ai.js'

const API_KEY_ENV = 'ANTHROPIC_API_KEY'

// Reads LLM_PROVIDER, treating unset or blank as the Anthropic default.
export function resolveProviderName() {
  return (process.env.LLM_PROVIDER?.trim() || LLM_PROVIDERS.ANTHROPIC).toLowerCase()
}

// Tells whether the AI provider is usable (supported provider and API key present).
export function isLlmConfigured() {
  return resolveProviderName() === LLM_PROVIDERS.ANTHROPIC && Boolean(process.env[API_KEY_ENV]?.trim())
}

/**
 * Logs an error at boot when the AI provider cannot be used.
 *
 * @param {{ error: Function }} logger
 * @returns {boolean} true when AI is configured
 */
export function checkLlmConfiguration(logger) {
  const provider = resolveProviderName()
  if (provider !== LLM_PROVIDERS.ANTHROPIC) {
    logger.error(`LLM_PROVIDER="${provider}" is not supported (use "${LLM_PROVIDERS.ANTHROPIC}") — AI assistant will be unavailable`)
    return false
  }
  if (!isLlmConfigured()) {
    logger.error(`${API_KEY_ENV} is not set — AI assistant will be unavailable (routes answer 503)`)
    return false
  }
  return true
}

// Reads ANTHROPIC_EFFORT at call time; returns null when unset, blank or not a known level.
export function resolveEffort() {
  const effort = process.env.ANTHROPIC_EFFORT?.trim().toLowerCase()
  return LLM_EFFORTS.includes(effort) ? effort : null
}
