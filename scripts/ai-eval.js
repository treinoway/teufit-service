// Manual real-model eval for iArnold: npm run ai:eval  (not part of CI; costs real API calls).
// This is the ONLY source of real accuracy numbers: the CI replay test (test/ai-eval) scripts the model's answers
// and only checks the fixtures and the engine wiring.
// Env: ANTHROPIC_API_KEY (required, skips cleanly without), ANTHROPIC_MODEL, AI_EVAL_RUNS (default 1),
//      AI_EVAL_MIN_ACCURACY (0-1, exit 1 below it), AI_EVAL_ONLY (comma-separated case ids), ANTHROPIC_EFFORT (low|medium|high|max).
// Each case may bring its own context fixture, student focus and a read-tool result fed back as a tool_result turn.
import 'dotenv/config'
import { AnthropicProvider } from '../src/llm/anthropic-provider.js'
import { TOOLS } from '../src/services/ai-tool-definitions.js'
import { AI_LIMITS } from '../src/constants/ai.js'
import { loadEvalFixtures, buildEvalMessages, buildEvalSystem, scoreCase } from '../test/ai-eval/eval-lib.js'

const RUNS = Number(process.env.AI_EVAL_RUNS || 1)

// Asks the real model once and normalizes its answer for matching.
async function askModel(provider, defaultContext, evalCase) {
  const response = await provider.chat({
    system: buildEvalSystem(evalCase, defaultContext),
    tools: TOOLS,
    messages: buildEvalMessages(evalCase),
    maxTokens: AI_LIMITS.MAX_TOKENS,
  })
  return { toolCalls: response.toolCalls, text: response.text ?? '' }
}

// Entry point: prints per-case results and the overall accuracy.
async function main() {
  if (!process.env.ANTHROPIC_API_KEY?.trim()) {
    console.log('ANTHROPIC_API_KEY is not set — skipping the real-model eval.')
    return
  }

  const { context, cases } = loadEvalFixtures()
  const only = process.env.AI_EVAL_ONLY?.split(',').map((id) => id.trim())
  const selected = only ? cases.filter((evalCase) => only.includes(evalCase.id)) : cases
  const provider = new AnthropicProvider()

  let passed = 0
  for (const evalCase of selected) {
    const { passes, lastFailure } = await scoreCase(evalCase, (current) => askModel(provider, context, current), { runs: RUNS })
    passed += passes
    const status = passes === RUNS ? 'PASS' : 'FAIL'
    console.log(`${status}  ${evalCase.id}  (${passes}/${RUNS})${lastFailure ? `  ${lastFailure}` : ''}`)
  }

  const total = selected.length * RUNS
  const accuracy = total === 0 ? 0 : passed / total
  console.log(`\nAccuracy: ${passed}/${total} = ${(accuracy * 100).toFixed(1)}%`)

  const minimum = Number(process.env.AI_EVAL_MIN_ACCURACY)
  if (minimum && accuracy < minimum) process.exitCode = 1
}

main().catch((err) => {
  console.error('ai:eval failed:', err.message)
  process.exitCode = 1
})
