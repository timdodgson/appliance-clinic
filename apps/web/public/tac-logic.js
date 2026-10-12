/*
 * Test ApplianceClinic — pure UI logic (no DOM).
 *
 * Extracted so the first-time-user behaviour can be unit-tested without a
 * browser: preset specs, resolved scenario counts, the concrete Run-button
 * label, honest paid-call messaging, and whether a test needs the local test
 * runner. Loaded as a plain <script> (attaches window.TacLogic) and also
 * require()-able in tests (module.exports).
 */
(/** @param {any} root @param {() => any} factory */ function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.TacLogic = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // The two one-click presets. 'quick' = 10 balanced, Fast Check; 'full' = every
  // approved scenario, Fast Check. Both are Private AI (local), no paid calls.
  function specFor(kind) {
    if (kind === 'quick') return { title: 'Quick check', mode: 'BALANCED', n: 10, judgeMode: 'DETERMINISTIC_ONLY', areas: [], families: [], frontier: false };
    if (kind === 'full') return { title: 'Full local test', mode: 'BALANCED', n: 'ALL', judgeMode: 'DETERMINISTIC_ONLY', areas: [], families: [], frontier: false };
    return null;
  }

  // Resolve a spec's concrete scenario count. 'ALL' resolves to the approved
  // library size so the Run button can name a real number.
  function resolveCount(spec, journeyCount) {
    if (!spec) return 0;
    if (spec.n === 'ALL') return Number(journeyCount) || 0;
    var n = Number(spec.n);
    return isFinite(n) && n > 0 ? n : 0;
  }

  // The primary action label is always concrete ("Run 10 scenarios"), never a
  // vague "Run"/"Start". Falls back only when the count is not yet resolved.
  function runLabel(count) {
    var n = Number(count);
    if (!isFinite(n) || n <= 0) return 'Run test';
    return 'Run ' + n + ' scenario' + (n === 1 ? '' : 's');
  }

  // Honest paid-call messaging. Fast Check (deterministic) = no paid calls.
  // Full Quality Review = one paid OpenAI review call per scenario. A frontier
  // experiment is paid too. Never claim "free" when paid calls occur.
  function paidCalls(spec, count) {
    if (!spec) return 'None';
    if (spec.judgeMode === 'FULL') {
      var n = resolveCount(spec, count) || Number(count) || 0;
      return n + ' paid OpenAI review call' + (n === 1 ? '' : 's');
    }
    if (spec.frontier) return 'Paid OpenAI calls apply (frontier experiment)';
    return 'None';
  }

  // Does executing this spec need the local test runner (the machine hosting
  // Private AI)? Any stage on Private AI (local) does. A pure frontier/frontier
  // experiment does not.
  function needsRunner(spec) {
    if (!spec) return true;
    if (spec.frontier) return spec.understand !== 'openai' || spec.compose !== 'openai';
    return true;
  }

  return { specFor: specFor, resolveCount: resolveCount, runLabel: runLabel, paidCalls: paidCalls, needsRunner: needsRunner };
});
