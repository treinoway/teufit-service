// Runs a best-effort task after a committed side effect; failures are logged, never propagated.
export async function runNonCritical(label, task) {
  try {
    await task();
  } catch (error) {
    console.error(`${label} failed (non-critical): ${error.message}`);
  }
}
