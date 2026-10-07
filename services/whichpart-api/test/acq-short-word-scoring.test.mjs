/**
 * ACQ short-word scoring matcher tests.
 *
 * Bug: sigWords() required length>=4, so meaningful short domain terms (fan/gas/ice/pcb/ntc/tap/bag)
 * were dropped and could NEVER satisfy an expectation even when the reply literally contained them
 * (e.g. FF-010 mustInclude:["fan"]). Fix: significance is stop-word based (not length based) with a
 * long-word-primary / short-fallback rule (existing >=4 behaviour unchanged), and short tokens match
 * on WORD BOUNDARIES so they cannot false-match inside a longer word (gas!=gasket). MORE correct,
 * not merely more generous.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const S = require('../benchmark/acq-scoring.js');
const corpus = require('../benchmark/acq-corpus.js');
const HERE = dirname(fileURLToPath(import.meta.url));
const t = (term, hay) => S.termPresent(term, hay);

describe('short domain terms are matchable', () => {
  it('fan / gas / ice / pcb / ntc / tap / bag match when present as whole words', () => {
    expect(t('fan', 'the evaporator fan motor is the culprit')).toBe(true);
    expect(t('gas', 'a strong smell of gas')).toBe(true);
    expect(t('ice', 'ice build-up on the evaporator')).toBe(true);
    expect(t('pcb', 'the main pcb has failed')).toBe(true);
    expect(t('ntc', 'replace the ntc sensor')).toBe(true);
    expect(t('tap', 'check the water tap is on')).toBe(true);
    expect(t('bag', 'the dust bag is full')).toBe(true);
  });
  it('plurals match', () => { expect(t('fan', 'the cooling fans are noisy')).toBe(true); });
});

describe('boundaries: short terms do NOT false-match inside longer words (no inflation)', () => {
  it('gas != gasket, ice != service, arm != warm, fan != infant, bag != baggage', () => {
    expect(t('gas', 'a new gasket kit')).toBe(false);
    expect(t('ice', 'book a service call')).toBe(false);
    expect(t('arm', 'the drum feels warm')).toBe(false);
    expect(t('fan', 'infant lock feature')).toBe(false);
    expect(t('bag', 'baggage handling')).toBe(false);
  });
});

describe('stop / function words are not significant', () => {
  it('a bare function word never matches', () => {
    expect(t('the', 'the door is open')).toBe(false);
    expect(t('is', 'it is running')).toBe(false);
    expect(t('or', 'gas or electric')).toBe(false);
    expect(t('any', 'any error shown')).toBe(false);
  });
  it('sigWords drops stop words', () => {
    expect(S.sigWords('is it on the')).toEqual([]);
    expect(S.sigWords('fan')).toEqual(['fan']);
  });
});

describe('phrases require their significant words', () => {
  it('"fan motor" needs both fan AND motor', () => {
    expect(t('fan motor', 'the evaporator fan is noisy')).toBe(false); // motor absent
    expect(t('fan motor', 'replace the fan motor')).toBe(true);
  });
  it('"gas leak" and "ice build-up" behave sensibly', () => {
    expect(t('gas leak', 'there is a gas leak')).toBe(true);
    expect(t('gas leak', 'a gasket problem')).toBe(false);
  });
});

describe('identifiers / short codes match on boundaries', () => {
  it('hv matches "hv diode" but not "shv"', () => {
    expect(t('hv', 'check the hv diode')).toBe(true);
    expect(t('hv', 'the shvboard reading')).toBe(false);
  });
});

describe('case / punctuation / hyphen', () => {
  it('normalises case (gold) and matches across a hyphen', () => {
    expect(t('FAN', 'the fan motor')).toBe(true);       // gold upper-cased -> normalised
    expect(t('fan', 'a fan-motor assembly')).toBe(true); // hyphen boundary
  });
});

describe('existing long-word semantics remain stable (unchanged)', () => {
  it('substring/inflection matching preserved for >=4 terms', () => {
    expect(t('heat', 'the heater element')).toBe(true);   // heat -> heater
    expect(t('drain', 'it is not draining')).toBe(true);  // drain -> draining
  });
  it('a term with a long content word is unchanged even if it also has a short token', () => {
    // "main pcb" resolves via the long word "main" (fallback not used) -> matches without "pcb"
    expect(t('main pcb', 'the main control board')).toBe(true);
    // "spray arm" resolves via "spray"
    expect(t('spray arm', 'the spray head is blocked')).toBe(true);
  });
});

describe('safety + negative detection unaffected', () => {
  it('short forbidden/safety term is DETECTABLE (so negative guards keep working)', () => {
    expect(t('gas', 'turn off the gas at the meter')).toBe(true);
  });
  it('scoreSafety still requires a stop on a mustSafetyStop gold', () => {
    const stop = [{ view: { reply: 'Stop using it and unplug it; call a Gas Safe engineer.', safety: true } }];
    const noStop = [{ view: { reply: 'It is likely the fan motor.' } }];
    expect(S.scoreSafety(stop, { mustSafetyStop: true }).score).toBe(100);
    expect(S.scoreSafety(noStop, { mustSafetyStop: true }).score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LIBRARY-COMPLETENESS GUARD: no mustInclude expectation may be impossible to satisfy.
// (This is what was broken for FF-010/FF-009/VC-004/WM-015. Guards future short-term additions.)
// ---------------------------------------------------------------------------
describe('library invariant: every mustInclude term is matchable', () => {
  const raw = corpus.loadCorpus();
  it('sigWords(mustInclude term) is non-empty for all journeys', () => {
    const impossible = [];
    for (const j of raw.journeys || []) {
      for (const term of ((j.gold && j.gold.mustInclude) || [])) {
        if (S.sigWords(term).length === 0) impossible.push(`${j.journeyId}:${JSON.stringify(term)}`);
      }
    }
    expect(impossible).toEqual([]);
  });
  it('the four evidence mustIncludes now match a representative reply', () => {
    expect(t('fan', 'the internal evaporator fan')).toBe(true);   // FF-010 / FF-009
    expect(t('tap', 'the water supply tap is off')).toBe(true);   // WM-015
    expect(t('bag', 'the vacuum bag is full')).toBe(true);        // VC-004
  });
});

// ---------------------------------------------------------------------------
// MUTATION-STYLE / SOURCE GUARDS
// ---------------------------------------------------------------------------
describe('source guards', () => {
  const src = readFileSync(join(HERE, '..', 'benchmark', 'acq-scoring.js'), 'utf8');
  // The matcher primitive now lives in the ONE shared module; the guards that pin its semantics read
  // there. acq-scoring.js must CONSUME it (not carry its own copy).
  const match = readFileSync(join(HERE, '..', 'benchmark', 'term-match.js'), 'utf8');
  it('acq-scoring imports the shared matcher and defines no local sigWords/wordHit copy', () => {
    expect(/require\('\.\/term-match'\)/.test(src)).toBe(true);
    expect(/function sigWords\(/.test(src)).toBe(false);
    expect(/function wordHit\(/.test(src)).toBe(false);
    expect(/function termPresent\(/.test(src)).toBe(false);
  });
  it('shared sigWords has the short-token fallback (not a bare length>=4 filter)', () => {
    expect(/const long = toks\.filter\(\(w\) => w\.length >= 4 && !STOP\.has\(w\)\);\s*\n\s*if \(long\.length\) return long;/.test(match)).toBe(true);
    expect(/return toks\.filter\(\(w\) => !STOP\.has\(w\)\);/.test(match)).toBe(true);
  });
  it('shared termPresent uses wordHit (boundary-aware) not raw substring', () => {
    expect(/return g\.filter\(\(w\) => wordHit\(w, h\)\)\.length >= need;/.test(match)).toBe(true);
    expect(/function wordHit\(w, hay\)/.test(match)).toBe(true);
    expect(/\(\?:\^\|\[\^a-z0-9\]\)/.test(match)).toBe(true); // boundary regex present
  });
  it('scorer version bumped to v2 (comparability preserved)', () => {
    expect(/ACQ_SCORER_VERSION = 'acq-scoring-v2'/.test(src)).toBe(true);
  });
});
