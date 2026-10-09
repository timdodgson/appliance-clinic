'use strict';
/**
 * Shared COMPOSE kit (wording only) for canonical journeys. PURE. Extracted from Journey 1.
 *   createCompose(pack) -> {brief, prompt, template, checkReply}
 * pack = {TASK, retestKey(nextAction, state)->key|null, conclusionCopy(state, a), OBS_COPY, CHECK_RESULT_COPY, statusChecks[], extraFacts(state, a)}
 * Every word a customer reads is either fixed copy keyed by typed keys, or an LLM rewording of it that
 * checkReply verifies (question count, no invented part / purchase / model ask, required safety present).
 */

// §9 requirement tokens -> fixed safety copy + a presence marker used ONLY to verify our own composed text.
const REQUIREMENT = {
  isolate_mains: { copy: 'Switch the machine off and unplug it first.', marker: /\b(unplug|switch(?:ed)?\s+(?:it\s+|the machine\s+)?off|isolat)/i },
  let_hot_water_cool: { copy: 'If it was on a hot wash, give the water time to cool before opening anything.', marker: /\b(cool|hot)\b/i },
  contain_water: { copy: 'Put towels down and have a shallow tray or baking dish ready, as several litres of water can come out.', marker: /\b(towel|tray|dish|bowl|container)/i },
  open_slowly: { copy: 'Unscrew the filter slowly so the water comes out gradually.', marker: /\b(slowly|gradual|a little at a time|bit by bit)/i },
  do_not_force: { copy: 'Don\'t force it if it won\'t turn.', marker: /\b(force|forcing)\b/i },
  keep_clear_of_socket_if_water_near: { copy: 'If any water has reached the plug or socket, don\'t touch it — tell me straight away instead.', marker: /\b(plug|socket)\b/i },
  door_stays_locked_until_empty: { copy: 'The door will stay locked until the water has gone, so don\'t try to force it open.', marker: /\b(door)\b/i },
  filter_already_removed: { copy: 'Do this with the filter still out and the machine still unplugged.', marker: /\b(filter)\b/i },
  no_tools_beyond_housing: { copy: 'Use a torch and a finger only — no tools inside the housing.', marker: /\b(torch|finger)\b/i },
  no_panel_removal: { copy: 'Don\'t take any panels off.', marker: /\bpanels?\b/i },
  machine_heavy_may_hold_water: { copy: 'The machine is heavy and may still hold water, so ease it forward carefully, ideally with help.', marker: /\b(heavy|carefully|help)\b/i },
  do_not_disconnect_under_load: { copy: 'Don\'t disconnect the hose while there is still water in the machine.', marker: /\b(disconnect|detach|pull the hose off)/i },
  stop_use: { copy: 'Stop using the machine.', marker: /\b(stop using|don't use|do not use)\b/i },
  do_not_touch_plug_if_wet: { copy: 'Don\'t touch the plug, socket or machine if they or your hands are wet.', marker: /\b(don't touch|do not touch)\b/i },
  isolate_at_consumer_unit_if_safe: { copy: 'If you can do it safely, switch off the circuit at the consumer unit (fuse box).', marker: /\b(consumer unit|fuse box|fuseboard)\b/i },
  // Journey 2 (not spinning)
  pause_wait_door_unlock: { copy: 'Pause or cancel the programme and wait for the door to unlock on its own before opening it.', marker: /\b(unlock|wait)/i },
  stop_if_violent_shaking: { copy: 'If it starts banging or shaking violently, stop the programme straight away.', marker: /\b(bang|shak|violent)/i },
  wait_drum_stopped_door_unlocked: { copy: 'Make sure the drum has stopped completely and the door has unlocked before you open it.', marker: /\b(stopped|unlock)/i },
  turn_by_hand_only: { copy: 'Turn the drum slowly by hand only — no tools.', marker: /\bby hand\b/i },
  never_bypass_interlock: { copy: 'Never try to force or bypass the door lock.', marker: /\b(bypass|force)/i },
  do_not_force_door: { copy: 'Don\'t force the door open or shut.', marker: /\bforc/i },
  do_not_open_or_reach_in_while_running: { copy: 'Just listen — don\'t open the door or reach in while it\'s running.', marker: /\b(listen|don't open|do not open|reach)/i },
  // Journey 3 (leaking)
  look_and_feel_only: { copy: 'Just look and feel along the rubber — don\'t pull or cut it.', marker: /\b(don'?t|do not|without|never)\s+(pull|pulling|cut|cutting|tug|tugging|stretch|stretching)\b/i },
  water_off_at_tap: { copy: 'Turn the water off at the tap (isolation valve) the machine is connected to.', marker: /\b(tap|valve|water off|turn off the water)\b/i },
  hand_tight_only: { copy: 'Hand-tighten only — no tools.', marker: /\bhand[- ]tight/i },
  watch_from_outside_only: { copy: 'Watch from outside the machine only — keep the panels on and don\'t reach in while it\'s running.', marker: /\b(watch|outside)\b/i },
  stop_if_water_near_socket: { copy: 'If water starts to reach the plug or socket, stop the programme and keep away from it.', marker: /\b(plug|socket)\b/i },
  power_off_only_if_dry: { copy: 'Only switch off or unplug at the socket if the plug and socket are completely dry — otherwise switch off at the consumer unit (fuse box).', marker: /\b(consumer unit|fuse box|dry)\b/i },
  // batch 2 (washing machine)
  tap_hose_from_outside: { copy: 'You can check this from the outside — there\'s no need to take anything apart.', marker: /\b(outside|take anything apart|no need to (open|take))/i },
  mesh_rinse_only: { copy: 'Just rinse the little mesh under a tap and ease any grit off gently — don\'t lever it out with tools.', marker: /\b(rinse|gently)\b/i },
  water_off_after_test: { copy: 'Turn the tap off again as soon as you\'ve seen whether water is still coming in.', marker: /\b(tap (back )?off|turn (the )?tap off|turn off the tap|tap off again)\b/i },
  watch_briefly_only: { copy: 'Only watch for a minute or so — don\'t leave it running in unattended.', marker: /\b(minute|unattended|don'?t leave)\b/i },
  stay_nearby_tap_ready: { copy: 'Stay nearby while it fills and turn the tap off straight away if the water gets too high.', marker: /\b(stay nearby|stay close|tap off|turn the tap off|turn off the tap)\b/i },
  look_only_no_tools: { copy: 'Look only — no tools on the catch or the lock.', marker: /\b(look only|no tools|without tools)\b/i },
  stand_clear_while_spinning: { copy: 'Stand clear while it spins and don\'t try to hold it still.', marker: /\b(stand clear|keep clear|hold it still|don'?t (try to )?hold)\b/i },
  torch_and_fingers_only: { copy: 'Use a torch and your fingers only — don\'t poke tools through the drum holes.', marker: /\b(torch|finger)/i },
  stop_if_trips_or_burning: { copy: 'If the electrics trip or you smell burning, stop it, leave it switched off and tell me.', marker: /\b(trip|burning)/i },
  hot_glass_wait_unlock: { copy: 'The glass and the water can get hot, so let the door unlock on its own at the end.', marker: /\b(hot|unlock)/i },
  // dishwasher family
  gloves_for_glass: { copy: 'Wear gloves — there can be broken glass in the sump.', marker: /\b(glove|broken glass)/i },
  dw_hot_steam: { copy: 'Open the door carefully at the end — the steam and the dishes can be very hot.', marker: /\b(steam|hot|carefully)\b/i },
  no_tilting: { copy: 'Leave the base tray alone — don\'t tip the dishwasher up to empty it.', marker: /\b(tip|tilt)/i },
  no_live_electrical_checks: { copy: 'Only check switches and plugs you can see — no electrical testing and no panels off.', marker: /\b(no electrical|panels? off|don'?t open|switches and plugs)/i },
  // fridge / freezer family
  unplug_fridge: { copy: 'Switch the fridge freezer off at the socket and unplug it first.', marker: /\b(unplug|switch(?:ed)?\s+(?:it\s+|the fridge(?: freezer)?\s+)?off)/i },
  no_refrigerant_work: { copy: 'Don\'t open, bend or pierce any of the pipes or the cooling circuit — it\'s sealed and needs a refrigeration engineer.', marker: /\b(pipes?|sealed|cooling circuit)\b/i },
  no_sharp_tools_on_ice: { copy: 'Don\'t chip the ice away with a knife or anything sharp — let it melt.', marker: /\b(sharp|knife|chip)/i },
  ff_defrost_towels: { copy: 'Move the food into cool bags, put towels down and leave the doors open until all the ice has melted (often several hours).', marker: /\btowel/i },
  ff_food_safety: { copy: 'Keep the doors shut as much as you can. A fridge should be at 5°C or below: chilled food that has been warmer than 8°C for more than about four hours is safest thrown away, and food that has fully thawed shouldn\'t be refrozen unless it\'s cooked first.', marker: /\b(5°C|8°C|thaw|refrozen|refreez)/i },
  ff_listen_only: { copy: 'Just listen from the outside — don\'t take any covers off or touch anything at the back.', marker: /\b(listen|covers? off|don'?t touch)/i },
  ff_hot_compressor: { copy: 'Unplug it and give it half an hour first — parts at the back can be hot.', marker: /\b(hot|half an hour|30 minutes)\b/i },
  // tumble dryer family
  td_unplug_cool: { copy: 'Switch the dryer off, unplug it and let it cool down first.', marker: /\b(unplug|cool)/i },
  // final pass: oven / hob / gas / microwave / vacuum
  oven_isolate_cool: { copy: 'Switch the oven off at the wall or its cooker switch (isolator) and let it cool completely first.', marker: /\b(isolator|cooker switch|switch(?:ed)? (?:it )?off|cool)/i },
  oven_hot_surfaces: { copy: 'Take care — the oven and grill get hot quickly, so use oven gloves and don\'t touch the elements.', marker: /\b(gloves|hot)\b/i },
  gas_knobs_off_cold: { copy: 'Make sure every gas knob is off and the burners are cold first.', marker: /\b(knobs? (are |is )?off|cold)\b/i },
  no_gas_dismantling: { copy: 'Only lift off the burner cap and crown — don\'t remove anything else or loosen any gas fittings.', marker: /\b(gas fittings|only lift|don'?t remove)\b/i },
  mw_no_casing: { copy: 'Unplug it first and never take the outer casing off — parts inside can hold a lethal charge even when it is unplugged.', marker: /\b(casing|lethal)\b/i },
  vac_power_off: { copy: 'Switch it off and unplug it (or take the battery off) first.', marker: /\b(unplug|battery|switch(?:ed)? (?:it )?off)/i },
  vac_filter_dry: { copy: 'A washed filter must be completely dry (at least 24 hours) before it goes back in.', marker: /\bdry\b/i },
  gas_emergency: { copy: 'Treat a gas smell as an emergency: no switches or flames, ventilate, and call the National Gas Emergency line on 0800 111 999.', marker: /0800 111 999/ },
};


const SAFETY_COPY = {
  electrical_water: 'Water near the plug or socket is dangerous. Please don\'t touch the plug, socket or machine if they or your hands are wet. If you can do it safely, switch off the circuit at the consumer unit (fuse box), keep away from the water, and don\'t use the machine again until a qualified electrician or appliance engineer has checked it.',
  electric_shock: 'Stop using the machine now. If you can do it safely, switch it off at the socket or at the consumer unit (fuse box). A shock usually means an earth or insulation fault, so don\'t use it again until a qualified electrician or appliance engineer has found and fixed it.',
  gas_escape: 'If you can smell gas, treat it as an emergency: don\'t turn any switches on or off and no naked flames. Turn the gas off at the meter if you safely can, open doors and windows, and leave if the smell is strong. Call the National Gas Emergency line on 0800 111 999.',
  burning: 'A burning smell or smoke can mean an electrical fault or a fire risk. Stop using the machine, switch it off and unplug it (or turn it off at the fuse box), and don\'t use it again until it has been checked by a qualified engineer.',
  supply_trip: 'Stop using the machine and don\'t keep resetting the trip. Leave it unplugged and have it checked by a qualified electrician or appliance engineer before using it again.',
};
SAFETY_COPY['major-leak'] = 'Let\'s stop the water first. Turn the water off at the tap (isolation valve) the machine is connected to. If the plug and socket are completely dry, switch the machine off at the socket; if there is water anywhere near them, don\'t touch them — switch off at the consumer unit (fuse box) instead. Then mop up and keep the machine off until we\'ve found where it\'s coming from. Once the water is off, tell me where you saw it coming from.';
SAFETY_COPY['uncontrolled-fill'] = 'Let\'s stop the water first. Turn the water off at the tap (isolation valve) the machine is connected to. If the plug and socket are completely dry, switch the machine off at the socket; if there is any water near them, don\'t touch them — switch off at the consumer unit (fuse box) instead. Mop up any spill and leave the tap off for now. When you\'re ready, tell me whether water was still running in after the machine was switched off, or whether it only takes too much water while a programme is running.';
SAFETY_COPY['uncontrolled-fill-off'] = 'Let\'s stop the water first. Turn the water off at the tap (isolation valve) the machine is connected to, and keep it off whenever the machine isn\'t in use for now. If the plug and socket are completely dry, switch the machine off at the socket; if there is any water near them, don\'t touch them — switch off at the consumer unit (fuse box) instead. Mop up any spill. When you\'re ready, tell me whether the water that comes in is clean like tap water, or dirty and smelly like waste water.';
SAFETY_COPY['uncontrolled-fill-known'] = 'Let\'s stop the water first. Turn the water off at the tap (isolation valve) the machine is connected to, and keep it off whenever the machine isn\'t in use for now. If the plug and socket are completely dry, switch the machine off at the socket; if there is any water near them, don\'t touch them — switch off at the consumer unit (fuse box) instead. Mop up any spill, and let me know once that\'s done so we can carry on.';
SAFETY_COPY.gas_smell = SAFETY_COPY.gas_escape;
SAFETY_COPY.exposed_live_wiring = 'Exposed or damaged live wiring (or a cracked hob top) can give a serious electric shock. Don\'t touch it — switch it off at the consumer unit (fuse box) or its isolator switch, keep everyone away, and don\'t use it again until a qualified electrician or appliance engineer has made it safe.';
SAFETY_COPY.microwave_arcing = 'Stop using the microwave now: switch it off at the socket and unplug it, and don\'t run it again (not even empty) until we know why it sparked. Never take the outer casing off — parts inside can hold a lethal charge even when it is unplugged.';
SAFETY_COPY['mw-arcing'] = `${SAFETY_COPY.microwave_arcing} Once it is unplugged, have a look inside with the door open: was there any metal, foil or a dish with a metal rim inside, is the small cover panel on the inside wall burnt or damaged, or is the paint inside burnt or chipped?`;
SAFETY_COPY['oven-trip'] = 'Please don\'t keep resetting the trip. Leave the oven switched off at its cooker switch (isolator) or at the fuse box and don\'t use it until it has been checked — never test it with the power on. One detail helps the engineer: does it trip as soon as it is switched on, or only after it has been heating for a while (or only on one function)?';
SAFETY_COPY.smoke = SAFETY_COPY.burning;
SAFETY_COPY.sparks_at_supply = SAFETY_COPY.supply_trip;


const REOFFER = 'No problem if you haven\'t had a chance yet.';
// they looked and found it blocked / dirty but have not cleared it yet: clearing it is the next step
const REOFFER_FOUND = 'You\'ve found it blocked, so clearing it is the next step, and that may well sort it.';
// Re-offer framing by the typed outcome of the previous request for the same target.
function reofferFrame(state, target) {
  const rs = ((state && state.requests) || []).filter((r) => r.target === target);
  const last = rs.length ? rs[rs.length - 1].outcome : null;
  const k = state && state.evidence && state.evidence.checks && state.evidence.checks[target];
  if (k && k.status === 'not_done' && k.result === 'found_unspecified') return REOFFER_FOUND;
  return last === 'not_done' || (k && k.status === 'not_done') ? REOFFER : '';
}

const factLine = (state) => {
  const out = [];
  const id = state.identity || {};
  const app = id.appliance && id.appliance.value ? String(id.appliance.value).replace(/-/g, ' ') : 'washing machine';
  out.push(`Appliance: ${app}`);
  if (id.make && id.make.value) out.push(`Make: ${id.make.value}`);
  if (id.model && id.model.value && id.model.confirmed) out.push(`Model: ${id.model.value}`);
  if (id.modelStatus === 'unavailable') out.push('The customer cannot find the model number.');
  const code = (id.displayedCodes || []).filter((f) => f.status === 'active').pop();
  if (code) out.push(`Displayed code: ${code.value} (a controller report only — not proof of a failed part)`);
  return out;
};
const STATUS_COPY = { not_done: 'not done yet', declined: 'customer prefers not to', unable: 'customer could not do it' };

function makeEvidenceLines(OBS_COPY, CHECK_RESULT_COPY, statusChecks) {
  /* Typed evidence as fixed phrases; `latest` = what THIS turn's merge recorded (turn == state.version). */
  function evidenceLines(state, onlyLatest = false) {
    const out = [];
    const now = state.version;
    const isNow = (t) => !onlyLatest || t === now;
    const obs = (state.evidence && state.evidence.observations) || {};
    for (const [k, [t, f]] of Object.entries(OBS_COPY)) {
      const o = obs[k]; const v = o && o.value;
      if (!o || !isNow(Math.max(o.turn || 0, o.lastTurn || 0))) continue;
      if (o.basis === 'derived') continue; // what the customer reported, never what we inferred from it
      if (v === true && t) out.push(t); else if (v === false && f) out.push(f);
    }
    const checks = (state.evidence && state.evidence.checks) || {};
    for (const [c, m] of Object.entries(CHECK_RESULT_COPY)) {
      const k = checks[c]; if (!k || !isNow(k.turn)) continue;
      if (k.status === 'done' && m[k.result]) out.push(m[k.result]);
      else if (k.status === 'not_done' && k.result === 'found_unspecified') out.push(`${c.replace('-', ' ')}: found blocked or dirty, not cleared yet`);
      else if (STATUS_COPY[k.status]) out.push(`${c.replace('-', ' ')}: ${STATUS_COPY[k.status]}`);
    }
    // Status-only functional checks (their result is an observation): report a non-performed status.
    for (const [c, label] of statusChecks) {
      const k = checks[c];
      if (k && isNow(k.turn) && STATUS_COPY[k.status]) out.push(`${label}: ${STATUS_COPY[k.status]}`);
    }
    return out;
  }
  function latestIdentity(state) {
    const id = state.identity || {}; const out = [];
    if (id.model && id.model.value && id.model.turn === state.version) out.push(`gave the model ${id.model.value}`);
    if (id.modelStatus === 'unavailable' && !(id.model && id.model.value)) out.push('cannot find the model number');
    return out;
  }
  const naturalList = (xs) => (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
  
  
  return { evidenceLines, latestIdentity, naturalList };
}

const DEFAULT_PURCHASE_RE = /\b(buy|order|purchase|price|£\s?\d)|\b(new|replacement|replace the)\s+(drain\s+)?(pump|pressure switch|pcb|control board|motor)\b/i;
function createCompose(pack) {
  const { TASK, conclusionCopy, OBS_COPY, CHECK_RESULT_COPY, statusChecks = [], retestKey = () => null, extraFacts = () => [], CONFIRM_ASK = 'Is it all working normally now?', PURCHASE_RE = DEFAULT_PURCHASE_RE,
    ASK_GUARD = false } = pack;
  const { evidenceLines, latestIdentity } = makeEvidenceLines(OBS_COPY, CHECK_RESULT_COPY, statusChecks);
  // An owner check the customer moved past (policy ownerCheck) is the first thing to do, said once with the conclusion.
  function withOwnerCheck(text, a) {
    if (a.conclusion && a.conclusion.repeat) return null;
    const t = a.conclusion && a.conclusion.ownerCheck;
    const task = t ? TASK[`ask_check:${t}`] : null;
    return task && task.say ? `${text} If you haven't had a chance yet, this check comes first: ${task.say}` : text;
  }
  function brief(state, a, diag, { partLookup = null, media = [] } = {}) {
    const key = retestKey(a, state) || `${a.kind}:${a.target}`;
    const task = TASK[key] || null;
    const isAsk = /^ask_/.test(a.kind);
    return {
      kind: a.kind, rule: a.rule, target: a.target,
      facts: [...factLine(state), ...extraFacts(state, a)], evidence: evidenceLines(state), latest: (state.version > 1 ? [...latestIdentity(state), ...evidenceLines(state, true)] : []),
      task: task ? { say: task.say, ask: task.ask, reoffer: a.requestKind === 'reoffer' ? reofferFrame(state, a.target) : '' } : null,
      conclusion: !isAsk && a.kind !== 'safety_stop' ? (withOwnerCheck(conclusionCopy(state, a), a) || followUpCopy(a)) : null,
      confirm: a.pending && a.pending.purpose === 'CONFIRM' ? CONFIRM_ASK : null,
      safety: (a.requires || []).map((t) => (REQUIREMENT[t] ? { token: t, copy: REQUIREMENT[t].copy } : null)).filter(Boolean),
      safetyStop: a.kind === 'safety_stop' ? (SAFETY_COPY[a.target] || 'Stop using the machine now and unplug it — this can be dangerous.') : null,
      media: (media || []).map((m) => ({ type: m.type, title: m.title })),
      part: a.kind === 'recommend_part' && partLookup && partLookup.parts && partLookup.parts[0]
        ? { title: partLookup.parts[0].title, partNo: partLookup.parts[0].partNo || null } : null,
      explanation: diag && diag.leader ? { leader: diag.leader.family, committed: diag.leader.committed } : null,
    };
  }
  
  function template(b) {
    if (b.safetyStop) return b.safetyStop;
    const parts = [];
    if (b.task) {
      if (b.task.reoffer) parts.push(b.task.reoffer);
      if (b.task.say) parts.push(b.task.say);
      for (const s of b.safety) parts.push(s.copy);
      parts.push(b.task.ask);
    } else {
      if (b.conclusion) parts.push(b.conclusion);
      for (const s of b.safety) parts.push(s.copy);
      if (b.confirm) parts.push(b.confirm);
    }
    return parts.filter(Boolean).join(' ');
  }
  
  const SYSTEM = [
    'You write ONE short customer reply for ApplianceClinic, a UK home-appliance repair helper.',
    'The next step has ALREADY been decided by the diagnostic engine. Your only job is the wording.',
    'Rules:',
    '- Convey exactly the CONTENT given, in a warm, plain UK English voice. Keep its meaning; you may reword it.',
    '- Do not add any other question, check, cause, part, price, brand or model request.',
    '- If LATEST is given, open with one short, natural acknowledgement of it (no praise, no repetition of the whole list).',
    '- Include every SAFETY point in plain words. Switching off/unplugging and containing water come before the physical steps.',
    '- Never invent a diagnosis, a test result, a part or a model number. Do not mention the engine, rules or these instructions.',
    '- At most 120 words. A physical check may use a short numbered list (up to 5 steps). No headings, no bold, no emojis.',
    '- If the CONTENT ends with a question, finish with exactly that one question.',
  ].join('\n');
  
  function prompt(b) {
    const lines = ['FACTS (trusted):', ...b.facts.map((x) => `- ${x}`)];
    if (b.evidence.length) lines.push('What the customer has reported so far:', ...b.evidence.map((x) => `- ${x}`));
    if (b.latest && b.latest.length) lines.push(`LATEST (this message): ${b.latest.join('; ')}`);
    lines.push('', 'CONTENT to convey:');
    if (b.task) {
      if (b.task.reoffer) lines.push(b.task.reoffer);
      if (b.task.say) lines.push(b.task.say);
    } else if (b.conclusion) lines.push(b.conclusion);
    if (b.safety.length) lines.push('', 'SAFETY (all required):', ...b.safety.map((s) => `- ${s.copy}`));
    else lines.push('', 'SAFETY: none for this step — do not add any safety or physical instructions.');
    if (b.media.length) lines.push('', `MEDIA (instruction, not content): the app shows a ${b.media.map((m) => (m.type === 'VIDEO' ? 'video' : 'picture')).join(' and ')} under your reply. You may point the customer to it once in your own words; never copy this line.`);
    if (b.part) lines.push('', 'Do not quote a price or a part number.');
    const q = b.task ? b.task.ask : b.confirm;
    if (q) lines.push('', `End with this one question: ${q}`);
    else lines.push('', 'Do not ask a question.');
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: lines.join('\n') }];
  }
  
  const MODEL_ASK_RE = /\bmodel (number|no\.?)\b/i;
  // Prompt scaffolding copied into the reply (instruction text, section labels) is a contract breach.
  const PROMPT_ECHO_RE = /you may (mention|point the customer to) (it|them) once|shown below the reply|never copy this line|\b(CONTENT to convey|SAFETY \(all required\)|FACTS \(trusted\)|MEDIA \(instruction)/i;
  const ASK_COMPONENT_WORDS = /\b(pcb|control board|motor|bearings?|heater|heating element|element|thermostat|thermistor|sensor|magnetron|capacitor|diode|transformer|inlet valve|drain pump|drive belt|compressor|relay|igniter|thermocouple|gas valve|regulator|interlock|battery|charger|fan motor|power board|induction (module|board|coil))\b/gi;
  
  /** Verify COMPOSE kept to the NextAction. Missing safety -> fixed copy prepended; contract breach -> fallback. */
  function checkReply(reply, a, b) {
    const violations = [];
    let text = String(reply || '').replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\*\*/g, '').trim();
    if (text.length < 20) return { ok: false, reply: template(b), violations: ['empty'] };
    const questions = (text.match(/\?/g) || []).length;
    const asks = Boolean(b.task || b.confirm);
    if (asks && questions === 0) violations.push('missing-question');
    if (asks && questions > 1) violations.push('extra-questions'); // exactly the ONE decided question
    if (!asks && questions > 0) violations.push('unexpected-question');
    if (a.kind !== 'recommend_part' && PURCHASE_RE.test(text)) violations.push('invented-part-or-purchase');
    // opt-in (final-pass packs): on an ask turn a component word must come from that step's fixed copy, the safety copy or
    // the customer's own words — never a diagnosis the step did not make ("check if the heating element is working")
    if (ASK_GUARD && /^ask_/.test(a.kind)) {
      const fixed = `${(b.task && `${b.task.say} ${b.task.ask} ${b.task.reoffer || ''}`) || ''} ${b.safety.map((s) => s.copy).join(' ')} ${(b.latest || []).join(' ')} ${(b.evidence || []).join(' ')}`.toLowerCase();
      const words = new Set((text.match(ASK_COMPONENT_WORDS) || []).map((w) => w.toLowerCase()));
      if ([...words].some((w) => !fixed.includes(w))) violations.push('invented-component');
    }
    const asksModel = (text.match(/[^.!?]*\?/g) || []).some((q) => MODEL_ASK_RE.test(q));
    if (!(a.kind === 'ask_identity' && a.target === 'model') && asksModel) violations.push('model-ask-not-decided');
    if (text.split(/\s+/).length > 190) violations.push('too-long');
    if (PROMPT_ECHO_RE.test(text)) violations.push('prompt-echo');
    if (violations.length) return { ok: false, reply: template(b), violations };
    const plain = text.replace(/[\u2018\u2019]/g, "'"); // typographic apostrophes ("don’t") match the markers too
    const missing = b.safety.filter((s) => !REQUIREMENT[s.token].marker.test(plain));
    if (missing.length) {
      text = `${missing.map((s) => s.copy).join(' ')} ${text}`;
      violations.push(...missing.map((s) => `safety-added:${s.token}`));
    }
    return { ok: true, reply: text, violations };
  }
  
  
  return { brief, prompt, template, checkReply };
}
/**
 * Standard conclusion wording for step-policy journeys (same structure as Journey 3's conclusionCopy).
 * Copy precedence: close_resolved · recommend_part · CONCLUSION["<rule>:<cause>"] · component without a
 * matched part · CONCLUSION[cause] · generic "most likely … (alternatives) + handoff".
 */
const HANDOFF_COPY = {
  engineer: 'An appliance engineer is the best next step to confirm it safely — I\'m not recommending a part from this.',
  plumbing: 'That is a household plumbing / supply matter rather than a machine fault, so a plumber (or your water supplier) is the next step — no machine part is needed.',
  install: 'That is an installation matter rather than a faulty part — no machine part is needed.',
  none: 'No part is needed.',
  gas: 'That needs a Gas Safe registered engineer — please don\'t take any gas parts apart or loosen any fittings. I\'m not recommending a part from this.',
};
/** A conclusion already given, with nothing new since: a short follow-up, not the whole conclusion again. */
function followUpCopy(a) {
  const c = a.conclusion || {};
  const next = c.ownerCheck ? 'The check I described is still the best next step when you get the chance, and if it doesn\'t help, ' : '';
  const tail = c.handoff === 'none' || !HANDOFF_COPY[c.handoff] ? 'just let me know what you find.' : HANDOFF_COPY[c.handoff].replace(/^./, (x) => x.toLowerCase());
  return `No problem — nothing changes from what I said above. ${next}${next ? tail : tail.replace(/^./, (x) => x.toUpperCase())}`;
}
function makeConclusionCopy({ FAMILY_LABEL, COMPONENT_LABEL, CONCLUSION = {}, REASON = {}, fitNote = 'Switch the machine off and unplug it before fitting it; if you\'d rather not, an appliance engineer can fit it.' }) {
  return function conclusionCopy(state, a) {
    const c = a.conclusion || {};
    const model = state.identity.model && state.identity.model.confirmed ? state.identity.model.value : null;
    const unavailable = state.identity.modelStatus === 'unavailable';
    if (a.kind === 'close_resolved') return `Glad it's working normally again${c.cause && FAMILY_LABEL[c.cause] ? ` — ${FAMILY_LABEL[c.cause]} was the likely cause` : ''}. No part is needed.`;
    if (a.kind === 'recommend_part') {
      const comp = COMPONENT_LABEL[c.component] || 'part';
      return `What you've found points to the ${comp}. I've shown the matching ${comp} for your ${model || 'machine'} below. ${fitNote}`;
    }
    if (c.cause === 'unsafe-request-declined') return UNSAFE_DECLINE[c.unsafeAction] || UNSAFE_DECLINE.default;
    if (CONCLUSION[`${a.rule}:${c.cause}`]) return CONCLUSION[`${a.rule}:${c.cause}`];
    if (c.level === 'component' && COMPONENT_LABEL[c.component]) {
      const noMatch = unavailable ? 'Without the model number I can\'t match the exact part' : 'I can\'t match a compatible part for your model from here';
      // a component is the leading candidate from what the customer described, never a certain cause (nothing was tested);
      // a journey may say WHY the evidence points there (REASON[component](state) -> sentence | null)
      const why = typeof REASON[c.component] === 'function' ? REASON[c.component](state, a) : null;
      if (why) return `${why} That makes the ${COMPONENT_LABEL[c.component]} the most likely cause — it would need testing to be certain. ${noMatch}, so an appliance engineer is the best next step.`;
      return `From what you've described, the ${COMPONENT_LABEL[c.component]} is the most likely cause — it would need testing to be certain. ${noMatch}, so an appliance engineer is the best next step.`;
    }
    if (CONCLUSION[c.cause]) return typeof CONCLUSION[c.cause] === 'function' ? CONCLUSION[c.cause](state, a) : CONCLUSION[c.cause];
    if (c.cause === 'likely-causes') {
      const ls = (c.alternatives || []).map((x) => FAMILY_LABEL[x]).filter(Boolean);
      if (ls.length) return `That's fine — I can't narrow it down further from what we know, so here are the usual causes, most likely first: ${naturalListFn(ls).replace(/ or ([^,]+)$/, ' and $1')}. ${HANDOFF_COPY[c.handoff] || HANDOFF_COPY.engineer}`;
    }
    if (c.cause === 'fault-source-unconfirmed') return `From what we have so far I can't pin down the cause safely. ${HANDOFF_COPY.engineer}`;
    const alts = (c.alternatives || []).map((x) => FAMILY_LABEL[x]).filter(Boolean);
    const label = FAMILY_LABEL[c.cause] || 'a fault we haven\'t been able to pin down';
    // an owner-fixable cause that is only "possible" is not confirmed: no "no part is needed" claim until it is
    const tail = c.handoff === 'none' && c.confidence !== 'likely' ? 'The check for it is simple; if it doesn\'t sort it, let me know what you find.' : (HANDOFF_COPY[c.handoff] || HANDOFF_COPY.engineer);
    return `From the checks so far, the most likely cause is ${label}${alts.length ? ` (${naturalListFn(alts)} is also possible)` : ''}. ${tail}`;
  };
}
/** Fixed decline copy for an unsafe request (policy P8, opt-in per journey). */
const UNSAFE_DECLINE = {
  refrigerant_work: 'I can\'t help with re-gassing or opening the cooling circuit — it\'s sealed and pressurised (and often uses a flammable gas), so only a refrigeration engineer should work on it. Please don\'t pierce or cut any pipes. We can carry on with the safe checks whenever you\'re ready.',
  bypass_safety_device: 'I can\'t help with getting round a door lock, thermal cut-out or any other safety device — they stop the appliance running when it isn\'t safe. We can carry on with the safe checks whenever you\'re ready.',
  live_electrical_test: 'I can\'t guide testing with the power on — that needs a qualified engineer. We can carry on with the safe checks you can do with it unplugged whenever you\'re ready.',
  open_while_powered: 'Please don\'t take panels off while it\'s plugged in. Any check I suggest is done unplugged and without opening it up — we can carry on with those whenever you\'re ready.',
  hv_microwave_work: 'I can\'t guide any testing or work inside a microwave — the high-voltage capacitor can hold a lethal charge even when it is unplugged, so the casing should only be opened by a qualified engineer. We can carry on with the safe checks you can do from the outside whenever you\'re ready.',
  gas_work: 'I can\'t help with taking apart or adjusting gas parts (valves, thermocouples, regulators or pipework) — that legally needs a Gas Safe registered engineer. We can carry on with the safe checks whenever you\'re ready.',
  repeated_reset_after_trip: 'Please don\'t keep resetting the trip — leave the appliance unplugged and have it checked by a qualified electrician or appliance engineer before using it again.',
  default: 'I can\'t help with that safely — it needs a qualified engineer. We can carry on with the safe checks whenever you\'re ready.',
};
/** Fixed copy for the shared retest step (owner fix -> run it again). */
const RETEST_TASK = { say: 'Now run a normal programme again and see whether the problem comes back.', ask: 'Is it working normally now, or does the problem still happen?' };

const naturalListFn = (xs) => (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

module.exports = { REQUIREMENT, SAFETY_COPY, REOFFER, reofferFrame, factLine, createCompose, naturalList: naturalListFn,
  makeConclusionCopy, HANDOFF_COPY, RETEST_TASK };
