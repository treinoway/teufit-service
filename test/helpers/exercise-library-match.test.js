import { describe, it, expect, vi } from 'vitest'
import {
  addToExerciseLibraryIndex,
  findLibraryExercise,
  libraryExerciseFields,
  loadExerciseLibraryIndex,
} from '../../src/helpers/exercise-library-match.js'

const TRAINER_ID = 'trainer-1'
const OTHER_TRAINER_ID = 'admin-trainer'

// Builds an index from templates already in ranking order (most recent first).
function indexOf(templates) {
  const index = { trainerId: TRAINER_ID, byName: new Map() }
  templates.forEach((t) => addToExerciseLibraryIndex(index, t))
  return index
}

describe('exercise-library-match', () => {
  describe('loadExerciseLibraryIndex', () => {
    it('queries the trainer own and public non-deleted templates', async () => {
      const prisma = { exerciseTemplate: { findMany: vi.fn().mockResolvedValue([]) } }

      await loadExerciseLibraryIndex(prisma, TRAINER_ID)

      expect(prisma.exerciseTemplate.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { deletedAt: null, OR: [{ trainerId: TRAINER_ID }, { isPublic: true }] },
          select: expect.objectContaining({ advancedTechniqueLinks: { select: { advancedTechniqueId: true, order: true } } }),
        }),
      )
    })
  })

  describe('findLibraryExercise', () => {
    it('matches ignoring case, accents and connector words', () => {
      const template = { id: 't1', trainerId: OTHER_TRAINER_ID, name: 'Elevação pélvica com barra', gifUrl: 'g' }
      const index = indexOf([template])

      expect(findLibraryExercise(index, 'elevacao pelvica barra')).toBe(template)
      expect(findLibraryExercise(index, 'ELEVAÇÃO PÉLVICA COM BARRA')).toBe(template)
    })

    it('returns null when no template matches', () => {
      const index = indexOf([{ id: 't1', trainerId: TRAINER_ID, name: 'Supino reto' }])

      expect(findLibraryExercise(index, 'Supino inclinado')).toBeNull()
    })

    it('prefers a template with media over one without, regardless of owner', () => {
      const ownWithoutMedia = { id: 'own', trainerId: TRAINER_ID, name: 'Supino reto', videoUrl: null, gifUrl: null }
      const publicWithGif = { id: 'pub', trainerId: OTHER_TRAINER_ID, name: 'Supino reto', videoUrl: null, gifUrl: 'g' }

      expect(findLibraryExercise(indexOf([ownWithoutMedia, publicWithGif]), 'Supino reto').id).toBe('pub')
    })

    it('prefers the trainer own template when both have media', () => {
      const publicWithGif = { id: 'pub', trainerId: OTHER_TRAINER_ID, name: 'Supino reto', gifUrl: 'g' }
      const ownWithVideo = { id: 'own', trainerId: TRAINER_ID, name: 'Supino reto', videoUrl: 'v' }

      expect(findLibraryExercise(indexOf([publicWithGif, ownWithVideo]), 'Supino reto').id).toBe('own')
    })

    it('keeps the first (most recent) template on a ranking tie', () => {
      const newer = { id: 'newer', trainerId: TRAINER_ID, name: 'Supino reto', gifUrl: 'g1' }
      const older = { id: 'older', trainerId: TRAINER_ID, name: 'Supino reto', gifUrl: 'g2' }

      expect(findLibraryExercise(indexOf([newer, older]), 'Supino reto').id).toBe('newer')
    })
  })

  describe('libraryExerciseFields', () => {
    it('returns the template link and media of a match', () => {
      const match = { id: 't1', trainerId: OTHER_TRAINER_ID, name: 'Agachamento livre', videoUrl: 'v', gifUrl: 'g' }

      expect(libraryExerciseFields(match)).toEqual({ exerciseTemplateId: 't1', videoUrl: 'v', gifUrl: 'g' })
    })

    it('returns no fields without a match', () => {
      expect(libraryExerciseFields(null)).toEqual({})
    })
  })
})
