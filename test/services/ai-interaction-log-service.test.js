import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  writeInteractionLog,
  isInteractionLogEnabled,
  extractTokenCounts,
} from '../../src/services/ai-interaction-log-service.js'
import { AI_INTERACTION_LOG } from '../../src/constants/ai.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePrisma(overrides = {}) {
  return {
    aiInteractionLog: {
      create: vi.fn().mockResolvedValue({ id: 'log-uuid' }),
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// isInteractionLogEnabled
// ---------------------------------------------------------------------------

describe('isInteractionLogEnabled', () => {
  afterEach(() => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
  })

  it('returns true when the env flag is not set (default ON)', () => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
    expect(isInteractionLogEnabled()).toBe(true)
  })

  it('returns false when AI_INTERACTION_LOG_ENABLED=false', () => {
    process.env[AI_INTERACTION_LOG.ENV_FLAG] = 'false'
    expect(isInteractionLogEnabled()).toBe(false)
  })

  it('returns false case-insensitively (FALSE)', () => {
    process.env[AI_INTERACTION_LOG.ENV_FLAG] = 'FALSE'
    expect(isInteractionLogEnabled()).toBe(false)
  })

  it('returns true when set to any non-false string', () => {
    process.env[AI_INTERACTION_LOG.ENV_FLAG] = 'true'
    expect(isInteractionLogEnabled()).toBe(true)
  })

  it('returns true when set to "1"', () => {
    process.env[AI_INTERACTION_LOG.ENV_FLAG] = '1'
    expect(isInteractionLogEnabled()).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// extractTokenCounts
// ---------------------------------------------------------------------------

describe('extractTokenCounts', () => {
  it('returns nulls for null input', () => {
    expect(extractTokenCounts(null)).toEqual({ inputTokens: null, outputTokens: null })
  })

  it('returns nulls for undefined input', () => {
    expect(extractTokenCounts(undefined)).toEqual({ inputTokens: null, outputTokens: null })
  })

  it('parses Anthropic usage shape (input_tokens / output_tokens)', () => {
    const usage = { input_tokens: 150, output_tokens: 300, cache_read_input_tokens: 50 }
    expect(extractTokenCounts(usage)).toEqual({ inputTokens: 150, outputTokens: 300 })
  })

  it('parses Gemini usage shape (promptTokenCount / candidatesTokenCount)', () => {
    const usage = { promptTokenCount: 200, candidatesTokenCount: 400 }
    expect(extractTokenCounts(usage)).toEqual({ inputTokens: 200, outputTokens: 400 })
  })

  it('returns nulls for an empty object (unknown shape)', () => {
    expect(extractTokenCounts({})).toEqual({ inputTokens: null, outputTokens: null })
  })

  it('handles partial Anthropic shape with missing output_tokens', () => {
    const usage = { input_tokens: 100 }
    expect(extractTokenCounts(usage)).toEqual({ inputTokens: 100, outputTokens: null })
  })
})

// ---------------------------------------------------------------------------
// writeInteractionLog — success path
// ---------------------------------------------------------------------------

describe('writeInteractionLog — success path (flag ON)', () => {
  beforeEach(() => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
  })

  it('inserts a row with correct fields on a successful chat turn', async () => {
    const prisma = makePrisma()

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: null,
      conversationId: 'conv-uuid',
      action: 'chat',
      userMessage: 'Quero criar um treino de peito',
      toolCall: null,
      responseText: 'Claro! O que você precisa?',
      model: 'claude-sonnet-4-6',
      usage: null,
      latencyMs: 1200,
      status: AI_INTERACTION_LOG.STATUS_SUCCESS,
      errorCode: null,
    })

    expect(prisma.aiInteractionLog.create).toHaveBeenCalledOnce()
    const { data } = prisma.aiInteractionLog.create.mock.calls[0][0]

    expect(data.trainerId).toBe('trainer-uuid')
    expect(data.studentId).toBeNull()
    expect(data.conversationId).toBe('conv-uuid')
    expect(data.action).toBe('chat')
    expect(data.userMessage).toBe('Quero criar um treino de peito')
    expect(data.toolsUsed).toBeNull()
    expect(data.responseText).toBe('Claro! O que você precisa?')
    expect(data.model).toBe('claude-sonnet-4-6')
    expect(data.inputTokens).toBeNull()
    expect(data.outputTokens).toBeNull()
    expect(data.latencyMs).toBe(1200)
    expect(data.status).toBe('success')
    expect(data.errorCode).toBeNull()
  })

  it('inserts a row with toolsUsed summary when a tool was executed', async () => {
    const prisma = makePrisma()

    const toolCall = {
      name: 'create_training_template',
      input: {
        name: 'Treino Peito',
        category: 'strength',
        exercises: [{ name: 'Supino', type: 'strength', sets: 3 }],
      },
    }

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: 'student-uuid',
      conversationId: 'conv-uuid',
      action: 'create_training_template',
      userMessage: 'Cria treino de peito com supino',
      toolCall,
      responseText: 'Treino criado!',
      model: 'claude-sonnet-4-6',
      usage: { input_tokens: 500, output_tokens: 120 },
      latencyMs: 2500,
      status: AI_INTERACTION_LOG.STATUS_SUCCESS,
      errorCode: null,
    })

    expect(prisma.aiInteractionLog.create).toHaveBeenCalledOnce()
    const { data } = prisma.aiInteractionLog.create.mock.calls[0][0]

    expect(data.studentId).toBe('student-uuid')
    expect(data.action).toBe('create_training_template')
    // toolsUsed must be an array with one entry summarising the tool call
    expect(Array.isArray(data.toolsUsed)).toBe(true)
    expect(data.toolsUsed[0].name).toBe('create_training_template')
    // args summary must mention category but NOT the name (PII-bearing field)
    expect(data.toolsUsed[0].argsSummary).toContain('category=strength')
    expect(data.toolsUsed[0].argsSummary).not.toContain('name=')
    // Token counts parsed from Anthropic usage shape
    expect(data.inputTokens).toBe(500)
    expect(data.outputTokens).toBe(120)
    expect(data.status).toBe('success')
  })

  it('truncates userMessage and responseText that exceed MAX_TEXT_LENGTH', async () => {
    const prisma = makePrisma()
    const longText = 'x'.repeat(AI_INTERACTION_LOG.MAX_TEXT_LENGTH + 500)

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: null,
      conversationId: null,
      action: 'chat',
      userMessage: longText,
      toolCall: null,
      responseText: longText,
      model: 'gemini-2.5-flash',
      usage: null,
      latencyMs: 800,
      status: AI_INTERACTION_LOG.STATUS_SUCCESS,
      errorCode: null,
    })

    const { data } = prisma.aiInteractionLog.create.mock.calls[0][0]
    expect(data.userMessage.length).toBe(AI_INTERACTION_LOG.MAX_TEXT_LENGTH)
    expect(data.responseText.length).toBe(AI_INTERACTION_LOG.MAX_TEXT_LENGTH)
  })
})

// ---------------------------------------------------------------------------
// writeInteractionLog — error path
// ---------------------------------------------------------------------------

describe('writeInteractionLog — error path (flag ON)', () => {
  beforeEach(() => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
  })

  it('inserts a row with status=error and errorCode when tool execution failed', async () => {
    const prisma = makePrisma()

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: null,
      conversationId: 'conv-uuid',
      action: 'create_training_template',
      userMessage: 'Cria treino',
      toolCall: { name: 'create_training_template', input: { category: 'strength' } },
      responseText: 'Não foi possível executar a ação.',
      model: 'claude-sonnet-4-6',
      usage: null,
      latencyMs: 900,
      status: AI_INTERACTION_LOG.STATUS_ERROR,
      errorCode: 'AI_EXERCISE_TEMPLATE_NOT_OWNED',
    })

    expect(prisma.aiInteractionLog.create).toHaveBeenCalledOnce()
    const { data } = prisma.aiInteractionLog.create.mock.calls[0][0]

    expect(data.status).toBe('error')
    expect(data.errorCode).toBe('AI_EXERCISE_TEMPLATE_NOT_OWNED')
  })
})

// ---------------------------------------------------------------------------
// writeInteractionLog — flag OFF
// ---------------------------------------------------------------------------

describe('writeInteractionLog — flag OFF', () => {
  beforeEach(() => {
    process.env[AI_INTERACTION_LOG.ENV_FLAG] = 'false'
  })

  afterEach(() => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
  })

  it('does NOT insert any row when the feature flag is disabled', async () => {
    const prisma = makePrisma()

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: null,
      conversationId: null,
      action: 'chat',
      userMessage: 'hello',
      toolCall: null,
      responseText: 'hi',
      model: 'claude-sonnet-4-6',
      usage: null,
      latencyMs: 100,
      status: AI_INTERACTION_LOG.STATUS_SUCCESS,
      errorCode: null,
    })

    expect(prisma.aiInteractionLog.create).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// writeInteractionLog — resilience: logging failure must NOT propagate
// ---------------------------------------------------------------------------

describe('writeInteractionLog — resilience', () => {
  beforeEach(() => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
  })

  it('swallows DB errors and does not throw', async () => {
    const prisma = makePrisma({
      create: vi.fn().mockRejectedValue(new Error('DB connection lost')),
    })

    // This must resolve without throwing
    await expect(
      writeInteractionLog(prisma, {
        trainerId: 'trainer-uuid',
        studentId: null,
        conversationId: null,
        action: 'chat',
        userMessage: 'test',
        toolCall: null,
        responseText: 'response',
        model: 'claude-sonnet-4-6',
        usage: null,
        latencyMs: 100,
        status: AI_INTERACTION_LOG.STATUS_SUCCESS,
        errorCode: null,
      }),
    ).resolves.toBeUndefined()
  })

  it('still logs a warning to console.warn when DB write fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prisma = makePrisma({
      create: vi.fn().mockRejectedValue(new Error('timeout')),
    })

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: null,
      conversationId: null,
      action: 'chat',
      userMessage: 'test',
      toolCall: null,
      responseText: 'response',
      model: 'claude-sonnet-4-6',
      usage: null,
      latencyMs: 100,
      status: AI_INTERACTION_LOG.STATUS_SUCCESS,
      errorCode: null,
    })

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[AI][interaction-log]'),
      expect.stringContaining('timeout'),
    )
    warnSpy.mockRestore()
  })
})

// ---------------------------------------------------------------------------
// PII field redaction in toolsUsed summary
// ---------------------------------------------------------------------------

describe('writeInteractionLog — PII redaction in toolsUsed', () => {
  beforeEach(() => {
    delete process.env[AI_INTERACTION_LOG.ENV_FLAG]
  })

  it('excludes PII-bearing fields (name, notes, description, assigneeId, studentId) from argsSummary', async () => {
    const prisma = makePrisma()

    const toolCall = {
      name: 'import_from_template',
      input: {
        assigneeId: 'student-secret-uuid',
        templateId: 'template-uuid',
        startDate: '2026-06-14',
        name: 'Rotina do João',
        notes: 'Personal notes here',
      },
    }

    await writeInteractionLog(prisma, {
      trainerId: 'trainer-uuid',
      studentId: 'student-uuid',
      conversationId: 'conv-uuid',
      action: 'import_from_template',
      userMessage: 'importa protocolo para João',
      toolCall,
      responseText: 'Protocolo criado!',
      model: 'claude-sonnet-4-6',
      usage: null,
      latencyMs: 700,
      status: AI_INTERACTION_LOG.STATUS_SUCCESS,
      errorCode: null,
    })

    const { data } = prisma.aiInteractionLog.create.mock.calls[0][0]
    const summary = data.toolsUsed[0].argsSummary

    // Must NOT leak PII fields
    expect(summary).not.toContain('assigneeId')
    expect(summary).not.toContain('student-secret-uuid')
    expect(summary).not.toContain('name=')
    expect(summary).not.toContain('notes')
    expect(summary).not.toContain('Personal notes')

    // Non-PII fields should be present
    expect(summary).toContain('templateId=template-uuid')
    expect(summary).toContain('startDate=2026-06-14')
  })
})
