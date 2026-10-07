# Whirlpool-group 12NC identifier resolution — findings

Data-only. Second validation of the reusable identifier layer, and the case that MODIFIES
the two-pipeline architecture.

## Verdict
12NC works as a strong identifier — but Whirlpool differs from Electrolux in a crucial way:
**for Whirlpool-group, some code MEANINGS (F02) are themselves platform-dependent**, so the
identifier pipeline must feed the code-meaning pipeline on demand. The 12NC PREFIX deterministically
routes platform lineage (8699 = Merloni/Hotpoint-Indesit; 85x/481x = Whirlpool-native), which
resolves the F02 conflict badge alone cannot.

## Identifier structure
- Whirlpool-native: 12-digit commercial code / 12NC, prefixes **85x** (851/853/857/859) and legacy **481x**. Already in OUR catalogue (Whirlpool WM 828, DW 1833 rows). Version tail embedded (851000529010/011/012).
- Hotpoint/Indesit: 12-digit 12NC starting **8699**, exposed in official hotpoint.co.uk/indesit.co.uk product URLs + data sheets. NOT in our catalogue (we hold model names + 5-digit spares codes). Also J00xxxxxx model refs and C00xxxxxx part numbers (Merloni/Indesit Company).
- Part 12NC (48xx xxx xxxxx) is distinct from the appliance 12NC.

## Prefix → platform lineage (the F02 key)
- **8699x → MERLONI** (Hotpoint/Indesit) → WHIRL_WM_FNN (F-codes).
- **85x / 481x → WHIRLPOOL_NATIVE** → WHIRL_WM_FNEN.
- Strong signal (MEDIUM); the 12NC also joins to a service doc that states the platform definitively.

## Catalogue coverage
Whirlpool-native 12NCs self-identify in-catalogue (2,661 12NC rows across WM+DW). Hotpoint/Indesit
(3,392+1,376 WM, 1,065+344 DW) have **zero** 12NC in-catalogue — recover from official product URLs
(the 12NC is embedded in the URL, e.g. `...nswm-846-bs-uk-869991684430/p`).

## Model→12NC (HIGH anchors, official)
- Hotpoint NSWM 846 BS UK → 869991684430 (WM, Merloni).
- Hotpoint NSWM 946 W UK → 869991690820 (WM, Merloni).
- Indesit DSFE 1B10 S UK N → 869991616200 (DW, Merloni).
- Whirlpool-native 12NCs already in catalogue (self-identifying; 851693838201 → parts).

## F02 flagship (RESOLVED)
- Indesit/Hotpoint model → 8699 12NC → MERLONI → **F02 = motor/tacho**.
- Whirlpool-native 12NC (85x) → **F02 = FnEn platform-specific (drain-time)**.
- Badge only → **AMBIGUOUS needsPlatform** (resolver refuses to guess).
This is the deterministic platform disambiguation the make+code pipeline could not do.

## Ownership vs lineage (preserved)
Hotpoint/Indesit are corporately under Beko Europe/Arcelik, but their code platform is **MERLONI
(FNN)** — 12NC 8699 confirms the Indesit-Company lineage. Do NOT reclassify as ARCELIK_WM_E/H.

## Architecture impact — MODIFICATION vs Electrolux
Electrolux: modern code meaning is identifier-INDEPENDENT (PNC only for parts/legacy).
**Whirlpool: some code meanings (F02) are platform-DEPENDENT**, so:
`make+appliance+code -> attempt group/scheme; if unambiguous -> meaning; if platform-dependent
(F02 etc.) -> resolve identifier -> 12NC -> platform -> meaning`, while product/parts resolution
stays separately available. The two-pipeline model survives, extended with a join-on-ambiguity edge.

## Parts by 12NC
Whirlpool-native 12NC → parts in our catalogue (851693838201 → door switch 481928048008).
Hotpoint/Indesit 8699 12NC → 0 in our catalogue (indexed by model/C00 parts) — use official portal.

## Scalability / risks
Model→12NC recoverable at scale for Hotpoint/Indesit (12NC embedded in official product URLs) and
native for Whirlpool. Risks: prefix→lineage is a strong signal not a per-unit proof; one model may
map to multiple 12NCs (market/revision) — keep first-class; 5-digit catalogue codes are spares SKUs
(invalid as 12NC). Provenance HIGH (official URLs/data sheets + catalogue-native + parts API).

## Reuse
Same layer applies to Arcelik product-number and Miele M.-Nr. Whirlpool is the strongest case that
the identifier layer must be able to drive CODE-MEANING resolution, not just parts.
