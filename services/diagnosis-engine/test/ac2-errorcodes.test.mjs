/**
 * ac2 error-code catalogue tool: lookup semantics, normalisation, fallback, free-text token spotting, and the
 * exported data staying in sync with the banked runtime mappings (error-codes/runtime-model/generated/runtime).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { expectedText, OUT_PATH, MAPPINGS_PATH } from '../../../error-codes/tools/export-engine-catalogue.mjs';

const require = createRequire(import.meta.url);
const EC = require('../ac2/errorcodes.js');
const DATA = require('../ac2/data/error-codes.json');

const one = (r) => r.candidates[0];

describe('exported catalogue', () => {
  it('is in sync with mappings.json (regenerate: node error-codes/tools/export-engine-catalogue.mjs)', () => {
    expect(readFileSync(OUT_PATH, 'utf8')).toBe(expectedText());
  });

  it('keeps every banked record under a unique id (no record lost to a shared mappingId)', () => {
    const mappings = JSON.parse(readFileSync(MAPPINGS_PATH, 'utf8'));
    expect(DATA.records).toHaveLength(mappings.length);
    expect(new Set(DATA.records.map((r) => r.id)).size).toBe(DATA.records.length);
    expect(DATA.records.filter((r) => r.id.startsWith('BSH_OVEN_E::default::E011')).map((r) => r.id).sort())
      .toEqual(['BSH_OVEN_E::default::E011@bsh-oven', 'BSH_OVEN_E::default::E011@tecnik-oven']);
  });

  it('refuses duplicate ids', () => {
    const r = DATA.records[0];
    expect(() => EC.assertUniqueIds([r, { ...r }])).toThrow(/duplicate/);
    expect(EC.assertUniqueIds(DATA.records)).toBe(true);
  });
});

describe('lookup', () => {
  it('Bosch oven E011 is the BSH record, not the Tecnik one', () => {
    const r = EC.lookup({ code: 'E011', brand: 'Bosch', appliance: 'oven-cooker' });
    expect(r.status).toBe('RESOLVED');
    expect(r.candidates).toHaveLength(1);
    expect(one(r).ids).toEqual(['BSH_OVEN_E::default::E011@bsh-oven']);
    expect(one(r).brands).toContain('bosch');
    expect(one(r).brands).not.toContain('tecnik');
    expect(one(r).meaning).toMatch(/disputed/i);
    expect(r.disputed).toBe(true);
    expect(one(r).appliances).toEqual(['oven-cooker']);
  });

  it('Tecnik oven E011 is the Tecnik record', () => {
    const r = EC.lookup({ code: 'E011', brand: 'tecnik', appliance: 'cooker-oven' });
    expect(r.status).toBe('RESOLVED');
    expect(one(r).ids).toEqual(['BSH_OVEN_E::default::E011@tecnik-oven']);
    expect(one(r).meaning).toMatch(/stuck key/i);
  });

  it('Samsung washing machine 4C is a water-supply fault', () => {
    const r = EC.lookup({ code: '4C', brand: 'Samsung', appliance: 'washing-machine' });
    expect(r.status).toBe('RESOLVED');
    expect(one(r).faultId).toBe('fill');
    expect(one(r).meaning).toMatch(/water supply/i);
  });

  it('Bosch dishwasher E24 (drain) and E15 (anti-flood)', () => {
    const e24 = EC.lookup({ code: 'E24', brand: 'bosch', appliance: 'dishwasher' });
    expect(e24.status).toBe('RESOLVED');
    expect(one(e24).faultId).toBe('drain');
    const e15 = EC.lookup({ code: 'e:15', brand: 'BOSCH', appliance: 'dishwasher' });
    expect(e15.status).toBe('RESOLVED');
    expect(one(e15).faultId).toBe('leak-protection');
  });

  it('washer-dryer falls back to the washing-machine records of the same brand, flagged', () => {
    const wd = EC.lookup({ code: 'E08', brand: 'Beko', appliance: 'washer-dryer' });
    const wm = EC.lookup({ code: 'E08', brand: 'Beko', appliance: 'washing-machine' });
    expect(wd.status).not.toBe('NOT_FOUND');
    expect(wd.fallback).toBe('washing-machine');
    expect(wd.candidates).toEqual(wm.candidates);
    expect(wm.fallback).toBe(null);
    // a washer-dryer record of its own wins: no fallback
    const own = EC.lookup({ code: 'E1', brand: 'Bush', appliance: 'washer-dryer' });
    expect(own.status).not.toBe('NOT_FOUND');
    expect(own.fallback).toBe(null);
    // no fallback for other appliances
    expect(EC.lookup({ code: 'E08', brand: 'Beko', appliance: 'tumble-dryer' }).fallback).toBe(null);
  });

  it('O/0 normalisation: EO3 -> E03 and 0E -> OE, flagged; an exact match always wins', () => {
    const eo3 = EC.lookup({ code: 'EO3', brand: 'Hoover', appliance: 'washing-machine' });
    expect(eo3.status).toBe('RESOLVED');
    expect(eo3.normalised).toBe(true);
    expect(eo3.matchedAs).toBe('E03');
    expect(one(eo3).faultId).toBe('drain');
    const e03 = EC.lookup({ code: 'E03', brand: 'Hoover', appliance: 'washing-machine' });
    expect(e03.normalised).toBe(false);
    expect(e03.candidates).toEqual(eo3.candidates);

    const zeroE = EC.lookup({ code: '0E', brand: 'LG', appliance: 'washing-machine' });
    expect(zeroE.normalised).toBe(true);
    expect(one(zeroE).faultId).toBe('drain');
    const oe = EC.lookup({ code: 'OE', brand: 'LG', appliance: 'washing-machine' });
    expect(oe.normalised).toBe(false);
    expect(EC.o0Variants('EO3').map((v) => v.code)).toContain('E03');
  });

  it('no brand or an unknown brand gives candidates across brands, AMBIGUOUS unless they agree', () => {
    const none = EC.lookup({ code: 'E15', appliance: 'dishwasher' });
    expect(none.status).toBe('AMBIGUOUS');
    expect(none.reason).toBe('NO_BRAND');
    expect(new Set(none.candidates.map((c) => c.faultId)).size).toBeGreaterThan(1);
    expect(none.candidates.length).toBeLessThanOrEqual(6);
    const unknown = EC.lookup({ code: 'E15', brand: 'Belkin', appliance: 'dishwasher' });
    expect(unknown.status).toBe('AMBIGUOUS');
    expect(unknown.brandKnown).toBe(false);
    expect(unknown.reason).toBe('BRAND_NOT_IN_CATALOGUE');
    // all candidates agree -> RESOLVED even without a brand
    const agree = EC.lookup({ code: '4C', appliance: 'washing-machine' });
    expect(agree.status).toBe('RESOLVED');
    expect(one(agree).brands).toContain('samsung');
  });

  it('Panasonic microwave H98 is the inverter/magnetron power fault', () => {
    const r = EC.lookup({ code: 'H98', brand: 'Panasonic', appliance: 'microwave' });
    expect(r.status).toBe('RESOLVED');
    expect(one(r).faultId).toBe('magnetron');
    expect(one(r).meaning).toMatch(/inverter/i);
  });

  it('Beko induction hob U = no suitable pan detected', () => {
    const r = EC.lookup({ code: 'U', brand: 'Beko', appliance: 'hobs' });
    expect(r.status).toBe('RESOLVED');
    expect(one(r).faultId).toBe('cookware');
  });

  it('known brand with an unknown code is NOT_FOUND; blank code is NOT_FOUND', () => {
    expect(EC.lookup({ code: 'E99', brand: 'Bosch', appliance: 'dishwasher' }).status).toBe('NOT_FOUND');
    expect(EC.lookup({ code: '  ', brand: 'Bosch' }).status).toBe('NOT_FOUND');
  });

  it('ports the resolve.py fold: subcode punctuation is equivalent', () => {
    const ref = EC.lookup({ code: 'E:36-10', brand: 'Bosch', appliance: 'washing-machine' });
    expect(ref.status).toBe('RESOLVED');
    for (const form of ['E36-10', 'E36/-10', 'E:36 / -10', 'E36/E10', 'e36/e10']) {
      expect(EC.lookup({ code: form, brand: 'Bosch', appliance: 'washing-machine' }).candidates).toEqual(ref.candidates);
    }
    expect(EC.fold('E36/E10')).toBe('E36-10');
    expect(EC.fold('E36/F36')).toBe('E36-F36');
  });
});

describe('brands and candidateTokens', () => {
  it('brands() lists lower-case catalogue brands without generic placeholders', () => {
    const b = EC.brands();
    expect(b).toContain('bosch');
    expect(b).toContain('samsung');
    expect(b.every((x) => x === x.toLowerCase() && !x.startsWith('('))).toBe(true);
  });

  const toks = (s) => EC.candidateTokens(s).map((t) => t.token);
  it('spots code-like tokens with their surrounding words', () => {
    expect(toks('My Bosch dishwasher shows E24 and sometimes E:15')).toEqual(['E24', 'E:15']);
    expect(toks('samsung washer says 4C')).toEqual(['4C']);
    expect(toks('LG showing OE on the display')).toEqual(['OE']);
    expect(toks('it says dE on the screen')).toEqual(['dE']);
    expect(toks("AEG washer dryer showing 'Er03'")).toEqual(['Er03']);
    expect(toks('the beko hob shows a U symbol')).toEqual(['U']);
    expect(toks('error code EO3')).toEqual(['EO3']);
    expect(toks('panasonic microwave H98, also F21 and E:36-10')).toEqual(['H98', 'F21', 'E:36-10']);
    const [t] = EC.candidateTokens('Hi, my washer keeps flashing E18 at the end');
    expect(t.quote).toContain('flashing E18');
    expect(EC.candidateTokens("code 'U'")[0].quoted).toBe(true);
  });

  it('is conservative about ordinary words and numbers', () => {
    expect(toks('I DO NOT KNOW WHAT TO DO, is it on or off?')).toEqual([]);
    expect(toks('A friend said I should try the 2nd rinse with a 5kg load')).toEqual([]);
    expect(toks('it is 10 years old and cost 300 pounds')).toEqual([]);
    expect(toks('Oe it is broken, no idea')).toEqual([]);
    expect(toks('I bought it as A 2 year old model')).toEqual([]);
    expect(toks('the display shows E 18')).toEqual(['E18']);
  });
});
