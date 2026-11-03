import 'dotenv/config'
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest'
import { prisma } from '../../src/db.js'
import { setupApp } from '../helpers/setup-app.js'
import { cleanDatabase } from '../helpers/db-cleanup.js'
import { signupVerified } from '../helpers/signup-user.js'
import { searchExerciseLibrary } from '../../src/helpers/exercise-library-search.js'

let emailCounter = 0

// Signs up a user, makes it a trainer and returns the trainer id.
async function createTrainer(app) {
  emailCounter += 1
  const email = `lib-search-${Date.now()}-${emailCounter}@test.com`
  const signupRes = await signupVerified(app, { method: 'POST', url: '/auth/signup', payload: { email, password: 'Test1234!' } })
  const { user: { id: userId }, token: { accessToken } } = signupRes.json()
  await app.inject({ method: 'PATCH', url: '/become-trainer', headers: { authorization: `Bearer ${accessToken}` } })
  const trainer = await prisma.trainer.findUnique({ where: { userId }, select: { id: true } })
  return trainer.id
}

// Creates a template row with sensible defaults.
function template(trainerId, name, overrides = {}) {
  return prisma.exerciseTemplate.create({ data: { trainerId, name, type: 'strength', ...overrides } })
}

describe('e2e: searchExerciseLibrary (real Postgres)', () => {
  let app
  let me
  let other

  beforeAll(async () => { app = await setupApp() })
  afterAll(async () => { if (app) await app.close() })

  beforeEach(async () => {
    await cleanDatabase()
    me = await createTrainer(app)
    other = await createTrainer(app)
  })

  it('matches accents, case, plural and extra words against public templates', async () => {
    await template(other, 'Tríceps testa', { isPublic: true, gifUrl: 'https://g/x.gif' })
    await template(other, 'Rosca martelo', { isPublic: true })

    const triceps = await searchExerciseLibrary(prisma, me, 'TRICEPS testa com barra W')
    expect(triceps).toEqual([{ name: 'Tríceps testa', type: 'strength', hasMedia: true }])

    const rosca = await searchExerciseLibrary(prisma, me, 'Roscas martelo com halteres')
    expect(rosca.map((r) => r.name)).toEqual(['Rosca martelo'])
  })

  it('excludes other trainers private templates and deleted ones, includes own private', async () => {
    await template(other, 'Rosca secreta', { isPublic: false })
    await template(other, 'Rosca apagada', { isPublic: true, deletedAt: new Date() })
    await template(me, 'Rosca minha', { isPublic: false })

    const result = await searchExerciseLibrary(prisma, me, 'rosca')
    expect(result.map((r) => r.name)).toEqual(['Rosca minha'])
  })

  it('ranks media above no media and own above public', async () => {
    await template(other, 'Rosca scott', { isPublic: true })
    await template(other, 'Rosca scott com barra', { isPublic: true, gifUrl: 'https://g/s.gif' })
    await template(me, 'Rosca scott com halter', { isPublic: false })

    const result = await searchExerciseLibrary(prisma, me, 'rosca scott')
    expect(result[0].name).toBe('Rosca scott')
    expect(result.map((r) => r.name)).toContain('Rosca scott com barra')
  })
})
