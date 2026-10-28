import { beforeEach, describe, expect, it } from 'vitest';

import config from '../../config/index.js';
import {
  isLegacyResetCircuitOpen,
  recordLegacyInvalidCode,
  resetLegacyResetCircuit,
} from '../../src/helpers/legacy-reset-circuit.js';

const { maxInvalid, windowMs } = config.auth.legacyResetToken.circuitBreaker;
const NOW = 1_700_000_000_000;

describe('legacy reset circuit breaker', () => {
  beforeEach(() => {
    resetLegacyResetCircuit();
  });

  it('should start closed', () => {
    expect(isLegacyResetCircuitOpen(NOW)).toBe(false);
  });

  it('should stay closed below maxInvalid invalid codes', () => {
    for (let index = 0; index < maxInvalid - 1; index += 1) recordLegacyInvalidCode(NOW);

    expect(isLegacyResetCircuitOpen(NOW)).toBe(false);
  });

  it('should open once maxInvalid invalid codes are recorded inside the window', () => {
    for (let index = 0; index < maxInvalid; index += 1) recordLegacyInvalidCode(NOW + index);

    expect(isLegacyResetCircuitOpen(NOW + maxInvalid)).toBe(true);
  });

  it('should not count invalid codes older than windowMs', () => {
    for (let index = 0; index < maxInvalid - 1; index += 1) recordLegacyInvalidCode(NOW);
    recordLegacyInvalidCode(NOW + windowMs + 1);

    expect(isLegacyResetCircuitOpen(NOW + windowMs + 1)).toBe(false);
  });

  it('should count invalid codes spread across the window as long as all are within windowMs of now', () => {
    for (let index = 0; index < maxInvalid; index += 1) recordLegacyInvalidCode(NOW + index * 1000);

    expect(isLegacyResetCircuitOpen(NOW + windowMs - 1)).toBe(true);
  });

  it('should close again after resetLegacyResetCircuit', () => {
    for (let index = 0; index < maxInvalid; index += 1) recordLegacyInvalidCode(NOW);
    resetLegacyResetCircuit();

    expect(isLegacyResetCircuitOpen(NOW)).toBe(false);
  });
});
