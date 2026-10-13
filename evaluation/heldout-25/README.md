# Held-out evaluation set (heldout-25)

**Purpose.** A frozen, held-out set of 31 UK homeowner appliance-diagnosis cases. It is used to check whether
changes tuned on `evaluation/independent-100` and GOLD generalise. Do not use these cases for tuning, prompt design or
journey authoring.

**Format.** Same schema as `evaluation/independent-100/cases.json`: id (`HO-` prefix), family, title, tags,
difficulty, opener, persona, hidden fact bank, hidden truth, expected outcome and provenance.
See `docs/evaluation/independent-100-case-benchmark.md` for how each field is used.

**Coverage.**
- **Families:** washing machine 4, washer-dryer 2, tumble dryer 3, dishwasher 4, fridge-freezer 3, microwave 2,
  oven/cooker 4, hob 3, vacuum 3, out-of-scope 3 (boiler, car, TV).
- **Tags:**
  - hazard 10 (gas smell, smoke/burning, electrical tingle near water, microwave HV request, swollen battery, two
    Whirlpool recalls, microwave fire, hot cooker switch, grill element flash);
  - normal-behaviour 6;
  - full model 20;
  - error code 9;
  - don't know / can't check / refuses 4 / 4 / 3;
  - replaceable part 7.
- **De-duplication:** no opener, model number or error code duplicates the independent-100. GOLD scenario
  titles, ids and model numbers were skimmed only to avoid overlap.

**Sources.** Every case lists the public URLs it was built from. These include:
- manufacturer UK support pages (Bosch, AEG, Miele, LG, Samsung, Vaillant, iRobot);
- OPSS/GOV.UK and other recall notices;
- forums (whitegoodshelp, Mumsnet, DIYnot, electricianforum, iFixit, Dyson community);
- UK retailer and parts listings, used to confirm that model numbers are real.

Expected outcomes were written from those sources and general appliance-repair knowledge only, before any system
was run. Where they are uncertain, they list acceptable alternatives.

**Freeze.**
- **Date:** 2026-10-12.
- **sha256 of `cases.json`:** `8db4dbb7837781ac1a94e413357e816280d6f4a8fa900aabb08171596b00517d`.

This set was created before any tuning against it. It must not be edited. A correction needs a new versioned file
and a recorded reason.
