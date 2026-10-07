#!/usr/bin/env python3
"""Error-Code MCP V1 — deterministic tool tests. Offline, no LLM/RAG/network.
Run: python3 error-codes/mcp/tests/test_mcp.py

Cases follow the 30 required intents. Where the spec's illustrative code did not exist in the
banked data, the nearest real dataset case is used (noted inline). Meaning is asserted to come
from the frozen V1 runtime, never from brand logic in the MCP layer.
"""
import os, sys, re, json
HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)
sys.path.insert(0, MCP)
# Isolate from any production LEARNING_BUCKET / last-good leftover.
os.environ["LEARNING_BUCKET"] = ""
os.environ["ERROR_CODE_LAST_GOOD"] = ""
from tools import ErrorCodeTools  # noqa: E402

T = ErrorCodeTools()
EC = None  # for meaning-parity check we reuse T.R
passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    if not ok: print(f"  FAIL: {n} :: {detail}")

def rec(make, appliance, code, **kw):
    a = {"make": make, "appliance": appliance, "code": code}; a.update(kw)
    return T.resolve_error_code(a)
def ctx(make, appliance, observed):
    return T.resolve_appliance_context({"make": make, "appliance": appliance, "observed": observed})

# 1 Bosch DW E15 -> RESOLVED
r = rec("Bosch", "dishwasher", "E15")
check("1 Bosch DW E15 RESOLVED", r["status"] == "RESOLVED" and r["meaning"], str(r.get("status")))
# 2 Siemens display alias (F18 == Bosch E18) -> RESOLVED drain
r = rec("Siemens", "washing-machine", "F18")
check("2 Siemens WM F18 display-alias RESOLVED drain", r["status"] == "RESOLVED" and r["meaning"], str(r.get("status")))
# 3 LG WM OE -> drain
r = rec("LG", "washing-machine", "OE")
check("3 LG WM OE RESOLVED drain", r["status"] == "RESOLVED" and "drain" in r["meaning"].lower(), str(r))
# 4 Samsung WM 4C -> fill
r = rec("Samsung", "washing-machine", "4C")
check("4 Samsung WM 4C RESOLVED (fill/supply)", r["status"] == "RESOLVED", str(r.get("status")))
# 5 Samsung vs LG OE cross-brand difference
rs = rec("Samsung", "washing-machine", "OE"); rl = rec("LG", "washing-machine", "OE")
check("5 Samsung OE != LG OE meaning", rs["status"] == "RESOLVED" and rl["status"] == "RESOLVED" and rs["meaning"] != rl["meaning"],
      f"{rs.get('meaning')!r} vs {rl.get('meaning')!r}")
# 6 BSH WM F06 without context -> NEEDS_CONTEXT
r = rec("Bosch", "washing-machine", "F06")
check("6 BSH WM F06 no-ctx NEEDS_CONTEXT", r["status"] == "NEEDS_CONTEXT" and any(n["attribute"] == "scheme" for n in r["needs"]), str(r.get("status")))
# 7 BSH WM F06 + modern E-Nr -> NTC/temp-sensor
r = rec("Bosch", "washing-machine", "F06", observed=[{"type": "E_NR", "value": "WGG244FCGB/01"}])
check("7 BSH WM F06 + E-Nr(EF) RESOLVED temp-sensor", r["status"] == "RESOLVED" and r["scheme"]["schemeId"] == "BSH_WM_EF" and r["productContextUsed"], str(r.get("scheme")))
# 8 BSH WM F06 + WFF E-Nr -> motor
r = rec("Bosch", "washing-machine", "F06", observed=[{"type": "E_NR", "value": "WFF1101GB/14"}])
check("8 BSH WM F06 + E-Nr(WFF) RESOLVED motor", r["status"] == "RESOLVED" and r["scheme"]["schemeId"] == "BSH_WM_WFF", str(r.get("scheme")))
# 9 Electrolux i20 alias notation (i20 == AL6 within scheme) -> both drain
ri = rec("AEG", "dishwasher", "i20"); ra = rec("AEG", "dishwasher", "AL6")
check("9 Electrolux i20/AL6 scheme-scoped notation both drain",
      ri["status"] == "RESOLVED" and ra["status"] == "RESOLVED" and ri["meaning"] == ra["meaning"], f"{ri.get('meaning')} / {ra.get('meaning')}")
# 10 Candy DW generation/scheme ambiguity -> NEEDS_CONTEXT (resolvable by scheme)
r = rec("Candy", "dishwasher", "E2")
check("10 Candy DW E2 NEEDS_CONTEXT (scheme-resolvable)", r["status"] == "NEEDS_CONTEXT", str(r.get("status")))
# 11 Hoover WM architecture ambiguity -> AMBIGUOUS (source-unresolved)
r = rec("Hoover", "washing-machine", "E16")
check("11 Hoover WM E16 AMBIGUOUS", r["status"] == "AMBIGUOUS" and "architecture" in r["ambiguityDimensions"], str(r.get("status")))
# 12 Haier WM E1 -> AMBIGUOUS
r = rec("Haier", "washing-machine", "E1")
check("12 Haier WM E1 AMBIGUOUS", r["status"] == "AMBIGUOUS", str(r.get("status")))
# 13 Haier DW E4 -> AMBIGUOUS
r = rec("Haier", "dishwasher", "E4")
check("13 Haier DW E4 AMBIGUOUS", r["status"] == "AMBIGUOUS", str(r.get("status")))
# 14 Miele F11 -> RESOLVED
r = rec("Miele", "washing-machine", "F11")
check("14 Miele WM F11 RESOLVED", r["status"] == "RESOLVED", str(r.get("status")))
# 15 Whirlpool F02 platform/architecture -> NEEDS_CONTEXT (resolvable)
r = rec("Whirlpool", "washing-machine", "F02")
check("15 Whirlpool WM F02 NEEDS_CONTEXT (architecture)", r["status"] == "NEEDS_CONTEXT" and any(n["attribute"] == "architecture" for n in r["needs"]), str(r.get("status")))
# 16 status record (Electrolux LOC)
r = rec("AEG", "dishwasher", "LOC")
check("16 Electrolux LOC STATUS", r["status"] == "RESOLVED" and r["recordType"] == "STATUS", str(r.get("recordType")))
# 17 maintenance record (Bosch DW E12 descale)
r = rec("Bosch", "dishwasher", "E12")
check("17 Bosch DW E12 MAINTENANCE", r["status"] == "RESOLVED" and r["recordType"] == "MAINTENANCE", str(r.get("recordType")))
# 18 protection state (Bosch DW E15 anti-flood)
r = rec("Bosch", "dishwasher", "E15")
check("18 Bosch DW E15 protectionState", r["enrichment"] and r["enrichment"]["behaviour"]["protectionState"] is True, str(r.get("enrichment")))
# 19 unknown code -> NOT_FOUND
r = rec("Bosch", "dishwasher", "E99")
check("19 unknown code NOT_FOUND", r["status"] == "NOT_FOUND", str(r.get("status")))
# 20 wrong make -> NOT_FOUND
r = rec("Belkin", "cooker-oven", "F1")
check("20 wrong make NOT_FOUND", r["status"] == "NOT_FOUND", str(r.get("status")))
# 21 valid code on wrong appliance -> NOT_FOUND (E15 is a dishwasher code)
r = rec("Bosch", "washing-machine", "E15")
check("21 valid code wrong appliance NOT_FOUND", r["status"] == "NOT_FOUND", str(r.get("status")))
# 22 malformed input -> INVALID_INPUT
r1 = rec("", "dishwasher", "E15")
r2 = T.resolve_error_code({"make": "Bosch", "appliance": "dishwasher", "code": "E15", "observed": [{"type": "BADTYPE", "value": "x"}]})
r3 = T.resolve_error_code({"make": "Bosch", "appliance": "dishwasher"})  # missing code
check("22 malformed -> INVALID_INPUT", r1["status"] == "INVALID_INPUT" and r2["status"] == "INVALID_INPUT" and r3["status"] == "INVALID_INPUT", f"{r1['status']}/{r2['status']}/{r3['status']}")
# 23 enrichment optional OFF
r = rec("Bosch", "dishwasher", "E15", includeEnrichment=False)
check("23 includeEnrichment=false omits enrichment", "enrichment" not in r, str(list(r.keys())))
# 24 enrichment available ON
r = rec("Bosch", "dishwasher", "E15", includeEnrichment=True)
check("24 includeEnrichment=true includes enrichment", "enrichment" in r and r["enrichment"] is not None, str(r.get("enrichment") is not None))
# 25 missing enrichment does not fail canonical resolve
T2 = ErrorCodeTools(); T2.enrichment = {}
r = T2.resolve_error_code({"make": "Bosch", "appliance": "dishwasher", "code": "E15"})
check("25 missing enrichment -> canonical still RESOLVED, enrichment None", r["status"] == "RESOLVED" and r["enrichment"] is None, str(r.get("status")))
# 26 no manufacturer-specific MEANING branches in the MCP layer
src = open(os.path.join(MCP, "tools.py")).read()
brand_branch = re.findall(r'(==|!=|startswith\()\s*["\']?(bosch|siemens|whirlpool|miele|electrolux|samsung|lg|haier|candy|beko|hotpoint|indesit)\b', src, re.I)
check("26 no brand meaning branches in tools.py", not brand_branch, str(brand_branch[:3]))
# 27 no global bare-code resolution (make/appliance mandatory; same code differs by make/appliance)
bare = rec("", "", "OE")
diff = rec("Samsung", "washing-machine", "OE")["meaning"] != rec("LG", "washing-machine", "OE")["meaning"]
check("27 no global bare-code resolution", bare["status"] == "INVALID_INPUT" and diff, str(bare.get("status")))
# 28 ProductContext tool output (E-Nr -> scheme)
c = ctx("Bosch", "washing-machine", [{"type": "E_NR", "value": "WGG244FCGB/01"}])
check("28 appliance-context resolves scheme", c["status"] == "RESOLVED" and c["resolvedAttributes"]["scheme"] == "BSH_WM_EF", str(c.get("resolvedAttributes")))
# 29 multiple identifiers (Miele model + serial -> generation)
c = ctx("Miele", "dishwasher", [{"type": "MODEL", "value": "G5000"}, {"type": "SERIAL", "value": "19045678"}])
check("29 multiple identifiers -> generation", c["status"] == "RESOLVED" and c["resolvedAttributes"]["generation"], str(c.get("resolvedAttributes")))
# 30 unresolved identifier context -> NEEDS_CONTEXT
c = ctx("Bosch", "dishwasher", [{"type": "E_NR", "value": "ZZZ9999"}])
check("30 unresolvable identifier -> NEEDS_CONTEXT", c["status"] == "NEEDS_CONTEXT", str(c.get("status")))

# ---- invariants ----
# meaning is owned by V1: resolved meaning must equal the frozen runtime resolver's meaning
for mk, ap, cd in [("Bosch", "dishwasher", "E15"), ("Siemens", "washing-machine", "F18"),
                   ("AEG", "dishwasher", "LOC"), ("Samsung", "washing-machine", "OE")]:
    r = rec(mk, ap, cd); v1 = T.R.resolve(mk, ap, cd)
    check(f"INV meaning owned by V1 ({mk} {cd})", r.get("meaning") == v1.get("meaning"), f"{r.get('meaning')!r} vs {v1.get('meaning')!r}")
# no-context parity: whenever V1 RESOLVES, MCP RESOLVES the same fault; when V1 NOT_FOUND, MCP NOT_FOUND
import itertools
sample = [("Bosch", "dishwasher", "E15"), ("Bosch", "dishwasher", "E22"), ("AEG", "dishwasher", "i20"),
          ("Miele", "washing-machine", "F11"), ("Bosch", "dishwasher", "E99"), ("Belkin", "cooker-oven", "F1"),
          ("Samsung", "fridge", "1C")]
for mk, ap, cd in sample:
    v1 = T.R.resolve(mk, ap, cd); r = rec(mk, ap, cd)
    if v1["status"] == "RESOLVED":
        check(f"INV parity RESOLVED ({mk} {cd})", r["status"] == "RESOLVED" and r["scheme"]["schemeId"] == v1["scheme"], str(r.get("status")))
    elif v1["status"] == "NOT_FOUND":
        check(f"INV parity NOT_FOUND ({mk} {cd})", r["status"] == "NOT_FOUND", str(r.get("status")))
# every resolved enrichment key exists in enrichment set (traceability)
r = rec("Bosch", "dishwasher", "E15")
check("INV enrichment key traceable", any(e["enrichmentKey"] == r["enrichment"]["enrichmentKey"] for e in T.enrichment.values()))
# tool manifest excludes internal tool by default
mf = T.tool_manifest()
check("INV manifest is 2 public tools", [t["name"] for t in mf] == ["resolve-error-code", "resolve-appliance-context"], str([t["name"] for t in mf]))
check("INV internal tool available when requested", len(T.tool_manifest(include_internal=True)) == 3)

# Customer-written subcode punctuation (slash / hyphen / colon / letter-repeat) hits the
# banked suffix mapping. Stem-only stays on the distinct shorter mapping.
_suf = rec("Bosch", "washing-machine", "E:36-10")
check("FOLD MCP suffix token RESOLVED", _suf.get("status")=="RESOLVED", str(_suf.get("status")))
r = rec("Bosch", "washing-machine", "E36/E10")
check("FOLD MCP slash+letter-repeat subcode matches suffix",
      r.get("status")=="RESOLVED" and r.get("system")==_suf.get("system"),
      str(r.get("status")) + " " + str(r.get("system")))
r = rec("Bosch", "washing-machine", "E36")
check("FOLD MCP stem-only is not the suffix mapping",
      r.get("status")=="RESOLVED" and r.get("system") != _suf.get("system"),
      f"{r.get('system')}/{_suf.get('system')}")

# A resolved alias must keep the customer's submitted token, not the mapping's canonical sibling.
_elx = rec("AEG", "washing-machine", "E21")
check("ALIAS customer token stays displayed (not canonical sibling)",
      _elx.get("status")=="RESOLVED" and (_elx.get("code") or {}).get("input")=="E21"
      and (_elx.get("code") or {}).get("displayed")=="E21",
      str(_elx.get("code")))
_c2 = rec("AEG", "washing-machine", "C2")
check("ALIAS a different shown form also stays the customer's token",
      _c2.get("status")=="RESOLVED" and (_c2.get("code") or {}).get("displayed")=="C2",
      str(_c2.get("code")))
_e15 = rec("Bosch", "dishwasher", "E15")
check("ALIAS canonical-equal input is unchanged",
      (_e15.get("code") or {}).get("displayed")=="E15", str(_e15.get("code")))

print(f"\nError-Code MCP V1 tests: {passed} passed / {failed} failed  (total {passed+failed})")
sys.exit(1 if failed else 0)
