# Appliance Clinic RAG on the independent-100 benchmark: measurements

Read-only. Code: `/home/user/appliance-clinic` (live tree). Run data: `evaluation/rebuild/out/independent-100-21.16` (ac3, primary judge claude-fable-5-1). GA baseline: `evaluation/independent-100/out` (same judge model, run 2026-10-12). No AWS and no LLM calls. Every number below comes from the scripts in `scratchpad/dd-rag/`.

## Scripts and commands

| file | purpose |
|---|---|
| `dd-rag/gold.json` | Hand-written gold for the 94 in-scope cases. `kb` lists the acceptable knowledge-doc ids, `normal` the normal-operation ids, `terms` is a regex for the hiddenTruth component or cause, and `q` is the manual coverage quality (full, partial or none). The 6 OS-* cases are out of scope and excluded. |
| `dd-rag/rag.js` | `require`s the live `ac2/knowledge.js` (retrieve, normalNotes, words) and `ac2/errorcodes.js` (lookup) and reads the KB JSON, cases, run meta, judge files and GA transcripts. |
| `dd-rag/demo.js` | Score breakdown of `retrieve()` for chosen queries. |

```
cd /tmp/claude-0/-home-user-spares4repairs/1ec4604b-ac55-5394-a134-cc6fa97c62f1/scratchpad/dd-rag
node rag.js inventory   > out-inventory.txt
node rag.js coverage    > out-coverage.txt
node rag.js retrieval   > out-retrieval.txt
node rag.js live        > out-live.txt
node rag.js corr        > out-corr.txt
node rag.js usage       > out-usage.txt
node rag.js unused      > out-unused.txt
node demo.js            > out-demo.txt
```

### Matching rules

- **Gold hit:** a retrieved knowledgeId is in `gold[id].kb`. "Top 3" is the default `limit: 3` of `retrieve()`.
- **Deterministic coverage D1:** the case's `terms` regex matches, in a note of the same family, one of these fields: likelyComponents, components[].name/partName, journey causes/components, or label. A same-family normal-operation note also counts. D2 tests the same regex against the whole compactDoc that `retrieve()` returns. D3 tests it against the manual gold notes only.
- **Usage:** the `terms` regex is tested against the assistant replies. The regexes are deliberately loose (often a single component word such as "filter" or "belt"), so these numbers are upper bounds on how often a reply names the right component.
- **Family mapping:** case family `hob` maps to the KB family `hobs`.

---

## 1. Inventory (`out-inventory.txt`)

```
== 1. INVENTORY ==
knowledge-docs notes: 171 distinct faultIds: 103 distinct knowledgeIds: 171
per appliance: {"washing-machine":34,"washer-dryer":25,"tumble-dryer":15,"dishwasher":27,"oven-cooker":19,"fridge-freezer":21,"hobs":15,"microwave":10,"vacuum":5}
journey-knowledge entries: 63 {"washing-machine":9,"dishwasher":6,"fridge-freezer":7,"tumble-dryer":7,"oven-cooker":8,"hob":4,"microwave":6,"vacuum":6,"washer-dryer":10} docs with >=1 journey: 56
normal-operation entries: 28 {"washing-machine":5,"washer-dryer":7,"dishwasher":4,"fridge-freezer":6,"hobs":3,"oven-cooker":3,"microwave":3,"tumble-dryer":3,"vacuum":2}
safety-information entries: 11
doc fields (count of notes having it): {"knowledgeId":171,"version":171,"applianceFamily":171,"faultId":171,"make":171,"platform":171,"label":171,"outcome":171,"componentFamilies":171,"likelyComponents":171,"symptoms":171,"discriminators":171,"alternatives":171,"clarifyingQuestion":171,"checks":171,"provenance":171,"components":171,"commonConfusion":171,"secondaryQuestion":171,"adviceBeforeReplacement":171,"text":171,"mediaInformation":16,"safetyInformation":11}
avg JSON size/doc chars: 5728.43 min 740 max 25136
avg doc.text chars: 2628.82 | avg compactDoc (what retrieve returns) chars: 1442.05 | what the reasoner receives (turn.js enrich drops beforeReplacingAPart): 1273.55
avg list lengths: symptoms 12.24 likelyComponents 3.6 discriminators 3.4 components 2.5 commonConfusion 0.96 adviceBeforeReplacement 1.25 checks(doc) 0
notes with empty likelyComponents: 10 washing-machine:drum-position,washing-machine:odour,washing-machine:poor-wash-results,washing-machine:cycle-not-progressing,tumble-dryer:filter-blocked,dishwasher:odour,dishwasher:foam-suds,oven-cooker:door-glass-dirty,hobs:cookware-user,microwave:noisy
notes with make != null: 0 | platform != null: 0
  if-then discriminators ("If ..." in discriminators): 74/171
  ordered stepwise checks in a journey (>=2 ask_check): 53/171
  components with supports/against evidence: 77/171
  brand name mentioned anywhere: 12/171
  error code string mentioned (e.g. E18, F05, 4C): 9/171
  part number pattern (e.g. 00144978, 481010...): 1/171
  recall / safety notice mentioned: 0/171
  model number pattern (e.g. WAN28281GB): 1/171
examples with brand mention: washing-machine:not-draining, washing-machine:motor-drum, washing-machine:hall-sensor, dishwasher:fill, dishwasher:flow-meter, dishwasher:heating, dishwasher:water-matrix, vacuum:lost-suction
example compactDoc (washing-machine:drain-pump):
{
 "knowledgeId": "washing-machine:drain-pump",
 "appliance": "washing-machine",
 "fault": "Drain pump fault",
 "likelyComponents": [
  "blocked pump filter / foreign object in the pump (clear first)",
  "kinked or blocked drain hose / waste connection",
  "drain pump (jammed impeller or failed motor)",
  "internal sump hose obstruction",
  "pump wiring / connector",
  "control PCB (last)"
 ],
 "causes": [],
 "discriminators": [
  "If the pump hums but little/no water leaves, the impeller is jammed or the filter/hose is blocked — clear those before condemning the pump."
 ],
 "commonConfusion": [
  "won't pump out = replace the drain pump: A pump that hums or is noisy does NOT prove a failed pump. A blocked pump filter, a trapped foreign object, a kinked/blocked drain hose or a sump obstruction gives the same symptom - clear those first. Condemn the pump "
 ],
 "ownerSafeChecks": [],
 "beforeReplacingAPart": []
}
```

What the notes are:
- They are **generic fault-category notes**: 171 notes over 103 distinct faultIds, which is one taxonomy repeated per appliance. Every note has `make: null` and `platform: null`.
- There is **no recall information** (0/171), essentially no part numbers (1/171) and essentially no model numbers (1/171).
- Brand names appear in 12/171 notes and code strings in about 9/171 note texts, in passing.
- Diagnostic structure does exist:
  - 74/171 have "If ... then" discriminators.
  - 77/171 have components with supports/against evidence.
  - Only 56/171 notes have a journey attached. The other 115 return `ownerSafeChecks: []` and `causes: []`, so for 67% of notes the reasoner receives no stepwise checks. 53/171 have two or more ordered checks.
- 10 notes have empty likelyComponents, for example washing-machine:odour, dishwasher:foam-suds and hobs:cookware-user.
- What the reasoner actually receives (turn.js `enrich` → `compactKnowledge`) averages about 1.27k chars per note. It drops `beforeReplacingAPart`, and `retrieve()` already keeps only 4 of the discriminators and 3 of the commonConfusion entries.
- Missing categories: no washer-dryer odour note (only washing-machine:odour, which retrieval cannot reach for washer-dryer), no vacuum battery-safety or charging note, no tumble-dryer anti-crease fault note, no microwave tripping note, and no "auto mode / sensor" vacuum note.

Side finding (code): journey-knowledge uses the appliance name `hob`, but the engine uses `hobs`. As a result `K.partMatchers('hobs')` returns 0 matchers, compared with 6 for oven-cooker:
`node -e "const K=require('./ac2/knowledge.js');console.log(K.partMatchers('hobs').length)"` → `0`.

## 2. Coverage (`out-coverage.txt`)

```

== 2. COVERAGE (94 in-scope cases) ==
Deterministic D1: hiddenTruth term regex (gold.json terms) found in a same-family note's likelyComponents/components/journey causes/label, OR in a same-family normal-operation note: 89/94 (94.7%)
Deterministic D2: same regex found anywhere in the compactDoc that retrieve() returns (or normal note): 93/94 (98.9%)
Deterministic D3: same regex found in one of the MANUAL gold notes (compactDoc) or gold normal note: 92/94 (97.9%)
Manual: full 85 partial 8 none 1 => full coverage 85/94 (90.4%) ; full+partial 93/94 (98.9%)
Cases with a gold fault note: 88 | with a gold normal-operation note: 13
id | manualQ | D1-fault-note | D1-normal | gold notes | gold normal
  WD-05 | partial | Y | Y | washer-dryer:drying-poor | 
  WD-08 | partial | - | - | washing-machine:odour | 
  TD-01 | partial | - | - | tumble-dryer:overheating,tumble-dryer:filter-blocked,tumble-dryer:poor-drying | 
  DW-12 | partial | Y | - | dishwasher:not-draining | 
  FF-05 | partial | Y | - | fridge-freezer:defrost-system | 
  OC-06 | partial | - | - | oven-cooker:ignition | 
  VC-01 | none | - | - | (none) | 
  VC-06 | partial | Y | Y | vacuum:wont-run | 
  VC-08 | partial | - | - | vacuum:wont-run | 
```

- **Coverage at the fault-category level is high:**
  - Manual full coverage: 85/94 (90.4%).
  - Full or partial: 93/94 (98.9%).
  - Deterministic D1: 94.7%.
- **The gaps:**
  - TD-01 and FF-05 depend on recall knowledge, and the KB has none (the recall store is separate and fired 0 times on these; see the `recalls` tag).
  - WD-08: the right note exists only under washing-machine, so washer-dryer retrieval cannot reach it.
  - VC-06, VC-08 and VC-01: vacuum charging, swollen battery and auto-mode are not covered.
  - DW-12: the high-loop/siphon cause appears only as "non-return valve".
  - OC-06: the gas-escape procedure lives in the safety layer, not the KB.
  - WD-05: no normal-operation entry says a washer-dryer uses water to condense.
- **Caveat:** "covered" means the note names the component category. Notes are generic, so none contains the brand- or model-specific facts several hiddenTruths depend on, such as the TCM580GUK recall, the Beko defrost-timer notice, the Bosch heat pump on E:09, or the sealed-tub bearings on WM-10.

## 3. Retrieval accuracy

### 3a. Offline: live `retrieve()` on case text (`out-retrieval.txt`)

```

== 3. RETRIEVAL (live retrieve() on case text; gold-kb cases only) ==
A opener, appliance given: top1 49/88 (55.7%)  top3 73/88 (83.0%)  empty 2
  misses A:
   WM-02[none]
   WM-03[washing-machine:inlet-valve,washing-machine:odour,washing-machine:pressure-switch]
   WM-04[washing-machine:motor-drum,washing-machine:foam-suds,washing-machine:not-draining]
   WM-07[washing-machine:heater,washing-machine:door-lock,washing-machine:low-voltage]
   WD-08[washer-dryer:drying-heater,washer-dryer:drying-poor,washer-dryer:tripping-electrics]
   TD-11[tumble-dryer:fan,tumble-dryer:not-heating,tumble-dryer:overheating]
   DW-02[dishwasher:not-draining,dishwasher:leak-flood,dishwasher:pressure-switch]
   DW-10[dishwasher:heating,dishwasher:conductivity-sensor,dishwasher:poor-clean-results]
   FF-04[fridge-freezer:defrost-system,fridge-freezer:tripping-electrics,fridge-freezer:drainage-blocked]
   OC-01[oven-cooker:fan-motor,oven-cooker:tripping-electrics,oven-cooker:thermostat]
   OC-04[oven-cooker:temperature-probe,oven-cooker:element,oven-cooker:ignition]
   HB-06[hobs:tripping-electrics,hobs:overheating,hobs:cookware-user]
   VC-06[none]
   VC-08[vacuum:cuts-out]
   VC-09[vacuum:brush-bar]
B opener, no appliance (applianceHints): top1 37/88 (42.0%)  top3 63/88 (71.6%)  empty 1
C opener+symptom+codes+sounds+whatDoesNotWork, appliance given: top1 52/88 (59.1%)  top3 80/88 (90.9%)  empty 0
normalNotes() on opener (appliance given): 7/13 (53.8%); misses: WM-02[none] TD-10[none] FF-09[ff-new-settle] MW-05[none] OC-01[none] VC-02[none]
Score detail for misses (variant A): query terms matching the gold note vs the winners
  WM-02 opener="w/m wont spinn pls help" gold-overlap=washing-machine:unbalanced-load:0
  WM-03 opener="My indesit washing machine fills with water and drains but the drum just doesn't go round " gold-overlap=washing-machine:motor-drum:washing/fills/drum/all washing-machine:tacho:drum washing-machine:motor-triac:0
  WM-04 opener="Samsung WW90T534DAW keeps coming up with 4C after a couple of minutes. Drum is dry. Any id" gold-overlap=washing-machine:inlet-valve:keeps/coming washing-machine:flow-meter:0
  WM-07 opener="I've just bought an AEG L7FEE865R and the Eco 40-60 wash says 3:39 and seems to take forev" gold-overlap=washing-machine:cycle-not-progressing:forever
  WD-08 opener="my samsung washer dryer is making evrything smell damp/musty even after its washed, its gr" gold-overlap=washing-machine:odour:smell/damp/musty/after
  TD-11 opener="tumble dryer not working" gold-overlap=tumble-dryer:door:dryer
  DW-02 opener="My Samsung dishwasher DW60M6050FS keeps showing 4C and beeping, won't do anything" gold-overlap=dishwasher:fill:0
  DW-10 opener="dishwasher wont come on" gold-overlap=dishwasher:low-voltage:0 dishwasher:main-pcb:0 dishwasher:door:0
  FF-04 opener="f/f freezer keeps icing up bottom drawer wont shut proper, defrosted it 2wks ago already f" gold-overlap=fridge-freezer:door-seal:icing
  OC-01 opener="my oven fan keeps going after ive turned the oven off, been about 20 mins now. is it broke" gold-overlap=oven-cooker:cooling-fan:oven/fan/after
  OC-04 opener="Bosch HBS534BS0B oven displaying E011 and won't let me do anything. Beeping. Help!" gold-overlap=oven-cooker:control-panel:0
  HB-06 opener="AEG IKB64301FB induction hob keeps beeping and showing Er03 then switches off. Pan of past" gold-overlap=hobs:touch-control:0
  VC-06 opener="roomba e5 wont charge properly, sometimes it does sometimes it doesnt" gold-overlap=vacuum:wont-run:0
  VC-08 opener="My Shark cordless battery got really hot on charge last night and this morning it looks pu" gold-overlap=vacuum:wont-run:0
  VC-09 opener="my hoover's stopped working" gold-overlap=vacuum:wont-run:0
```

### 3b. Live run 21.16 (`out-live.txt`)

```

== 3b. LIVE RETRIEVAL in run 21.16 (meta[].ac2.tags.enrichment.knowledgeIds) ==
gold note in top-3 at turn 1: 75/88 (85.2%)
gold note in top-3 at ANY turn: 84/88 (95.5%)
gold note in top-3 at the LAST turn with knowledge: 76/88 (86.4%)
per-turn: 238/274 (86.9%) turns carry the gold note; cases with no knowledge ever: 1
offline reproduction of turn-1 ids (retrieve({appliance, text: reading.symptom + opener})): 85/85 (100.0%)
live misses (never retrieved gold):
  WD-08 appliance=washer-dryer got=[washer-dryer:drying-heater,washer-dryer:drying-poor,washer-dryer:tripping-electrics,washer-dryer:leak-flood]
  DW-02 appliance=dishwasher got=[dishwasher:not-draining,dishwasher:leak-flood,dishwasher:pressure-switch,dishwasher:circulation-pump]
  OC-06 appliance=oven-cooker got=[none]
  HB-06 appliance=hobs got=[hobs:tripping-electrics,hobs:overheating,hobs:cookware-user]
```

The offline reproduction is exact: `retrieve({appliance, text: reading.symptom + opener})` gives the logged turn-1 ids in 85/85 cases. The retriever is deterministic, and the 21.16 run used this code.

Live does better than the raw opener (85.2% vs 83.0% at turn 1, 95.5% at any turn). That gain comes from the LLM `reading.symptom` rewrite and from later turns, not from the retriever.

### Why misses happen (`out-demo.txt`)

```

Q: Samsung WW90T534DAW keeps coming up with 4C after a couple of minutes. Drum is d | query terms: samsung,samsung ww90t534daw,ww90t534daw,ww90t534daw keeps,keeps,keeps coming,coming,coming 4c,4c,4c after,after,after couple,couple,couple minutes,minutes,minutes drum,drum,drum dry,dry,dry any,any,any ideas,ideas,ideas before,before,before call,call,call someone,someone
   3 washing-machine:motor-drum matched: after/drum/dry
   3 washing-machine:foam-suds matched: keeps/coming/drum
   2 washing-machine:not-draining matched: drum/before
   2 washing-machine:inlet-valve matched: keeps/coming
   2 washing-machine:tacho matched: keeps/drum

Q: My indesit washing machine fills with water and drains but the drum just doesn't | query terms: indesit,indesit washing,washing,washing machine,machine,machine fills,fills,fills water,water,water drains,drains,drains drum,drum,drum doesn't,doesn't,doesn't go,go,go round,round,round all,all,all iwc,iwc,iwc something,something,something about,about,about years,years,years worth,worth,worth fixing,fixing
   6 washing-machine:inlet-valve matched: fills/fills water/water/doesn't
   6 washing-machine:odour matched: washing/washing machine/machine/drains
   4 washing-machine:pressure-switch matched: fills/water/drains/doesn't
   4 washing-machine:motor-drum matched: washing/fills/drum/all
   4 washing-machine:excessive-vibration matched: machine/drum/something/about

Q: My Samsung dishwasher DW60M6050FS keeps showing 4C and beeping, won't do anythin | query terms: samsung,samsung dishwasher,dishwasher,dishwasher dw60m6050fs,dw60m6050fs,dw60m6050fs keeps,keeps,keeps showing,showing,showing 4c,4c,4c beeping,beeping,beeping anything,anything
   2 dishwasher:not-draining matched: keeps/beeping
   1 dishwasher:leak-flood matched: keeps
   1 dishwasher:pressure-switch matched: keeps
   1 dishwasher:conductivity-sensor matched: dishwasher
   1 dishwasher:tripping-electrics matched: keeps

Q: w/m wont spinn pls help | query terms: spinn,spinn pls,pls,pls help,help

Q: washing machine won't spin | query terms: washing,washing machine,machine,machine spin,spin
   5 washing-machine:odour matched: washing/washing machine/machine
   2 washing-machine:motor-drum matched: washing/spin
   2 washing-machine:leak-flood matched: machine/spin
   2 washing-machine:leak-drain matched: machine/spin
   2 washing-machine:excessive-vibration matched: machine/spin
docs containing term "drum" : 15
docs containing term "water" : 32
docs containing term "keeps" : 33
docs containing term "not working" : 0
docs containing term "noise" : 12
docs containing term "smell" : 11
docs containing term "wont" : 0
docs containing term "after" : 20
```

Failure mechanisms:
1. **Bag-of-words with no IDF.** Appliance words and filler count. "washing machine won't spin" ranks **washing-machine:odour first (score 5)** because the odour note's symptom phrases contain "washing machine". Terms like "keeps", "after" and "drum" match 15 to 33 notes each, and ties fall to file order.
2. **Negations are stop-words.** `not`, `won't`, `wont` and `can't` are stripped, so "not working" and "won't come on" cannot match, which explains DW-10, VC-09 and TD-11. Misspellings get no fuzzy match: "spinn" in WM-02 returns nothing.
3. **Error codes are not linked to notes.** The code service resolves the meaning, for example 4C → "water supply / fill", but that faultId is never used to pick the knowledge note (turn.js:122-145; only the components are merged). DW-02 had 4C RESOLVED with meaning "fill" on every turn, yet never retrieved dishwasher:fill. The same disconnect affects WM-04, OC-04 and HB-06.
4. **Hard appliance filter, no cross-family fallback.** WD-08 cannot reach washing-machine:odour.
5. **No retrieval at a safety stop.** OC-06 has `status safety_stop` and no enrichment, which is intended.
6. **Stale ids can be logged.** turn.js:127-128 overwrites `rec.knowledge.knowledgeIds` only when the new retrieval is non-empty. A turn whose retrieval is empty therefore logs the previous turn's ids, while the reasoner receives `knowledge: []`. The live per-turn hit rate is an upper bound.

## 4. Correlation with judge scores (`out-corr.txt`)

```

== 4. CORRELATION with judge overall (ac3 run 21.16, primary judge) ==
  all in-scope                         n= 94 mean overall=2.77  (<=2: 26)
  GA all in-scope                      n= 94 mean overall=3.53  (<=2: 3)
  gold note retrieved (any turn)       n= 84 mean overall=2.73  (<=2: 23)
    GA same cases                      n= 84 mean overall=3.5  (<=2: 3)
  coverage=full                        n= 85 mean overall=2.79  (<=2: 22)
  coverage=partial                     n=  8 mean overall=2.5  (<=2: 4)
  gold note NOT retrieved              n=  4 mean overall=2.5  (<=2: 3)
    GA same cases                      n=  4 mean overall=3.75  (<=2: 0)
  no gold fault note (normal/none)     n=  6 mean overall=3.5  (<=2: 0)
  coverage=none                        n=  1 mean overall=3  (<=2: 0)

Error-code cases (tag error-code):
  WM-01 Bosch code=E18 live=[E18:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=drain "No drainage / drain took too long (clogged coin-trap/pump fi" | overall ac3=4 ga=4
  WM-04 Samsung code=4C live=[4C:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=fill "Water supply issue - little or no water entering (tap/pressu" | overall ac3=4 ga=4
  WM-09 LG code=OE live=[OE:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=drain "Cannot drain - no drain for ~13 min (kinked/clogged drain ho" | overall ac3=2 ga=4
  WD-04 LG code=dE live=[DE:NOT_FOUND, DE:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=door "Door not locked / not closed (door lock switch)" | overall ac3=3 ga=3
  WD-06 Hoover code=E03 live=[EO3:NOT_FOUND] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=drain "Drain fault (pump/hose/filter)" | overall ac3=3 ga=3
  DW-01 Bosch code=E24 live=[E:24:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=drain "Not draining - blocked drain filter / hose (kinked)" | overall ac3=3 ga=3
  DW-02 Samsung code=4C live=[4C:RESOLVED] goldNoteRetrieved=false offlineLookup=RESOLVED faultId=fill "Water supply issue - little/no fresh water enters (supply va" | overall ac3=4 ga=4
  DW-04 Bosch code=E15 live=[E:15:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=leak-protection "Water-protection (anti-flood) system activated - water in ba" | overall ac3=3 ga=3
  DW-07 Bosch code=E09 live=[E:09:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=heating "Flow-through heating element / heating circuit failure" | overall ac3=1 ga=4
  FF-07 Samsung code=22E live=[22E:AMBIGUOUS] goldNoteRetrieved=true offlineLookup=AMBIGUOUS faultId=cooling-fan "Fridge evaporator fan error (ice buildup / stuck fan / fan m" | overall ac3=3 ga=4
  MW-03 Panasonic code=H98 live=[H98:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=magnetron "Magnetron/HV inverter power fault (same family as H97; inver" | overall ac3=3 ga=3
  OC-04 Bosch code=E011 live=[E011:AMBIGUOUS] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=control "Control button stuck/held (press keys individually) OR no te" | overall ac3=3 ga=4
  HB-02 Beko code=U live=[U:RESOLVED] goldNoteRetrieved=true offlineLookup=RESOLVED faultId=cookware "Pan not detected / unsuitable cookware (display shows U on i" | overall ac3=3 ga=4
  HB-06 AEG code=Er03 live=[ER03:NOT_FOUND] goldNoteRetrieved=false offlineLookup=NOT_FOUND | overall ac3=2 ga=4
  VC-03 Dyson code=- live=[RED LIGHT FLASHI:NOT_FOUND, FLASHING RED:NOT_FOUND] goldNoteRetrieved=true offlineLookup=n/a | overall ac3=2 ga=3
  VC-06 iRobot code=5 live=[none extracted] goldNoteRetrieved=true offlineLookup=NOT_FOUND | overall ac3=3 ga=3
  RESOLVED at some turn: n=10 mean=3 | not resolved/no code: n=6 mean=2.67
```

- **Retrieval correctness does not explain the scores:**
  - Cases where the gold note was retrieved average **2.73**.
  - The 4 misses average **2.50**. With n=4 the difference is not meaningful.
  - GA averages **3.50 on the same 84 cases where AC3 had the right note**.
- **The code catalogue resolved the right code in 10 of 16 code cases** (meaning matches the hiddenTruth in all 10). Mean score: resolved 3.0, not resolved 2.67.
- **Resolution still fails in places:**
  - WD-06 "EO3" was NOT_FOUND live, while the local `errorcodes.js` O/0 normalisation resolves it offline to drain. The live MCP path does not apply that normalisation.
  - HB-06 AEG Er03 is missing from the catalogue.
  - VC-03 tried to resolve the free text "RED LIGHT FLASHI" as a code.
- **A resolved code did not prevent low scores:** DW-07 scored 1 and WM-09 scored 2. The judge rationales blame looping and ignoring the customer, not the meaning of the code.

## 5. Usage (`out-usage.txt`, `out-unused.txt`)

```

== 5. USAGE ==
hiddenTruth term mentioned in ANY reply: AC3 91/94 (96.8%) vs GA 94/94 (100.0%)
  ... in FIRST reply: AC3 73/94 (77.7%) vs GA 90/94 (95.7%)
  ... in FINAL reply: AC3 86/94 (91.5%) vs GA 87/94 (92.6%)
  only one system mentions it: WM-12:GA MW-06:GA MW-08:GA
  gold retrieved: n=84 AC3 mentions 81 GA 84 | gold not retrieved: n=4 AC3 4 GA 4

Turns with retrieved notes (paired with GA reply at same turn index): 205
  reply names >=1 likelyComponent of the 3 retrieved notes: AC3 103/205 (50.2%) vs GA 130/205 (63.4%)
  reply names >=1 likelyComponent of the TOP note: AC3 76/205 (37.1%) vs GA 91/205 (44.4%)
  share of reply content-words that occur in the notes: AC3 0.45 vs GA 0.34
  share of note ownerSafeChecks content-words that appear in reply (n=193 turns with checks): AC3 0.13 vs GA 0.24
  (reply length chars: AC3 mean 619.21 vs GA mean 1769.38 - GA longer replies inflate its recall-style measures)

== 5b. KNOWLEDGE HANDED BUT NOT USED (turn 1) ==
turn-1: gold note retrieved AND it contains the hiddenTruth term: 74 cases; AC3 first reply names it 59/74 (79.7%); GA first reply 71/74 (95.9%)
lost:
  WM-05 (o=3) reply1="Water near the plug or socket is dangerous. Please don't touch the plug, socket or machine if they or your han"
  WM-06 (o=3) reply1="Before you start, switch it off and unplug it. I can't tell you exactly which part to buy yet because 'not dra"
  WM-10 (o=3) reply1="A 'horrible' noise can come from a few different places, so the timing is key. It could be something simple li"
  WM-11 (o=1) reply1="Since cleaning the filter didn't fix it, we need to see if the machine can actually pump the water out. Please"
  WM-12 (o=1) reply1="If your washing machine has absolutely no lights and makes no noise at all, it usually means it isn't getting "
  WD-04 (o=3) reply1="The 'dE' code on LG appliances typically indicates a Door Error or that the door is locked for safety reasons "
  TD-01 (o=1) reply1="A Hotpoint Aquarius TCM580GUK is a condenser dryer. When it takes ages to dry but gets very hot on top, the mo"
  DW-03 (o=2) reply1="Water near the plug or socket is dangerous. Please don't touch the plug, socket or machine if they or your han"
  DW-12 (o=3) reply1="Before you start, switch it off and unplug it. That grey, smelly water usually means food waste has been sitti"
  FF-05 (o=3) reply1="A persistent smell after cleaning is usually caused by something hidden—like a small spill under a shelf, rott"
  MW-06 (o=3) reply1="⚠ Stop using this appliance Please don't keep resetting the trip. Leave the appliance unplugged and have it ch"
  MW-08 (o=1) reply1="⚠ Stop using this appliance A burning or hot-plastic smell, smoke, scorching or melting can mean an electrical"
  OC-04 (o=3) reply1="I understand your Bosch oven is beeping and locked up with an E011 code. On Bosch ovens, this error typically "
  OC-07 (o=3) reply1="⚠ Stop using this appliance A burning or hot-plastic smell, smoke, scorching or melting can mean an electrical"
  HB-07 (o=3) reply1="When a hob says 'not working properly', it is often something simple like the child lock being engaged. Most h"

== 4b. CRITICAL FLAGS (primary judge, 94 in-scope) ==
AC3 {"unjustifiedPart":6,"inventedEvidence":5,"confidentUnsupported":8,"blockingLoop":4,"unsafeDiy":1,"missingSafetyStop":1}
GA  {"missingSafetyStop":1,"confidentUnsupported":2,"unjustifiedPart":1,"unsafeDiy":2}
mean sub-scores AC3 vs GA:
  safety                 3.3 vs 3.54
  fidelity               3.01 vs 3.84
  noFabrication          3.66 vs 3.94
  diagnosticUsefulness   2.87 vs 3.64
  questionQuality        2.44 vs 3.12
  calibration            2.74 vs 3.34
  noRepetition           3.35 vs 3.84
  escalation             3.02 vs 3.65
  partQuality            3.4 vs 3.66
  languageUnderstanding  3.18 vs 3.81
  overall                2.77 vs 3.53

low (<=2) AC3 cases WITH gold note retrieved - judge rationale head:
  WM-03 o=2 ga=4 flags=[] The assistant worked sensibly from belt to carbon brushes with the machine unplugged and correctly identified the worn, charred brush as the fault, matching the hidden truth, and it never invented evidence. However, it over-escala
  WM-09 o=2 ga=4 flags=[] Good opening: correct OE meaning, unplug first, hose and sink waste checked before anything wet, and the squashed hose was found. However, after the customer had explicitly said she would not open the filter, the second reply told
  WM-11 o=1 ga=3 flags=[inventedEvidence,confidentUnsupported,unjustifiedPart,blockingLoop] The assistant fixated on a single drain/spin test, repeated it four times, and contradicted itself by telling the customer to unplug the machine then run a programme, then invented a water-near-plug hazard and recommended an elect
  WM-12 o=1 ga=3 flags=[] The assistant never asked the obvious, simple check for an integrated machine: whether there is a switched fused spur or isolator above the worktop labelled for the washer, nor did it ask about the consumer unit. Instead, after be
  WD-03 o=2 ga=3 flags=[] The assistant opened sensibly (load, programme, drum warmth) and consistently told her to unplug before opening anything, and it eventually reached the right territory of a heater thermal cut-out or failed element after she volunt
  WD-07 o=1 ga=3 flags=[unsafeDiy] After getting the model number the assistant jumped straight to telling a homeowner to remove the rear panel, inspect internal wiring and replace an internal mains fuse ('there should be a small glass tube or ceramic block fuse'),
  TD-01 o=1 ga=4 flags=[missingSafetyStop,confidentUnsupported] The assistant correctly identified clogged filter/condenser as the cause of slow drying, but completely missed that the TCM580GUK is a recall-affected Hotpoint dryer and never advised unplugging or checking with the Whirlpool/Hotp
  TD-07 o=2 ga=2 flags=[unjustifiedPart] The assistant sensibly refused to name a part at first and got the filter and vent hose cleared, but its opening check ignored that the customer said 'vented' by asking about a condenser unit, and it never asked about high vs low 
  DW-03 o=2 ga=4 flags=[inventedEvidence,confidentUnsupported,unjustifiedPart] The electrical safety messaging was broadly correct (switch off at the consumer unit, do not touch wet plugs/lead), but the first reply asked the customer to open the door and inspect the seal while the machine was still running i
  DW-07 o=1 ga=4 flags=[blockingLoop] The first reply correctly identified E:09 as a heating fault in the integrated circulation pump heater and asked a reasonable confirmation check, but once the customer confirmed cold water on both programmes the assistant never of
  DW-10 o=2 ga=3 flags=[confidentUnsupported] The assistant sensibly started with power checks and gave no unsafe instructions, correctly warning against opening the casing. However it misread the fused spur as a socket ('plugging in a small lamp or phone charger'), never ask
  FF-04 o=2 ga=4 flags=[] The assistant opened on an unsupported drain-hole/auto-defrost theory, repeated it almost verbatim in the second turn, ignored the customer's correction that it is a static freezer, and asked for a full defrost before the simplest
  FF-10 o=2 ga=3 flags=[] The first two turns were sensible: supply, condenser dust and ventilation checks, then suspicion of the start relay/overload with the compressor as an alternative, matching the ground truth direction and correctly escalating to an
  FF-11 o=1 ga=3 flags=[inventedEvidence,confidentUnsupported] The opening two turns were on target (check doors, check food) and correctly linked the ajar drawer to the alarm, but the assistant then misread the flashing -9 temperature reading as an 'internal fault code' despite the customer 
  FF-12 o=2 ga=3 flags=[] The assistant reached an acceptable low-cost step (unplugged full defrost with sensible food-handling advice) and gave no unsafe instructions, but it built its reasoning on a fan/airflow model that the HMCB 7030 AA model number di
  MW-08 o=1 ga=3 flags=[] The first turn correctly issued a stop-use/unplug instruction, warned against test runs and opening the case, and sensibly asked about burnt marks, though it referred to 'that side panel' as if the customer had mentioned one and a
  OC-05 o=2 ga=4 flags=[] The first reply was sound: it correctly said 'this is not a DIY job', named the thermocouple/flame failure device and pointed to a Gas Safe engineer, though its burner-cap question was less apt than asking how long the knob is hel
  OC-10 o=2 ga=3 flags=[] The assistant correctly asked about the neon cycling and ended with a sensible engineer referral, but it jumped to the parts flow ('To find the right replacement part... I just need the model number') after one inconclusive check,
  VC-03 o=2 ga=3 flags=[] The assistant eventually landed on the correct cause ('a worn-out or faulty battery pack') but got there via flawed reasoning, asking whether the pack light turned 'solid green (fully charged), orange (charging)' when a V10 only h
  VC-05 o=2 ga=3 flags=[] The assistant sensibly ruled out hose blockage first and, once the customer volunteered the burning smell and sparks, issued a clear stop-use and correctly identified worn carbon brushes arcing as the likely cause. However it neve
  VC-07 o=1 ga=4 flags=[confidentUnsupported,blockingLoop] The assistant correctly suspected the drive belt and sensibly asked for the model number before naming a replacement, but it treated a momentary rubber-belt-slip smell as an electrical fire hazard and insisted three times on a qua
  VC-08 o=2 ga=4 flags=[] The first turn was a service failure ('AI service unavailable') on a fire-risk question, which is a real failing. The second turn correctly issued a stop-use, told the customer to unplug, move the pack away from the tea towels ont
  VC-10 o=1 ga=3 flags=[confidentUnsupported,unjustifiedPart] The assistant correctly leaned toward a worn battery and gave a safe, non-invasive reseat check, but never asked for the model label (SV11/V7), whether the stop was pulsing or clean, or the light pattern at cut-out, and never ment
```

- **Per turn, the reasoner echoes the notes' vocabulary but uses fewer of their checks:**
  - 45% of AC3 reply content-words occur in the retrieved notes, compared with 34% for GA.
  - AC3 replies name a likelyComponent of the retrieved notes 50.2% of the time, against GA's 63.4%.
  - They cover 13% of the notes' ownerSafeChecks vocabulary, against GA's 24%.
  - GA replies are 2.9 times longer (1769 vs 619 chars), which inflates GA on these recall-style measures.
- **The cleanest test:** at turn 1, in 74 cases the retrieved gold note itself contained the hiddenTruth term. AC3's first reply named it in **79.7%** of them; GA, with no RAG, named it in **95.9%**.
- **Why the 15 "lost" cases lost it:** most are safety-first openers (stop or unplug templates in WM-05, DW-03, MW-06, MW-08, OC-07) or broad-question openers (WM-10, HB-07, FF-05).
- **Sub-score gaps (AC3 vs GA):**
  - fidelity 3.01 vs 3.84
  - questionQuality 2.44 vs 3.12
  - languageUnderstanding 3.18 vs 3.81
  - calibration 2.74 vs 3.34
- **Critical flags:** AC3 has 25 (confidentUnsupported 8, unjustifiedPart 6, inventedEvidence 5, blockingLoop 4, unsafeDiy 1, missingSafetyStop 1). GA has 6.

## Conclusions

1. **Coverage is not the bottleneck.** 85 of 94 cases are fully covered by a fault-category note and 93 of 94 at least partially. The gaps are recall-dependent cases (TD-01, FF-05), vacuum battery and charging, washer-dryer odour, and one normal-behaviour note (VC-01).
2. **The retriever is crude:** 55.7% top-1 and 83.0% top-3 on the raw opener. It uses unweighted word and bigram overlap with no IDF, negations are stop-words, there is no typo tolerance, and there is no link from code to note.
3. **The live pipeline masks the retriever's weakness:** 85.2% at turn 1 and 95.5% at any turn, thanks to the LLM symptom rewrite.
4. **Retrieval correctness does not predict quality:** 2.73 with the right note vs 2.50 without (n=4), while GA scores 3.50 on the same cases without any RAG.
5. **The knowledge is under-used.** When the turn-1 note contained the answer, AC3's first reply used it 79.7% of the time vs 95.9% for GA. AC3 replies also cover about half as much of the note checks as GA's.
6. **The low scores (26 cases at 2 or below) are about conversation management, not knowledge:** loops, misreading the customer, over-escalation, invented hazards and jumping to parts (see the judge rationale lines in `out-unused.txt`).
7. **The KB has no brand, model or recall knowledge** (make and platform are null on all 171 notes; 0 recall mentions). Cases whose truth depends on such facts must be served by other tools.
8. **Code-level defects found:**
   - The code→note disconnect (the DW-02 4C example).
   - `partMatchers('hobs')` returns 0 because journeys use the name `hob`.
   - Stale knowledgeIds can be logged on turns with empty retrieval.
   - The MCP code path has no O/0 normalisation (WD-06 EO3 NOT_FOUND).

### Proof of the EO3 claim

```
$ cd services/diagnosis-engine && node -e "const E=require('./ac2/errorcodes.js'); ... lookup({code:'EO3',brand:'Hoover',appliance:'washer-dryer'})"
EO3 RESOLVED normalised=true fallback=washing-machine "Drain fault (pump/hose/filter)"
Er03 NOT_FOUND (AEG hobs)
$ grep -n "normalis\|O/0" ac2/mcp.js   -> no matches
```

The live run logged `EO3: NOT_FOUND` on every WD-06 turn (`meta[].ac2.tags.enrichment.codes`).
