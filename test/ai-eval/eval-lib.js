import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isExplicitConfirmation } from '../../src/helpers/ai-confirmation.js'
import { wrapUserInput } from '../../src/services/ai-prompt.js'

const EVAL_DIR = import.meta.dirname
const TOOL_KINDS = new Set(['tool', 'read'])
const TEXT_KINDS = new Set(['propose', 'clarify', 'no_tool'])

// Loads the shared trainer context and the eval cases.
export function loadEvalFixtures() {
  const context = JSON.parse(readFileSync(join(EVAL_DIR, 'context.json'), 'utf8'))
  const { cases } = JSON.parse(readFileSync(join(EVAL_DIR, 'cases.json'), 'utf8'))
  return { context, cases }
}

// Tells whether every expected key/value (recursively, arrays by index) is present in the actual value.
export function isSubset(expected, actual) {
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.every((item, index) => isSubset(item, actual[index]))
  }
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key]))
  }
  return expected === actual
}

// Builds the model messages for a case: replayed history wrapped like production, then the request.
export function buildEvalMessages(evalCase) {
  const history = evalCase.history.map((entry) =>
    entry.role === 'user' ? { role: 'user', content: wrapUserInput(entry.content) } : entry,
  )
  return [...history, { role: 'user', content: wrapUserInput(evalCase.message) }]
}

// Checks a (real or replayed) model answer against the case expectation.
export function matchesExpected(expected, { toolCalls, text }) {
  if (TOOL_KINDS.has(expected.kind)) {
    const call = toolCalls[0]
    if (!call) return { pass: false, reason: 'no tool call' }
    if (call.name !== expected.tool) return { pass: false, reason: `called ${call.name}, expected ${expected.tool}` }
    return isSubset(expected.args, call.input)
      ? { pass: true, reason: 'ok' }
      : { pass: false, reason: `args ${JSON.stringify(call.input)} miss ${JSON.stringify(expected.args)}` }
  }
  if (toolCalls.length > 0) return { pass: false, reason: `unexpected tool ${toolCalls[0].name}` }
  if (expected.textMatches && !new RegExp(expected.textMatches, 'i').test(text ?? '')) {
    return { pass: false, reason: `text does not match /${expected.textMatches}/` }
  }
  return { pass: true, reason: 'ok' }
}

// Lists the problems of one case against the tool definitions (empty when valid).
function caseProblems(evalCase, toolsByName) {
  const problems = []
  const { expected, replay } = evalCase
  if (!evalCase.id || !evalCase.message || !Array.isArray(evalCase.history)) problems.push('needs id, message and history[]')
  if (![...TOOL_KINDS, ...TEXT_KINDS].includes(expected?.kind)) problems.push(`unknown kind ${expected?.kind}`)
  if (!replay || typeof replay.text !== 'string') problems.push('needs replay.text')

  if (TOOL_KINDS.has(expected?.kind)) {
    const tool = toolsByName.get(expected.tool)
    if (!tool) problems.push(`unknown tool ${expected.tool}`)
    if (!expected.args || Object.keys(expected.args).length === 0) problems.push('tool case needs expected.args')
    if (!replay?.toolCall) problems.push('tool case needs replay.toolCall')
    if (tool && replay?.toolCall) {
      const missing = tool.input_schema.required.filter((key) => replay.toolCall.input[key] === undefined)
      if (missing.length > 0) problems.push(`replay input misses required ${missing.join(', ')}`)
    }
    if (expected.kind === 'tool' && !isExplicitConfirmation(evalCase.message)) problems.push('write case must end with a confirmation message')
    if (expected.kind === 'tool' && evalCase.history.length < 2) problems.push('write case needs the proposal in history')
  } else if (replay?.toolCall) {
    problems.push('non-tool case must not replay a tool call')
  }
  return problems
}

// Validates the fixture schema; returns "caseId: problem" strings.
export function validateCases(cases, tools) {
  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]))
  const ids = cases.map((evalCase) => evalCase.id)
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index).map((id) => `${id}: duplicate id`)
  const perCase = cases.flatMap((evalCase) => caseProblems(evalCase, toolsByName).map((problem) => `${evalCase.id}: ${problem}`))
  return [...duplicates, ...perCase]
}
