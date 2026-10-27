import { describe, it, expect } from 'vitest'
import { isExplicitConfirmation, lastAssistantAskedForConfirmation } from '../../src/helpers/ai-confirmation.js'

describe('isExplicitConfirmation', () => {
  it.each([
    'confirmar',
    'Fechado',
    'pode sim',
    'yes',
    'sure',
    'go ahead',
    'confirm',
    'Yes, go ahead',
  ])('should accept the additional confirmation "%s"', (message) => {
    expect(isExplicitConfirmation(message)).toBe(true)
  })

  it.each([
    'faz o B em vez disso',
    'pode trocar por crucifixo',
    'pode mudar o treino',
    'altera para 5 séries',
    'nem pensar',
    'pera, deixa eu ver',
    'calma, tá errado',
    'ok, mas errado',
    'wait, not that one',
    'do it instead',
  ])('should reject the hesitation or substitution "%s"', (message) => {
    expect(isExplicitConfirmation(message)).toBe(false)
  })

  it.each([
    'sim',
    'Sim',
    'SIM!',
    'Sim, pode criar',
    'pode fazer',
    'Pode fazer.',
    'confirmo',
    'confirma',
    'ok',
    'Ok, confirma',
    'beleza, manda ver',
    'isso mesmo',
    'Sim, pode ser',
  ])('should accept "%s"', (message) => {
    expect(isExplicitConfirmation(message)).toBe(true)
  })

  it.each([
    'E se fosse com 4 séries?',
    'Quais modelos eu tenho?',
    'Não, cancela isso',
    'não',
    'Hum, deixa eu pensar',
    'Sim, mas troque o supino por remada',
    'ok?',
    'pode fazer isso depois',
    'espera, muda para 5 séries',
    'Sim, pode criar o protocolo completo com todos os exercícios que você listou e mais três de ombro',
    '',
    '   ',
  ])('should reject "%s"', (message) => {
    expect(isExplicitConfirmation(message)).toBe(false)
  })

  it('should ignore accents and case when matching', () => {
    expect(isExplicitConfirmation('NÃO, pode não')).toBe(false)
    expect(isExplicitConfirmation('PÓDE FAZER')).toBe(true)
    expect(isExplicitConfirmation('Faça')).toBe(true)
  })

  it('should not throw on non-string input', () => {
    expect(isExplicitConfirmation(null)).toBe(false)
    expect(isExplicitConfirmation(undefined)).toBe(false)
  })
})

describe('lastAssistantAskedForConfirmation', () => {
  it.each([
    'Vou criar o protocolo A. Confirma?',
    'Posso criar o treino agora?',
    'Quer que eu adicione também a remada?',
    'Please confirm.',
  ])('should detect a confirmation request in "%s"', (content) => {
    expect(lastAssistantAskedForConfirmation([{ role: 'assistant', content }])).toBe(true)
  })

  it.each([
    'Você tem os modelos Full Body e ABC.',
    'Protocolo "A" criado com sucesso!',
    'Qual aluno você quer?',
  ])('should not treat "%s" as a confirmation request', (content) => {
    expect(lastAssistantAskedForConfirmation([{ role: 'assistant', content }])).toBe(false)
  })

  it('should only look at the most recent assistant message', () => {
    const history = [
      { role: 'assistant', content: 'Confirma?' },
      { role: 'user', content: 'sim' },
      { role: 'assistant', content: 'Feito!' },
    ]

    expect(lastAssistantAskedForConfirmation(history)).toBe(false)
  })

  it('should read text blocks of provider-shaped messages', () => {
    const history = [{ role: 'assistant', content: [{ type: 'text', text: 'Posso executar?' }, { type: 'tool_use', id: 'x' }] }]

    expect(lastAssistantAskedForConfirmation(history)).toBe(true)
  })

  it('should be false for an empty or missing history', () => {
    expect(lastAssistantAskedForConfirmation([])).toBe(false)
    expect(lastAssistantAskedForConfirmation(undefined)).toBe(false)
  })
})
