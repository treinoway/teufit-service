// Returns the exercise the student actually performed: the substitute when the log was substituted.
export function resolveEffectiveExerciseId(exerciseLog) {
  return exerciseLog.substitutedByExerciseId ?? exerciseLog.exerciseId;
}

// Tells whether a set can compete for best set: completed with both load and repetitions.
function isRankableSet(set) {
  return set.completed === true && set.load != null && set.repetitions != null;
}

// Tells whether the candidate beats the current best: higher tonnage, then higher load, then lower setNumber.
function beatsBest(candidate, best) {
  if (best === null) return true;
  if (candidate.tonnage !== best.tonnage) return candidate.tonnage > best.tonnage;
  if (candidate.load !== best.load) return candidate.load > best.load;
  return candidate.setNumber < best.setNumber;
}

// Maps a rankable set to the best-set shape with its tonnage (load × repetitions).
function toBestSetCandidate(set) {
  return {
    setNumber: set.setNumber,
    load: set.load,
    repetitions: set.repetitions,
    duration: set.duration ?? null,
    rpe: set.rpe ?? null,
    restSeconds: set.restSeconds ?? null,
    completed: true,
    tonnage: set.load * set.repetitions,
  };
}

/**
 * Picks the completed set with the highest tonnage (load × repetitions), or null when none qualifies.
 * @param {Array<{setNumber:number, repetitions:number|null, load:number|null, duration?:number|null, rpe?:number|null, restSeconds?:number|null, completed?:boolean}>} sets
 * @returns {{setNumber:number, load:number, repetitions:number, duration:number|null, rpe:number|null, restSeconds:number|null, completed:boolean, tonnage:number}|null}
 */
export function computeBestSet(sets) {
  if (!Array.isArray(sets)) return null;
  return sets
    .filter(isRankableSet)
    .map(toBestSetCandidate)
    .reduce((best, candidate) => (beatsBest(candidate, best) ? candidate : best), null);
}
