#!/usr/bin/env python3
"""Canned MCP-shaped responses for deterministic orchestration tests.

Shapes mirror the REAL deployed Error-Code MCP (verified against it). Keyed by
(make-lower, appliance-hyphen, code-upper), with F06 variants keyed by an extra scheme tag
resolved from observed E-Nr (WGG -> EF, WFF -> WFF)."""

def _enr(components=None, causes=None, checks=None, protection=False, safety="NORMAL_DIAGNOSTIC", stop=False):
    return {"components": components or [], "likelyCauses": causes or [], "checks": checks or [],
            "behaviour": {"protectionState": protection, "mayRunPumpContinuously": False, "mayPreventStart": False},
            "safety": {"class": safety, "stopUse": stop}}

def _resolved(displayed, make, appliance, meaning, system, recordType="FAULT", conf="HIGH",
              scheme=None, enr=None, ctxUsed=False):
    return {"status": "RESOLVED", "code": {"input": displayed, "displayed": displayed},
            "make": make, "appliance": appliance, "recordType": recordType, "meaning": meaning,
            "system": system, "confidence": conf, "scheme": scheme or {"schemeId": "X", "variantId": "default"},
            "productContextUsed": ctxUsed, "enrichment": enr or _enr(), "evidenceRefs": []}

CANNED = {
    # Bosch DW E15 — leak protection FAULT with protection state
    ("bosch", "dishwasher", "E15"): _resolved(
        "E15", "Bosch", "dishwasher",
        "Water-protection (anti-flood) system activated - water in base pan; drain pump runs, cycle locked (close tap)",
        "leak-flood", enr=_enr(components=["drain-pump"], protection=True)),
    # Bosch WM F06 — NEEDS_CONTEXT (scheme) ; variants via observed
    ("bosch", "washing-machine", "F06"): {
        "status": "NEEDS_CONTEXT", "code": {"input": "F06", "displayed": "F06"},
        "make": "Bosch", "appliance": "washing-machine",
        "reason": "The displayed code has different meanings on different washing-machine schemes.",
        "needs": [{"attribute": "scheme", "resolutionSources": ["MODEL", "E_NR", "PNC", "12NC"]}],
        "candidates": [{"schemeId": "BSH_WM_EF", "faultId": "temp-sensor", "meaning": "NTC temperature sensor fault"},
                       {"schemeId": "BSH_WM_WFF", "faultId": "motor", "meaning": "Motor fault (brushes/tacho)"}]},
    ("bosch", "washing-machine", "F06", "EF"): _resolved(
        "F06", "Bosch", "washing-machine", "NTC temperature sensor fault", "temperature-sensing",
        scheme={"schemeId": "BSH_WM_EF", "variantId": "default"}, ctxUsed=True,
        enr=_enr(components=["ntc"], checks=["check the temperature sensor wiring"])),
    ("bosch", "washing-machine", "F06", "WFF"): _resolved(
        "F06", "Bosch", "washing-machine", "Motor fault (brushes/tacho)", "motor-drive",
        conf="MEDIUM", scheme={"schemeId": "BSH_WM_WFF", "variantId": "default"}, ctxUsed=True,
        enr=_enr(components=["motor"])),
    # Haier WM E1 — AMBIGUOUS
    ("haier", "washing-machine", "E1"): {
        "status": "AMBIGUOUS", "code": {"input": "E1", "displayed": "E1"},
        "reason": "SOURCE_UNRESOLVED", "ambiguityDimensions": ["source"],
        "candidates": [{"schemeId": "HAIER_WM", "faultId": "drain", "meaning": "Drain error (cannot drain in time)"}]},
    # AEG DW LOC — STATUS
    ("aeg", "dishwasher", "LOC"): _resolved(
        "LOC", "AEG", "dishwasher", "Child lock / control lock is active", "status",
        recordType="STATUS", enr=_enr(safety="STATUS_ONLY")),
    # AEG DW PF — INFORMATION (power failure)
    ("aeg", "dishwasher", "PF"): _resolved(
        "PF", "AEG", "dishwasher", "Power failure occurred during the last cycle", "power",
        recordType="INFORMATION"),
    # Bosch DW E12 — MAINTENANCE (descale)
    ("bosch", "dishwasher", "E12"): _resolved(
        "E12", "Bosch", "dishwasher", "Limescale build-up / descale required", "maintenance",
        recordType="MAINTENANCE", conf="MEDIUM"),
    # LG tumble-dryer D80 — STOP_USE (fire hazard, blocked duct)
    ("lg", "tumble-dryer", "D80"): _resolved(
        "D80", "LG", "tumble-dryer", "Exhaust duct blockage - fire hazard; clear the duct", "airflow",
        recordType="WARNING", enr=_enr(safety="STOP_USE", stop=True)),
    # Samsung FF 22C — NEEDS_CONTEXT (scheme/model dependent) but ALL candidate meanings collapse to
    # the SAME diagnostic area (fan). Mirrors the real MCP: SAMSUNG_FF -> faultId "cooling-fan",
    # SAMSUNG_REF -> faultId "fan". The runtime resolver grounds an evaporator-fan fault, which does
    # NOT conflict with either candidate -> deliver the diagnosis, model only for exact part.
    ("samsung", "fridge-freezer", "22C"): {
        "status": "NEEDS_CONTEXT", "code": {"input": "22C", "displayed": "22C"},
        "make": "Samsung", "appliance": "fridge-freezer",
        "reason": "The displayed code has different meanings on different fridge-freezer schemes/platforms.",
        "needs": [{"attribute": "scheme", "resolutionSources": ["MODEL"]}],
        "candidates": [{"schemeId": "SAMSUNG_FF", "faultId": "cooling-fan", "meaning": "Fridge evaporator fan error"},
                       {"schemeId": "SAMSUNG_REF", "faultId": "fan", "meaning": "Fridge fan fault"}]},
    # Samsung FF 22E — same structural ambiguity, same single area (fan).
    ("samsung", "fridge-freezer", "22E"): {
        "status": "NEEDS_CONTEXT", "code": {"input": "22E", "displayed": "22E"},
        "make": "Samsung", "appliance": "fridge-freezer",
        "reason": "The displayed code has different meanings on different fridge-freezer schemes/platforms.",
        "needs": [{"attribute": "scheme", "resolutionSources": ["MODEL"]}],
        "candidates": [{"schemeId": "SAMSUNG_FF", "faultId": "cooling-fan", "meaning": "Fridge evaporator fan error"},
                       {"schemeId": "SAMSUNG_REF", "faultId": "fan", "meaning": "Fridge fan fault"}]},
    # Samsung FF 40E — AUTHORITY-CONFLICT probe: candidate meanings genuinely DIVERGE (fan vs
    # compressor). The runtime resolver grounds a fan fault, but because the code's documented
    # meanings span two distinct areas the orchestrator MUST clarify rather than silently pick one.
    ("samsung", "fridge-freezer", "40E"): {
        "status": "NEEDS_CONTEXT", "code": {"input": "40E", "displayed": "40E"},
        "make": "Samsung", "appliance": "fridge-freezer",
        "reason": "The displayed code has different meanings on different fridge-freezer schemes/platforms.",
        "needs": [{"attribute": "scheme", "resolutionSources": ["MODEL"]}],
        "candidates": [{"schemeId": "SAMSUNG_FF", "faultId": "fan", "meaning": "Evaporator fan fault"},
                       {"schemeId": "SAMSUNG_REF", "faultId": "compressor", "meaning": "Compressor / sealed-system fault"}]},
    # Samsung FF 23E — AMBIGUOUS, but all candidate meanings collapse to the SAME area (fan). Stays
    # unresolved even WITH a model (no variant pin here) so it exercises the multi-turn path where the
    # displayed code must persist into the runtime resolver on a later model-only turn.
    ("samsung", "fridge-freezer", "23E"): {
        "status": "AMBIGUOUS", "code": {"input": "23E", "displayed": "23E"},
        "make": "Samsung", "appliance": "fridge-freezer", "reason": "SOURCE_UNRESOLVED",
        "candidates": [{"schemeId": "SAMSUNG_FF", "faultId": "cooling-fan", "meaning": "Fridge evaporator fan error"},
                       {"schemeId": "SAMSUNG_REF", "faultId": "fan", "meaning": "Fridge fan fault"}]},
    # Samsung FF 22C WITH model context -> RESOLVED to the exact evaporator-fan fault (scheme pinned).
    ("samsung", "fridge-freezer", "22C", "SAMSUNG_FF"): _resolved(
        "22C", "Samsung", "fridge-freezer", "Fridge evaporator fan error - fan not reaching target speed",
        "cooling-fan", scheme={"schemeId": "SAMSUNG_FF", "variantId": "default"}, ctxUsed=True,
        enr=_enr(components=["evaporator fan motor"], checks=["check the evaporator fan for ice/obstruction"])),
    # Samsung vs LG WM OE — same token, different make/meaning
    ("samsung", "washing-machine", "OE"): _resolved(
        "OE", "Samsung", "washing-machine", "Overflow error - too much water/detergent; drain pump runs", "leak-flood"),
    ("lg", "washing-machine", "OE"): _resolved(
        "OE", "LG", "washing-machine", "Drain issue - not draining (food clogs / installation)", "drain"),
}
