#!/usr/bin/env python3
"""Effective Error-Code catalogue — overlay merge, collisions, retire, last-good.

Offline. No LLM. Uses the banked mappings file plus in-memory overlay.
Run: python3 error-codes/mcp/tests/test_catalogue_effective.py
"""
import json, os, sys, copy
HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)
EC = os.path.dirname(MCP)
sys.path.insert(0, os.path.join(EC, "runtime-model", "compiler"))
sys.path.insert(0, MCP)
os.environ["LEARNING_BUCKET"] = ""
os.environ["ERROR_CODE_LAST_GOOD"] = ""

from catalogue_effective import (
    CatalogueError, empty_overlay, merge, validate_create, validate_patch,
    apply_create, apply_patch, apply_retire, apply_restore, apply_delete,
    collide, tok, fold,
)
from catalogue_store import CatalogueStore
from resolve import Resolver
from tools import ErrorCodeTools

RT = os.path.join(EC, "runtime-model", "generated", "runtime")
ENR = os.path.join(EC, "enrichment", "generated", "enrichment.json")
BASE = json.load(open(os.path.join(RT, "mappings.json")))
ENRICH = json.load(open(ENR))["records"]
SOURCES = {s["sourceId"]: s for s in json.load(open(os.path.join(RT, "sources.json")))}

passed = 0
failed = 0

def check(name, cond, detail=""):
    global passed, failed
    ok = bool(cond)
    passed += ok
    failed += (not ok)
    if not ok:
        print(f"  FAIL: {name} :: {detail}")

# --- baseline ---
snap = merge(BASE, ENRICH, empty_overlay(), SOURCES)
check("847 is shipped source-code records", snap["sourceCodeRecordCount"] == 847, snap["sourceCodeRecordCount"])
check("unique lookup keys last-wins mappingId", snap["baselineCount"] == 783, snap["baselineCount"])
check("baseline active unique keys", snap["effectiveActiveCount"] == 783, snap["effectiveActiveCount"])
check("baseline overlay none", snap["overlay"]["state"] == "none")
check("338 distinct display tokens among unique keys", len({r["code"] for r in snap["inspect"]}) == 338, len({r["code"] for r in snap["inspect"]}))

# --- create ---
body = {
    "appliance": "washing-machine", "brand": "hotpoint", "code": "ZZ99ADMIN",
    "meaning": "Synthetic admin test mapping. Not a real customer code.",
    "aliases": ["ZZ99-ADMIN"],
    "provenance": {"sourceType": "ADMIN_CURATED", "publisher": "ApplianceClinic admin"},
}
mapping, enr = validate_create(body, {r["appliances"][0] for r in snap["inspect"] if r["appliances"]}, snap)
ov = apply_create(empty_overlay(), mapping, enr)
snap2 = merge(BASE, ENRICH, ov, SOURCES)
check("admin create increases effective active", snap2["effectiveActiveCount"] == 784, snap2["effectiveActiveCount"])
check("admin mapping is active", any(r["mappingId"] == mapping["mappingId"] and r["status"] == "active" for r in snap2["inspect"]))

# duplicate
try:
    validate_create(body, set(a for r in snap2["inspect"] for a in r["appliances"]), snap2)
    check("duplicate rejected", False, "no error")
except CatalogueError as e:
    check("duplicate rejected", e.code == "duplicate", e.code)

# alias collision with the synthetic
body2 = dict(body)
body2["code"] = "OTHER99"
body2["aliases"] = ["ZZ99ADMIN"]
try:
    validate_create(body2, set(a for r in snap2["inspect"] for a in r["appliances"]), snap2)
    check("alias collision rejected", False)
except CatalogueError as e:
    check("alias collision rejected", e.code == "collision", e.code)

try:
    validate_create({**body, "appliance": "not-a-family", "code": "ZZ1"}, set(a for r in snap["inspect"] for a in r["appliances"]), snap)
    check("invalid family rejected", False)
except CatalogueError as e:
    check("invalid family rejected", e.code == "invalid_family", e.code)

try:
    validate_create({**body, "code": "ZZ2", "provenance": {"url": "javascript:alert(1)"}}, set(a for r in snap["inspect"] for a in r["appliances"]), snap)
    check("js url rejected", False)
except CatalogueError as e:
    check("malformed provenance rejected", e.code == "invalid_provenance", e.code)

try:
    validate_create({"appliance": "washing-machine", "brand": "hotpoint"}, set(a for r in snap["inspect"] for a in r["appliances"]), snap)
    check("missing required rejected", False)
except CatalogueError as e:
    check("missing required rejected", e.code == "invalid", e.code)

# --- live MCP lookup uses same effective mappings ---
store = CatalogueStore(BASE, ENRICH, SOURCES, loader=lambda: (ov, "active"), saver=lambda o: None, bucket="test", ttl_ms=0)
T = ErrorCodeTools(store=store)
r = T.resolve_error_code({"make": "Hotpoint", "appliance": "washing-machine", "code": "ZZ99ADMIN"})
check("MCP resolves admin-added record", r["status"] == "RESOLVED" and "Synthetic admin" in r["meaning"], r.get("status"))
r2 = T.resolve_error_code({"make": "Hotpoint", "appliance": "washing-machine", "code": "ZZ99-ADMIN"})
check("alias uses same MCP fold/token rules", r2["status"] == "RESOLVED", r2.get("status"))
r3 = T.resolve_error_code({"make": "Bosch", "appliance": "washing-machine", "code": "ZZ99ADMIN"})
check("admin record is brand-scoped not global", r3["status"] == "NOT_FOUND", r3.get("status"))

# --- edit content, not identity ---
shipped_id = "INDESIT_WM_F::default::F05"
shipped = [m for m in BASE if m["mappingId"] == shipped_id][0]
try:
    validate_patch({"mapping": shipped, "origin": "shipped", "status": "active"}, {"code": "E99"}, snap)
    check("shipped identity locked", False)
except CatalogueError as e:
    check("shipped identity locked", e.code == "identity_locked", e.code)

patch, _ = validate_patch(
    {"mapping": mapping, "origin": "admin", "status": "active"},
    {"meaning": "Edited synthetic meaning."},
    snap2,
)
ov3 = apply_patch(ov, mapping["mappingId"], "admin", patch, None, enr)
snap3 = merge(BASE, ENRICH, ov3, SOURCES)
T3 = ErrorCodeTools(store=CatalogueStore(BASE, ENRICH, SOURCES, loader=lambda: (ov3, "active"), saver=lambda o: None, bucket="test", ttl_ms=0))
re = T3.resolve_error_code({"make": "Hotpoint", "appliance": "washing-machine", "code": "ZZ99ADMIN"})
check("edit is resolved by MCP", re["status"] == "RESOLVED" and re["meaning"] == "Edited synthetic meaning.", re.get("meaning"))

# --- retire shipped ---
ov4 = apply_retire(empty_overlay(), shipped_id, "shipped", "test")
snap4 = merge(BASE, ENRICH, ov4, SOURCES)
check("retired shipped excluded from active", shipped_id not in snap4["active_mappings"])
check("retired shipped still inspectable", any(r["mappingId"] == shipped_id and r["status"] == "retired" for r in snap4["inspect"]))
T4 = ErrorCodeTools(store=CatalogueStore(BASE, ENRICH, SOURCES, loader=lambda: (ov4, "active"), saver=lambda o: None, bucket="test", ttl_ms=0))
rf = T4.resolve_error_code({"make": "Hotpoint", "appliance": "washing-machine", "code": "F05"})
check("retired shipped not actively resolved", rf["status"] != "RESOLVED" or rf.get("meaning") != shipped["meaning"], rf.get("status"))

ov5 = apply_restore(ov4, shipped_id, "shipped")
snap5 = merge(BASE, ENRICH, ov5, SOURCES)
check("restore returns shipped to active", shipped_id in snap5["active_mappings"])

try:
    apply_delete(empty_overlay(), shipped_id, "shipped", "active")
    check("shipped hard-delete forbidden", False)
except CatalogueError as e:
    check("shipped hard-delete forbidden", e.code == "forbidden", e.code)

ov6 = apply_delete(ov, mapping["mappingId"], "admin", "active")
snap6 = merge(BASE, ENRICH, ov6, SOURCES)
check("admin delete removes record", mapping["mappingId"] not in snap6["all_mappings"] and snap6["effectiveActiveCount"] == 783)

# --- overlay absent vs malformed vs last-good ---
st_none = CatalogueStore(BASE, ENRICH, SOURCES, loader=lambda: (empty_overlay(), "none"), saver=lambda o: None, bucket="", ttl_ms=0)
check("overlay absent = baseline", st_none.reload(True)["effectiveActiveCount"] == 783)

def boom():
    raise RuntimeError("s3-down")
st_fail = CatalogueStore(BASE, ENRICH, SOURCES, loader=boom, saver=lambda o: None, bucket="x", ttl_ms=0)
st_fail._last_good = ov4
st_fail._overlay = ov4
snap_lg = st_fail.reload(True)
check("unavailable uses last-good retired state", shipped_id not in snap_lg["active_mappings"] and snap_lg["overlay"]["state"] == "unavailable")

def bad():
    raise ValueError("malformed-overlay")
st_bad = CatalogueStore(BASE, ENRICH, SOURCES, loader=bad, saver=lambda o: None, bucket="x", ttl_ms=0)
snap_bad = st_bad.reload(True)
check("malformed overlay without last-good is baseline", snap_bad["effectiveActiveCount"] == 783 and snap_bad["overlay"]["state"] in ("malformed", "unavailable"))

# --- same normalisation as MCP ---
check("tok F05", tok("F05") == "F05")
check("fold E:18", fold("E:18") == "E18")
check("no fuzzy E1==E01 globally", tok("E1") != tok("E01"))
R = Resolver()
check("resolver injection does not change predicates", R._tok("F 05") == tok("F 05"))

# existing shipped still resolves through ErrorCodeTools with overlay none
T0 = ErrorCodeTools(store=CatalogueStore(BASE, ENRICH, SOURCES, loader=lambda: (empty_overlay(), "none"), saver=lambda o: None, bucket="", ttl_ms=0))
rb = T0.resolve_error_code({"make": "Bosch", "appliance": "dishwasher", "code": "E15"})
check("shipped Bosch E15 unchanged with empty overlay", rb["status"] == "RESOLVED" and "water" in (rb.get("meaning") or "").lower(), rb.get("meaning"))

print(f"\ncatalogue_effective: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
