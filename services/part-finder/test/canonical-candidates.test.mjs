/**
 * Stage D (A): high-recall identifier / brand / component candidate pre-pass. Structural only:
 * candidates are ENUMERATED (never filtered by "looks like a model"); hints only annotate.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../canonical/candidates.js');
const { buildMc1Request, adaptMc1Answers } = require('../canonical/mc1-questions.js');

const ids = (m) => C.identifierCandidates(m).map((c) => c.value);
const brands = (m) => C.buildCandidates(m).brands.map((b) => b.value);
const comps = (m) => C.buildCandidates(m).components.map((b) => b.value);

describe('identifier candidates', () => {
  it('Neff B1ACE4HN0B is a candidate (the old model-shape gate lost it)', () => {
    expect(ids("It's a Neff B1ACE4HN0B")).toEqual(['B1ACE4HN0B']);
  });
  it('Bosch / Siemens E-Nr shapes: verbatim, joined and split parts', () => {
    const v = ids('Bosch E-Nr WAN28281GB/01 FD 9203');
    for (const x of ['WAN28281GB/01', 'WAN28281GB01', 'WAN28281GB', '01', 'FD9203', '9203']) expect(v).toContain(x);
    expect(ids('Siemens WM14T391GB/22')).toEqual(expect.arrayContaining(['WM14T391GB/22', 'WM14T391GB', '22']));
  });
  it('Hotpoint WMUD962P + code in the same message', () => {
    expect(ids('Hotpoint WMUD962P showing F05')).toEqual(['WMUD962P', 'F05']);
  });
  it('Dyson V6 / V11 series', () => {
    expect(ids('My Dyson V6 keeps pulsing')).toEqual(['V6']);
    expect(ids('dyson v11 cuts out')).toContain('V11');
    expect(ids('it is a v 6')).toContain('V6');
  });
  it('Samsung 4C, spaced e 21', () => {
    expect(ids('Samsung washer showing 4C')).toEqual(['4C']);
    expect(ids('showing e 21')).toContain('E21');
  });
  it('slash code: whole, joined and both parts', () => {
    expect(ids('error E36/E10')).toEqual(['E36/E10', 'E36E10', 'E36', 'E10']);
  });
  it('hyphenated identifier', () => {
    expect(ids('model HW80-B14979')).toEqual(expect.arrayContaining(['HW80-B14979', 'HW80B14979', 'HW80', 'B14979']));
  });
  it('spaced identifier joins', () => {
    expect(ids('model is WAN 28281 GB')).toEqual(expect.arrayContaining(['WAN28281', 'WAN28281GB', '28281GB', '28281']));
  });
  it('multiple identifiers keep message order', () => {
    expect(ids('WAW28750GB and also WAN24108GB')).toEqual(['WAW28750GB', 'WAN24108GB']);
  });
  it('part numbers and PNC', () => {
    expect(ids('part number 481236118511')).toEqual(['481236118511']);
    expect(C.identifierCandidates('part number 481236118511')[0].hints).toEqual(expect.arrayContaining(['cue:part', 'part_number_shape']));
    expect(ids('PNC 914 531 207')).toContain('914531207');
  });
  it('digit-free code after an explicit cue (UE) is offered; without a cue it is not', () => {
    expect(ids('the display shows UE')).toEqual(['UE']);
    expect(ids('my washer is broken')).toEqual([]);
  });
  it('no identifiers', () => {
    expect(ids('washing machine ends full of water')).toEqual([]);
    expect(ids("I don't know")).toEqual([]);
  });
  it('shape hints annotate but never filter', () => {
    const c = C.identifierCandidates('code 12 and B1ACE4HN0B and E15');
    expect(c.map((x) => x.value)).toEqual(expect.arrayContaining(['12', 'B1ACE4HN0B', 'E15']));
    expect(c.find((x) => x.value === 'E15').hints).toContain('code_shape');
  });
});

describe('brand and component candidates', () => {
  it('brand catalogue mentions (incl. multi-word and non-catalogue vacuum brands)', () => {
    expect(brands("It's a Neff B1ACE4HN0B")).toEqual(['neff']);
    expect(brands('tricity bendix oven')).toEqual(['tricity bendix']);
    expect(brands('My Dyson keeps pulsing')).toEqual(['dyson']);
    expect(brands('my hoover has lost suction')).toEqual(['hoover']); // offered; Jev decides make vs noun
  });
  it('component mentions + head-noun expansion (pump -> drain-pump, circulation-pump, …)', () => {
    const pump = comps('I already changed the pump');
    expect(pump).toEqual(expect.arrayContaining(['drain-pump', 'circulation-pump']));
    expect(pump).not.toContain('pump'); // generic head noun replaced by its specific entries
    expect(comps('the magnetron has gone')).toEqual(['magnetron']); // no specific entries -> kept
    expect(comps('could it be the pressure switch?')).toEqual(['pressure-switch']);
    expect(comps('washing machine ends full of water')).toEqual([]);
  });
});

describe('choice chunking (max 32 options per question + none)', () => {
  const many = Array.from({ length: 70 }, (_, i) => `X${i + 100}Y`).join(' ');
  const cands = C.buildCandidates(many);
  it('>32 candidates are split into disjoint chunks; none dropped', () => {
    expect(cands.identifiers.length).toBeGreaterThanOrEqual(70);
    const req = buildMc1Request({ latestMessage: many, candidates: cands });
    const keys = Object.keys(req.questions).filter((k) => k.startsWith('candModel__'));
    expect(keys.length).toBe(Math.ceil(cands.identifiers.length / C.JEV_CHOICE_MAX_OPTIONS));
    const offered = keys.flatMap((k) => Object.keys(req.questions[k].criteria).filter((x) => x !== 'none'));
    expect(offered.length).toBe(cands.identifiers.length);
    expect(new Set(offered).size).toBe(offered.length);
    for (const k of keys) {
      const n = Object.keys(req.questions[k].criteria).length;
      expect(n).toBeLessThanOrEqual(C.JEV_CHOICE_MAX_OPTIONS + 1);
      expect(req.questions[k].criteria.none).toBeTruthy();
    }
  });
  it('chunk winners reconcile deterministically: highest confidence wins, ties -> earlier chunk', () => {
    const req = buildMc1Request({ latestMessage: many, candidates: cands });
    const plan = req.plan.roles.candModel;
    const lastChunk = plan[plan.length - 1];
    const answers = { mcScope: { type: 'choice', choice: 'appliance', confidence: 0.9 } };
    for (const p of plan) answers[p.key] = { type: 'choice', choice: 'none', confidence: 0.9 };
    answers[plan[0].key] = { type: 'choice', choice: plan[0].ids[3], confidence: 0.6 };
    answers[lastChunk.key] = { type: 'choice', choice: lastChunk.ids[0], confidence: 0.8 };
    const out = adaptMc1Answers(answers, req.plan);
    const byId = new Map(cands.identifiers.map((x) => [x.id, x.value]));
    expect(out.classification.identity.model.value).toBe(byId.get(lastChunk.ids[0]));
    expect(out.meta.chunked[0].winners).toEqual([plan[0].key, lastChunk.key]);
    answers[lastChunk.key].confidence = 0.6; // tie
    expect(adaptMc1Answers(answers, req.plan).classification.identity.model.value).toBe(byId.get(plan[0].ids[3]));
  });
});

describe('recall gap', () => {
  it('identifier of type X not among candidates: value stays null, gap recorded, no guessing', () => {
    const msg = 'It is the Dyson Ball Animal model';
    const req = buildMc1Request({ latestMessage: msg, candidates: C.buildCandidates(msg) });
    expect(req.plan.roles.candModel).toBeUndefined(); // no identifier candidates at all
    const out = adaptMc1Answers({ mcScope: { type: 'choice', choice: 'appliance', confidence: 0.9 },
      mcIdentifierNotListed: { type: 'choice', choice: 'model', confidence: 0.85 } }, req.plan);
    expect(out.classification.identity.model).toEqual({ value: null, basis: null });
    expect(out.meta.recallGap).toEqual({ type: 'model', roleFilled: false });
  });
  it('low-confidence recall answer is not a gap', () => {
    const req = buildMc1Request({ latestMessage: 'hello', candidates: C.buildCandidates('hello') });
    const out = adaptMc1Answers({ mcIdentifierNotListed: { type: 'choice', choice: 'model', confidence: 0.3 } }, req.plan);
    expect(out.meta.recallGap).toBeNull();
  });
});
