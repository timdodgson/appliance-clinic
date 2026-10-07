# Electrolux-group PNC identifier resolution — findings

Data-only. The positive counterpart to the retailer-SKU POC: PNC is a strong, officially
recoverable join key, and the evidence reshapes the target pipeline.

## Verdict
**PNC solves the identifier problem** where retailer SKUs failed. Model→PNC is recoverable at
scale from official Electrolux service PDFs + the AEG/Electrolux shop; PNC→parts is confirmed
via our own parts API. Crucially, PNC is needed for **exact product/part identity**, NOT for
modern **error-code meaning** (which stays brand+appliance-wide). This proves the nuanced
two-pipeline architecture.

## PNC structure (official)
- PNC = Product Number Code / "Prod.No.", **begins with 9, 9 digits**; on the rating plate it
  is shown with a **2-digit ELC** (revision/version) → the "11-digit" number AEG references.
- **Prefix encodes appliance:** 914 = washing machine, 911 = dishwasher (605 = legacy AEG WM).
- AEG / Electrolux / Zanussi **share** the PNC/ELC system (Electrolux-group).
- The catalogue's `-NN` suffix on PNC rows **is the ELC** (e.g. 914528104-01 = PNC 914528104 + ELC 01).

## Catalogue coverage (already contains PNCs)
936 PNC rows: AEG WM 573 / DW 76, ELX WM 107 / DW 9, Zanussi WM 114 / DW 57. **44 base-PNCs
carry multiple ELC revisions** in the catalogue (e.g. AEG 914528104 → -00/-01/-02/-03;
Zanussi 911516002 → base/-01/-02). Models and PNCs are stored as SEPARATE rows (no internal join).

## Model→PNC recovery (HIGH, scalable)
Official Electrolux service exploded-view PDFs carry a `PNC / ELC / ProdDate / Brand / Model`
matrix. Confirmed joins (all AEG WM, matching catalogue LAV*/L* prefixes):
- LWX9A9613C → 914600341 (ELC 00 @2021-09-20 AND ELC 01 @2022-03-02) — one model, one PNC, **two ELC**.
- LAV86760 → 914002535/00; LAV84760 → 914002495/00.
- LAVW1455 → 914002594; LAVW1450 → 914002596; LAVW1441 → 914002606 (one shared exploded view, 3 PNCs).
- L86800 → 914525332; L50600 → 914524032/01.
Plus the AEG shop resolves a model page → PNC, and the parts API resolves PNC+ELC → exact parts
(914528104-01 → door gasket + pressure switch).

## Does PNC change error-code meaning?
**No (modern).** ELX_WM_EXX and ELX_DW_IXX remain brand+appliance-wide; no same-model/
different-PNC/same-code/different-meaning conflict found. PNC's value is **product/part
identity** and **legacy-platform disambiguation** (the join key to the right service manual),
not modern code meaning.

## Architecture answer (explicit)
1. PNC necessary BEFORE code interpretation? **No** for modern ELX meaning.
2. PNC necessary AFTER, for part identity? **Yes** — model→PNC+ELC → exact parts.
3. Same model spans multiple PNC/ELC revisions? **Yes** (ELC revisions; sometimes multiple PNCs by market).
4. PNC gives architecture/generation info unavailable from model? **Yes** — via the exploded
   view/parts (controller, revision, prod date), and it is the join key for legacy platforms.
5. One-observed-model → many-canonical-identifiers must be first-class? **Yes.**
6. Separate diagnostic-code resolution from exact product/part resolution? **Yes** — two
   independent pipelines that JOIN only on ambiguity (legacy) or when exact parts are needed.

Recommended pipeline: `make + appliance + code → error-code scheme/meaning` INDEPENDENTLY of
`observed model/rating-plate → PNC(+ELC) → exact product/platform/parts`; JOIN on demand.

## Applicability to other identifiers
The layer is generic: **Whirlpool 12NC**, **Arçelik product number**, **Miele M.-Nr./Type** are
the same "resolve the authoritative identifier first" problem and can reuse this schema. PNC is
the cleanest because Electrolux publishes the join tables and prefix-encodes the appliance.

## Data-quality risks
Catalogue model↔PNC not internally joined (needs the service-PDF/shop feed); one-model→many-PNC
must not be flattened; a bare model string can't be distinguished as real-but-unmapped vs
invalid without a model registry (resolver returns MODEL_RESOLVED_PNC_UNKNOWN honestly).
