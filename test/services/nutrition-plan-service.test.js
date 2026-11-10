import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/nutritionist-patient-service.js', () => ({ requirePatientLink: vi.fn() }));
vi.mock('../../src/services/nutrition-plan-access.js', () => ({ loadPlanView: vi.fn(), requireOwnedPlan: vi.fn() }));
vi.mock('../../src/services/nutrition-training-activities-service.js', () => ({ suggestActivitiesFromTraining: vi.fn() }));

import { suggestActivitiesFromTraining } from '../../src/services/nutrition-training-activities-service.js';
import { getOrCreatePlan } from '../../src/services/nutrition-plan-service.js';

const NUTRITIONIST_ID = 'nutri-1';
const PATIENT_ID = 'patient-1';
const PLAN_ID = 'plan-1';
const SUGGESTION = { name: 'Musculação', met: 5, minutes: 60, perWeek: 4 };

// Test helper: make prisma.
function makePrisma(existing = null) {
  return {
    dietProtocol: {
      findUnique: vi.fn().mockResolvedValue(existing),
      create: vi.fn().mockResolvedValue({ id: PLAN_ID }),
    },
  };
}

describe('getOrCreatePlan activities prefill', () => {
  beforeEach(() => {
    suggestActivitiesFromTraining.mockResolvedValue({ items: [SUGGESTION] });
  });

  it('should create the draft with training activities included and flagged fromTraining', async () => {
    const prisma = makePrisma();

    await getOrCreatePlan(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(prisma.dietProtocol.create).toHaveBeenCalledWith({
      data: {
        nutritionistId: NUTRITIONIST_ID,
        assigneeId: PATIENT_ID,
        activities: [{ ...SUGGESTION, included: true, fromTraining: true }],
      },
      select: { id: true },
    });
  });

  it('should create the draft with an empty activity list when there is no active protocol', async () => {
    suggestActivitiesFromTraining.mockResolvedValue({ items: [] });
    const prisma = makePrisma();

    await getOrCreatePlan(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(prisma.dietProtocol.create.mock.calls[0][0].data.activities).toEqual([]);
  });

  it('should not suggest activities again when the plan already exists', async () => {
    const prisma = makePrisma({ id: PLAN_ID });

    await getOrCreatePlan(prisma, { nutritionistId: NUTRITIONIST_ID, patientId: PATIENT_ID });

    expect(prisma.dietProtocol.create).not.toHaveBeenCalled();
    expect(suggestActivitiesFromTraining).not.toHaveBeenCalled();
  });
});
