import { LANGFUSE_CONTENT_MODES, AI_TRACE_MASK } from '../constants/ai-tracing.js'

// Redacts the student-focus block and e-mail addresses inside one string.
function maskString(text) {
  return text
    .replace(AI_TRACE_MASK.FOCUS_PATTERN, AI_TRACE_MASK.FOCUS_PLACEHOLDER)
    .replace(AI_TRACE_MASK.EMAIL_PATTERN, AI_TRACE_MASK.EMAIL_PLACEHOLDER)
}

// Deep-copies arrays and plain objects, masking every string leaf.
function maskDeep(value) {
  if (typeof value === 'string') return maskString(value)
  if (Array.isArray(value)) return value.map(maskDeep)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, maskDeep(value[key])]))
  }
  return value
}

// Applies the content mode to trace data: off drops it, full keeps it, masked redacts personal data.
export function maskTraceData(data, mode) {
  if (mode === LANGFUSE_CONTENT_MODES.OFF) return undefined
  if (mode === LANGFUSE_CONTENT_MODES.FULL) return data
  try {
    return maskDeep(data)
  } catch {
    return AI_TRACE_MASK.UNMASKABLE
  }
}

// Redacts the student name of every roster line of the "Alunos ativos" section; null when the format is unknown.
function redactRosterLines(lines) {
  const start = lines.indexOf(AI_TRACE_MASK.ROSTER_HEADER)
  if (start === -1) return null
  const out = [...lines]
  for (let index = start + 1; index < out.length && out[index].trim() !== ''; index++) {
    const line = out[index]
    const match = AI_TRACE_MASK.ROSTER_LINE_PATTERN.exec(line)
    if (match) out[index] = `- ${AI_TRACE_MASK.NAME_PLACEHOLDER} ${match[1]}`
    else if (!AI_TRACE_MASK.ROSTER_NOTE_PATTERNS.some((pattern) => pattern.test(line))) return null
  }
  return out
}

// Redacts roster and assignee names in one trainer-data block, or the whole block when its format is unknown.
function redactRosterBlock(block) {
  const lines = redactRosterLines(block.split('\n'))
  if (!lines) return AI_TRACE_MASK.TRAINER_BLOCK_PLACEHOLDER
  return lines
    .map((line) => line.replace(AI_TRACE_MASK.PROTOCOL_ASSIGNEE_PATTERN, `$1${AI_TRACE_MASK.NAME_PLACEHOLDER}$2`))
    .join('\n')
}

// Redacts student names inside every trainer-data block of a string, keeping the REF ids.
export function redactTrainerRoster(text) {
  return text.replace(AI_TRACE_MASK.ROSTER_BLOCK_PATTERN, redactRosterBlock)
}

// Visits every string leaf of arrays and plain objects.
function forEachString(value, visit) {
  if (typeof value === 'string') visit(value)
  else if (Array.isArray(value)) value.forEach((item) => forEachString(item, visit))
  else if (value && typeof value === 'object') Object.keys(value).forEach((key) => forEachString(value[key], visit))
}

// Splits a student-focus block into the whole text and its substantial lines.
function focusSecrets(inner) {
  const lines = inner.split('\n').map((line) => line.trim())
  return [inner.trim(), ...lines].filter((secret) => secret.length >= AI_TRACE_MASK.MIN_SECRET_CHARS)
}

// Rewrites every string leaf with the given function, copying the structure.
function mapStrings(value, transform) {
  if (typeof value === 'string') return transform(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).map((key) => [key, mapStrings(value[key], transform)]))
  }
  return value
}

// Replaces every known secret in a string.
function replaceSecrets(text, secrets) {
  let result = text
  for (const secret of secrets) result = result.split(secret).join(AI_TRACE_MASK.FOCUS_PLACEHOLDER)
  return result
}

// Creates a per-turn redactor: learns student-focus text from inputs, strips it and roster names from records.
export function createTurnRedactor() {
  const secrets = new Set()
  return (value) => {
    try {
      forEachString(value, (text) => {
        for (const match of text.matchAll(AI_TRACE_MASK.FOCUS_CAPTURE_PATTERN)) focusSecrets(match[1]).forEach((secret) => secrets.add(secret))
      })
      return mapStrings(value, (text) => replaceSecrets(redactTrainerRoster(text), secrets))
    } catch {
      return AI_TRACE_MASK.UNMASKABLE
    }
  }
}
