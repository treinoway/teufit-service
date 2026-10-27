export const USER_ID = 'user-1'
export const TRAINER_ID = 'trainer-1'
export const STUDENT_ID = 'student-1'
export const CONVERSATION_ID = 'conv-1'

// Two prior messages so write tools pass the first-turn enforcement guard.
export const PRIOR_EXCHANGE = [
  { role: 'user', content: 'Crie o protocolo A para a Ana' },
  { role: 'assistant', content: 'Vou criar o protocolo A para a Ana. Confirma?' },
]

// Normalized plain-text provider response.
export function textResponse(text, extra = {}) {
  return {
    stopReason: 'end_turn',
    text,
    toolCalls: [],
    rawContent: [{ type: 'text', text }],
    usage: null,
    ...extra,
  }
}

// Normalized provider response that asks for a single tool call.
export function toolResponse({ id = 'tc-1', name, input = {}, text = '' }) {
  const toolUse = { type: 'tool_use', id, name, input }
  return {
    stopReason: 'tool_use',
    text,
    toolCalls: [{ id, name, input }],
    rawContent: text ? [{ type: 'text', text }, toolUse] : [toolUse],
    usage: null,
  }
}

// Provider stream generator that yields the text, then a complete event.
export function streamOf(response) {
  return async function* () {
    if (response.text) yield { type: 'text_delta', content: response.text }
    yield { type: 'complete', response }
  }
}

// Collects every event of an async generator.
export async function drain(generator) {
  const events = []
  for await (const event of generator) events.push(event)
  return events
}

// Anthropic-shaped tool_result turn builder used by the fake provider.
export function buildToolResultMessages(previousAssistantContent, toolResults) {
  return [
    { role: 'assistant', content: previousAssistantContent },
    {
      role: 'user',
      content: toolResults.map((r) => ({ type: 'tool_result', tool_use_id: r.toolCallId, content: r.content })),
    },
  ]
}

// Stubs every Prisma read buildTrainerContext performs.
export function stubTrainerContext(prisma, overrides = {}) {
  prisma.trainer.findUnique.mockResolvedValue({ id: TRAINER_ID })
  prisma.trainerStudent.findMany.mockResolvedValue(overrides.students ?? [])
  prisma.trainingProtocolTemplate.findMany.mockResolvedValue(overrides.protocolTemplates ?? [])
  prisma.trainingTemplate.findMany.mockResolvedValue(overrides.trainingTemplates ?? [])
  prisma.trainingProtocol.findMany.mockResolvedValue(overrides.activeProtocols ?? [])
  prisma.exerciseTemplate.findMany.mockResolvedValue(overrides.exerciseTemplates ?? [])
}

// Stubs persistence for a brand-new conversation.
export function stubNewConversation(prisma) {
  prisma.aiConversation.create.mockResolvedValue({ id: CONVERSATION_ID, userId: USER_ID, title: null })
  prisma.aiMessage.create.mockResolvedValue({ id: 'msg-1' })
  prisma.aiConversation.update.mockResolvedValue({})
}

// Stubs an existing conversation; messages are given in chronological order.
export function stubExistingConversation(prisma, { messages = PRIOR_EXCHANGE, conversationId = CONVERSATION_ID } = {}) {
  prisma.aiConversation.findUnique.mockResolvedValue({
    id: conversationId,
    userId: USER_ID,
    title: 'Conversa',
    messages: [...messages].reverse(),
  })
  prisma.aiMessage.create.mockResolvedValue({ id: 'msg-2' })
  prisma.aiConversation.update.mockResolvedValue({})
}

// Flattens the system prompt (string or text blocks) into a single string.
export function flattenSystemPrompt(system) {
  return Array.isArray(system) ? system.map((block) => block.text).join('\n') : String(system)
}
