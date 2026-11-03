import { describe, it, expect, vi } from 'vitest'
import { exerciseSearchTokens, searchExerciseLibrary } from '../../src/helpers/exercise-library-search.js'

const TRAINER_ID = 'trainer-1'

// Builds a prisma double whose raw query returns the given rows.
function prismaWith(rows) {
  return { $queryRaw: vi.fn().mockResolvedValue(rows) }
}

// Builds a candidate row as the SQL prefilter returns it.
function row(name, { hasMedia = false, own = false } = {}) {
  return { name, type: 'strength', hasMedia, own, dbScore: 1 }
}

describe('exerciseSearchTokens', () => {
  it('drops accents, case, connectors and one-letter tokens', () => {
    expect(exerciseSearchTokens('Tríceps testa com barra W').sort()).toEqual(['barra', 'testa', 'tricep'])
  })

  it('stems simple Portuguese plurals on both sides', () => {
    expect(exerciseSearchTokens('halteres')).toEqual(exerciseSearchTokens('halter'))
    expect(exerciseSearchTokens('barras')).toEqual(exerciseSearchTokens('barra'))
    expect(exerciseSearchTokens('extensões')).toEqual(exerciseSearchTokens('extensão'))
  })
})

describe('searchExerciseLibrary', () => {
  it('returns [] without querying when the query has no significant token', async () => {
    const prisma = prismaWith([])
    expect(await searchExerciseLibrary(prisma, TRAINER_ID, 'com a')).toEqual([])
    expect(prisma.$queryRaw).not.toHaveBeenCalled()
  })

  it('builds a trainer-scoped, non-deleted, accent-tolerant query', async () => {
    const prisma = prismaWith([])
    await searchExerciseLibrary(prisma, TRAINER_ID, 'triceps')

    const sql = prisma.$queryRaw.mock.calls[0][0]
    expect(sql.sql).toContain('deleted_at IS NULL')
    expect(sql.sql).toMatch(/trainer_id = [?$]/)
    expect(sql.sql).toContain('is_public = true')
    expect(sql.values).toContain(TRAINER_ID)
    expect(sql.values.some((v) => typeof v === 'string' && v.includes('[iíìîï]'))).toBe(true)
  })

  it('finds a library name when the query differs by plural, accent and extra words', async () => {
    const prisma = prismaWith([row('Rosca concentrada'), row('Rosca martelo')])
    const result = await searchExerciseLibrary(prisma, TRAINER_ID, 'Rosca concentrada com halteres')
    expect(result[0]).toEqual({ name: 'Rosca concentrada', type: 'strength', hasMedia: false })
  })

  it('ignores word order', async () => {
    const prisma = prismaWith([row('Barra reta tríceps polia')])
    const result = await searchExerciseLibrary(prisma, TRAINER_ID, 'Tríceps na polia com barra reta')
    expect(result.map((r) => r.name)).toEqual(['Barra reta tríceps polia'])
  })

  it('drops candidates sharing fewer than half of the query words', async () => {
    const prisma = prismaWith([row('Banco inclinado'), row('Mergulho no banco')])
    const result = await searchExerciseLibrary(prisma, TRAINER_ID, 'Mergulho no banco')
    expect(result.map((r) => r.name)).toEqual(['Mergulho no banco', 'Banco inclinado'])
    const strict = await searchExerciseLibrary(prismaWith([row('Banco inclinado')]), TRAINER_ID, 'Rosca martelo com halter banco')
    expect(strict).toEqual([])
  })

  it('ranks relevance first, then media, then own over public', async () => {
    const prisma = prismaWith([
      row('Rosca direta com barra EZ extra', { hasMedia: true }),
      row('Rosca direta', { hasMedia: false, own: false }),
      row('Rosca direta com barra', { hasMedia: true, own: false }),
      row('Rosca direta com barra reta', { hasMedia: true, own: true }),
    ])
    const result = await searchExerciseLibrary(prisma, TRAINER_ID, 'Rosca direta barra')
    expect(result.map((r) => r.name)).toEqual([
      'Rosca direta com barra',
      'Rosca direta com barra reta',
      'Rosca direta com barra EZ extra',
      'Rosca direta',
    ])
  })

  it('prefers media then own among same-name duplicates and keeps one', async () => {
    const prisma = prismaWith([
      row('Rosca martelo', { hasMedia: false, own: true }),
      row('Rosca Martelo', { hasMedia: true, own: false }),
    ])
    const result = await searchExerciseLibrary(prisma, TRAINER_ID, 'rosca martelo')
    expect(result).toEqual([{ name: 'Rosca Martelo', type: 'strength', hasMedia: true }])
  })

  it('caps the results', async () => {
    const rows = Array.from({ length: 9 }, (_, i) => row(`Rosca variação ${i}`))
    const result = await searchExerciseLibrary(prismaWith(rows), TRAINER_ID, 'rosca', { maxResults: 3 })
    expect(result).toHaveLength(3)
  })
})
