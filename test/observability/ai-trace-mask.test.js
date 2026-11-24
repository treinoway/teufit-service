import { describe, it, expect } from 'vitest'
import { maskTraceData } from '../../src/observability/ai-trace-mask.js'

const FOCUS_OPEN = '<dados_do_aluno_em_foco>'
const FOCUS_CLOSE = '</dados_do_aluno_em_foco>'
const FOCUS_PLACEHOLDER = '[redacted: student focus]'
const EMAIL_PLACEHOLDER = '[redacted: email]'
const UNMASKABLE = '[unmaskable]'
const HEALTH_TEXT = 'Ana tem hernia de disco e toma losartana'

// Wraps text in the student-focus block the system prompt uses.
function focusBlock(text) {
  return `${FOCUS_OPEN}${text}${FOCUS_CLOSE}`
}

describe('maskTraceData off mode (AC 10)', () => {
  it('should return undefined so no input or output is exported', () => {
    expect(maskTraceData({ messages: ['oi'] }, 'off')).toBeUndefined()
  })
})

describe('maskTraceData full mode (AC 10)', () => {
  it('should return the data unchanged', () => {
    const data = { system: focusBlock(HEALTH_TEXT), email: 'ana@example.com' }

    expect(maskTraceData(data, 'full')).toEqual(data)
  })
})

describe('maskTraceData masked mode student focus (AC 10)', () => {
  it('should replace the content between the focus tags with the placeholder', () => {
    const masked = maskTraceData(`antes ${focusBlock(HEALTH_TEXT)} depois`, 'masked')

    expect(masked).toBe(`antes ${FOCUS_PLACEHOLDER} depois`)
  })

  it('should redact a focus block spanning several lines', () => {
    const masked = maskTraceData(focusBlock(`linha 1\nlinha 2\n${HEALTH_TEXT}`), 'masked')

    expect(masked).not.toContain(HEALTH_TEXT)
  })

  it('should redact every focus block in the same string', () => {
    const masked = maskTraceData(`${focusBlock('segredo-1')} e ${focusBlock('segredo-2')}`, 'masked')

    expect(masked).toBe(`${FOCUS_PLACEHOLDER} e ${FOCUS_PLACEHOLDER}`)
  })

  it('should leave text outside the focus block untouched', () => {
    const masked = maskTraceData('Crie o protocolo A para a Ana', 'masked')

    expect(masked).toBe('Crie o protocolo A para a Ana')
  })
})

describe('maskTraceData masked mode e-mail addresses (AC 10)', () => {
  it('should replace an e-mail address with the placeholder', () => {
    expect(maskTraceData('fale com ana.lima+gym@example.com.br hoje', 'masked')).toBe(`fale com ${EMAIL_PLACEHOLDER} hoje`)
  })

  it('should replace every e-mail address in the string', () => {
    expect(maskTraceData('a@x.com e b@y.org', 'masked')).toBe(`${EMAIL_PLACEHOLDER} e ${EMAIL_PLACEHOLDER}`)
  })
})

describe('maskTraceData masked mode structure', () => {
  it('should mask strings nested in objects and arrays', () => {
    const data = {
      system: [{ type: 'text', text: focusBlock(HEALTH_TEXT) }],
      messages: [{ role: 'user', content: 'meu email e ana@example.com' }],
    }

    const masked = maskTraceData(data, 'masked')

    expect(masked).toEqual({
      system: [{ type: 'text', text: FOCUS_PLACEHOLDER }],
      messages: [{ role: 'user', content: `meu email e ${EMAIL_PLACEHOLDER}` }],
    })
  })

  it('should not mutate the original data', () => {
    const data = { content: 'ana@example.com' }

    maskTraceData(data, 'masked')

    expect(data).toEqual({ content: 'ana@example.com' })
  })

  it('should preserve non-string values', () => {
    const data = { count: 3, ok: true, none: null, list: [1, 2] }

    expect(maskTraceData(data, 'masked')).toEqual(data)
  })

  it('should never throw and return the unmaskable marker when masking fails', () => {
    const hostile = {
      get boom() {
        throw new Error('getter exploded')
      },
    }

    expect(maskTraceData(hostile, 'masked')).toBe(UNMASKABLE)
  })
})
