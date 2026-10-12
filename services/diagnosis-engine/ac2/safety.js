'use strict';
/**
 * Deterministic safety kernel.
 *
 * Detects hazards in the customer's own words, decides what each hazard forbids and whether the conversation may
 * continue, and checks every proposed reply for prohibited advice before it is returned. The reasoner is told the
 * active constraints, but nothing here depends on the reasoner agreeing: a hazard found in the customer's words is
 * active whatever the reasoner says, and a reply that gives prohibited advice is changed whatever it says.
 *
 * A safety intervention does not end the conversation unless continuing would itself be unsafe (gas, an active fire).
 * Otherwise the unsafe action is stopped, the reason given, and help continues with checks that are safe.
 */

// Exact wording where it matters. Carried over unchanged from the journey engine's safety copy.
const COPY = {
  gas: 'If you can smell gas, treat it as an emergency: don\'t turn any switches on or off and no naked flames. Turn the gas off at the meter if you safely can, open doors and windows, and leave if the smell is strong. Call the National Gas Emergency line on 0800 111 999.',
  fire: 'If there are flames or smoke is still coming from it, keep away, don\'t open the door of an oven, microwave or dryer that is on fire, switch it off at the wall or the fuse box only if you can do that safely, get everyone out and call 999.',
  burning: 'A burning smell or smoke can mean an electrical fault or a fire risk. Stop using it, switch it off and unplug it (or turn it off at the fuse box), and don\'t run it again — not even as a test — until it has been checked by a qualified engineer.',
  electrical_water: 'Water near the plug or socket is dangerous. Please don\'t touch the plug, socket or machine if they or your hands are wet. If you can do it safely, switch off the circuit at the consumer unit (fuse box), keep away from the water, and don\'t use the machine again until a qualified electrician or appliance engineer has checked it.',
  electric_shock: 'Stop using it now. If you can do it safely, switch it off at the socket or at the consumer unit (fuse box). A shock usually means an earth or insulation fault, so don\'t use it again until a qualified electrician or appliance engineer has found and fixed it.',
  supply_trip: 'Please don\'t keep resetting the trip. Leave the appliance unplugged and have it checked by a qualified electrician or appliance engineer before using it again.',
  microwave_hv: 'I can\'t guide any testing or work inside a microwave — the high-voltage capacitor can hold a lethal charge even when it is unplugged, so the casing should only be opened by a qualified engineer.',
  microwave_arcing: 'Stop using the microwave now: switch it off at the socket and unplug it, and don\'t run it again (not even empty) until we know why it sparked. Never take the outer casing off — parts inside can hold a lethal charge even when it is unplugged.',
  battery: 'A swollen, very hot or chemical-smelling battery can catch fire. Stop using and charging it now, unplug the charger, and if it is safe to move put it somewhere non-flammable away from anything that could burn. Don\'t puncture, squeeze or try to open the battery, and don\'t put it in the household bin — take it to a battery recycling point.',
  recall: 'This model may be covered by a product-safety recall. Stop using it and check the recall notice with the manufacturer before using it again; a recall repair or replacement is usually free.',
  refrigerant: 'I can\'t help with re-gassing or opening the cooling circuit — it\'s sealed and pressurised (and often uses a flammable gas), so only a refrigeration engineer should work on it. Please don\'t pierce or cut any pipes.',
  gas_work: 'I can\'t help with taking apart or adjusting gas parts (valves, thermocouples, regulators or pipework) — that legally needs a Gas Safe registered engineer.',
  live_test: 'I can\'t guide testing with the power on — that needs a qualified engineer. Any check I suggest is done with it switched off and unplugged.',
  bypass: 'I can\'t help with getting round a door lock, thermal cut-out or any other safety device — they stop the appliance running when it isn\'t safe.',
};

const NEG = /\b(no|not|never|isn'?t|wasn'?t|aren'?t|don'?t|doesn'?t|didn'?t|can'?t|cannot|without|nothing|none)\b/;

/** Split text into clauses so a negation only covers its own clause. */
function clauses(text) {
  return String(text || '').toLowerCase().replace(/[’]/g, "'").split(/[.!?;\n]+|,\s*(?:but|and|though|although)\s+|\bbut\b/).map((s) => s.trim()).filter(Boolean);
}

/** True when `re` matches a clause of `text` that does not negate it before the match. */
function affirmed(text, re, scope = 'clause') {
  const parts = scope === 'sentence' ? String(text || '').toLowerCase().replace(/[’]/g, "'").split(/[.!?\n]+/).map((x) => x.trim()).filter(Boolean) : clauses(text);
  for (const c of parts) {
    const m = c.match(re);
    if (!m) continue;
    const before = c.slice(Math.max(0, m.index - 28), m.index);
    if (!NEG.test(before)) return { clause: c, match: m[0] };
  }
  return null;
}

// Hazard detectors over the customer's words. Each returns the clause that triggered it.
const DETECT = [
  { type: 'gas', re: /\b((?:smell(?:s|ing|ed)?|smelt) (?:of )?gas|gas smell|gas leak|leaking gas|smell gas|whiff of gas|rotten eggs?)\b/ },
  { type: 'fire', re: /\b(on fire|caught fire|flames? (?:coming|inside|came|from)|still smoking|smoke (?:is )?(?:still )?(?:coming|pouring|billowing))\b/ },
  { type: 'battery', re: /\b(battery|batteries)\b[^.]{0,40}\b(swollen|swelling|bulg\w*|puff\w*|expand\w*|melt\w*|leak\w*|hiss\w*|smok\w*|really hot|very hot|too hot to touch|overheat\w*)\b|\b(swollen|bulg\w*|puffed up|expanded)\b[^.]{0,30}\bbattery\b|\bbattery\b[^.]{0,40}\bchemical smell\b|\bchemical smell\b[^.]{0,40}\bbattery\b/ },
  { type: 'microwave_arcing', re: /\b(spark(?:s|ing|ed)?|arc(?:s|ing|ed)?|flash(?:es|ing)? inside|blue flash)\b/, appliance: ['microwave'] },
  { type: 'burning', re: /\b(burning smell|(?:smell(?:s|ed|ing)?|smelt) (?:of |like )?(?:burning|something burning)|smel(?:ls?|t) burnt|burnt smell|burning plastic|smoke|smoking|smoked|scorch\w*|melted|melting|fishy smell|electrical smell|hot plastic smell)\b/ },
  { type: 'electric_shock', re: /\b(electric shock|got a shock|gave me a shock|shocked me|tingl\w+|zapped me|small shock)\b/ },
  { type: 'electrical_water', scope: 'sentence', re: /\b(water|wet|leak\w*|puddle|flood\w*)\b[^.!?]{0,140}\b(plug|socket|wiring|wires|extension|fuse ?box|consumer unit)\b|\b(plug|socket|wiring|extension)\b[^.!?]{0,80}\b(wet|water|damp|soaked)\b/ },
  { type: 'supply_trip', re: /\b(trips? (?:the|my|our)? ?(?:electrics?|power|fuse|rcd|breaker|switch)|tripping (?:the )?(?:electrics?|power|rcd|breaker)|keeps tripping|blew the fuse|blows the fuse)\b/ },
];

// Unsafe things the customer may ask to do. These are declined whatever the hazard state.
const UNSAFE_REQUEST = [
  { type: 'microwave_hv', re: /\b(capacitor|magnetron|high[- ]voltage|hv (?:diode|fuse|transformer)|discharge)\b|\b(open|take off|remove|unscrew)\b[^.]{0,30}\b(casing|cover|case|outer)\b/, appliance: ['microwave'] },
  { type: 'gas_work', re: /\b(thermocouple|gas valve|regulator|gas pipe|gas fitting|injector|jet)\b[^.]{0,40}\b(replace|adjust|remove|change|fix|take apart|unscrew|swap)\b|\b(replace|adjust|remove|change|fix|take apart|unscrew|swap)\b[^.]{0,40}\b(thermocouple|gas valve|regulator|gas pipe|gas fitting)\b/ },
  { type: 'refrigerant', re: /\b(re-?gas|regas|top up (?:the )?(?:gas|refrigerant)|refrigerant|recharge (?:the )?gas|pierce (?:the )?pipe)\b/ },
  { type: 'bypass', re: /\b(bypass|by-pass|bridge|jump(?:er)?|override|defeat)\b[^.]{0,40}\b(thermal fuse|cut-?out|door lock|interlock|thermostat|safety)\b/ },
  { type: 'live_test', re: /\b(live|while (?:it'?s |it is )?(?:on|plugged in|powered)|with the power on|mains voltage|230 ?v|240 ?v)\b[^.]{0,40}\b(test|measure|check|meter|multimeter|probe)\b|\b(test|measure|probe)\b[^.]{0,40}\b(while (?:it'?s |it is )?(?:on|plugged in|powered)|with the power on|live)\b/ },
];

/** Hazard policy: what continues and what is forbidden. */
const POLICY = {
  gas: { terminate: true, escalate: 'gas-emergency', prohibit: ['operate', 'ignite', 'switches', 'test', 'diy'] },
  fire: { terminate: true, escalate: 'emergency', prohibit: ['operate', 'test', 'open', 'diy'] },
  battery: { terminate: false, escalate: 'replace-battery-via-manufacturer', prohibit: ['charge', 'operate', 'open', 'puncture'] },
  microwave_arcing: { terminate: false, escalate: 'engineer-if-internal', prohibit: ['operate', 'open', 'test'] },
  burning: { terminate: false, escalate: 'engineer', prohibit: ['operate', 'test', 'open-live'] },
  electric_shock: { terminate: false, escalate: 'electrician-or-engineer', prohibit: ['operate', 'test', 'open-live'] },
  electrical_water: { terminate: false, escalate: 'electrician-or-engineer', prohibit: ['touch-wet', 'operate', 'test'] },
  supply_trip: { terminate: false, escalate: 'electrician-or-engineer', prohibit: ['reset-repeatedly', 'operate', 'test'] },
  recall: { terminate: false, escalate: 'manufacturer-recall', prohibit: ['operate'] },
};

// Prohibited advice in a proposed reply. `when` = the hazard types (or '*' = always) under which it is prohibited.
const PROHIBITED_ADVICE = [
  { id: 'hv-microwave', when: '*', appliance: ['microwave'], re: /\b(discharg\w+|capacitor|magnetron|hv diode|high[- ]voltage (?:diode|transformer|fuse))\b[^.]{0,60}\b(test|check|replace|remov\w*|short|screwdriver|meter|discharg\w*)\b|\b(remove|take off|unscrew|open)\b[^.]{0,25}\b(outer )?(casing|cover|case)\b/ },
  { id: 'live-test', when: '*', re: /\b(with (?:the )?power (?:on|connected)|while (?:it'?s |it is )?(?:plugged in|switched on|powered|live|running))\b[^.]{0,50}\b(test|measure|probe|meter|check (?:the )?voltage)\b|\b(measure|test|check) (?:the )?(?:mains )?voltage\b/ },
  { id: 'bypass', when: '*', re: /\b(bypass|by-pass|bridge|jump(?:er)? out|link out|override)\b[^.]{0,40}\b(thermal fuse|cut-?out|door lock|interlock|thermostat|safety (?:switch|device))\b/ },
  { id: 'refrigerant', when: '*', re: /\b(re-?gas|top up (?:the )?refrigerant|recharge (?:the )?(?:gas|refrigerant)|cut (?:the )?(?:pipe|capillary))\b/ },
  { id: 'gas-dismantle', when: '*', re: /\b(replace|remove|adjust|unscrew|disconnect)\b[^.]{0,30}\b(thermocouple|gas valve|regulator|gas pipe|gas fitting|injector)\b/ },
  { id: 'tv-open', when: '*', re: /\b(open|remove)\b[^.]{0,20}\b(back (?:panel|cover) of (?:the|your) tv|tv'?s back)\b|\bbacklight strips?\b[^.]{0,40}\b(replace|swap|solder|install)\b/ },
  { id: 'run-after-burning', when: ['burning', 'fire', 'microwave_arcing', 'supply_trip', 'electric_shock', 'electrical_water', 'battery'], re: /\b(run|try|test|switch|turn|power|plug)\b[^.]{0,30}\b(it )?(again|back on|on again|a (?:short |quick |test )?(?:cycle|programme|program|run)|an empty|empty cycle|test run|in again)\b/ },
  { id: 'touch-plug-near-water', when: ['electrical_water'], re: /\b(unplug|pull (?:out )?the plug|switch (?:it )?off at the (?:wall|socket|plug)|turn (?:it )?off at the (?:wall|socket|plug)|touch the (?:plug|socket))\b/ },
  { id: 'ignite-gas', when: ['gas'], re: /\b(light|ignite|spark|switch|turn)\b[^.]{0,30}\b(burner|hob|oven|on|off|ignition|match|lighter)\b/ },
  { id: 'charge-battery', when: ['battery'], re: /\b(charge|charging|plug (?:it|the charger) (?:back )?in|recharge)\b(?![^.]{0,20}\b(don'?t|never|stop)\b)/ },
  { id: 'reset-trip', when: ['supply_trip'], re: /\breset (?:the )?(?:rcd|breaker|trip|switch)\b(?![^.]{0,20}\b(once|don'?t)\b)/ },
];

function customerTexts(messages) {
  return (messages || []).filter((m) => m && m.role === 'user').map((m) => String(m.content || ''));
}

/**
 * Hazards present in the customer's words (whole conversation, latest turn first).
 * appliance: the ledger's appliance value (some detectors are appliance-specific).
 */
function detectHazards(messages, appliance) {
  const found = [];
  const texts = customerTexts(messages);
  texts.forEach((text, i) => {
    for (const d of DETECT) {
      if (d.appliance && !(appliance && d.appliance.includes(appliance))) continue;
      const hit = affirmed(text, d.re, d.scope);
      if (hit && !found.some((f) => f.type === d.type)) found.push({ type: d.type, clause: hit.clause, customerTurn: i + 1 });
    }
  });
  return found;
}

/** Unsafe requests in the latest customer message. */
function detectUnsafeRequest(latest, appliance) {
  const t = String(latest || '').toLowerCase();
  for (const u of UNSAFE_REQUEST) {
    if (u.appliance && !(appliance && u.appliance.includes(appliance))) continue;
    if (u.re.test(t)) return u.type;
  }
  return null;
}

/** The single most serious active hazard. */
const SEVERITY = ['gas', 'fire', 'battery', 'electrical_water', 'electric_shock', 'microwave_arcing', 'burning', 'supply_trip', 'recall'];
function mostSerious(hazards) {
  return [...hazards].sort((a, b) => SEVERITY.indexOf(a.type) - SEVERITY.indexOf(b.type))[0] || null;
}

/**
 * Check a proposed reply. Returns { text, violations[] } with each prohibited sentence removed.
 * Sentences that tell the customer NOT to do the thing are kept.
 */
function gateReply(reply, { hazards = [], appliance = null } = {}) {
  const active = new Set(hazards.map((h) => h.type));
  const sentences = String(reply || '').match(/[^.!?\n]+[.!?]*\s*|\n+/g) || [];
  const violations = [];
  const kept = sentences.filter((s) => {
    const low = s.toLowerCase();
    if (/\b(don'?t|do not|never|avoid|stop|no need to|please don'?t|shouldn'?t|must not|not safe to)\b/.test(low)) return true;
    for (const p of PROHIBITED_ADVICE) {
      if (p.appliance && !(appliance && p.appliance.includes(appliance))) continue;
      if (p.when !== '*' && !p.when.some((w) => active.has(w))) continue;
      if (p.re.test(low)) { violations.push({ rule: p.id, sentence: s.trim().slice(0, 200) }); return false; }
    }
    return true;
  });
  return { text: kept.join('').replace(/\s{2,}/g, ' ').trim(), violations };
}

function copyFor(type) {
  return COPY[type] || null;
}

module.exports = { COPY, POLICY, detectHazards, detectUnsafeRequest, mostSerious, gateReply, copyFor, affirmed, customerTexts };
