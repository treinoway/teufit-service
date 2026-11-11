// Summarizes a tool result into the short shape the model needs (the raw Prisma response can be huge).
export function summarizeToolResult(toolResult) {
  if (!toolResult.success) {
    return {
      success: false,
      error: toolResult.error,
      message: toolResult.message,
    };
  }

  const data = toolResult.data;
  if (!data) return { success: true };

  if (data.trainings && Array.isArray(data.trainings)) {
    return {
      success: true,
      name: data.name,
      type: data.type,
      trainingsCount: data.trainings.length,
      trainings: data.trainings.map((t) => ({
        name: t.trainingTemplate?.name || t.name,
        weekDay: t.weekDay,
        exercisesCount: t.trainingTemplate?.trainingTemplateExerciseTemplates?.length ?? null,
        exercises: t.trainingTemplate?.trainingTemplateExerciseTemplates?.map((e) => ({
          name: e.name || e.exerciseTemplate?.name || "exercício",
          sets: e.sets ?? null,
          repetitions: e.repetitions ?? null,
          restInterval: e.restInterval ?? null,
          hasLoad: e.hasLoad ?? null,
          suggestedLoad: e.suggestedLoad ?? null,
        })) ?? [],
      })),
    };
  }

  if (
    data.trainingTemplateExerciseTemplates &&
    Array.isArray(data.trainingTemplateExerciseTemplates)
  ) {
    return {
      success: true,
      name: data.name,
      category: data.category,
      exercisesCount: data.trainingTemplateExerciseTemplates.length,
      exercises: data.trainingTemplateExerciseTemplates.map((e) => ({
        name: e.name || e.exerciseTemplate?.name || "exercício",
        sets: e.sets ?? null,
        repetitions: e.repetitions ?? null,
        restInterval: e.restInterval ?? null,
        hasLoad: e.hasLoad ?? null,
        suggestedLoad: e.suggestedLoad ?? null,
      })),
    };
  }

  if (data.sessionCounts && typeof data.sessionCounts === 'object') {
    return {
      success: true,
      studentId: data.studentId,
      studentName: data.studentName,
      window: data.window,
      sessionCounts: data.sessionCounts,
      totalSessions: data.totalSessions,
      completionRate: data.completionRate,
      lastSessionAt: data.lastSessionAt,
      currentProtocol: data.currentProtocol,
      topExercises: (data.topExercises ?? []).map((e) => ({
        exerciseId: e.exerciseId,
        name: e.name,
        hasLoad: e.hasLoad,
        sessionCount: e.sessionCount,
        lastPerformedAt: e.lastPerformedAt,
        latestMaxLoad: e.latestMaxLoad,
        latestAvgLoad: e.latestAvgLoad,
        latestTotalVolume: e.latestTotalVolume,
        maxLoadDelta: e.maxLoadDelta,
        maxLoadDeltaPct: e.maxLoadDeltaPct,
      })),
    };
  }

  if (Array.isArray(data.results)) {
    return { success: true, results: data.results };
  }

  return {
    success: true,
    name: data.name,
    id: data.id,
  };
}
