/**
 * Journey 1 pipeline — merge -> diagnostics -> policy -> request issue, over multi-turn mc/1 sequences.
 * Exercises real request history: no loops, re-offer once, retest after clearance, sparse replies bound
 * to pendingRequest, shadow never writes requests, replay reproduces the state exactly.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { merge } = require('../canonical/merge.js');
const { emptyState } = require('../canonical/cs1.js');
const mc1 = require('../canonical/mc1.js');
const J = require('../canonical/j1-pipeline.js');
const EC = require('../faults-catalogue.json').errorCodes;

const C = (f = {}) => mc1.validateClassification({ scope: 'appliance', ...f });
const WM = { identity: { appliance: { value: 'washing-machine', basis: 'stated' } }, problem: { journey: 'not-draining', faultDomain: 'water' } };
const opener = () => C({ ...WM, observations: [{ key: 'waterRemaining', value: true }] });

/** Run one turn: merge, then the pipeline (control by default). */
function turn(s, c, { control = true, partLookup = null } = {}) {
  const m = merge(s, c, { turn: s.version + 1 });
  const prep = J.prepare(m.state, { errorCodes: EC });
  const out = J.decide(m.state, prep, { control, partLookup, turn: m.state.version });
  return { state: out.state, merged: m.state, action: out.nextAction, issued: out.issuedRequest, prep };
}
function play(cs, opts) {
  let s = emptyState('cs_t'); const log = [];
  for (const c of cs) { const r = turn(s, c, opts); s = r.state; log.push(r); }
  return { s, log, rules: log.map((r) => `${r.action.rule}:${r.action.target}`) };
}

describe('journey sequences', () => {
  it('retained water -> filter clear -> drain fails, hums -> impeller clear -> hose clear -> model -> part', () => {
    const { s, rules, log } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }, { key: 'pumpHumming', value: true }] }),
      C({ checks: [{ check: 'pump-impeller', status: 'done', result: 'clear' }] }),
      C({ checks: [{ check: 'drain-hose', status: 'done', result: 'clear' }] }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R11:pump-impeller', 'R12:drain-hose', 'R13:model']);
    expect(s.requests.map((r) => [r.target, r.kind, r.outcome])).toEqual([
      ['drain-filter', 'ask', 'answered'], ['drain-command', 'ask', 'answered'], ['pump-impeller', 'ask', 'answered'],
      ['drain-hose', 'ask', 'answered'], ['model', 'ask', 'pending']]);
    expect(log[4].prep.diag.partEvidence.sufficient).toBe(true);
    const last = turn(s, C({ identity: { model: { value: 'WAN28281GB', basis: 'stated' }, make: { value: 'bosch', basis: 'stated' } } }),
      { partLookup: { available: true, component: 'drain-pump' } });
    expect(last.action).toMatchObject({ kind: 'recommend_part', target: 'drain-pump', rule: 'R14' });
    expect(last.prep.partLookupNeed).toMatchObject({ model: 'WAN28281GB', component: 'drain-pump' });
    expect(last.state.pendingRequest).toBe(null);
  });
  it('blockage cleared -> retest -> works -> likely fixed (CONFIRM) -> customer confirms -> close', () => {
    const { s, rules } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'found_and_cleared' }] }),
      C({ observations: [{ key: 'commandedDrain', value: true }] }),
      C({ reply: { toPending: 'answered', outcome: 'resolved' } }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R9:filter-blockage', 'R2:filter-blockage']);
    expect(s.requests.map((r) => [r.target, r.kind, r.outcome])).toEqual([
      ['drain-filter', 'ask', 'answered'], ['drain-command', 'retest', 'answered'], ['resolution', 'ask', 'answered']]);
    expect(s.resolution).toBe('resolved');
  });
  it('blockage cleared -> still fails -> continues (FB excluded as the remaining cause)', () => {
    const { rules, log } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'found_and_cleared' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }] }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R10:pumpHumming']);
    expect(log[2].prep.diag.contradicted.map((c) => c.family)).toContain('filter-blockage');
  });
  it('not done yet -> exactly one re-offer -> then another path', () => {
    const nd = C({ checks: [{ check: 'drain-filter', status: 'not_done' }] });
    const { s, rules } = play([opener(), nd, nd]);
    expect(rules).toEqual(['R7:drain-filter', 'R7:drain-filter', 'R8:drain-command']);
    expect(s.requests.filter((r) => r.target === 'drain-filter').map((r) => [r.kind, r.outcome])).toEqual([['ask', 'not_done'], ['reoffer', 'not_done']]);
  });
  it('live defect: "not done yet" classified with toPending=cannot_answer is still re-offered (check status wins)', () => {
    const nd = C({ checks: [{ check: 'drain-filter', status: 'not_done' }], reply: { toPending: 'cannot_answer' } });
    const { s, rules } = play([opener(), nd]);
    expect(rules).toEqual(['R7:drain-filter', 'R7:drain-filter']);
    expect(s.declined).toEqual([]);
  });
  it('cannot access the filter -> drain command; impeller never asked', () => {
    const { rules } = play([opener(), C({ checks: [{ check: 'drain-filter', status: 'unable' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }, { key: 'pumpHumming', value: true }] })]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R12:drain-hose']);
  });
  it('sparse "I don\'t know" binds to the pending request (cannot_answer) and moves on', () => {
    const { s, rules } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }] }),
      C({ reply: { toPending: 'cannot_answer' } }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R10:pumpHumming', 'R11:pump-impeller']);
    expect(s.requests.find((r) => r.target === 'pumpHumming').outcome).toBe('cannot_answer');
  });
  it('model unavailable -> conclusion without a part', () => {
    const { s, rules } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }, { key: 'pumpHumming', value: true }] }),
      C({ checks: [{ check: 'pump-impeller', status: 'done', result: 'clear' }] }),
      C({ checks: [{ check: 'drain-hose', status: 'done', result: 'clear' }] }),
      C({ identity: { modelStatus: 'unavailable' }, reply: { toPending: 'cannot_answer' } }),
    ], { partLookup: { available: true, component: 'drain-pump' } });
    expect(rules.slice(-2)).toEqual(['R13:model', 'R15:drain-pump']);
    expect(s.identity.modelStatus).toBe('unavailable');
  });
  it('safety mid-journey stops; sticky after correction', () => {
    const { rules } = play([
      opener(),
      C({ safety: { hazard: 'electrical_water' } }),
      C({ reply: { correction: ['safety.hazard'] } }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R1:electrical_water', 'R1:electrical_water']);
  });
  it('water returns mid-journey -> plumbing conclusion', () => {
    const { rules } = play([opener(), C({ observations: [{ key: 'waterReturnsAfterDrain', value: true }] })]);
    expect(rules).toEqual(['R7:drain-filter', 'R6a:household-waste-backflow']);
  });
  it('foam -> filter clear -> rinse/spin drains -> excess suds', () => {
    const { rules } = play([
      C({ ...WM, observations: [{ key: 'waterRemaining', value: true }, { key: 'excessiveFoam', value: true }] }),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: true }] }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R9a:excess-suds']);
  });
  it('correction of a check result is honoured (clear -> found_and_cleared)', () => {
    const { rules } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'found_and_cleared' }], reply: { correction: ['checks.drain-filter'] } }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R8:drain-command']);
  });
  it('re-stated failure after a later clearance is ordered after it (retest -> fails -> continue)', () => {
    const { rules } = play([
      opener(),
      C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }, { key: 'pumpHumming', value: true }] }),
      C({ checks: [{ check: 'pump-impeller', status: 'done', result: 'found_and_cleared' }] }),
      C({ observations: [{ key: 'commandedDrain', value: false }] }),
    ]);
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command', 'R11:pump-impeller', 'R8:drain-command', 'R12:drain-hose']);
  });
});

describe('invariants', () => {
  it('no target is ever asked more than twice (ask + reoffer) across an all-ignored session', () => {
    const cs = [opener()]; for (let i = 0; i < 14; i += 1) cs.push(C({ reply: { toPending: 'ignored' } }));
    const { s } = play(cs);
    const counts = {};
    for (const r of s.requests) if (r.kind !== 'retest') counts[r.target] = (counts[r.target] || 0) + 1;
    for (const n of Object.values(counts)) expect(n).toBeLessThanOrEqual(2);
    expect(s.requests.filter((r) => r.outcome === 'pending').length).toBeLessThanOrEqual(1);
  });
  it('an all-ignored session always ends in a conclusion (never stalls)', () => {
    const cs = [opener()]; for (let i = 0; i < 14; i += 1) cs.push(C({ reply: { toPending: 'ignored' } }));
    const { log } = play(cs);
    expect(log[log.length - 1].action.kind).toBe('conclude');
  });
  it('shadow mode never writes requests or pendingRequest', () => {
    const { s, rules } = play([opener(), C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] })], { control: false });
    expect(rules).toEqual(['R7:drain-filter', 'R8:drain-command']);
    expect(s.requests).toEqual([]); expect(s.pendingRequest).toBe(null);
  });
  it('requests are not issued for a turn that is not Journey 1 (other journeys untouched)', () => {
    const r = turn(emptyState('cs_t'), C({ identity: { appliance: { value: 'dishwasher', basis: 'stated' } }, problem: { journey: 'not-draining' } }));
    expect(r.prep.entry.applies).toBe(false);
    expect(r.state.requests).toEqual([]);
  });
  it('replay: merge + applyIssuedRequest reproduces the state exactly', () => {
    let s = emptyState('cs_t');
    for (const c of [opener(), C({ checks: [{ check: 'drain-filter', status: 'done', result: 'clear' }] })]) {
      const r = turn(s, c);
      const replayed = J.applyIssuedRequest(merge(s, c, { turn: s.version + 1 }).state, r.issued, s.version + 1);
      expect(JSON.stringify(replayed)).toBe(JSON.stringify(r.state));
      s = r.state;
    }
  });
  it('media by check key', () => {
    expect(J.mediaFor({ kind: 'ask_check', target: 'drain-filter' }).ids).toContain('wm-pump-filter');
    expect(J.mediaFor({ kind: 'conclude', target: 'household-waste-backflow' }).ids).toEqual(['wm-backflow-sink-waste-pipe']);
    expect(J.mediaFor({ kind: 'ask_check', target: 'drain-command' })).toBe(null);
    expect(J.mediaFor({ kind: 'ask_identity', target: 'model' })).toBe(null);
  });
});
