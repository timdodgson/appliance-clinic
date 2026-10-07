#!/usr/bin/env python3
"""Error-Code Admin workflow: draft → publish boundary, immutable versions, rollback, archive,
hard delete only for never-published drafts, validation, optimistic concurrency, and the live
Resolver boundary. Offline. Drives the real CatalogueApi over an in-memory store with ETag semantics.
Run: python3 error-codes/mcp/tests/test_catalogue_workflow.py
"""
import asyncio, json, os, sys, copy
HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)
EC = os.path.dirname(MCP)
sys.path.insert(0, os.path.join(EC, "runtime-model", "compiler"))
sys.path.insert(0, MCP)
os.environ["LEARNING_BUCKET"] = ""
os.environ["ERROR_CODE_LAST_GOOD"] = ""
from catalogue_effective import empty_overlay
from catalogue_store import CatalogueStore, WriteConflict
from catalogue_api import CatalogueApi
from tools import ErrorCodeTools

RT = os.path.join(EC, "runtime-model", "generated", "runtime")
BASE = json.load(open(os.path.join(RT, "mappings.json")))
ENRICH = json.load(open(os.path.join(EC, "enrichment", "generated", "enrichment.json")))["records"]
SOURCES = {s["sourceId"]: s for s in json.load(open(os.path.join(RT, "sources.json")))}
passed = failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
    else:
        failed += 1
        print(f"  FAIL: {name} :: {detail}")


class MemS3:
    """state.json with a real ETag: conditional saves fail when the ETag moved on."""
    def __init__(self):
        self.doc = None
        self.etag = None
        self.n = 0
        self.writes = 0
        self.race = None  # optional callable run just before the next conditional save

    def loader(self):
        if self.doc is None:
            return empty_overlay(), "none", None
        return json.loads(self.doc), "active", self.etag

    def saver(self, overlay, etag=None):
        if self.race:
            r, self.race = self.race, None
            r()
        if self.doc is not None and etag != self.etag:
            raise WriteConflict("PreconditionFailed")
        if self.doc is None and etag is not None:
            raise WriteConflict("PreconditionFailed")
        self.doc = json.dumps(overlay)
        self.n += 1
        self.etag = '"e%d"' % self.n
        self.writes += 1

    def state(self):
        return json.loads(self.doc) if self.doc else empty_overlay()


def setup():
    s3 = MemS3()
    store = CatalogueStore(BASE, ENRICH, SOURCES, loader=s3.loader, saver=s3.saver, bucket="test", ttl_ms=0)
    tools = ErrorCodeTools(store=store)
    return s3, tools, CatalogueApi(tools)


def call(api, method, path, body=None, qs=""):
    raw = json.dumps(body).encode() if body is not None else b""

    async def receive():
        return {"body": raw, "more_body": False}
    scope = {"method": method, "path": path, "query_string": qs.encode()}
    return asyncio.run(api.handle(scope, receive))


def resolve(tools, make, appliance, code):
    tools.ensure_catalogue(force=True)
    return tools.resolve_error_code({"make": make, "appliance": appliance, "code": code})


NEW = {"appliance": "washing-machine", "brand": "Hotpoint", "code": "ZZ98WF", "meaning": "Synthetic workflow test meaning.",
       "aliases": ["ZZ98-WF"], "diagnosticHints": {"components": ["test part"], "likelyCauses": ["test cause"], "checks": ["test check"]},
       "provenance": {"sourceType": "ADMIN_CURATED", "publisher": "Test", "reference": "workflow"}, "actor": "admin@example.test"}
NEW_ID = "ADMIN::washing-machine::hotpoint::ZZ98WF"

# ------------------------------------------------------------------ CREATE → draft, no live effect
s3, tools, api = setup()
st, body = call(api, "POST", "/catalogue", NEW)
check("create returns 201", st == 201, (st, body))
check("create makes a never-published draft", body["record"]["status"] == "draft" and body["admin"]["everPublished"] is False, body.get("admin"))
check("draft revision 1, no versions", body["admin"]["revision"] == 1 and body["admin"]["versions"] == [], body["admin"])
check("draft is not resolvable by the live engine", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF")["status"] == "NOT_FOUND")
st, lst = call(api, "GET", "/catalogue")
row = [r for r in lst["records"] if r["mappingId"] == NEW_ID]
check("draft listed for Admin with status draft", row and row[0]["status"] == "draft", row)
check("drafts excluded from effective active count", lst["effectiveActiveCount"] == 783, lst["effectiveActiveCount"])
st, dup = call(api, "POST", "/catalogue", NEW)
check("duplicate identity rejected (draft exists)", st == 409 and dup["error"] == "duplicate", (st, dup))
bad = dict(NEW, code="")
st, b = call(api, "POST", "/catalogue", bad)
check("create without code rejected", st == 400 and b["error"] == "invalid", b)
st, b = call(api, "POST", "/catalogue", dict(NEW, code="ZZ97", appliance="toaster-oven-x"))
check("create with unknown appliance rejected", st == 400 and b["error"] == "invalid_family", b)
st, b = call(api, "POST", "/catalogue", dict(NEW, code="ZZ96", provenance={"url": "javascript:alert(1)"}))
check("create with unsafe URL rejected", st == 400 and b["error"] == "invalid_provenance", b)
st, b = call(api, "POST", "/catalogue", dict(NEW, code="ZZ95", safety={"class": "STOP_USE", "stopUse": True}))
check("STOP_USE without reason rejected", st == 400 and b["error"] == "invalid", b)
st, b = call(api, "POST", "/catalogue", dict(NEW, code="F05"))
check("create colliding with an active shipped code rejected", st == 409 and b["error"] == "collision", b)

# edit the never-published draft (still not live)
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": 1, "meaning": "Synthetic workflow meaning v1.", "actor": "a@x"}, "id=" + NEW_ID)
check("save draft on new record", st == 200 and e["record"]["meaning"] == "Synthetic workflow meaning v1." and e["admin"]["revision"] == 2, (st, e.get("admin")))
check("still not live after saving the draft", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF")["status"] == "NOT_FOUND")
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": 1, "meaning": "stale"}, "id=" + NEW_ID)
check("stale revision rejected (409 conflict)", st == 409 and e["error"] == "conflict" and e["revision"] == 2, (st, e))
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": 2, "code": "ZZ00"}, "id=" + NEW_ID)
check("identity cannot be edited", st == 400 and e["error"] == "identity_locked", e)
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": 2, "meaning": "  "}, "id=" + NEW_ID)
check("blank meaning rejected on save", st == 400 and e["error"] == "invalid", e)

# ------------------------------------------------------------------ PUBLISH → live, v1
st, p = call(api, "POST", "/catalogue/item/publish", {"expectedRevision": 2, "note": "first", "actor": "pub@x"}, "id=" + NEW_ID)
check("publish succeeds", st == 200 and p["published"]["version"] == 1, (st, p))
check("published record is active, v1 live, draft cleared", p["record"]["status"] == "active" and p["admin"]["currentVersion"] == 1 and not p["admin"]["draftPending"], p["admin"])
check("version metadata: author + note", p["admin"]["versions"][0]["publishedBy"] == "pub@x" and p["admin"]["versions"][0]["note"] == "first", p["admin"]["versions"])
r = resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF")
check("live engine resolves the published record", r["status"] == "RESOLVED" and r.get("meaning") == "Synthetic workflow meaning v1.", r)
check("alias resolves with the same lookup rules", resolve(tools, "Hotpoint", "washing-machine", "ZZ98-WF")["status"] == "RESOLVED")
rev = p["admin"]["revision"]
st, e = call(api, "POST", "/catalogue/item/publish", {"expectedRevision": rev}, "id=" + NEW_ID)
check("publish without a draft rejected", st == 409 and e["error"] == "no_draft", e)

# edit live → draft → live unchanged → publish v2
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": rev, "meaning": "Synthetic workflow meaning v2.", "diagnosticHints": {"checks": ["v2 check"]}}, "id=" + NEW_ID)
check("edit of a live record saves a draft", st == 200 and e["admin"]["draftPending"] and e["admin"]["draft"]["meaning"] == "Synthetic workflow meaning v2.", e.get("admin"))
check("Admin record view still shows the live content", e["record"]["meaning"] == "Synthetic workflow meaning v1.", e["record"]["meaning"])
check("pending changes listed", "meaning" in e["admin"]["pendingChanges"] and "diagnosticHints" in e["admin"]["pendingChanges"], e["admin"]["pendingChanges"])
check("live engine unchanged by the draft", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF").get("meaning") == "Synthetic workflow meaning v1.")
v1_snapshot = copy.deepcopy([v for v in s3.state()["records"][NEW_ID]["versions"] if v["version"] == 1][0])
st, p = call(api, "POST", "/catalogue/item/publish", {"expectedRevision": e["admin"]["revision"], "note": "second"}, "id=" + NEW_ID)
check("publish v2", st == 200 and p["published"]["version"] == 2 and p["admin"]["currentVersion"] == 2, p.get("admin"))
check("live engine now returns v2", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF").get("meaning") == "Synthetic workflow meaning v2.")
v1_after = [v for v in s3.state()["records"][NEW_ID]["versions"] if v["version"] == 1][0]
check("v1 is immutable after publishing v2", v1_after == v1_snapshot)

# ------------------------------------------------------------------ ROLLBACK → v3 with v1 content
st, rb = call(api, "POST", "/catalogue/item/rollback", {"expectedRevision": p["admin"]["revision"], "toVersion": 1, "note": "undo"}, "id=" + NEW_ID)
check("rollback creates v3", st == 200 and rb["published"]["version"] == 3 and rb["admin"]["currentVersion"] == 3, (st, rb.get("admin")))
vs = rb["admin"]["versions"]
check("history v3 (rollback from v1), v2, v1", [v["version"] for v in vs] == [3, 2, 1] and vs[0]["source"] == "rollback" and vs[0]["rolledBackFrom"] == 1, vs)
check("live engine back to v1 content", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF").get("meaning") == "Synthetic workflow meaning v1.")
check("v1 and v2 untouched by rollback", [v for v in s3.state()["records"][NEW_ID]["versions"] if v["version"] == 1][0] == v1_snapshot)
st, v = call(api, "GET", "/catalogue/item/version", None, "id=" + NEW_ID + "&v=2")
check("old version readable", st == 200 and v["version"]["record"]["meaning"] == "Synthetic workflow meaning v2.", v)
rev = rb["admin"]["revision"]
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": rev, "meaning": "pending"}, "id=" + NEW_ID)
st, e2 = call(api, "POST", "/catalogue/item/rollback", {"expectedRevision": e["admin"]["revision"], "toVersion": 2}, "id=" + NEW_ID)
check("rollback blocked while a draft is pending", st == 409 and e2["error"] == "draft_pending", e2)
st, d = call(api, "DELETE", "/catalogue/item", {"expectedRevision": e["admin"]["revision"]}, "id=" + NEW_ID)
check("DELETE on a published record only discards the draft", st == 200 and "deleted" not in d and not d["admin"]["draftPending"] and d["record"]["status"] == "active", d)
rev = d["admin"]["revision"]
st, e = call(api, "DELETE", "/catalogue/item", {"expectedRevision": rev}, "id=" + NEW_ID)
check("published record cannot be hard deleted", st == 409 and e["error"] == "invalid_state", e)

# ------------------------------------------------------------------ ARCHIVE / RESTORE
st, a = call(api, "POST", "/catalogue/item/retire", {"expectedRevision": rev, "reason": "test"}, "id=" + NEW_ID)
check("archive", st == 200 and a["record"]["status"] == "retired", a.get("record", {}).get("status"))
check("archived record not resolved", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF")["status"] == "NOT_FOUND")
check("archived record keeps history", [v["version"] for v in a["admin"]["versions"]] == [3, 2, 1])
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": a["admin"]["revision"], "meaning": "x"}, "id=" + NEW_ID)
check("archived record cannot be edited", st == 409 and e["error"] == "invalid_state", e)
st, rs = call(api, "POST", "/catalogue/item/restore", {"expectedRevision": a["admin"]["revision"]}, "id=" + NEW_ID)
check("restore", st == 200 and rs["record"]["status"] == "active", rs.get("record", {}).get("status"))
check("restored record resolves its current version again", resolve(tools, "Hotpoint", "washing-machine", "ZZ98WF").get("meaning") == "Synthetic workflow meaning v1.")
st, e = call(api, "POST", "/catalogue/item/retire", {"expectedRevision": 0}, "id=" + NEW_ID)
check("stale archive rejected", st == 409 and e["error"] == "conflict", e)

# ------------------------------------------------------------------ DELETE only for never-published drafts
st, c = call(api, "POST", "/catalogue", dict(NEW, code="ZZ94WF", aliases=[]))
mid2 = c["record"]["mappingId"]
st, e = call(api, "POST", "/catalogue/item/retire", {"expectedRevision": 1}, "id=" + mid2)
check("never-published draft cannot be archived", st == 409 and e["error"] == "invalid_state", e)
st, d = call(api, "DELETE", "/catalogue/item", {"expectedRevision": 1}, "id=" + mid2)
check("never-published draft hard-deletes", st == 200 and d.get("deleted") == mid2, d)
check("deleted draft gone from the store", mid2 not in s3.state()["records"])

# ------------------------------------------------------------------ SHIPPED record: draft, publish, rollback to baseline
shipped = [m for m in BASE if m.get("token") == "F05" and "hotpoint" in json.dumps(m.get("applicability")).lower()][-1]
sid = shipped["mappingId"]
base_r = resolve(tools, "Hotpoint", "washing-machine", "F05")
st, e = call(api, "PATCH", "/catalogue/item", {"expectedRevision": 0, "applicabilityNote": "Test note for workflow."}, "id=" + sid)
check("shipped record edit → draft", st == 200 and e["admin"]["draftPending"] and e["admin"]["origin"] == "shipped", e.get("admin"))
check("shipped record live unchanged by draft", resolve(tools, "Hotpoint", "washing-machine", "F05") == base_r)
st, e2 = call(api, "PATCH", "/catalogue/item", {"expectedRevision": e["admin"]["revision"], "brand": "Bosch"}, "id=" + sid)
check("shipped identity locked", st == 400 and e2["error"] == "identity_locked", e2)
st, p = call(api, "POST", "/catalogue/item/publish", {"expectedRevision": e["admin"]["revision"]}, "id=" + sid)
check("shipped publish → v1", st == 200 and p["admin"]["currentVersion"] == 1, p.get("admin"))
check("shipped history has v1 + baseline v0", [v["version"] for v in p["admin"]["versions"]] == [1, 0], p["admin"]["versions"])
check("shipped publish keeps meaning/identity (only the note changed)", p["record"]["meaning"] == shipped["meaning"] and p["record"]["applicabilityNote"] == "Test note for workflow.")
st, rb = call(api, "POST", "/catalogue/item/rollback", {"expectedRevision": p["admin"]["revision"], "toVersion": 0}, "id=" + sid)
check("rollback to shipped baseline → v2", st == 200 and rb["admin"]["currentVersion"] == 2 and rb["admin"]["versions"][0]["rolledBackFrom"] == 0, rb.get("admin"))
check("engine output identical to the untouched baseline after rollback", resolve(tools, "Hotpoint", "washing-machine", "F05") == base_r)
st, e = call(api, "DELETE", "/catalogue/item", {"expectedRevision": rb["admin"]["revision"]}, "id=" + sid)
check("shipped record never hard-deleted", st == 409, e)

# ------------------------------------------------------------------ CONCURRENCY at the store level
s3b, toolsb, apib = setup()
st, c = call(apib, "POST", "/catalogue", NEW)


def other_writer():
    # A different admin creates another draft between our read and our write.
    doc = s3b.state()
    doc["records"]["ADMIN::washing-machine::hotpoint::ZZ93OTHER"] = {"origin": "admin", "status": "draft", "revision": 1,
        "draft": {"mapping": dict(c["record"]["raw"], mappingId="ADMIN::washing-machine::hotpoint::ZZ93OTHER", token="ZZ93OTHER", shown=["ZZ93OTHER"]), "enrichment": None}}
    s3b.doc = json.dumps(doc); s3b.n += 1; s3b.etag = '"e%d"' % s3b.n
s3b.race = other_writer
st, e = call(apib, "PATCH", "/catalogue/item", {"expectedRevision": 1, "meaning": "mine"}, "id=" + NEW_ID)
recs = s3b.state()["records"]
check("ETag conflict on another record → retried on fresh state, both changes kept",
      st == 200 and recs[NEW_ID]["draft"]["mapping"]["meaning"] == "mine" and "ADMIN::washing-machine::hotpoint::ZZ93OTHER" in recs, (st, e))


def same_record_writer():
    doc = s3b.state()
    doc["records"][NEW_ID]["revision"] = 99
    s3b.doc = json.dumps(doc); s3b.n += 1; s3b.etag = '"e%d"' % s3b.n
s3b.race = same_record_writer
st, e = call(apib, "PATCH", "/catalogue/item", {"expectedRevision": 2, "meaning": "theirs?"}, "id=" + NEW_ID)
check("concurrent edit of the same record → 409, nothing overwritten", st == 409 and e["error"] == "conflict"
      and s3b.state()["records"][NEW_ID]["draft"]["mapping"]["meaning"] == "mine", (st, e))

# ------------------------------------------------------------------ failed write leaves live intact
s3c, toolsc, apic = setup()
st, c = call(apic, "POST", "/catalogue", NEW)
st, p = call(apic, "POST", "/catalogue/item/publish", {"expectedRevision": 1}, "id=" + NEW_ID)
before = s3c.doc


def broken(overlay, etag=None):
    from catalogue_store import StoreUnavailable
    raise StoreUnavailable("s3 down")
toolsc.store._saver = broken
st, e = call(apic, "PATCH", "/catalogue/item", {"expectedRevision": p["admin"]["revision"], "meaning": "never"}, "id=" + NEW_ID)
check("store failure → 503, nothing changed", st == 503 and s3c.doc == before, (st, e))
check("live engine still on the published version", resolve(toolsc, "Hotpoint", "washing-machine", "ZZ98WF").get("meaning") == "Synthetic workflow test meaning.")

# ------------------------------------------------------------------ legacy overlay records stay compatible
legacy = empty_overlay()
legacy["records"][NEW_ID] = {"origin": "admin", "status": "active", "mapping": json.loads(json.dumps(c["record"]["raw"])), "enrichment": None}
s3d = MemS3(); s3d.doc = json.dumps(legacy); s3d.etag = '"L1"'; s3d.n = 1
toolsd = ErrorCodeTools(store=CatalogueStore(BASE, ENRICH, SOURCES, loader=s3d.loader, saver=s3d.saver, bucket="test", ttl_ms=0))
apid = CatalogueApi(toolsd)
check("pre-existing live Admin record (no revision) still resolves", resolve(toolsd, "Hotpoint", "washing-machine", "ZZ98WF")["status"] == "RESOLVED")
st, it = call(apid, "GET", "/catalogue/item", None, "id=" + NEW_ID)
check("legacy record shows as ever-published, revision 0", it["admin"]["everPublished"] and it["admin"]["revision"] == 0 and it["admin"]["canArchive"], it["admin"])
st, e = call(apid, "PATCH", "/catalogue/item", {"expectedRevision": 0, "meaning": "Edited legacy."}, "id=" + NEW_ID)
st, p = call(apid, "POST", "/catalogue/item/publish", {"expectedRevision": e["admin"]["revision"]}, "id=" + NEW_ID)
check("first publish keeps the legacy live content as v1, new content v2", [v["version"] for v in p["admin"]["versions"]] == [2, 1]
      and p["admin"]["versions"][1]["source"] == "legacy", p["admin"]["versions"])

# ------------------------------------------------------------------ unchanged data → unchanged lookup
s3e, toolse, _ = setup()
fresh = ErrorCodeTools(store=CatalogueStore(BASE, ENRICH, SOURCES, loader=lambda: (empty_overlay(), "none"), saver=lambda o: None, bucket="", ttl_ms=0))
for make, app, code in [("Bosch", "washing-machine", "E15"), ("Hotpoint", "washing-machine", "F05"), ("Samsung", "washing-machine", "4C")]:
    check("lookup unchanged for unchanged data: %s %s" % (make, code),
          resolve(toolse, make, app, code) == resolve(fresh, make, app, code))

# ------------------------------------------------------------------ "changed" summary compares EFFECTIVE content
s3c, toolsc, apic = setup()
SID = "ELX_WM_EXX::default::E40"
st, e = call(apic, "PATCH", "/catalogue/item", {"expectedRevision": 0, "meaning": "Changed-summary test meaning."}, "id=" + SID)
check("shipped meaning-only draft pending change is just meaning", e["admin"]["pendingChanges"] == ["meaning"], e["admin"].get("pendingChanges"))
st, e = call(apic, "POST", "/catalogue/item/publish", {"expectedRevision": e["admin"]["revision"]}, "id=" + SID)
v1 = [v for v in e["admin"]["versions"] if v["version"] == 1][0]
check("publish of a meaning-only edit records only meaning as changed", v1["changed"] == ["meaning"], v1.get("changed"))
st, e = call(apic, "POST", "/catalogue/item/rollback", {"expectedRevision": e["admin"]["revision"], "toVersion": 0}, "id=" + SID)
v2 = [v for v in e["admin"]["versions"] if v["version"] == 2][0]
check("rollback to baseline records only meaning as changed", v2["changed"] == ["meaning"], v2.get("changed"))
check("rollback to baseline restores shipped meaning", e["record"]["meaning"] == "Door lock / door not locked", e["record"].get("meaning"))

print(f"\ncatalogue_workflow: {passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
