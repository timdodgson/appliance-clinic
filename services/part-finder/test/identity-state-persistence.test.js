'use strict';
/**
 * STAGE A — deterministic appliance-identity state precedence across conversation turns.
 *
 *   node services/part-finder/test/identity-state-persistence.test.js
 *
 * These are pure state-transition tests: given a PRIOR persisted identity and THIS turn's typed Jev
 * output, the resolved family + state is a deterministic function. Jev owns the semantic provenance
 * (customer_named = the customer stated OR corrected the family in their own words); this code owns
 * the state precedence. No customer-language regex / keyword scoring is used here.
 */
globalThis.awslambda = globalThis.awslambda || {
  streamifyResponse: (fn) => fn,
  HttpResponseStream: { from: (s) => s },
};
const {
  FAMILY_STATE, nextFamilyIdentity, resolveConversationIdentity,
} = require('../identity.js');

let pass = 0;
let fail = 0;
function check(name, cond, detail) {
  if (cond) pass++;
  else { fail++; console.log('  FAIL:', name, detail !== undefined ? `:: ${JSON.stringify(detail)}` : ''); }
}

const EST = FAMILY_STATE.ESTABLISHED;
const WRK = FAMILY_STATE.WORKING;
const UNK = FAMILY_STATE.UNKNOWN;

// ---------------------------------------------------------------------------
// nextFamilyIdentity — the central pure state machine
// ---------------------------------------------------------------------------

// ESTABLISHED + null → keep old family (ESTABLISHED)
{
  const r = nextFamilyIdentity(
    { family: 'washing-machine', familyState: EST },
    { family: null, provenance: 'none', workingFamily: null },
  );
  check('ESTABLISHED + null → keep washing-machine ESTABLISHED',
    r.family === 'washing-machine' && r.familyState === EST && r.transition === 'preserved', r);
}

// ESTABLISHED + uncertain → keep
{
  const r = nextFamilyIdentity(
    { family: 'dishwasher', familyState: EST },
    { family: null, provenance: 'uncertain', workingFamily: null },
  );
  check('ESTABLISHED + uncertain → keep dishwasher ESTABLISHED',
    r.family === 'dishwasher' && r.familyState === EST, r);
}

// ESTABLISHED + unknown family (weak) → keep
{
  const r = nextFamilyIdentity(
    { family: 'vacuum', familyState: EST },
    { family: 'unknown', provenance: 'none', workingFamily: null },
  );
  check('ESTABLISHED + unknown → keep vacuum ESTABLISHED',
    r.family === 'vacuum' && r.familyState === EST, r);
}

// ESTABLISHED + inferred SAME family → keep ESTABLISHED (not downgraded to working)
{
  const r = nextFamilyIdentity(
    { family: 'washing-machine', familyState: EST },
    { family: 'washing-machine', provenance: 'inferred', workingFamily: 'washing-machine' },
  );
  check('ESTABLISHED + inferred same → washing-machine ESTABLISHED (not downgraded)',
    r.family === 'washing-machine' && r.familyState === EST, r);
}

// ESTABLISHED + inferred DIFFERENT family → keep established old family (weak cannot overwrite)
{
  const r = nextFamilyIdentity(
    { family: 'washing-machine', familyState: EST },
    { family: 'dishwasher', provenance: 'inferred', workingFamily: 'dishwasher' },
  );
  check('ESTABLISHED + inferred different → keep washing-machine ESTABLISHED',
    r.family === 'washing-machine' && r.familyState === EST && r.transition === 'preserved', r);
}

// ESTABLISHED + explicit correction to a DIFFERENT family → new ESTABLISHED family
{
  const r = nextFamilyIdentity(
    { family: 'washing-machine', familyState: EST },
    { family: 'dishwasher', provenance: 'customer_named', workingFamily: 'dishwasher' },
  );
  check('ESTABLISHED + explicit correction → dishwasher ESTABLISHED (corrected)',
    r.family === 'dishwasher' && r.familyState === EST && r.transition === 'corrected'
      && r.familySource === 'correction', r);
}

// ESTABLISHED + explicit re-statement of SAME family → stays ESTABLISHED (established, not corrected)
{
  const r = nextFamilyIdentity(
    { family: 'oven-cooker', familyState: EST },
    { family: 'oven-cooker', provenance: 'customer_named', workingFamily: null },
  );
  check('ESTABLISHED + explicit same → oven-cooker ESTABLISHED (established)',
    r.family === 'oven-cooker' && r.familyState === EST && r.transition === 'established', r);
}

// WORKING + stronger explicit evidence → ESTABLISHED
{
  const r = nextFamilyIdentity(
    { family: 'dishwasher', familyState: WRK },
    { family: 'dishwasher', provenance: 'customer_named', workingFamily: 'dishwasher' },
  );
  check('WORKING + explicit customer naming → dishwasher ESTABLISHED',
    r.family === 'dishwasher' && r.familyState === EST, r);
}

// WORKING + null later turn → retain WORKING family (not erased)
{
  const r = nextFamilyIdentity(
    { family: 'dishwasher', familyState: WRK },
    { family: null, provenance: 'none', workingFamily: null },
  );
  check('WORKING + null → retain dishwasher WORKING',
    r.family === 'dishwasher' && r.familyState === WRK && r.transition === 'preserved', r);
}

// WORKING + inferred DIFFERENT family → this turn's working inference may replace a working hypothesis
{
  const r = nextFamilyIdentity(
    { family: 'dishwasher', familyState: WRK },
    { family: 'washing-machine', provenance: 'inferred', workingFamily: 'washing-machine' },
  );
  check('WORKING + inferred different → washing-machine WORKING (hypothesis updated)',
    r.family === 'washing-machine' && r.familyState === WRK, r);
}

// No prior + inferred working → WORKING (a weak inference is NEVER auto-ESTABLISHED)
{
  const r = nextFamilyIdentity(
    { family: null, familyState: UNK },
    { family: 'dishwasher', provenance: 'inferred', workingFamily: 'dishwasher' },
  );
  check('UNKNOWN + inferred → dishwasher WORKING (never auto-established)',
    r.family === 'dishwasher' && r.familyState === WRK, r);
}

// No prior + explicit customer naming → ESTABLISHED
{
  const r = nextFamilyIdentity(
    { family: null, familyState: UNK },
    { family: 'washing-machine', provenance: 'customer_named', workingFamily: 'washing-machine' },
  );
  check('UNKNOWN + explicit → washing-machine ESTABLISHED',
    r.family === 'washing-machine' && r.familyState === EST, r);
}

// No prior + nothing → UNKNOWN
{
  const r = nextFamilyIdentity(
    { family: null, familyState: UNK },
    { family: null, provenance: 'none', workingFamily: null },
  );
  check('UNKNOWN + none → UNKNOWN', r.family === null && r.familyState === UNK, r);
}

// Weak initial ambiguous opener ("Dishes hot but not dry" → inferred dishwasher) must NOT lock as
// permanently established just because it routed as dishwasher.
{
  const r = nextFamilyIdentity(
    { family: null, familyState: UNK },
    { family: 'dishwasher', provenance: 'none', workingFamily: 'dishwasher' },
  );
  check('weak inferred opener → WORKING, not ESTABLISHED',
    r.family === 'dishwasher' && r.familyState === WRK, r);
}

// ---------------------------------------------------------------------------
// resolveConversationIdentity with priorIdentity — the reconciliation is wired in
// ---------------------------------------------------------------------------

// prior ESTABLISHED washing-machine + this-turn weak/unknown → preserved
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'it makes a humming noise' }],
    jevFamily: null,
    jevFamilyProvenance: 'none',
    priorIdentity: { family: 'washing-machine', familyState: EST },
  });
  check('resolve: prior established + weak turn → washing-machine ESTABLISHED preserved',
    id.family === 'washing-machine' && id.familyEstablished === true, id);
}

// prior ESTABLISHED washing-machine + this-turn explicit dishwasher → corrected
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'sorry it is actually the dishwasher' }],
    jevFamily: 'dishwasher',
    jevFamilyProvenance: 'customer_named',
    priorIdentity: { family: 'washing-machine', familyState: EST },
  });
  check('resolve: prior established + explicit correction → dishwasher ESTABLISHED',
    id.family === 'dishwasher' && id.familyEstablished === true, id);
}

// prior ESTABLISHED washing-machine + this-turn INFERRED dishwasher → preserve washing-machine
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'the dishes come out wet' }],
    jevFamily: 'dishwasher',
    jevFamilyProvenance: 'inferred',
    priorIdentity: { family: 'washing-machine', familyState: EST },
  });
  check('resolve: prior established + inferred different → washing-machine preserved',
    id.family === 'washing-machine' && id.familyEstablished === true, id);
}

// no priorIdentity → single-turn behaviour unchanged (customer_named establishes)
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'my washing machine wont spin' }],
    jevFamily: 'washing-machine',
    jevFamilyProvenance: 'customer_named',
  });
  check('resolve: no prior + customer_named → washing-machine ESTABLISHED (unchanged)',
    id.family === 'washing-machine' && id.familyEstablished === true, id);
}

// no priorIdentity + inferred → WORKING (unchanged single-turn behaviour, WP-03/WP-39 untouched)
{
  const id = resolveConversationIdentity({
    messages: [{ role: 'user', content: 'mums bosch code e36 wont spin soaking wet' }],
    jevFamily: 'washing-machine',
    jevFamilyProvenance: 'inferred',
  });
  check('resolve: no prior + inferred → washing-machine WORKING (single-turn unchanged)',
    id.family === 'washing-machine' && id.familyState === WRK && id.familyEstablished === false, id);
}

console.log(`\nidentity-state-persistence: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
