/**
 * Jev symptom-taxonomy contract: the symptom family set must distinguish an INTERNAL appliance
 * thermal-protection event (overheating: thermal fuse / cut-out / overheat thermostat opening) from
 * the HOUSEHOLD supply tripping (trips_electrics: RCD / breaker / consumer unit / earth-leakage).
 * Deterministic contract assertions only — the semantic classification itself is validated against
 * the deployed Jev model + the active GOLD suite, not here. No customer-text parsing is involved.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SYMPTOM_FAMILIES, buildQuestions } = require('../jev-understand.js');

describe('symptom taxonomy: thermal protection vs household trip', () => {
  const questions = buildQuestions({});
  const criteria = questions.symptomFamily.criteria;
  const instructions = questions.symptomFamily.instructions;

  it('exposes a distinct overheating / thermal-protection symptom family', () => {
    expect(SYMPTOM_FAMILIES).toContain('overheating');
    expect(SYMPTOM_FAMILIES).toContain('trips_electrics');
    expect(criteria.overheating).toBeTruthy();
  });

  it('overheating criterion describes an internal thermal protective device, not the mains', () => {
    expect(/thermal (fuse|cut-?out)|overheat/i.test(criteria.overheating)).toBe(true);
    expect(/internal|protect/i.test(criteria.overheating)).toBe(true);
  });

  it('trips_electrics criterion is scoped to the household supply and excludes the internal fuse', () => {
    expect(/rcd|breaker|consumer unit|fuse box|household|mains/i.test(criteria.trips_electrics)).toBe(true);
    expect(/not an internal appliance thermal|that is overheating/i.test(criteria.trips_electrics)).toBe(true);
  });

  it('the question instructions tell the model to judge by meaning, not the words fuse/trip', () => {
    expect(/not by the words/i.test(instructions)).toBe(true);
    expect(/overheating/i.test(instructions) && /trips_electrics/i.test(instructions)).toBe(true);
  });

  it('overheating and trips_electrics have genuinely different descriptions', () => {
    expect(criteria.overheating).not.toEqual(criteria.trips_electrics);
  });
});
