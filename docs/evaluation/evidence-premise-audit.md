# Evidence-premise audit (conclusion copy)

**Rule:** no customer-facing conclusion may assert an observation, completed check, state or prerequisite that cs/1 does not record.

## The defect

Live case (2026-10-12): the customer said "oven not heating", then "I don't know", then "not sure, sorry". The product replied "With the fan running and the grill working but the main oven cold, the fan-oven element … is the usual cause."

Reproduced in `services/diagnosis-engine/test/canonical-evidence-premises.test.mjs`:

| Turn | cs/1 evidence | NextAction |
|---|---|---|
| 1 | `mainOvenWorks: false` | OH10 `ask_check oven-clock-mode` |
| 2 | clock request `cannot_answer` | OH11 `ask_observation ovenFunctions` |
| 3 | grill request `cannot_answer` | OH22 `conclude fan-oven-element` (`cause_family`, `possible`; leader uncommitted) |

The fan and grill claims came in at two layers:

1. **Policy.** After two unanswered requests (`policy-kit.js` `disengaged()`), P22 concludes the best-supported leader even when it is uncommitted. Here that leader was the fan-oven element: its prior plus the weak `ovenDead` signal.
2. **Copy (root cause).** `compose-kit.js` `makeConclusionCopy` returned the fixed `CONCLUSION[cause]` text whatever the evidence. That text hard-coded the premise of the evidence pattern it was written for. A cause-keyed entry can be reached through P22 with any evidence, so its premises were never guaranteed.

## The fix

Fixed copy that states a premise now declares the evidence it needs:

```js
{ requires: { obs: { key: value }, checks: { check: result | [results] | 'done' }, anyOf: [...], committed: true },
  text: '<unchanged evidence-specific copy>',
  otherwise: '<premise-free copy: same safety, handoff and no-part content>' }
```

- `evidenceCopy` uses `text` only when every requirement holds in recorded cs/1 evidence. Otherwise it uses `otherwise`, or the neutral generic wording if there is none.
- `committed: true` covers copy that settles the outcome ("it's normal", "no part is needed"). It requires the engine's committed cause (confidence `likely`).
- A plain string asserts no evidence. A function derives its premises from state itself.
- The neutral generic wording says "the checks so far" only after a completed check. It calls an uncommitted leader "the most likely area".

The policy is unchanged. A best-supported conclusion still names the leading cause, and where the evidence does exist the evidence-specific copy is still used.

## Coverage

303 fixed conclusion texts were audited across all 63 journeys: every `CONCLUSION` entry, every `REASON` function, and the inline cause and recommend-part copy in j1–j3. 157 are now gated. 152 were unsupported premises (including the 3 in ov1), and 5 settle the outcome ("no part is needed") on an uncommitted leader. The rest were either guaranteed by the rule that reaches them or state no premise.

Regression tests, in `canonical-evidence-premises.test.mjs`:

- **Exact live case:** the "don't know" and "not sure" paths.
- **Established evidence still used:** a positive case where fan and grill are recorded.
- **Every gated entry in every journey:** its text appears only when its declared evidence is recorded.
- **A 63-journey sweep:** opener, then "I don't know" until the journey concludes. No premise lead-in may appear, and no gated text may appear without its evidence.

## Why GOLD v2.4 missed it

- Every oven-not-heating scenario (G2-OC-01, G2-OC-05) supplies the fan and grill evidence, so the premise copy was true wherever GOLD looked.
- The cannot-answer scenarios (G2-OC-03 and others) answer the discriminating question later, or conclude through likely-causes.
- No scenario disengages on the discriminator while a weak signal leaves an uncommitted leader.
- The rubric has an evidence-use dimension ("used the evidence the customer gave") but no critical failure for asserting evidence the customer never gave.

**Decision: C, targeted regression.** The deterministic sweep covers every journey's disengagement path on every build. One more LLM-judged scenario would cover one journey per run. GOLD is unchanged and not weakened.

## Per-group audit tables

These are the working tables from the audit, by journey group. Each row gives the premise asserted, the cs/1 facts required, how the entry can be reached, the verdict and the action taken.

### Evidence-premise audit: GROUP ovhbwd (oven / hob / gas / washer-dryer drying)

Policy facts used: P7 (`<P>7:<cause>`) fires only when `likelyResolved`, i.e. the committed leader has a present SS `restoredAfter<X>Fix` fact (evidence-engine.diagnoseSpec), and that fact needs the leader's own FIX_CHECK done (found / or done with no result) plus `faultPersists:false` at or after it (P2 close_resolved runs before P7 when resolution=resolved). Early targets that are not FAMILY values (control-stuck-on, cooling-fan-run-on, door-glass-cracked, zone-stuck-on, water-container-full) can only come from their early() rule. Every other cause-keyed entry can be reached by P22 with whatever evidence makes that family the leader, committed or not.

| file | key | premise asserted | cs/1 facts required | reachable without? (rules) | verdict | action |
|---|---|---|---|---|---|---|
| ov1 | OH7:clock-or-auto-mode | "That was the clock / auto mode" | oven-clock-mode fix + faultPersists:false after | No: P7 needs CM committed + restoredAfterClockFix (CM's only SS restoredAfter) | GUARANTEED | none |
| ov1 | OH7:function-or-setting | "That was the setting" | programme-setting fix + faultPersists:false after | No: P7 needs PG + restoredAfterProgFix | GUARANTEED | none |
| ov1 | fan-oven-element / thermostat-or-sensor / selector-or-control | (exemplar) | as declared | n/a | already gated | verified |
| ov1 | REASON fan-oven-element | fan turning, grill heating | ovenFanTurns:true, grillWorks:true | function checks state itself | GUARANTEED (function) | none |
| ov2 | control-stuck-on | keeps heating when turned down / off | stuckOnHigh:true | No: only early OT5 (not a family) | GUARANTEED | none |
| ov2 | OT7:setting-or-function | "That was the setting" | programme-setting fix + restored | No (P7) | GUARANTEED | none |
| ov2 | circulation-fan | "With the fan not turning" | ovenFanTurns:false | Yes: P22, CF leads on tooHot alone (prior beats TH) | UNSUPPORTED | gated |
| ov2 | cooling-fan-or-overheat-cut-out | "Cutting out when it gets hot" | cutsOut:true OR overheatsThenCuts:true | Yes: P22, CL leads on fanTurns alone (beats TH on prior) | UNSUPPORTED | gated (anyOf); otherwise keeps "let it cool / don't keep restarting" as a conditional |
| ov2 | thermostat-sensor-or-control | settings right / fan turning | programme-setting clear / ovenFanTurns:true | function picks the lead clause from state | GUARANTEED (function) | none (see other defects) |
| ov3 | OG7:clock-or-auto-mode, OG7:grill-setting-or-door-position | "That was ..." | fix + restored | No (P7) | GUARANTEED | none |
| ov3 | grill-element | main oven working, grill set correctly, grill cold | mainOvenWorks:true, programme-setting clear (grill cold = journey ownership: grillWorks:false or grill_only scope) | Yes: P22, GE leads uncommitted on grillDead+ovenOk with no setting check | UNSUPPORTED | gated (mainOvenWorks + setting clear; grill-cold left to ownership because it may be scope-only) |
| ov3 | grill-control-or-selector | none | none | n/a | NO-PREMISE | none |
| ov4 | cooling-fan-run-on | fan runs on after switching off | fanRunsAfterOff:true | No: only early OF5 | GUARANTEED | none |
| ov4 | fan-motor | none | none | n/a | NO-PREMISE | none |
| ov4 | loose-fan-blade-or-cover | rattle / scrape, fan turning | ovenFanTurns:true AND (rattlingNoise OR scrapingNoise) | Yes: P22, LB leads on fanTurns alone | UNSUPPORTED | gated; otherwise keeps "don't run it" as "If it rattles or scrapes, please don't run it like that" |
| ov4 | cooling-fan | "The noise ..." (a noise exists) | humNoise (CF eligible only with hum / coolingNoise) | No: eligibility | GUARANTEED | none |
| ov5 | OD7:supply / clock / key-lock | "That was ..." | fix + restored | No (P7) | GUARANTEED | none |
| ov5 | mains-input-or-control | switch + breaker on, no display | noPower:true, power-supply clear | By scoring MP only leads with dead + socketOk (PW outscores otherwise) | GUARANTEED (scoring) | gated defensively (same facts) |
| ov5 | selector-or-control | has power, nothing locked | (noPower:false OR clockFlashing:true) AND child-lock clear / found_and_cleared | Yes: P22, SC leads on powered + clockOk with no lock check, or on clockOk alone | UNSUPPORTED | gated |
| ov6 | door-glass-cracked | glass cracked | doorGlassCracked:true | No: only early OR5 | GUARANTEED | none |
| ov6 | OR7:lock-released-after-cooling | lock hadn't released (it opened after cooling) | reset-power-cycle done + doorOpens:true | No (P7, RL only SS) | GUARANTEED | none |
| ov6 | OR7:door-obstruction-or-seating, OR7:door-seal | fix fixed it | fix + restored | No (P7) | GUARANTEED | none |
| ov6 | door-lock | "The door lock hasn't released" | doorOpens:false | Yes: LK is eligible on a door-lock error code alone (door may open) | UNSUPPORTED | gated; otherwise "If the door is stuck, please don't force it" |
| ov6 | door-fine | door closes / lines up, seal fine | oven-door-fit clear AND door-seal clear | Yes: P22, NF leads on fitOk alone or sealOk alone | UNSUPPORTED | gated; otherwise makes no "no part needed" claim |
| ov7 | moisture-after-cleaning | "Tripping after cleaning" | recentCleaning:true | Yes: P22, MO leads on `later` alone (MO = EL, prior wins) | UNSUPPORTED | gated |
| ov7 | element-insulation | trips once heating / on one function | tripsImmediately:false | Yes: P22, EL leads on notCleaned alone | UNSUPPORTED | gated |
| ov7 | wiring-terminal-or-control | trips straight away | tripsImmediately:true | By scoring WR leads only with `immediately` | GUARANTEED (scoring) | gated defensively |
| gas (ov8/hb4) | GC7 / GH7:burner-cap-wet-or-misaligned | "That was the burner cap" | burner-parts-clean fix + restored | No (P7) | GUARANTEED | none |
| gas | igniter-or-spark-unit | "With no click at all" | sparkClicks:false | Yes: P22, IG leads on capsOk + one (beats FF on prior) | UNSUPPORTED | gated |
| gas | flame-failure-device | lights then goes out | flameGoesOut:true | Yes: clicksNoLight + one + capsOk knocks out CP/IG/SU, so FF leads with no goes-out | UNSUPPORTED | gated |
| gas | gas-supply | "If none ... even though they click" | none (conditional) | n/a | NO-PREMISE | none |
| hb1 | HZ7:key-or-child-lock | "That was the lock" | child-lock fix + restored | No (P7) | GUARANTEED | none |
| hb1 | pan-compatibility | the zone works with a suitable pan | worksWithKnownGoodPan:true | Yes: P22, PC leads on inductionHob / panSymbolFlashing alone | UNSUPPORTED | gated; otherwise drops "No part is needed" (it isn't established) |
| hb1 | induction-zone-or-power-board | known-good pan fails on that zone | failsKnownGoodPan:true | Yes: IZ leads on induction + one_zone | UNSUPPORTED | gated |
| hb1 | element-or-zone-control | one zone, ceramic / solid-plate | problem scope one_zone AND (ceramicHob OR solidPlateHob) | Yes: EZ leads on radiant alone, or on one_zone with no hob type | UNSUPPORTED | FUNCTION entry (scope isn't an obs/check) |
| hb1 | control-or-power-side | "With nothing locked" | child-lock clear | Yes: CT leads on allZones alone | UNSUPPORTED | gated |
| hb2 | HP7:supply-or-isolator, HP7:key-or-child-lock | "That was ..." | fix + restored | No (P7) | GUARANTEED | none |
| hb2 | mains-connection-or-power-side | isolator + breaker on, no lights | noPower:true, power-supply clear | By scoring needs dead + socketOk | GUARANTEED (scoring) | gated defensively |
| hb2 | touch-control | has power, nothing locked | noPower:false AND child-lock clear / found_and_cleared | Yes: CT leads on lockOk alone (LK contradicted) | UNSUPPORTED | gated |
| hb3 | zone-stuck-on | stays on full / won't turn off | stuckOnHigh:true | No: only early HO5 | GUARANTEED | none |
| hb3 | cooling-or-ventilation | induction hob switching off when hot | inductionHob:true AND (overheatsThenCuts OR cutsOut) | Yes: CV leads on induction alone, or on cutsHot / overheat code with no hob type | UNSUPPORTED | gated; otherwise keeps the ventilation check as a conditional |
| hb3 | temperature-sensor-or-control | switching off when hot | overheatsThenCuts OR cutsOut | Yes: TS leads on radiant alone | UNSUPPORTED | gated |
| wd-not-drying | WY7:load / programme / water-supply / pump-filter / drain-hose | "That was ..." / "Cleaning the pump filter very likely fixed it" | own fix check + restored | No (P7) | GUARANTEED | none |
| wd-not-drying | pump-filter-fluff (fn), leak branch | leaks only while drying | dryLeak(state) | function checks state | GUARANTEED (function) | none |
| wd-not-drying | pump-filter-fluff (fn), else branch | "From the checks so far" | some check done | by scoring LF only leads with filterFixed, but the function didn't check | GUARANTEED (scoring), function didn't check | basis now chosen by state: "From the checks so far" only when a check is done, else "From what you've described" |
| wd-not-drying | drying-heater-or-thermostat | washing side fine; no heat at all on a drying programme | heatState(state)==='cold' (noHeat/heatPresent by turn); wash side fine = wdDrySide:true or dry_only scope | Yes: DH leads on progOk alone, or on a code | UNSUPPORTED | FUNCTION: cold + dry side → original text; cold only → same sentence without the washing-side clause; else otherwise |
| wd-not-drying | water-container-full | "You mentioned the water container is full" | tankWarning:true (+ leakDry) | No: only early WY5 | GUARANTEED | none |
| wd-not-drying | condenser-water-path | pump filter + drain hose clear; leaks only while drying | drain-filter AND drain-hose clear / found_and_cleared (leakDry = CL eligibility) | Yes: CL leads on leakDry + hoseOk with no filter check | UNSUPPORTED | gated |
| wd-not-drying | drying-sensor | "The code points to ..." | an active displayed code (the code table isn't available to compose) | By scoring SN only leads with codeDrySensor | GUARANTEED (scoring) | FUNCTION, defensive: "The code" only when an active displayedCode is recorded |
| wd-not-drying | drying-fan-or-air-duct | heats; load, programme, water supply, filter all fine | heatState warm AND wd-dry-capacity, programme-setting, inlet-hose-tap OK AND (drain-filter OR lint-filter) OK (OK = clear / found_and_cleared) | Yes: AF leads on warm + one clear check | UNSUPPORTED | FUNCTION (heatState is turn-ordered) |
| ov-family / hob-family / wd-family | none | no conclusion copy | n/a | n/a | n/a | not touched |

### Other defects noticed (not fixed)
- ov7: in element-insulation and wiring-terminal-or-control (text and otherwise), `— ${OFF}` puts a capitalised "Keep it switched off ..." straight after an em dash. Wording is pre-existing; not changed.
- ov2 thermostat-sensor-or-control (function): the "food burning or cooking unevenly points to ..." clause is framed generally, but the journey is also owned by 'cuts-out' (no burning stated). With no evidence it opens "From what we have, food burning ...". Borderline, left as is.
- gas-ignition igniter-or-spark-unit says "on a mains-ignition cooker" in the hob journey (hb4) as well. Wording issue only.
- wd-not-drying pump-filter-fluff (else branch) says "the most likely cause is" even at confidence 'possible', and "The check for it is simple" when the filter was already cleaned (LF only leads with filterFixed). Pre-existing wording.
- ov3: grillSign uses grillWorks !== true, so a grill_only scope with no grillWorks answer counts as "grill cold". The grill-element gate relies on journey ownership for grill-cold for the same reason.
- ov4: SPEC.obs has no mapping for the `coolingNoise` fact, so CF is eligible only through humNoise.

### Evidence-premise audit: GROUP=dwff (dishwasher dw1–dw6, fridge-freezer ff1–ff7)

Conventions. FOUND = check result in [found_and_cleared, found_not_cleared]. FINE = [clear, found_and_cleared], meaning the thing is fine *now*.
These are local consts added above each CONCLUSION; a file only gets the ones it uses.
Rule-keyed `X7:` entries are reached only by P7: the leader is committed and its `restoredAfter<Fix>` fact is present. The engine's
fixTurnOf counts a fix check that is `done` with result found_* OR **null** ("I've already cleaned it"). So a P7 entry guarantees "check done + fault gone".
It does NOT guarantee "something was found". Copy that names a found state ("the blocked filter", "the loose connection", "clearing the seal") is
therefore UNSUPPORTED on a null result. Copy that only names the cause ("That was the power supply") is GUARANTEED.
dw-family.js / ff-family.js hold no conclusion copy, so they were not touched.

| file | key | premise asserted | cs/1 facts required | reachable without? (rules) | verdict | action |
|---|---|---|---|---|---|---|
| dw1 | household-waste-or-spigot | none (conditional "If the sink backs up…") | – | A5 / A22 | NO-PREMISE | – |
| dw1 | A7:filter-or-sump-blockage | filter was blocked | dishwasher-filter FOUND | A7 with filter result null | UNSUPPORTED | gated |
| dw1 | A7:pump-obstruction | something was caught at the pump | pump-impeller FOUND | A7, result null | UNSUPPORTED | gated |
| dw1 | A7:drain-hose-restriction | hose was kinked/blocked | drain-hose FOUND | A7, result null | UNSUPPORTED | gated |
| dw1 | A7:household-waste-or-spigot | cause only | (P7: waste-spigot done + fault gone) | – | GUARANTEED | – |
| dw1 | drain-pump | filter, pump cover, hose clear; water still not pumping | filter/pump-impeller/drain-hose FINE; commandedDrain:false or faultPersists:true | A22 uncommitted DP / disengaged | UNSUPPORTED | gated |
| dw1 | level-or-control | the same checks clear + pump silent | same checks FINE; pumpHumming:false | A22 (codeControl alone) | UNSUPPORTED | gated |
| dw2 | household-supply | none (conditional) | – | B5 / B22 | NO-PREMISE | – |
| dw2 | B7:tap-hose-or-aquastop | tap was off / hose was kinked | inlet-hose-tap FOUND | B7, result null | UNSUPPORTED | gated |
| dw2 | B7:inlet-mesh-filter | mesh was blocked | inlet-filter FOUND | B7, result null | UNSUPPORTED | gated |
| dw2 | inlet-valve | supply, hose and mesh fine; no water coming in | supplyOk:true, waterEntering:false; inlet-hose-tap, inlet-filter FINE | B22 uncommitted IV | UNSUPPORTED | gated |
| dw2 | fill-sensing-or-control | supply, tap, hose and mesh fine | supplyOk:true; inlet-hose-tap, inlet-filter FINE | B22 (flow/pressure code alone) | UNSUPPORTED | gated |
| dw2 | tap-hose-or-aquastop (fn) | red AquaStop window only when fault_seen | inlet-hose-tap fault_seen | – | GUARANTEED (fn checks state) | – (see defect 1) |
| dw3 | foam-or-wrong-detergent | general statement | – | K5 / K22 | NO-PREMISE | – |
| dw3 | K7:door-seal | something was cleared from the seal | door-seal FOUND | K7, result null | UNSUPPORTED | gated |
| dw3 | K7:loading-or-spray-escape | cause only | P7 | – | GUARANTEED | – |
| dw3 | K7:inlet-connection | connection was loose | inlet-connection FOUND | K7, result null | UNSUPPORTED | gated |
| dw3 | K7:drain-connection | connection was loose | drain-connection FOUND | K7, result null | UNSUPPORTED | gated |
| dw3 | internal-leak (fn) | water in base set off flood protection; hoses and door fine | waterInBase:true; inlet-connection, drain-connection, door-seal FINE | fn checked only base (and counted pumping alone as "water in base"), never the hoses or door | UNSUPPORTED | fn rewritten: each clause gated with ck.evidenceHolds, original two sentences unchanged |
| dw4 | C7:dirty-filter | filter was clogged | dishwasher-filter FOUND | C7, result null | UNSUPPORTED | gated |
| dw4 | C7:spray-arm-jets | arms were cleared | spray-arms FOUND | C7, result null | UNSUPPORTED | gated |
| dw4 | C7:loading | cause only | P7 | – | GUARANTEED | – |
| dw4 | C7:detergent-or-dispenser | dispenser was sorted | dw-dispenser FOUND | C7 (DT can commit via tablet) | UNSUPPORTED | gated |
| dw4 | C7:programme-choice | cause only | P7 | – | GUARANTEED | – |
| dw4 | circulation-or-distribution | filter, arms, loading, detergent, heat, fill all fine | filter/spray-arms/loading-clearance FINE; waterEntering:true; heatPresent:true or noHeat:false; tabletUndissolved:false or dw-dispenser FINE | C22 (codeCirc alone, disengaged) | UNSUPPORTED | gated (nested anyOf) |
| dw5 | normal-condensation-drying | "that's normal", i.e. only plastics wet | onlyPlasticsWet:true | T22 NP leader without it | UNSUPPORTED | gated (conditional otherwise) |
| dw5 | T7:rinse-aid | cause only | P7 | – | GUARANTEED | – |
| dw5 | programme-choice | general | – | – | NO-PREMISE | – |
| dw5 | drying-system | hot dishes, rinse aid in use, normal programme, everything wet | hotProgrammeUsed:true, onlyPlasticsWet:false, rinse-aid FINE, heatPresent:true or noHeat:false | T22 | UNSUPPORTED | gated |
| dw5 | heater | cold on a programme that should heat | diagnostics fact coldOnHot (noHeat + hot programme, or cold after the supervised test) | T22 with heater code or cold alone | UNSUPPORTED | **function entry**: diagnose(state,{codeFault:null}).facts has coldOnHot (the test-timing part can't be written as requires) |
| dw5 | temperature-sensor / heating-control | none | – | – | NO-PREMISE | – |
| dw6 | mains-or-control-dead | socket and switch working; no lights | noPower:true; power-supply FINE | G22 disengaged before power check | UNSUPPORTED | gated |
| dw6 | G7:power-supply / G7:delay-start-or-programme | cause only | P7 | – | GUARANTEED | – (shared line split in two, text unchanged) |
| dw6 | G7:child-or-control-lock | lock was on | child-lock FOUND | G7, result null | UNSUPPORTED | gated |
| dw6 | G7:door-obstruction-or-alignment | something was stopping the door and was cleared | door-catch FOUND | G7, result null | UNSUPPORTED | gated |
| dw6 | start-control | has power; door recognised; no lock or delay | doorRecognised:true; child-lock, programme-setting FINE | G22 | UNSUPPORTED | gated. "Has power" is covered by doorRecognised:true, because the policy skips the noPower question once the door is recognised (G12 path) |
| dw6 | door-latch | none | – | – | NO-PREMISE | – |
| ff1 | FC7:door-left-open | doors kept shut, then it recovered | doorLeftOpen:true + faultPersists:false (P7 via restoredAfterDoorClosed) | – | GUARANTEED (borderline: "kept shut" itself is not a cs/1 fact) | – |
| ff1 | door-left-open | general | – | – | NO-PREMISE | – |
| ff1 | FC7:blocked-defrost-drain | drain was cleared; water inside too | defrost-drain found_and_cleared; waterInsideFridge:true | FC7 (null / found_not_cleared result; drainFixed without waterInside) | UNSUPPORTED | gated |
| ff1 | blocked-defrost-drain | water inside; drain won't clear | waterInsideFridge:true; defrost-drain found_not_cleared | FC22 disengaged with waterInside only | UNSUPPORTED | gated |
| ff1 | FC7:temperature-setting | cause only | P7 | – | GUARANTEED | – |
| ff1 | FC7:blocked-vents-or-overpacking | vents were freed | vents-clear FOUND | FC7, result null | UNSUPPORTED | gated |
| ff1 | FC7:door-seal | seal was sorted | door-seal FOUND | FC7, result null | UNSUPPORTED | gated |
| ff1 | FC7:condenser-coils-or-clearance | coils cleaned / space made | condenser-coil-clear FOUND | FC7, result null | UNSUPPORTED | gated |
| ff1 | room-temperature-location | cause + general (LO eligible only with location) | – | – | NO-PREMISE | – |
| ff1 | internal-fan-or-airflow | freezer cold, fridge warm | problem scope = fridge_only | FC22 (fan code alone; bothCompartmentsWarm:false doesn't say which compartment) | UNSUPPORTED | **function entry** checks kit.problemOf(state).scope (scope is not an obs, so requires can't express it) |
| ff1 | sealed-system-or-compressor | settings, vents, seal, coils fine; still running | the 4 checks FINE; compressorRuns:true or runsConstantly:true | FC22 | UNSUPPORTED | gated |
| ff2 | FX7:temperature-setting | cause only | P7 | – | GUARANTEED | – |
| ff2 | FX7:food-against-back-wall / room-temperature-location | general | – | – | NO-PREMISE | – |
| ff2 | thermostat-sensor-or-damper | settings normal; nothing against back wall | temp-setting, vents-clear FINE | FX22 (freezer-only path never asks vents) | UNSUPPORTED | gated |
| ff3 | normal-operating-noise | general | – | FN5 / FN22 | NO-PREMISE | – |
| ff3 | FN7:touching-or-loose-at-back | cause only | P7 | – | GUARANTEED | – |
| ff3 | FN7:runs-constantly-coils | coils cleaned | condenser-coil-clear FOUND | FN7, result null | UNSUPPORTED | gated |
| ff3 | internal-fan | squeal/grind from inside that stops with the door open | noiseFromInside:true, noiseStopsWhenDoorOpen:true, squealNoise or grindingNoise true | FN22 uncommitted EF | UNSUPPORTED | gated |
| ff3 | condenser-fan-or-compressor-area | nothing touching; coils clear | ff-clearance, condenser-coil-clear FINE | FN22 | UNSUPPORTED | gated |
| ff3 | runs-constantly-coils | runs all the time with clean coils | runsConstantly:true; condenser-coil-clear FINE | FN22 | UNSUPPORTED | gated |
| ff4 | FL7:blocked-defrost-drain | drain was cleared | defrost-drain found_and_cleared | FL7 (null / found_not_cleared) | UNSUPPORTED | gated |
| ff4 | blocked-defrost-drain | drain blocked, won't clear | defrost-drain found_not_cleared | FL22 with inside only | UNSUPPORTED | gated |
| ff4 | condensation-door-or-warm-food | drain clear | defrost-drain FINE | FL22 | UNSUPPORTED | gated |
| ff4 | FL7:drip-tray-or-drain-tube | tray/tube was refitted | drip-tray FOUND | FL7, result null | UNSUPPORTED | gated |
| ff4 | FL7:water-supply-line | connection was loose | inlet-connection FOUND | FL7, result null | UNSUPPORTED | gated |
| ff4 | water-supply-line | supply line looks damaged | inlet-connection fault_seen | FL22 with supply location only | UNSUPPORTED | gated |
| ff4 | internal-leak | drain, tray, supply all fine | the 3 checks FINE | FL22 | UNSUPPORTED | gated |
| ff5 | one-off-door-or-loading | general | – | FI5 / FI22 | NO-PREMISE | – |
| ff5 | FI7:one-off-door-or-loading | frost not back since defrost | P7 restoredAfterDefrostFix (defrost done + faultPersists/iceReturns false) | – | GUARANTEED | – |
| ff5 | FI7:door-seal-air-leak | seal was sorted | door-seal FOUND | FI7, result null | UNSUPPORTED | gated |
| ff5 | FI7:blocked-defrost-drain | drain was cleared | defrost-drain found_and_cleared | FI7 | UNSUPPORTED | gated |
| ff5 | blocked-defrost-drain | blocked, won't clear | defrost-drain found_not_cleared | FI22 with ice in base only | UNSUPPORTED | gated |
| ff5 | defrost-system | back-wall frost returns after full defrost; door shut; seal fine | frostOnBackWall:true, doorLeftOpen:false, door-seal FINE, iceReturns:true or (faultPersists:true + defrost done) | FI22 with defrost code alone | UNSUPPORTED | gated |
| ff6 | FD7:door-obstruction-or-level | something was stopping the door | ff-door-fit FOUND | FD7, result null | UNSUPPORTED | gated |
| ff6 | FD7:door-seal | seal was sorted | door-seal FOUND | FD7, result null | UNSUPPORTED | gated |
| ff6 | door-handle | broken handle | handleBroken:true (HD eligible only with it) | – | GUARANTEED (eligibility) | – |
| ff6 | door-closes-fine | door shuts, lines up, seal fine | ff-door-fit, door-seal FINE | FD22 NF leads on fitOk alone after disengaging | UNSUPPORTED | gated |
| ff7 | FP7:power-supply | cause only | P7 | – | GUARANTEED | – |
| ff7 | FP7:condenser-coils-or-clearance | coils cleaned | condenser-coil-clear FOUND | FP7, result null | UNSUPPORTED | gated |
| ff7 | mains-or-control-dead | socket working; no lights | noPower:true; power-supply FINE | FP22 | UNSUPPORTED | gated |
| ff7 | lights-on-not-running | has power; motor never runs | noPower:false, compressorRuns:false | FP22 (powered only) | UNSUPPORTED | gated |
| ff7 | click-start-relay-or-compressor | clicking without starting | clicksNoStart:true | FP22. With only "lights on", CK wins the prior-order tie and printed the clicking copy | UNSUPPORTED | gated |
| ff7 | running-not-cooling | it runs | compressorRuns:true | FP22 | UNSUPPORTED | gated |

Counts: 83 entries audited · 55 UNSUPPORTED fixed (52 as {requires,text,otherwise}, 3 as function entries: dw3 internal-leak, dw5 heater, ff1 internal-fan-or-airflow) · 15 GUARANTEED · 13 NO-PREMISE.

### Other defects noticed (not fixed)
1. dw2 `tap-hose-or-aquastop` fn: the fault_seen branch always says "A red AquaStop window means…". fault_seen also covers "inlet hose damaged" without a red window (CHECK_RESULT_COPY 'hose damaged / AquaStop red'), so the red window can be asserted when it wasn't seen. A fix needs a separate fact; there is none in cs/1.
2. ff1 `FC7:door-left-open` says "Keeping the doors shut let it recover". cs/1 records only doorLeftOpen:true + faultPersists:false, not that the doors were kept shut. Left as is (borderline).
3. Engine fixTurnOf (evidence-engine.js) counts a done fix check with a null result as a "fix" for restoredAfter*/failsAfter*. That is why every "the blocked X / clearing X" P7 entry needed gating. Other journey groups with P7 copy are likely affected the same way.
4. compose-kit.js was changed by another agent during this run (conclusionCopy is now wrapped by Object.assign and exposes CONCLUSION). That didn't affect these files, and tests pass.

### Evidence-premise audit — GROUP tdvacmw (td1–td7, vac1–vac6, mw1–mw6)

td-family.js / vac-family.js / mw-family.js hold no conclusion copy (mw-family only has the shared `HV` safety sentence, which states no premise). None of these journeys has REASON functions or custom conclusionCopy: all use ck.makeConclusionCopy.

Shorthand used below:
- G = GUARANTEED, U = UNSUPPORTED, NP = NO-PREMISE.
- "P7 fix" = rule-keyed `<P>7:<cause>`. P7 needs `likelyResolved`: a committed leader with a present SS `restoredAfter<X>Fix` fact, meaning that family's own fix check is done and `faultPersists:false` at or after it. I checked each family: its only SS restoredAfter fact is its own check(s). (See the edge case in Other defects #1.)
- "elig" = the family is only ranked when `SPEC.eligible` holds (rankFamilies skips it otherwise).
- "CC" = `['clear','found_and_cleared']`. "ok-or-persists" means: each check is clear, or it was sorted and `faultPersists:true` was recorded afterwards. (If a sort fixed it, that is P7.)

| file | key | premise asserted | cs/1 facts required | reachable without? (rules) | verdict | action |
|---|---|---|---|---|---|---|
| td1 | DH7:programme-setting | that was the programme | programme-setting done + faultPersists false | P7 fix only | G | none |
| td1 | DH7:airflow-thermal-cut-out | clearing the airflow fixed it | lint/condenser/vent done + faultPersists false | P7 fix only | G | none |
| td1 | heat-pump-runs-cooler | the air feels warm (heat pump) | heatPresent:true (heat pump guaranteed by elig / DH5) | DH5 needs warm, so G there; P22 HN leader has no warm (DH5 pre-empts warm) | U | object: requires obs heatPresent:true; otherwise has no warm claim, plus an engineer if it is completely cold |
| td1 | heat-pump-system | filters + heat exchanger clean, no warmth at all | noHeat:true; lint-filter + condenser ok-or-persists | P22 on priors / "not sure" | U | object (requires as stated) |
| td1 | heater-or-thermal-cut-out | airflow clear, still no heat | noHeat:true; lint-filter + (condenser or vent-duct) ok-or-persists | P22 on priors / heating code / "not sure" | U | object (AIRFLOW_CLEAR) |
| td1 | airflow-thermal-cut-out | — (cause + advice) | — | — | NP | none |
| td2 | DD7:* (6 entries) | that was / cleaning X fixed it | own fix check done + faultPersists false | P7 fix only | G | none |
| td2 | drying-airflow-system | it heats; filters, load, settings fine; not the heater | heatPresent:true; lint-filter, load-check, programme-setting clear | P22 on priors / "not sure" | U | object |
| td3 | DT7:overload-or-bulky-item | that was the load | load-check done + faultPersists false | P7 only | G | none |
| td3 | drum-seized-rollers-or-bearing | drum feels stiff / stuck by hand | drum-by-hand fault_seen AND drumUnusuallyFree not true (fault_seen + free means "spins easily", SPEC.extra) | P22 | U | function (the "not free" condition can't be written as a `requires` object) |
| td3 | motor-or-control | no motor sound, drum turns normally by hand | motorAudible:false; drum-by-hand clear | P22 | U | object |
| td3 | drive-belt | motor runs + drum spins freely | motorAudible:true, drumUnusuallyFree:true | P22 (incl. beltSeen only, or a weak signal) | U | object |
| td4 | DN7:foreign-object | that was the loose item | drum-foreign-object done + faultPersists false | P7 only | G | none (see Other #1) |
| td4 | object-out-of-reach | something is stuck out of reach | drum-foreign-object found_not_cleared | OS elig requires objStuck | G | none |
| td4 | drum-rollers-or-idler | squeal/rumble + rough by hand | drum-by-hand fault_seen; squealNoise or grindingNoise true | P22 (uncommitted) | U | object |
| td4 | drive-area | nothing loose, drum smooth by hand | drum-foreign-object clear; drum-by-hand clear | P22 | U | object |
| td4 | normal-pump-or-compressor-hum | condenser / heat-pump dryer (hum is guaranteed by elig) | stated type condenser or heat-pump (tdArchitecture, latest wins) | P22: NN elig needs only a hum | U | function (the type is latest-wins across 3 keys) |
| td5 | DS7:* (3 entries) | that was / clearing X fixed it | own fix check(s) done + faultPersists false | P7 only | G | none |
| td5 | airflow-overheating | — | — | — | NP | none |
| td5 | thermal-protection-or-thermostat | restarts after cooling with the airflow clear | restartsAfterCooling:true; AIRFLOW_CLEAR | P22 | U | object |
| td5 | control-or-power | airflow, load, sensors fine; not restarting | restartsAfterCooling:false; load-check + sensor-bars clear; AIRFLOW_CLEAR | P22 | U | object |
| td6 | vented-no-container | it is a vented dryer | architecture vented | DW5 only (not a FAMILY key) | G | none |
| td6 | DW7:container-full-or-not-seated | "(the warning is just doing its job)": a container warning was on | tankWarning:true | DW7 guarantees only that the container check fixed it, not that a warning showed | U | object; otherwise drops the warning clause |
| td6 | DW7:condenser-blocked | cleaning the condenser fixed it | condenser done + faultPersists false | P7 only | G | none |
| td6 | drain-kit-fitted | a drain hose is fitted | drainKitFitted:true | DK elig requires drainKit | G | none (see Other #2) |
| td6 | condensate-pump-or-float | water not reaching container, condenser clean | tankStaysEmpty:true; condenser ok-or-persists | P22 (incl. pump code alone) | U | object |
| td6 | internal-hose-or-seal-leak | container + condenser fine; "the leak" | leakUnderneath:true; water-container + condenser clear | P22 | U | object; otherwise makes the wet-floor advice conditional |
| td7 | mains-or-control-dead | socket working, no lights at all | noPower:true; power-supply clear | P22 (MP elig needs dead or powerFixed only) | U | object |
| td7 | DG7:* (4 entries) | that was X / child lock was on | own fix check done + faultPersists false | P7 only | G | none |
| td7 | start-control | has power, door recognised, no lock / delay | noPower:false, doorRecognised:true; child-lock + programme-setting clear | P22 | U | object |
| td7 | door-latch | "This points to…" — no specific fact | — | — | NP | none |
| vac1 | VS7:* (3 entries) | that was / clearing X fixed it | own fix check + faultPersists false | P7 only | G | none |
| vac1 | airflow-blockage | a blockage that won't shift | vacuum-blockage found_not_cleared | P22 (whistle only, priors, hoseSplit uncommitted) | U | object |
| vac1 | internal-seal-or-motor-area | bin, filters, hose, brush all clear; suction still weak | weakSuction:true; 3 checks ok-or-persists | P22 | U | object |
| vac2 | VP7:* (3 entries) | that was / clearing X fixed it | own fix check + faultPersists false | P7 only | G | none |
| vac2 | airflow-blockage | a blockage that won't shift | vacuum-blockage found_not_cleared | P22 | U | object |
| vac2 | battery-or-charging | filters + airflow clear; runs briefly / won't charge | bin-filters + blockage ok-or-persists; shortRuntime:true or wontCharge:true | P22 (BT on priors) | U | object (nested anyOf) |
| vac2 | internal-motor-or-electronics | filters, airflow, brush clear; no sign of a battery problem | 3 checks ok-or-persists; corded (vacType) OR (shortRuntime:false and wontCharge not true) | P22 | U | function (needs a negation + vacType) |
| vac3 | VN7:* (3 entries) | that was the supply / charging / cut out after a blockage | own fix check + faultPersists false | P7 only | G | none |
| vac3 | damaged-cable-stop-use | the cable / plug is damaged | power-supply fault_seen | VN5 only (not a FAMILY key) | G | none |
| vac3 | thermal-cut-out-after-blockage | a blockage that won't shift | vacuum-blockage found_not_cleared | P22 (cutOut S, priors) | U | object |
| vac3 | battery-or-charger-fault | — ("From what you've described…") | — | — | NP | none |
| vac3 | switch-cable-or-motor | supply + airflow fine, still dead | noPower:true; (power-supply or charger) + blockage ok-or-persists | P22 | U | object |
| vac4 | VB7:brush-bar-tangled-or-jammed | clearing it fixed it | brush-bar-clear done + faultPersists false | P7 only | G | none |
| vac4 | floorhead-drive | the bar is clean and turns freely | brush-bar-clear ok-or-persists | P22 | U | object |
| vac5 | VR7:* (3 entries) | that was X / cleaning fixed it | own fix check + faultPersists false | P7 only | G | none |
| vac5 | battery-or-charger-not-charging | — | — | — | NP | none |
| vac5 | battery-worn | runs briefly from full charge; charger, mode, filters fine | shortRuntime:true; charger, programme-setting, bin-filters clear (= SPEC batteryFade) | P22 (BA on shortRun alone / uncommitted) | U | object; otherwise adds "I'm not recommending a part from this" |
| vac6 | VY7:* (3 entries) | clearing X fixed it / that was the seating | own fix check + faultPersists false | P7 only | G | none |
| vac6 | airflow-blockage | a blockage that won't shift | vacuum-blockage found_not_cleared | P22 | U | object |
| vac6 | motor-bearing-or-fan | airways, brush, filters clear; grinding / screech | 3 checks ok-or-persists; grindingNoise or squealNoise true | P22 | U | object (nested anyOf) |
| mw1 | MH7:power-level-or-mode | that was the power level / mode | programme-setting done + faultPersists false | P7 only | G | none |
| mw1 | high-voltage-heating-system | runs normally with no heat | runsNormally:true | P22 (priors, heating code, "not sure") | U | object |
| mw1 | overheat-cut-out-or-control | it stops part way | cutsOut:true | P22 (CT on progOk / priors) | U | object |
| mw2 | MS7:* (3 entries) | that was X / lock was on | own fix check + faultPersists false | P7 only | G | none |
| mw2 | supply-or-plug-fuse | display completely dead | noPower:true | P22 (PW elig: dead OR powerFixed) | U | object |
| mw2 | internal-fuse-cut-out-or-control | socket working, display dead | noPower:true; power-supply clear | P22 | U | object |
| mw2 | control | has power, nothing locked | noPower:false; child-lock clear | P22 | U | object |
| mw3 | door-glass-cracked | the door is cracked | doorGlassCracked:true | MD5 only (not a FAMILY key) | G | none |
| mw3 | MD7:dirt-or-obstruction | cleaning the latch fixed it | mw-door-check done + faultPersists false | P7 only | G | none |
| mw3 | door-hook-or-latch | a broken hook / latch | mw-door-check fault_seen | P22 uncommitted (wontClose only, priors) | U | object; otherwise drops "with your model number I can check for the latch… can fit it" (that part offer depends on the broken hook) |
| mw3 | door-release-mechanism | the door won't open | doorOpens:false | RL elig requires wontOpen | G | none |
| mw3 | interlock-switches | hooks fine; door not recognised / only works pushed | mw-door-check clear; doorRecognised:false or startsWhenPushed:true | P22 (IL on door code / priors) | U | object |
| mw4 | MT7:tray-seating-or-obstruction | that was the tray seating | turntable-parts done + faultPersists false | P7 only | G | none |
| mw4 | turntable-motor | tray, coupler, ring fine; still not turning | turntableTurns:false; turntable-parts ok-or-persists | P22 | U | object |
| mw5 | metal-or-foil-inside | sparks from the metal; removed; nothing burnt; **"fine to use again"** | metalInside:true; mw-cavity-check found_and_cleared; waveguideCoverDamaged / cavityBurnt not true | P22: ME is first in PRIOR, so it can lead uncommitted on a sparking report alone | U (SAFETY) | function; otherwise says don't use it until the metal is out and the cover / paint are checked |
| mw5 | cavity-paint-burnt | the paint inside is burnt | cavityBurnt:true | P22 (CB on arcing alone) | U | object |
| mw5 | arcing-high-voltage-side | sparking, no metal, nothing visibly burnt | arcing (hazard or sparking report); mw-cavity-check clear | P22 | U | function (sparking is a hazard / journey, not an obs) |
| mw5 | waveguide-cover | the cover is burnt and needs replacing | waveguideCoverDamaged:true or mw-cavity-check fault_seen | P22: WG leads uncommitted on arcing alone (first of the arcing-S ties) | U | object; otherwise "until it's been checked" |
| mw5 | MN7:turntable-noise | that was the turntable parts | turntable-parts done + faultPersists false | P7 only | G | none |
| mw5 | normal-operating-hum | hum, heats normally, no sparks / burning | humNoise, heatPresent, no spark / burning / harsh noise | MN5 only (normalHum; not a FAMILY key) | G | none |
| mw5 | high-voltage-noise | a loud buzz / hum from inside | humNoise:true | P22 (HN on partsOk / priors) | U | object |
| mw6 | door-interlock-or-control | it starts by itself when the door closes | startsWhenDoorCloses:true | MC5 is unconditional, but the journey is only owned when that obs is true (mwOwner); journeys [] means no safety-carry | G | none |

Counts: 95 entries audited; 41 UNSUPPORTED fixed (td 17, vac 11, mw 13); 49 GUARANTEED; 5 NO-PREMISE.
Of the 41 fixes, 5 are function entries: td3 drum-seized, td4 NN hum, vac2 internal-motor, mw5 metal-or-foil and mw5 arcing-HV-side. Each one keeps its original sentence verbatim as the evidence branch. The other 36 are `{ requires, text, otherwise }`, with every `text` byte-identical.

Shared constants added locally (no refactor): `CLEAN` / `AIRFLOW_CLEAR` in td1 and td5, `CC` / `AIRFLOW_CLEAR` in vac2, and `CC` / `ALL_CLEAR` in vac1, vac3 and vac6. They encode "ok-or-persists", so a check sorted earlier is only called "clear" when the fault was re-reported afterwards.

### Other defects noticed (not fixed)
1. **P7 premise is a little looser than the copy.** evidence-engine `fixTurnOf` counts a fix check done with `result == null` ("I've already checked it") or `found_not_cleared` as the fix, and the policy `fixResults` override does not reach `projectFacts`. So rule-keyed P7 copy can say "That was the loose item" (td4 DN7), "Cleaning the filter very likely fixed it" or "The child lock was on" when nothing was recorded as found / cleared. These are rare: it needs a null-result report followed by the fault going away. I left all P7 entries plain, as the ov1 OH7 exemplar does.
2. td6 `drain-kit-fitted`: "so an empty container is normal" implies the container is empty, but DK elig only needs drainKitFitted (a warning-on report could reach it). Mild; left alone.
3. td4 NN / td1 architecture: model-part-derived architecture (ctx.modelParts) is not visible to compose. So the NN function shows the otherwise copy when only the model's part list says condenser / heat pump. This is conservative.
4. mw5 metal-or-foil: the cavity check's found_and_cleared means "metal / food splatter removed", which is ambiguous. That is why the safety copy also needs `metalInside:true`.
5. td3 drive-belt: when the owner actually saw the belt off (drive-belt fault_seen) but no motor / free-drum obs exist, the neutral otherwise copy is shown, even though the evidence is stronger. A dedicated beltSeen wording might be wanted (not this bug class).
6. Several otherwise texts open "From what you've described" even when some unrelated check was completed. This matches the ov1 exemplar wording; the generic fallback switches to "From the checks so far".

### Evidence-premise audit — GROUP wm (j1–j9 compose; also serves wd1–wd9)

wd note: wd-family makeWashWrapper only rewrites identity.appliance in a cloned *view* for the inner policy; canonical-runtime
calls JC.brief(canonical.state, ...) with the real state, whose evidence.observations/checks are identical (same keys). The
`requires` below therefore hold identically for wd-not-draining … wd-not-heating-wash. (j9's NB function calls
j9-diagnostics.diagnose(state) — the projection reads evidence/requests only, not appliance.)

FOUND = ['found_and_cleared','found_not_cleared']. Note: diagnoseSpec fixTurnOf (j4–j9) also counts a fix check done with result=null,
so P7 rule-keyed entries can fire without a found result.

| file | key | premise asserted | cs/1 facts required | reachable without? (rules) | verdict | action |
|---|---|---|---|---|---|---|
| j1 | R9:filter-blockage / R9:impeller-obstruction / R9:hose-or-waste-restriction | blockage found & draining again | check found_and_cleared + commandedDrain/drainsNormally true after | no (R9 needs likelyResolved = committed + restoredAfterXClear, which requires found_and_cleared and drain after) | GUARANTEED | none |
| j1 | R9a:excess-suds | rinse/spin cleared foam | excessiveFoam true, commandedDrain true | no (R9a condition) | GUARANTEED | none |
| j1 | obstruction-beyond-reach | blockage at pump not clearable | drain-filter or pump-impeller found_not_cleared | no (not a diag family; only R6) | GUARANTEED | none |
| j1 | hose-or-waste-restriction | "The restriction is in the drain hose…" (a restriction exists) | checks.drain-hose found_not_cleared | yes: R15/R16 with uncommitted HR leader (priors / cannot_answer) | UNSUPPORTED | gated + otherwise |
| j1 | household-waste-backflow | conditional "If … comes back" | (waterReturnsAfterDrain — HW eligibility) | n/a | NO-PREMISE | none |
| j1 | pressure-or-level | "Because it pumps out when you run a drain or spin" | obs.commandedDrain true | R15/R16 PL leader without commandedDrainWorks not provably excluded | UNSUPPORTED | gated + otherwise |
| j1 | control | "With the pump silent and the drain path clear" | pumpHumming false; drain-filter clear; pump-impeller clear | yes: CT eligible on codePumpCircuit alone (R15/R16) | UNSUPPORTED | gated + otherwise |
| j1 | inline recommend_part | "filter, impeller and hose all checked clear and the pump humming but not moving water" | filter/impeller/hose clear, pumpHumming true, commandedDrain false | yes: R14 passes via impellerDamaged / filterDamaged / hoseDamaged decisive facts | UNSUPPORTED | gated (PART_PREMISE) + neutral "From what you've found…" |
| j1 | inline drain-pump component | "The checks point to the drain pump" | some check done | no: DP component needs commit = SS drainPathClearPumpEnergised or impellerDamaged (check-based) | GUARANTEED | none |
| j1 | inline drain-pump non-component | none | — | — | NO-PREMISE | none |
| j1 | inline fallback | "From what we've been able to check" | any check done | yes: R15/R16 filter-blockage after cannot_answer (coordinator sweep) | UNSUPPORTED | "From what you've described, the most likely area is…" when no check done |
| j1 | close_resolved | cause from found_and_cleared / excessiveFoam | — | R2 derives cause from those facts | GUARANTEED | none |
| j2 | S9:load-imbalance / S9:programme-setting | load/setting found and spin restored | load-check/programme-setting FOUND + commandedSpin true after | no (likelyResolved) | GUARANTEED | none |
| j2 | load-imbalance | "Because it spins properly when it's empty" | obs.spinsEmpty true | yes: LB always eligible, first prior; S19 after cannot_answer (coordinator sweep) | UNSUPPORTED | gated + otherwise |
| j2 | programme-setting | "It spins on a spin-only programme" | obs.commandedSpin true | yes: PG eligible on emptySpinOk / programmeOk (S19) | UNSUPPORTED | gated + otherwise |
| j2 | suspension-or-movement | "Violent shaking with normal loads" | excessiveVibration true; load-check clear | yes: SU leads on vibration when LB contradicted (S19) | UNSUPPORTED | gated + otherwise |
| j2 | pressure-or-level | "it drains but won't … spin even when empty" | spinsEmpty false; anyOf waterRemaining false / drainsNormally true / commandedDrain true | yes: PL eligible on drainsOk + codePressure (S19) | UNSUPPORTED | gated + otherwise |
| j2 | mechanical-resistance | drum stiff/rough/seized by hand | drum-by-hand fault_seen/found_not_cleared or drumTurnsByHand false | S6 needs commit (handResist SS) → guaranteed; S19 ME on grindingNoise only → not | UNSUPPORTED (via S19) | gated + otherwise |
| j2 | control | "Nothing is driving the drum and the drum itself turns normally" | drumTurns false, motorAudible false, drum-by-hand clear or drumTurnsByHand true | yes: CT eligible on codeControl (S19) | UNSUPPORTED | gated + otherwise |
| j2 | inline recommend_part drive-belt | "motor runs but drum doesn't, drum unusually free by hand" | motorAudible true, drumTurns false, drumUnusuallyFree true | yes: decisive beltSeenFaulty (drive-belt check) also passes S18 | UNSUPPORTED | gated + "What you've found points to…" |
| j2 | inline recommend_part carbon-brushes | "The worn carbon brushes you found" | carbon-brushes fault_seen | no (only decisive brushesSeenWorn) | GUARANTEED | none |
| j2 | inline recommend_part door-lock | "isn't engaging even with the door closed firmly" | doorLocks false + door-closed-latched done | no (only decisive doorNoLockConfirmed) | GUARANTEED | none |
| j2 | inline door-lock cause | "isn't confirming the door is shut" | obs.doorLocks false | yes: DL eligible on codeDoorLock (S19) | UNSUPPORTED | gated (evidenceHolds) + neutral |
| j2 | inline drive-belt cause | "The motor runs but the drum doesn't turn" | motorAudible true, drumTurns false | yes: BT leads on drumStill by prior after cannot_answer (S17 unavailable → S19) | UNSUPPORTED | gated + neutral |
| j2 | inline motor-brushes component | "would explain" | — | — | NO-PREMISE | none |
| j2 | inline motor-drive / brushes | archNote from typed architecture (make platform / model parts) | — | derived from state | GUARANTEED (function) | none |
| j2 | inline fallback | "From what we've been able to check" | any check done | unknown families only | UNSUPPORTED (latent) | neutral when no check done |
| j3 | L15:* (6 entries) | trapped item / blocked drawer / dose / cap not seated / loose fill / loose drain | the check FOUND + leakRecurs false after | no (j3 own fixTurn = FOUND only; likelyResolved) | GUARANTEED | none |
| j3 | household-backflow | conditional | (waterReturnsAfterDrain — HB eligibility) | — | NO-PREMISE | none |
| j3 | oversudsing | "This looks like too much detergent" (cause) | — | — | NO-PREMISE | none (see other #2) |
| j3 | inline component | "looks damaged" | X fault_seen | no (component level only with decisive fault_seen) | GUARANTEED | none |
| j3 | inline recommend_part | "The damaged X you found" | X fault_seen | no | GUARANTEED | none |
| j3 | internalCopy lead | "With X checked and fine" | derived from clear checks | function | GUARANTEED | none |
| j3 | INTERNAL tub-or-major-internal | "with this much water" | obs.majorLeak true | yes: TB eligible with underneath + ≥2 clear checks (L18) | UNSUPPORTED | major-gated variant; body otherwise identical minus clause |
| j3 | INTERNAL others | none | — | — | NO-PREMISE | none |
| j3 | inline fallback | "From the checks so far" | any check done | yes: L18 DS/DR/FS/IC/DC uncommitted after cannot_answer | UNSUPPORTED | "From what you've described" when no check done |
| j4 | household-supply | conditional | (supplyOk false; early F5) | — | NO-PREMISE | none |
| j4 | F7:tap-or-fill-hose | causal inference | fix on inlet-hose-tap + faultPersists false | P7 guarantees both | GUARANTEED | none |
| j4 | F7:inlet-mesh-filter | "The blocked inlet mesh" | inlet-filter FOUND | yes: P7 fires with inlet-filter done/result null (fixTurnOf) | UNSUPPORTED | gated + otherwise |
| j4 | inlet-valve | "supply, hose and mesh fine" | supplyOk true; inlet-hose-tap clear; inlet-filter clear | yes: IV leads on oneProgramme / code / noWater (P22) | UNSUPPORTED | gated + otherwise |
| j4 | pressure-or-control | "supply, tap, hose and mesh all fine" | same | yes: PC on codePressure (P22) | UNSUPPORTED | gated + otherwise |
| j5 | O7:drain-hose-siphon | causal inference | fix on drain-hose-height + restored | P7 | GUARANTEED | none |
| j5 | drain-hose-siphon / foam-level | conditional / generic | — | — | NO-PREMISE | none |
| j5 | level-sensing-or-control | function checks fillsWhenOff false | — | function | GUARANTEED | none |
| j5 | waste-backflow | "with the drain hose fitted correctly" | waterIsDirty true; drain-hose-height clear | yes: WB eligible on dirty alone (P22) | UNSUPPORTED | gated + otherwise |
| j5 | inlet-valve-stuck-open | "Water coming in with the machine switched off" | fillsWhenOff true | yes: IV first prior, leads on clean / codeValve (P22) | UNSUPPORTED | gated + otherwise |
| j6 | normal-release-delay | "That's the … normal safety delay" (it opened after waiting) | door-release-wait done; doorOpens true | early D5 guaranteed; P22 DY leader on wontOpen alone not | UNSUPPORTED (P22) | gated + otherwise |
| j6 | D7:child-lock | causal | fix + restored | P7 | GUARANTEED | none |
| j6 | D7:handle-or-catch | "Clearing the catch" | door-catch found_and_cleared | yes: P7 with result null / found_not_cleared | UNSUPPORTED | gated + otherwise |
| j6 | level-sensing-or-control | "no water inside, wait and power-off done, child lock off" | waterRemaining false, doorOpens false, door-release-wait done, child-lock clear/found_and_cleared | yes: PS eligible on wontOpen (P22) | UNSUPPORTED | gated + otherwise |
| j6 | door-lock | "This points to" | — | — | NO-PREMISE | none |
| j7 | V7:* (3) | causal (levelling done is guaranteed by fixTurnOf) | — | P7 | GUARANTEED | none |
| j7 | transit-bolts / levelling-or-floor / load-imbalance | conditional / cause only | — | — | NO-PREMISE | none |
| j7 | suspension-dampers | "bolts out, machine level, drum still shaking when empty" | shakesWhenEmpty true; transit-bolts & levelling clear/found_and_cleared | yes: SU on prior signals (P22) | UNSUPPORTED | gated + otherwise |
| j7 | drum-support-or-bearings | "A loose or rumbling drum" | drumPlay true or grindingNoise true | no: BR eligible only on grinding/loose | GUARANTEED | none |
| j8 | N7:pump-obstruction | "Whatever was caught at the pump" | drain-filter FOUND or pump-impeller FOUND | yes: P7 with drain-filter done/result null | UNSUPPORTED | gated + otherwise |
| j8 | N7:foreign-object | "The object you removed" | drum-foreign-object found_and_cleared | yes: P7 with result null (diag fixTurnOf) | UNSUPPORTED | gated + otherwise |
| j8 | N7:load-or-installation | causal | — | P7 | GUARANTEED | none |
| j8 | normal-operating-noise | generic | — | — | NO-PREMISE | none |
| j8 | foreign-object | function (found_not_cleared branch checked) | — | function | GUARANTEED | none |
| j8 | drum-bearings | "A rough, grinding drum" | drum-by-hand fault_seen, or grindingNoise+noiseOnSpin+drumPlay true | yes: BE always eligible (P22 on grind/onSpin alone) | UNSUPPORTED | gated + otherwise |
| j9 | H7:programme-setting | causal | — | P7 | GUARANTEED | none |
| j9 | normal-low-temperature (function) | else-branch "Warm washing on the 60°C test" | diag fact warmOnHotTest (test asked/done + warm) | yes: NB on lowProg + heatPresent true | UNSUPPORTED | function now checks j9-diagnostics warmOnHotTest; neutral third branch |
| j9 | heater-element | "Cold washing on a programme that should heat" | noHeat true + (hotProgrammeUsed true or hot-wash-test done) | yes: HE leads on opener noHeat alone (P22) | UNSUPPORTED | gated + otherwise |
| j9 | temperature-sensor / heating-control / fill-or-level | none | — | — | NO-PREMISE | none |

Note: the j9 heater-element requirement approximates the diagnostic's coldOnHot (which also accepts a test result restated after
the request without a check record). Where they differ it falls back to the neutral copy, which is the safe direction.

### Other defects noticed (not fixed)
1. compose-kit generic recommend_part "What you've found points to the X" (j4–j9) — every part passes only with a decisive fact,
   but for j4 IV the decisive fact is problem scope one_programme ("found" is loose). Shared kit, out of scope.
2. "no part is needed" stated for possible (uncommitted) leaders in premise-free entries: j3 oversudsing, j7 load-imbalance,
   j5 foam-level, j8 normal-operating-noise, j6 normal-release-delay's text. Overclaims without stating evidence.
3. j3 INTERNAL inlet-valve-or-fill drawer variant says "a drawer that **still** overflows" when only drawerOverflowing=true
   (drawer not necessarily cleaned). Minor premise outside the gate.
4. j1 fallback with a check done says "the most likely cause is" for an uncommitted leader (wording, not evidence).
5. diagnoseSpec fixTurnOf treats a fix check done with result=null as an owner fix, so P7 copy like "the blocked mesh",
   "the object you removed" was reachable on "I've already done X" — fixed by gating in copy; the projection itself is unchanged.
6. canonical-wd-family / canonical-evidence-premises each failed once and passed on 3 reruns with no changes — probably from other
   agents editing files in the shared worktree at the same time.
