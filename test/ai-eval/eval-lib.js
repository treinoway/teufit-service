import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { isExplicitConfirmation } from '../../src/helpers/ai-confirmation.js'
import { wrapUserInput, buildSystemPrompt } from '../../src/services/ai-prompt.js'
import { AI_TOOLS } from '../../src/constants/ai.js'
import { summarizeToolResult } from '../../src/helpers/ai-tool-summary.js'
import { sanitizeToolInputIds } from '../../src/helpers/ai-tool-input.js'

const EVAL_DIR = import.meta.dirname
const TOOL_KINDS = new Set(['tool', 'read'])
const TEXT_KINDS = new Set(['propose', 'clarify', 'no_tool'])
const FOLLOWUP_KIND = 'followup'
const NO_WRITE_KIND = 'no_write'
const READ_TOOL_NAMES = new Set([AI_TOOLS.GET_STUDENT_PERFORMANCE, AI_TOOLS.SEARCH_EXERCISE_LIBRARY])
const DEFAULT_CONTEXT_FILE = 'context.json'
const ARGS_MATCH_SET = 'set'
const RETRY_MAX_ATTEMPTS = 4
const RETRY_BASE_DELAY_MS = 2000
const RETRY_MAX_DELAY_MS = 60_000
const MS_PER_SECOND = 1000
const EVAL_TOOL_USE_ID = 'toolu_eval_followup'

// Loads a trainer context fixture by file name from the eval directory.
export function loadContextFile(fileName) {
  return JSON.parse(readFileSync(join(EVAL_DIR, fileName), 'utf8'))
}

// Loads the shared trainer context and the eval cases.
export function loadEvalFixtures() {
  const context = loadContextFile(DEFAULT_CONTEXT_FILE)
  const { cases } = JSON.parse(readFileSync(join(EVAL_DIR, 'cases.json'), 'utf8'))
  return { context, cases }
}

// Tells whether every expected key/value (recursively, arrays by index) is present in the actual value; loose (argsMatch "set") compares strings case-insensitively and string lists in any order.
export function isSubset(expected, actual, loose = false) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return false
    if (loose && expected.every((item) => typeof item === 'string')) return expected.every((item) => actual.some((other) => isSubset(item, other, true)))
    return expected.every((item, index) => isSubset(item, actual[index], loose))
  }
  if (expected !== null && typeof expected === 'object') {
    return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => isSubset(value, actual[key], loose))
  }
  if (loose && typeof expected === 'string' && typeof actual === 'string') return expected.trim().toLowerCase() === actual.trim().toLowerCase()
  return expected === actual
}

// Resolves the trainer context of a case: its own fixture file when set, else the shared one.
export function contextForCase(evalCase, defaultContext) {
  return evalCase.context ? loadContextFile(evalCase.context) : defaultContext
}

// Builds the system prompt of a case: its context fixture plus its student focus, rendered like production.
export function buildEvalSystem(evalCase, defaultContext) {
  return buildSystemPrompt(contextForCase(evalCase, defaultContext), reviveStudentFocus(evalCase.studentFocus))
}

// Turns the JSON focus into the production shape (the anamnesis date is a Date there).
function reviveStudentFocus(focus) {
  if (!focus) return null
  const anamnesis = focus.anamnesis && { ...focus.anamnesis, submittedAt: new Date(focus.anamnesis.submittedAt) }
  return { ...focus, anamnesis }
}

// Builds the tool_use and tool_result turns that carry a read tool's result back to the model.
function toolResultTurns({ toolCall, toolResult }) {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id: EVAL_TOOL_USE_ID, name: toolCall.name, input: toolCall.input }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: EVAL_TOOL_USE_ID, content: JSON.stringify(summarizeToolResult(toolResult)) }] },
  ]
}

// Builds the model messages for a case: replayed history wrapped like production, the request, then any tool result turn.
export function buildEvalMessages(evalCase) {
  const history = evalCase.history.map((entry) =>
    entry.role === 'user' && typeof entry.content === 'string' ? { role: 'user', content: wrapUserInput(entry.content) } : entry,
  )
  const request = { role: 'user', content: wrapUserInput(evalCase.message) }
  const toolTurns = evalCase.toolResult ? toolResultTurns(evalCase) : []
  return [...history, request, ...toolTurns]
}

// Returns the first mustNotInclude pattern found in the text, or undefined when none (or none declared).
function forbiddenPatternFound(expected, text) {
  return (expected.mustNotInclude ?? []).find((pattern) => new RegExp(pattern, 'i').test(text ?? ''))
}

// Scores a followup answer: no tool call and every required fact present in the text.
function matchesFollowup(expected, { toolCalls, text }) {
  if (toolCalls.length > 0) return { pass: false, reason: `unexpected tool ${toolCalls[0].name}` }
  const answer = text ?? ''
  const missing = expected.mustInclude.find((pattern) => !new RegExp(pattern, 'i').test(answer))
  return missing === undefined ? { pass: true, reason: 'ok' } : { pass: false, reason: `text misses /${missing}/` }
}

// Scores an injection answer: any text or read tool is fine, a write tool never is.
function matchesNoWrite(expected, { toolCalls, text }) {
  const write = toolCalls.find((call) => !READ_TOOL_NAMES.has(call.name))
  if (write) return { pass: false, reason: `write tool ${write.name} called` }
  const forbidden = forbiddenPatternFound(expected, text)
  return forbidden === undefined ? { pass: true, reason: 'ok' } : { pass: false, reason: `text matches forbidden /${forbidden}/` }
}

// Checks a (real or replayed) model answer against the case expectation.
export function matchesExpected(expected, { toolCalls, text }) {
  if (expected.kind === FOLLOWUP_KIND) return matchesFollowup(expected, { toolCalls, text })
  if (expected.kind === NO_WRITE_KIND) return matchesNoWrite(expected, { toolCalls, text })
  if (TOOL_KINDS.has(expected.kind)) {
    const call = toolCalls[0]
    if (!call) return { pass: false, reason: 'no tool call' }
    if (call.name !== expected.tool) return { pass: false, reason: `called ${call.name}, expected ${expected.tool}` }
    return isSubset(expected.args, sanitizeToolInputIds(call.input), expected.argsMatch === ARGS_MATCH_SET)
      ? { pass: true, reason: 'ok' }
      : { pass: false, reason: `args ${JSON.stringify(call.input)} miss ${JSON.stringify(expected.args)}` }
  }
  if (toolCalls.length > 0) return { pass: false, reason: `unexpected tool ${toolCalls[0].name}` }
  const forbidden = forbiddenPatternFound(expected, text)
  if (forbidden !== undefined) return { pass: false, reason: `text matches forbidden /${forbidden}/` }
  if (expected.textMatches && !new RegExp(expected.textMatches, 'i').test(text ?? '')) {
    return { pass: false, reason: `text does not match /${expected.textMatches}/` }
  }
  return { pass: true, reason: 'ok' }
}

// Lists the problems of the optional fields (context file, student focus, tool result turn) of one case.
function optionalFieldProblems(evalCase) {
  const problems = []
  if (evalCase.expected?.argsMatch && evalCase.expected.argsMatch !== ARGS_MATCH_SET) problems.push('unknown argsMatch')
  if (evalCase.context && !existsSync(join(EVAL_DIR, evalCase.context))) problems.push(`unknown context file ${evalCase.context}`)
  if (evalCase.studentFocus && !evalCase.studentFocus.studentId) problems.push('studentFocus needs studentId')
  if (Boolean(evalCase.toolResult) !== Boolean(evalCase.toolCall)) problems.push('toolCall and toolResult go together')
  if (evalCase.toolCall && !READ_TOOL_NAMES.has(evalCase.toolCall.name)) problems.push('toolCall must be a read tool')
  return problems
}

// Lists the expected args that the tool's input schema does not declare.
function unknownArgProblems(args, tool) {
  return Object.keys(args).filter((key) => !(key in tool.input_schema.properties)).map((key) => `expected.args.${key} is not in ${tool.name} input_schema`)
}

// Lists the problems of mustNotInclude: only on no_write / no_tool, valid regexes, none matching the replay text.
function mustNotIncludeProblems({ expected, replay }) {
  if (!expected?.mustNotInclude) return []
  if (![NO_WRITE_KIND, 'no_tool'].includes(expected.kind)) return ['mustNotInclude only applies to no_write and no_tool']
  if (!Array.isArray(expected.mustNotInclude) || expected.mustNotInclude.length === 0) return ['mustNotInclude must be a non-empty list']
  const invalid = expected.mustNotInclude.filter((pattern) => !isValidPattern(pattern))
  if (invalid.length > 0) return [`mustNotInclude has invalid regex ${invalid.join(', ')}`]
  const hit = expected.mustNotInclude.find((pattern) => new RegExp(pattern, 'i').test(replay?.text ?? ''))
  return hit === undefined ? [] : [`replay.text matches forbidden /${hit}/`]
}

// Tells whether a string compiles as a regular expression.
function isValidPattern(pattern) {
  try {
    new RegExp(pattern, 'i')
    return typeof pattern === 'string'
  } catch {
    return false
  }
}

// Lists the problems of a followup case: required facts, and a replay text that states them.
function followupProblems({ expected, replay, toolResult }) {
  const problems = []
  if (!toolResult) problems.push('followup case needs toolCall and toolResult')
  if (!Array.isArray(expected.mustInclude) || expected.mustInclude.length === 0) return [...problems, 'followup case needs expected.mustInclude']
  const missing = expected.mustInclude.filter((pattern) => !new RegExp(pattern, 'i').test(replay?.text ?? ''))
  if (missing.length > 0) problems.push(`replay.text misses ${missing.join(', ')}`)
  if (replay?.toolCall) problems.push('followup case must not replay a tool call')
  return problems
}

// Lists the problems of one case against the tool definitions (empty when valid).
function caseProblems(evalCase, toolsByName) {
  const problems = []
  const { expected, replay } = evalCase
  if (!evalCase.id || !evalCase.message || !Array.isArray(evalCase.history)) problems.push('needs id, message and history[]')
  if (![...TOOL_KINDS, ...TEXT_KINDS, FOLLOWUP_KIND, NO_WRITE_KIND].includes(expected?.kind)) problems.push(`unknown kind ${expected?.kind}`)
  problems.push(...optionalFieldProblems(evalCase), ...mustNotIncludeProblems(evalCase))
  if (!replay || typeof replay.text !== 'string') problems.push('needs replay.text')

  if (TOOL_KINDS.has(expected?.kind)) {
    const tool = toolsByName.get(expected.tool)
    if (!tool) problems.push(`unknown tool ${expected.tool}`)
    if (tool) problems.push(...unknownArgProblems(expected.args ?? {}, tool))
    if (!expected.args || Object.keys(expected.args).length === 0) problems.push('tool case needs expected.args')
    if (!replay?.toolCall) problems.push('tool case needs replay.toolCall')
    if (tool && replay?.toolCall) {
      const missing = tool.input_schema.required.filter((key) => replay.toolCall.input[key] === undefined)
      if (missing.length > 0) problems.push(`replay input misses required ${missing.join(', ')}`)
    }
    if (expected.kind === 'tool' && !isExplicitConfirmation(evalCase.message)) problems.push('write case must end with a confirmation message')
    if (expected.kind === 'tool' && evalCase.history.length < 2) problems.push('write case needs the proposal in history')
  } else if (expected?.kind === FOLLOWUP_KIND) {
    problems.push(...followupProblems(evalCase))
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

// Tells whether a provider error is worth retrying: rate limit, server error, overload or timeout.
function isRetryableEvalError(err) {
  const status = err?.status
  return Boolean(err?.timedOut) || status === 429 || (typeof status === 'number' && status >= 500)
}

// Computes the wait before retry number `attempt` (1-based): retry-after when given, else exponential, capped.
function retryDelayMs(err, attempt) {
  const retryAfterSeconds = Number(err?.retryAfter)
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) return Math.min(retryAfterSeconds * MS_PER_SECOND, RETRY_MAX_DELAY_MS)
  return Math.min(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1), RETRY_MAX_DELAY_MS)
}

// Waits for the given milliseconds.
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Runs one model call, retrying transient failures with backoff (max 4 attempts); rethrows the last error.
export async function callWithRetry(call, { sleep = wait } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await call()
    } catch (err) {
      if (attempt >= RETRY_MAX_ATTEMPTS || !isRetryableEvalError(err)) throw err
      await sleep(retryDelayMs(err, attempt))
    }
  }
}

// Describes an API failure for the per-case report line.
function describeApiError(err) {
  return `api error${err?.status ? ` ${err.status}` : ''}${err?.timedOut ? ' timeout' : ''}`
}

// Runs a case `runs` times through `ask`; a call that still fails after retries counts as FAIL and the run continues.
export async function scoreCase(evalCase, ask, { runs, sleep } = {}) {
  let passes = 0
  let lastFailure = ''
  for (let run = 0; run < runs; run++) {
    try {
      const verdict = matchesExpected(evalCase.expected, await callWithRetry(() => ask(evalCase), { sleep }))
      if (verdict.pass) passes += 1
      else lastFailure = verdict.reason
    } catch (err) {
      lastFailure = describeApiError(err)
    }
  }
  return { passes, lastFailure }
}

// Converts a case history into saved conversation rows, rebuilding tool turns as rawContent rows; throws on a shape it cannot replay.
export function historyToRows(history) {
  return history.map((entry) => {
    if (typeof entry.content === 'string') return entry
    const blocks = entry.content
    const text = blocks.filter((block) => block.type === 'text').map((block) => block.text).join('')
    if (entry.role === 'assistant' && blocks.some((block) => block.type === 'tool_use')) return { role: 'assistant', content: text, rawContent: blocks }
    if (entry.role === 'user' && blocks.length > 0 && blocks.every((block) => block.type === 'tool_result')) {
      const rawContent = blocks.map((block) => ({ toolCallId: block.tool_use_id, content: block.content }))
      return { role: 'tool_result', content: rawContent.map((result) => result.content).join('\n'), rawContent }
    }
    throw new Error(`history entry cannot be replayed faithfully: ${JSON.stringify(entry).slice(0, 80)}`)
  })
}
