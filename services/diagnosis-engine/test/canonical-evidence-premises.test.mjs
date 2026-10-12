/**
 * No customer-facing conclusion asserts an observation, completed check or state that cs/1 does not record.
 * Live defect (2026-10-12): "oven not heating" -> "I don't know" -> "not sure, sorry" concluded the fan-oven element
 * with "With the fan running and the grill working ..." although neither was ever answered: P22 concluded an
 * uncommitted leader after the customer disengaged, and the fixed conclusion copy was used whatever the evidence.
 * Fixed copy that states a premise now declares it ({ requires, text, otherwise }, compose-kit evidenceCopy).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const H = require('./helpers/b2-journey.cjs');
const L = require('../handler.js')._internal;
const mc1 = require('../canonical/mc1.js');
const ck = require('../canonical/compose-kit.js');
const { emptyState, newFact } = require('../canonical/cs1.js');
const { merge } = require('../canonical/merge.js');
const OPENERS = require('./fixtures/journey-openers.json');
const EC = require('../faults-catalogue.json').errorCodes;
const { C, O, K } = H;

const PACKS = L.CANONICAL_JOURNEY_PACKS;
const mod = (p) => require(p.replace('./canonical/', '../canonical/'));
const OVI = { appliance: { value: 'oven-cooker', basis: 'stated' } };
const unsure = () => C({ reply: { toPending: 'cannot_answer' } });
const OV1 = mod(PACKS['oven-not-heating'].pipeline);

function opener(e) {
  const identity = { appliance: { value: e.appliance, basis: 'stated' } };
  if (e.fuel) identity.fuel = { value: e.fuel, basis: 'stated' };
  return C({ identity, intent: 'report_fault', problem: { journey: e.journey }, observations: (e.obs || []).map(([k, v]) => O(k, v)) });
}
const owner = (s) => Object.keys(PACKS).find((k) => { const p = mod(PACKS[k].pipeline).prepare(s, { errorCodes: EC, modelParts: null }); return p.entry && p.entry.applies; });
/** Opener then "I don't know" to every question until the journey stops asking. */
function untilConclusion(key, first, max = 10) {
  const J = mod(PACKS[key].pipeline);
  const r = H.play(J, [first, ...Array.from({ length: max - 1 }, unsure)]);
  const i = r.actions.findIndex((x) => !/^ask_/.test(x.action.kind));
  return i < 0 ? null : r.actions[i];
}
const copyOf = (key, { state, action }) => mod(PACKS[key].compose).brief(state, action, null, {}).conclusion;
const obsRecorded = (s) => Object.entries(s.evidence.observations).filter(([, f]) => f && f.value != null).map(([k]) => k);
const checksDone = (s) => Object.entries(s.evidence.checks).filter(([, k]) => k && k.status === 'done').map(([c]) => c);

describe('the live oven case (reproduction)', () => {
  const run = () => H.play(OV1, [H.opener('no-heat', null, [O('mainOvenWorks', false)], {}, OVI), unsure(), unsure()]);
  it('reaches OH22 on an uncommitted fan-oven-element leader with neither fan nor grill recorded', () => {
    const r = run();
    expect(r.rules).toEqual(['OH10:oven-clock-mode', 'OH11:ovenFunctions', 'OH22:fan-oven-element']);
    expect(r.last.conclusion).toMatchObject({ cause: 'fan-oven-element', level: 'cause_family', confidence: 'possible' });
    expect(r.prep.diag.leader.committed).toBe(false);
    expect(obsRecorded(r.state)).toEqual(['mainOvenWorks']);
    expect(checksDone(r.state)).toEqual([]);
  });
  it('the conclusion states no fan / grill observation and is not the evidence-specific copy', () => {
    const r = run();
    const copy = OV1.brief(r.state, r.last, null, {}).conclusion;
    expect(copy).not.toContain(OV1.CONCLUSION['fan-oven-element'].text);
    expect(copy).not.toMatch(/fan (is )?(running|turning)|grill (is )?(working|heating)|clock (is )?working/i);
    expect(copy).toMatch(/fan-oven \(circular\) element/);
    expect(copy).toMatch(/can't confirm/);
    expect(copy).toMatch(/appliance engineer/);
  });
  it('"don\'t know" from the opening question onward: the usual causes, no premise', () => {
    const r = H.play(OV1, [H.opener('no-heat', null, [], {}, OVI), unsure(), unsure()]);
    expect(r.last.conclusion.cause).toBe('likely-causes');
    expect(OV1.brief(r.state, r.last, null, {}).conclusion).not.toMatch(/^(with|because|since|as)\b/i);
  });
  it('the clock answered but the grill question unanswered: still no fan / grill claim', () => {
    const r = H.play(OV1, [H.opener('no-heat', null, [O('mainOvenWorks', false)], {}, OVI), C({ checks: [K('oven-clock-mode', 'done', 'clear')] }), unsure(), unsure()]);
    expect(r.last.kind).toBe('conclude');
    expect(OV1.brief(r.state, r.last, null, {}).conclusion).not.toMatch(/fan (is )?(running|turning)|grill (is )?(working|heating)/i);
  });
});

describe('established evidence is still used', () => {
  const s3 = (obs) => {
    const s = emptyState('ov1'); s.version = 4;
    s.identity.appliance = newFact('oven-cooker', 'stated', 1);
    for (const [k, v] of Object.entries(obs)) s.evidence.observations[k] = newFact(v, 'stated', 2);
    return s;
  };
  const a = { kind: 'conclude', rule: 'OH22', target: 'fan-oven-element', requires: [],
    conclusion: { cause: 'fan-oven-element', level: 'cause_family', confidence: 'possible', handoff: 'engineer', alternatives: [] } };
  it('fan turning, grill heating and main oven cold recorded -> the evidence-specific copy', () => {
    const copy = OV1.brief(s3({ ovenFanTurns: true, grillWorks: true, mainOvenWorks: false }), a, null, {}).conclusion;
    expect(copy).toContain(OV1.CONCLUSION['fan-oven-element'].text);
  });
  it('the full answered journey names the fan and grill evidence', () => {
    const r = H.play(OV1, [H.opener('no-heat', null, [], {}, OVI), C({ checks: [K('oven-clock-mode')] }), C({ observations: [O('grillWorks'), O('mainOvenWorks', false)] }),
      C({ observations: [O('ovenFanTurns')] }), C({ checks: [K('programme-setting')] }), H.model('ZOB35301XK', 'zanussi')]);
    expect(r.last.rule).toBe('OH22');
    expect(OV1.brief(r.state, r.last, null, {}).conclusion).toMatch(/fan turning and the grill heating/);
  });
  it('only part of the premise recorded (fan, no grill answer) -> neutral copy', () => {
    const copy = OV1.brief(s3({ ovenFanTurns: true, mainOvenWorks: false }), a, null, {}).conclusion;
    expect(copy).not.toMatch(/grill (is )?(working|heating)/i);
  });
});

/** The minimal cs/1 state that satisfies an entry's declared requirements (first branch of anyOf). */
function stateMeeting(req, base) {
  const s = JSON.parse(JSON.stringify(base));
  const apply = (r) => {
    for (const [k, v] of Object.entries(r.obs || {})) s.evidence.observations[k] = newFact(v, 'stated', 1);
    for (const [c, want] of Object.entries(r.checks || {})) {
      const result = want === 'done' ? null : (Array.isArray(want) ? want[0] : want);
      s.evidence.checks[c] = { status: 'done', result, turn: 1, history: [] };
    }
    if (r.anyOf && r.anyOf.length) apply(r.anyOf[0]);
  };
  apply(req || {});
  return s;
}

describe('every evidence-gated conclusion entry, every journey', () => {
  const seen = new Set();
  for (const key of Object.keys(PACKS)) {
    const JC = mod(PACKS[key].compose);
    if (seen.has(JC)) continue; seen.add(JC);
    const gated = Object.entries(JC.CONCLUSION || {}).filter(([, e]) => e && typeof e === 'object');
    for (const [k, e] of gated) {
      it(`${key} · ${k}: its text only when its declared evidence is recorded`, () => {
        expect(typeof e.text).toBe('string');
        expect(e.requires && typeof e.requires === 'object').toBe(true);
        expect(e.otherwise == null || typeof e.otherwise === 'string').toBe(true);
        const [rule, cause] = k.includes(':') ? k.split(':') : ['X22', k];
        // `committed` copy needs the engine's committed cause (confidence 'likely'); a best guess ('possible') never gets it
        const act = (confidence) => ({ kind: 'conclude', rule, target: cause, requires: [], conclusion: { cause, level: 'cause_family', confidence, handoff: 'engineer', alternatives: [] } });
        const base = emptyState('gate'); base.version = 3; base.identity.appliance = newFact(PACKS[key].family, 'stated', 1);
        const met = stateMeeting(e.requires, base);
        expect(ck.evidenceHolds(met, e.requires)).toBe(true);
        expect(JC.brief(met, act(e.requires.committed ? 'likely' : 'possible'), null, {}).conclusion).toContain(e.text);
        if (e.requires.committed) expect(JC.brief(met, act('possible'), null, {}).conclusion || '').not.toContain(e.text);
        const evidenceFree = !Object.keys(e.requires).some((k) => k !== 'committed');
        if (!evidenceFree) expect(ck.evidenceHolds(base, e.requires)).toBe(false);
        if (!evidenceFree) expect(JC.brief(base, act('likely'), null, {}).conclusion || '').not.toContain(e.text);
      });
    }
  }
});

// Lead-ins that state a finding. A zero-evidence conclusion may name the likely cause and the next step, never why.
const PREMISE = /^(with|because|since|now that|as|given)\b|\b(you've (confirmed|checked|found)|the checks (show|so far|point)|what we've been able to check|we know that)\b/i;
describe('a customer who can answer nothing gets no asserted evidence, in any journey', () => {
  it('the opener fixture covers every journey, and each opener is owned by its journey', () => {
    expect(Object.keys(OPENERS).sort()).toEqual(Object.keys(PACKS).sort());
    for (const [key, e] of Object.entries(OPENERS)) expect(owner(merge(emptyState('own'), opener(e), { turn: 1 }).state)).toBe(key);
  });
  for (const [key, e] of Object.entries(OPENERS)) {
    it(key, () => {
      const end = untilConclusion(key, opener(e));
      expect(end).not.toBeNull();
      const copy = copyOf(key, end);
      if (end.action.kind === 'safety_stop') return;
      expect(copy && copy.length > 20).toBe(true);
      expect(checksDone(end.state)).toEqual([]);
      expect(obsRecorded(end.state).sort()).toEqual((e.obs || []).map(([k]) => k).sort());
      // nothing beyond the opening complaint is recorded, so nothing may be stated as found
      expect(copy).not.toMatch(PREMISE);
      for (const [, entry] of Object.entries(mod(PACKS[key].compose).CONCLUSION || {})) {
        if (!entry || typeof entry !== 'object' || !copy.includes(entry.text)) continue;
        expect(ck.evidenceHolds(end.state, entry.requires)).toBe(true);
        if (entry.requires.committed) expect(end.action.conclusion.confidence).toBe('likely');
      }
    });
  }
});

describe('neutral fallback wording', () => {
  it('says "the checks so far" only when a check was completed', () => {
    const copy = ck.makeConclusionCopy({ FAMILY_LABEL: { x: 'the x' }, COMPONENT_LABEL: {} });
    const s = emptyState('n'); s.version = 2;
    const a = { kind: 'conclude', rule: 'Z22', conclusion: { cause: 'x', level: 'cause_family', confidence: 'possible', handoff: 'engineer', alternatives: [] } };
    expect(copy(s, a)).toMatch(/^From what you've described, the most likely area is the x/);
    s.evidence.checks.c = { status: 'done', result: 'clear', turn: 1, history: [] };
    expect(copy(s, a)).toMatch(/^From the checks so far/);
  });
  it('mc1 still knows every observation key the gated entries name', () => {
    for (const key of Object.keys(PACKS)) {
      for (const e of Object.values(mod(PACKS[key].compose).CONCLUSION || {})) {
        if (!e || typeof e !== 'object') continue;
        const keys = (r) => [...Object.keys(r.obs || {}), ...(r.anyOf || []).flatMap(keys)];
        for (const k of keys(e.requires)) expect(mc1.OBSERVATION_KEYS).toContain(k);
      }
    }
  });
});

// GOLD G2-FF-06 (17.1 gate run 2): "no idea on the model sorry, can't find it" while the door question was pending was
// acknowledged as "Thanks for letting us know about the model number", read as the customer having given it. The
// model status carries no turn, so "cannot find the model number" was also handed to COMPOSE as news on every later turn.
describe('"can\'t find the model" is acknowledged by fixed copy, and only on the turn it was said', () => {
  const FF1 = mod(PACKS['ff-not-cooling'].pipeline);
  const op = C({ identity: { appliance: { value: 'fridge-freezer', basis: 'stated' } }, intent: 'report_fault', problem: { journey: 'not-cooling' },
    observations: [O('majorLeak'), O('waterInsideFridge')] });
  const user = (x) => FF1.prompt(FF1.brief(x.state, x.action, null, {}))[1].content;
  it('the G2-FF-06 path (door question superseded, engine moves on): no free acknowledgement about the model', () => {
    const r = H.play(FF1, [op, C({ observations: [O('bothCompartmentsWarm'), O('fridgeOnlyWarm')] }), C({ identity: { modelStatus: 'unavailable' } })]);
    expect(r.rules).toEqual(['FC10:ffCompartment', 'FC11:doorLeftOpen', 'FC23:defrost-drain']);
    expect(user(r.actions[2])).not.toMatch(/LATEST[^\n]*model number/);
  });
  it('answered "can\'t find it" to the pending question: the fixed model frame, no free acknowledgement', () => {
    const r = H.play(FF1, [op, C({ observations: [O('bothCompartmentsWarm')] }), C({ identity: { modelStatus: 'unavailable' }, reply: { toPending: 'cannot_answer' } }), unsure()]);
    const b = FF1.brief(r.actions[2].state, r.actions[2].action, null, {});
    expect(b.task.reoffer).toMatch(/^No problem about the model number — we can carry on without it/);
    expect(user(r.actions[2])).not.toMatch(/Open with one short acknowledgement/);
    // the next turn is not told the customer just said it again
    expect(FF1.brief(r.actions[3].state, r.actions[3].action, null, {}).latest).not.toContain('cannot find the model number');
    expect(user(r.actions[3])).not.toMatch(/LATEST[^\n]*model number/);
  });
  it('the engine moving on to a new step on the same turn still gets the fixed frame, with the step\'s own copy', () => {
    const r = H.play(FF1, [op, C({ observations: [O('bothCompartmentsWarm')] }), C({ identity: { modelStatus: 'unavailable' }, reply: { toPending: 'cannot_answer' } })]);
    const x = r.actions[2]; const s = JSON.parse(JSON.stringify(x.state));
    const a = { ...x.action, requestKind: 'new', kind: 'ask_check', target: 'defrost-drain', rule: 'FC23' };
    const b = FF1.brief(s, a, null, {});
    expect(b.task.reoffer).toMatch(/^No problem about the model number/);
    expect(b.task.say).toBe(FF1.TASK['ask_check:defrost-drain'].say);
  });
});
