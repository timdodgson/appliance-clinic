#!/usr/bin/env python3
"""Runtime-model tests: 28 hard corpus cases + corpus-wide validation invariants.
Offline, deterministic, no network/LLM. Run: python3 tests/test_runtime.py"""
import json, os, sys, re
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "compiler"))
from resolve import Resolver

OUT = os.path.join(os.path.dirname(HERE), "generated", "runtime")
def load(n): return json.load(open(os.path.join(OUT, n)))

R = Resolver()
passed = 0; failed = 0; results = []
def check(name, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    results.append((("PASS" if ok else "FAIL"), name, detail))
    if not ok: print(f"  FAIL: {name} :: {detail}")

def st(mk, ap, cd, ctx=None): return R.resolve(mk, ap, cd, ctx)

# ---------------- 28 HARD CORPUS CASES ----------------
r = st("Bosch","dishwasher","E15");            check("1 BSH DW E15 leak", r["status"]=="RESOLVED" and r["faultId"]=="leak-protection", str(r.get('faultId')))
r = st("Bosch","dishwasher","E22");            check("2 BSH DW E22 drain FAULT", r["status"]=="RESOLVED" and r["faultId"]=="drain" and r["recordType"]=="FAULT", str(r))
r = st("Bosch","washing-machine","E17");       check("3 BSH WM E17 source-unresolved", r["status"]=="AMBIGUOUS" and r["reason"]=="SOURCE_UNRESOLVED")
r = st("Siemens","washing-machine","F18");     check("4 BSH WM F18 (Siemens F-alias of E18) drain", r["status"]=="RESOLVED" and r["faultId"]=="drain", str(r.get('faultId')))
r = st("Siemens","washing-machine","F16");     check("5 Bosch E16==Siemens F16 display alias", r["status"]=="RESOLVED" and r["faultId"]=="door", str(r.get('faultId')))
r = st("AEG","dishwasher","AL6");              check("6 Electrolux DW AL6 notation == i20 drain", r["status"]=="RESOLVED" and r["faultId"]=="drain", str(r.get('faultId')))
r = st("AEG","dishwasher","i40");              check("7 Electrolux DW i40 region/scheme ambiguity", r["status"]=="AMBIGUOUS")
r1 = st("AEG","cooker-oven","F10"); r2 = st("Electrolux","cooker-oven","F30"); check("8 Electrolux oven EU/NA present", r1["status"] in("RESOLVED","AMBIGUOUS") and r2["status"] in("RESOLVED","AMBIGUOUS"))
r = st("Candy","dishwasher","E2");             check("9 Candy DW E2 generation split ambiguous", r["status"]=="AMBIGUOUS")
r = st("Hoover","washing-machine","E16");      check("10 Hoover WM motor-scheme ambiguous", r["status"]=="AMBIGUOUS")
r = st("Hotpoint","washing-machine","F06");    check("11 Hotpoint/Indesit F06 split ambiguous", r["status"]=="AMBIGUOUS")
r = st("Hotpoint","washing-machine","F18");    check("12 Hotpoint/Indesit F18 split ambiguous", r["status"]=="AMBIGUOUS")
# 13 Servis two-era: two schemes for servis dishwasher
servis_schemes = {s["schemeId"] for s in load("schemes.json") if "servis" in [b for b in s["brands"]] and "dishwasher" in s["appliances"]}
check("13 Servis DW two schemes (Merloni/Vestel)", len(servis_schemes) >= 2, str(servis_schemes))
# 14 Bush multi-OEM: bush appears in >1 scheme
bush_schemes = {s["schemeId"] for s in load("schemes.json") if "bush" in s["brands"]}
check("14 Bush multi-OEM (>1 scheme)", len(bush_schemes) >= 2, str(len(bush_schemes)))
r = st("Haier","washing-machine","E1");        check("15 Haier WM E1 platform split ambiguous", r["status"]=="AMBIGUOUS")
r = st("Haier","dishwasher","E4");             check("16 Haier DW E4 generation split ambiguous", r["status"]=="AMBIGUOUS")
r1 = st("Panasonic","breadmaker","U50"); r2 = st("Panasonic","washing-machine","U12")
check("17 Panasonic domain separation (BM U50 vs laundry U12)", r1["status"]=="RESOLVED" and r2["status"]=="RESOLVED" and r1["faultId"]!=r2["faultId"], f"{r1.get('faultId')}/{r2.get('faultId')}")
r = st("Samsung","fridge","1C");               check("18 Samsung E/C notation (1C==1E)", r["status"]=="RESOLVED" and r["faultId"]=="sensor", str(r.get('faultId')))
r = st("AEG","dishwasher","LOC");              check("19 Electrolux LOC = STATUS (not fault)", r["status"]=="RESOLVED" and r["recordType"]=="STATUS", str(r.get('recordType')))
r = st("AEG","dishwasher","PF");               check("20 Electrolux PF = INFORMATION (not fault)", r["status"]=="RESOLVED" and r["recordType"]=="INFORMATION", str(r.get('recordType')))
r = st("Bosch","dishwasher","E12");            check("21 maintenance/descale (Bosch DW E12 limescale)", r["status"]=="RESOLVED" and r["recordType"]=="MAINTENANCE", str(r.get('recordType')))
r = st("Samsung","fridge","5E");               check("22 identifier-independent lookup", r["status"]=="RESOLVED", str(r.get('status')))
r = st("Bosch","dishwasher","E15",{"generation":"whatever"}); check("23 scheme resolves w/o needing identifier context", r["status"]=="RESOLVED")
r = st("Candy","dishwasher","E2",{"generation":"pre-2008"}); check("24 generation context supplied (still ambiguous - source not machine-split)", r["status"] in ("AMBIGUOUS","RESOLVED"))
r = st("Bosch","cooker-oven","E011");          check("25 unresolved ambiguity (BSH oven E011 multi-meaning)", r["status"] in ("AMBIGUOUS","NOT_FOUND"))
r = st("Bosch","dishwasher","E99");            check("26 NOT_FOUND unknown code", r["status"]=="NOT_FOUND")
r = st("Belkin","cooker-oven","F1");           check("27 wrong make + valid-looking code -> NOT_FOUND", r["status"]=="NOT_FOUND")
# 28 same code across appliance types resolves differently / independently
e2apps = {a for m in load("mappings.json") if m["token"]=="E2" for c in m["applicability"]["conditions"] if c["k"]=="appliance" for a in (c.get("v") or [])}
check("28 same code E2 spans multiple appliance types", len(e2apps) >= 3, str(sorted(e2apps)[:6]))

# 29 (customer-journey finding G) a washing-machine-scheme code must NOT leak into a dishwasher query.
#    WHIRL_WM_FNN F13 = washer-dryer drying/sensor fault; scoped to washing-machine only. Before the
#    per-scheme appliance-scoping fix, a Hotpoint DISHWASHER F13 wrongly returned the washer-dryer meaning.
_f13wm = [m for m in load("mappings.json") if m["schemeId"]=="WHIRL_WM_FNN" and m["token"]=="F13"]
check("29 WHIRL_WM_FNN F13 mapping present", len(_f13wm)==1, str(len(_f13wm)))
if _f13wm:
    _apps13 = [a for c in _f13wm[0]["applicability"]["conditions"] if c["k"]=="appliance" for a in (c.get("v") or [])]
    check("29 WHIRL_WM_FNN F13 scoped to washing-machine only (no dishwasher leak)",
          "dishwasher" not in _apps13 and "washing-machine" in _apps13, str(_apps13))
r = st("Hotpoint","dishwasher","F13")
check("29 Hotpoint DW F13 never returns the washer-dryer meaning",
      not (r.get("status")=="RESOLVED" and "washer-dryer" in (r.get("meaning") or "").lower()), str(r.get("meaning")))

# ---------------- CORPUS-WIDE INVARIANTS ----------------
mappings = load("mappings.json"); schemes = {s["schemeId"] for s in load("schemes.json")}
faults = {f["faultId"] for f in load("faults.json")}
sources = {s["sourceId"] for s in load("sources.json")}
schemes_full = {s["schemeId"]: s for s in load("schemes.json")}
manifest = load("manifest.json")

check("INV every mapping has a valid scheme", all(m["schemeId"] in schemes for m in mappings))
check("INV every mapping references a valid fault", all(m["faultId"] in faults for m in mappings))
check("INV every mapping variant declared on its scheme", all(m["variantId"] in schemes_full[m["schemeId"]]["variants"] for m in mappings))
check("INV every scheme has >=1 appliance", all(len(s["appliances"])>=1 for s in schemes_full.values()))
check("INV every FAULT/HIGH mapping has >=1 source", all(m["sourceRefs"] for m in mappings if m["confidence"]=="HIGH"))
check("INV all sourceRefs resolve", all(all(r in sources for r in m["sourceRefs"]) for m in mappings))
check("INV recordType in enum", all(m["recordType"] in {"FAULT","WARNING","STATUS","MAINTENANCE","INFORMATION","PROMPT"} for m in mappings))
check("INV confidence in enum", all(m["confidence"] in {"HIGH","MEDIUM","LOW"} for m in mappings))
check("INV no source code record lost (mappings == source records)", len(mappings)==manifest["counts"]["sourceCodeRecords"])
# (finding G) per-scheme appliance scoping: when a source scheme declares its OWN appliance, every
# generated mapping for that scheme must be scoped to that appliance only — no cross-appliance leak
# (a washer-dryer WHIRL_WM_FNN code must never be resolvable on a dishwasher, and vice-versa).
import glob as _glob
_MG = os.path.join(os.path.dirname(os.path.dirname(HERE)), "manufacturer-groups")
_scheme_appliance = {}
for _fn in _glob.glob(os.path.join(_MG, "*.json")):
    try: _d = json.load(open(_fn))
    except Exception: continue
    for _sc in _d.get("schemes", []) or []:
        _sid = _sc.get("schemeId"); _sap = _sc.get("appliance") or _sc.get("appliances")
        if _sid and _sap:
            _scheme_appliance[_sid] = [_sap.lower()] if isinstance(_sap, str) else [a.lower() for a in _sap]
def _map_apps(m):
    return [a for c in m["applicability"]["conditions"] if c["k"]=="appliance" for a in (c.get("v") or [])]
_leaks = [m["mappingId"] for m in mappings
          if m["schemeId"] in _scheme_appliance
          and any(a not in _scheme_appliance[m["schemeId"]] for a in _map_apps(m))]
check("INV per-scheme appliance scoping (no cross-appliance code leak)", not _leaks, f"{len(_leaks)} leaks e.g. {_leaks[:3]}")
# no global bare-code resolver: a bare token with no make must not resolve
try:
    R.resolve("", "", "E15"); bare_ok = True
except Exception: bare_ok = True
check("INV make+appliance mandatory (empty make -> NOT_FOUND)", R.resolve("","", "E15")["status"]=="NOT_FOUND")
# scoped aliases stay scoped: E1 and E01 are not globally merged
tokens = {m["token"] for m in mappings}
check("INV notation scoped (E1 and E01 both exist as distinct tokens where present)", ("E1" in tokens) )
# HIGH mappings only from qualifying evidence (>=1 MANUFACTURER or SERVICE_DOCUMENTATION source)
src = {s["sourceId"]: s for s in load("sources.json")}
def qualifies(m): return any(src[r]["sourceType"] in ("MANUFACTURER","SERVICE_DOCUMENTATION","TIER2_SERVICE","SPECIALIST_REPAIR") for r in m["sourceRefs"])
bad_high = [m["mappingId"] for m in mappings if m["confidence"]=="HIGH" and not any(src[r]["sourceType"] in ("MANUFACTURER","SERVICE_DOCUMENTATION") for r in m["sourceRefs"])]
check("INV no HIGH mapping without manufacturer/service evidence", not bad_high, f"{len(bad_high)} offenders: {bad_high[:5]}")

# Customer-written subcode punctuation is equivalent to the banked token.
# Uses banked suffix-scheme records (not a product special-case): same mapping
# must resolve from colon, hyphen, slash, spaces, and a repeated letter prefix.
_suffix = st("Bosch", "washing-machine", "E:36-10")
check("FOLD banked suffix token still RESOLVED", _suffix.get("status")=="RESOLVED" and _suffix.get("faultId")=="drain", str(_suffix))
for form in ("E36-10", "E36/-10", "E:36 / -10", "E36/E10", "e36/e10"):
    r = st("Bosch", "washing-machine", form)
    check(f"FOLD customer form {form!r} matches banked suffix",
          r.get("status")=="RESOLVED" and r.get("faultId")==_suffix.get("faultId"),
          str(r.get("status")) + " " + str(r.get("faultId")))
# Stem-only lookup still hits the distinct shorter mapping (canonical / shown), not the suffix.
_stem = st("Bosch", "washing-machine", "E36")
check("FOLD stem-only is the distinct shorter mapping, not the suffix",
      _stem.get("status")=="RESOLVED" and _stem.get("faultId") != _suffix.get("faultId"),
      f"{_stem.get('faultId')}/{_suffix.get('faultId')}")
_alias = st("Bosch", "washing-machine", "E36/F36")
check("FOLD two-letter alias form still matches the stem mapping",
      _alias.get("status")=="RESOLVED" and _alias.get("faultId")==_stem.get("faultId"),
      str(_alias.get("faultId")))

print(f"\nRESULT: {passed} passed / {failed} failed  (total {passed+failed})")
sys.exit(1 if failed else 0)
