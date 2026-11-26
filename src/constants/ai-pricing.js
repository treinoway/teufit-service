// Anthropic API list prices, USD per million tokens (cacheWrite = 5-minute cache write); source: https://platform.claude.com/docs/en/about-claude/pricing, read 2026-11-24.
export const AI_MODEL_PRICES_USD_PER_MTOK = Object.freeze({
  'claude-sonnet-5-5': Object.freeze({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }),
  'claude-sonnet-4-6': Object.freeze({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }),
});
