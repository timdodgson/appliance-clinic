'use strict';
/**
 * Batch-run target and production intent (Phase 7, PLAN.md "benchmarks routed to staging only").
 *
 * A batch run sends its turns to an Appliance Clinic API and, when its COMPOSE differs from live, rewrites the live
 * AI-config document for the run (routing-override.js). That document is also read by the diagnosis Lambda, which
 * serves Spares4Repairs. So:
 *
 *   • The default target is STAGING. No staging environment is configured today (BENCHMARK_STAGING_URL unset), so a
 *     run without an explicit target is refused, with how to declare production intent. Nothing is ever queued for
 *     production by default.
 *   • target "production" requires confirmProduction: true.
 *   • A run whose COMPOSE would change live routing also requires confirmProductionRouting: true.
 *   • The intent (who, when, routing or not) is recorded on the run. routing-override.js begin() refuses to rewrite
 *     live routing for a run that does not carry it, so a queued run cannot change production routing silently.
 */

const TARGETS = ['staging', 'production'];

/**
 * Decide whether a batch run may be queued.
 * @param {object} body     the admin request body: target, confirmProduction, confirmProductionRouting
 * @param {object} opts     { plan: planOverride() result for the run against the live document, or null if unknown,
 *                            by: admin identity, now: () => ms, env }
 * @returns {{ok:true, target:string, productionIntent:object}|{ok:false, status:number, body:object}}
 */
function decideTarget(body, opts = {}) {
  const b = body || {};
  const env = opts.env || process.env;
  const target = b.target == null ? 'staging' : b.target;
  if (TARGETS.indexOf(target) === -1) {
    return { ok: false, status: 400, body: { error: 'INVALID_TARGET', message: 'target must be "staging" or "production".' } };
  }
  if (target === 'staging') {
    if (!env.BENCHMARK_STAGING_URL) {
      return { ok: false, status: 409, body: {
        error: 'STAGING_NOT_CONFIGURED',
        message: 'Batch runs default to staging, and no staging environment is configured. To run against production, '
          + 'send target "production" with confirmProduction: true (and confirmProductionRouting: true if the run changes live AI routing).',
      } };
    }
    return { ok: true, target: 'staging', productionIntent: null };
  }
  if (b.confirmProduction !== true) {
    return { ok: false, status: 400, body: { error: 'PRODUCTION_CONFIRMATION_REQUIRED', message: 'A production batch run needs confirmProduction: true.' } };
  }
  const plan = opts.plan || null;
  // Unknown plan (live document unreadable): treat as a routing change, the conservative side.
  const routingChange = !plan || plan.required === true;
  if (routingChange && b.confirmProductionRouting !== true) {
    return { ok: false, status: 409, body: {
      error: 'PRODUCTION_ROUTING_CONFIRMATION_REQUIRED',
      message: 'This run changes live AI routing for its duration (also read by the Spares4Repairs diagnosis service). '
        + 'Send confirmProductionRouting: true to allow it.',
      changes: plan ? plan.changes : null,
    } };
  }
  const now = opts.now ? opts.now() : Date.now();
  return { ok: true, target: 'production', productionIntent: {
    by: opts.by || null, at: new Date(now).toISOString(), routing: routingChange,
  } };
}

/** begin() guard: may this run rewrite live routing? Only with recorded production routing intent. */
function routingAllowed(run) {
  return Boolean(run && run.target === 'production' && run.productionIntent && run.productionIntent.routing === true);
}

module.exports = { decideTarget, routingAllowed, TARGETS };
