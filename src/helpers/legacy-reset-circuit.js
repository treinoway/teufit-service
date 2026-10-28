import config from '../../config/index.js';

let invalidCodeTimestamps = [];
let circuitOpen = false;

// Records one invalid legacy code; returns true only when this call trips the breaker.
export function recordLegacyInvalidCode(now = Date.now()) {
  const { maxInvalid, windowMs } = config.auth.legacyResetToken.circuitBreaker;
  invalidCodeTimestamps = invalidCodeTimestamps.filter((timestamp) => timestamp > now - windowMs);
  invalidCodeTimestamps.push(now);
  if (circuitOpen || invalidCodeTimestamps.length < maxInvalid) return false;
  circuitOpen = true;
  return true;
}

// Whether the breaker has tripped (it stays open until reset or restart).
export function isLegacyResetCircuitOpen() {
  return circuitOpen;
}

// Closes the breaker and forgets recorded invalid codes.
export function resetLegacyResetCircuit() {
  invalidCodeTimestamps = [];
  circuitOpen = false;
}
