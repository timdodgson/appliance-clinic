#!/usr/bin/env python3
"""Admin catalogue HTTP API — inspect the effective Error-Code catalogue and manage it safely.

Bearer-gated by the deployment wrapper (the BFF holds the bearer; Admin Cognito gates the BFF).
Deterministic. No LLM, no transcripts.

Live-diagnosis boundary (see catalogue_workflow.py):
  - create / save draft / discard draft  → write `draft` only; the Resolver never reads it
  - publish / rollback / archive / restore → change the live fields; publish and rollback append an
    immutable version in the same document write
Every write re-reads the overlay from S3, validates against that fresh state, checks the record
revision the client edited from, and writes conditionally on the S3 ETag (If-Match), retrying
only when a different record changed in between. A failed write changes nothing.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs

import catalogue_workflow as wf
from catalogue_effective import CatalogueError, inspect_detail
from catalogue_store import StoreUnavailable, WriteConflict

WRITE_RETRIES = 3


def _qs(scope):
    raw = (scope.get("query_string") or b"").decode("utf-8")
    out = {}
    for k, v in parse_qs(raw, keep_blank_values=True).items():
        out[k] = v[0] if v else ""
    return out


class CatalogueApi:
    def __init__(self, tools):
        self.tools = tools

    # ------------------------------------------------------------------ helpers
    def _snap(self, force=False):
        self.tools.ensure_catalogue(force=force)
        return self.tools.catalogue_snapshot()

    def _appliances(self, snap):
        s = set()
        for r in snap["inspect"]:
            if r.get("status") != "draft":
                s.update(r.get("appliances") or [])
        return sorted(s)

    def _brands(self, snap):
        s = set()
        for r in snap["inspect"]:
            if r.get("status") != "draft":
                s.update(r.get("brands") or [])
        return sorted(s)

    def _find(self, snap, mapping_id):
        if not mapping_id:
            raise CatalogueError("invalid", "id is required.")
        m = (snap.get("all_mappings") or snap.get("active_mappings") or {}).get(mapping_id)
        meta = (snap["meta"] or {}).get(mapping_id)
        if m is None and mapping_id in (snap.get("draft_mappings") or {}):
            return snap["draft_mappings"][mapping_id], meta or {"status": "draft", "origin": "admin"}
        if m is None:
            raise CatalogueError("not_found", "Error-code record not found.")
        return m, meta or {"status": "active", "origin": "shipped"}

    def _origin(self, snap, mapping_id):
        return ((snap.get("meta") or {}).get(mapping_id) or {}).get("origin") or (
            "admin" if mapping_id in (snap.get("draft_mappings") or {}) else "shipped")

    def _write(self, fn):
        """Load fresh (with ETag) → fn(overlay, snap) → conditional save. Returns fn's result."""
        store = self.tools.store
        for _ in range(WRITE_RETRIES):
            try:
                overlay, etag = store.load_for_write()
            except StoreUnavailable:
                raise CatalogueError("unavailable", "The Error Code store could not be read. Nothing was changed.")
            snap = store.snapshot_of(overlay)
            new_overlay, result = fn(overlay, snap)
            try:
                store.save(new_overlay, etag=etag, conditional=True)
            except WriteConflict:
                continue  # someone else wrote; re-validate on fresh state (revision checks still apply)
            except StoreUnavailable:
                raise CatalogueError("unavailable", "The Error Code store could not be written. Nothing was changed.")
            self.tools.ensure_catalogue(force=True)
            return result
        raise CatalogueError("conflict", "The Error Code store changed while saving. Please try again.")

    def _admin_view(self, snap, mapping_id):
        overlay = self.tools.store._overlay or {}
        rec = (overlay.get("records") or {}).get(mapping_id) or {}
        origin = self._origin(snap, mapping_id)
        m, meta = self._find(snap, mapping_id)
        status = meta.get("status") or "active"
        live_detail = None if status == "draft" else inspect_detail(m, meta, snap["enrichment"], self.tools.R.sources)
        draft_detail = None
        d = rec.get("draft")
        if d:
            base = (snap.get("baseline_by_id") or self.tools.store.baseline_by_id()).get(mapping_id)
            eff = wf.effective_of(origin, base, d.get("mapping")) if origin == "shipped" else d.get("mapping")
            if eff:
                from catalogue_effective import enr_key
                dmeta = dict(meta, status="draft" if status == "draft" else status)
                draft_detail = inspect_detail(eff, dmeta, {enr_key(eff): d.get("enrichment")} if d.get("enrichment") else {},
                                              self.tools.R.sources)
        ever = wf.ever_published(rec, origin)
        versions = wf.version_list(rec, origin)
        legacy = (not rec.get("versions")) and bool(rec.get("mapping") or rec.get("enrichment")) and origin == "admin"
        changed = []
        if d and live_detail and draft_detail:
            changed = wf.changed_fields(live_detail.get("raw"), _enr_of(live_detail), draft_detail.get("raw"), _enr_of(draft_detail))
        return {
            "mappingId": mapping_id,
            "origin": origin,
            "status": status,
            "revision": int(rec.get("revision") or 0),
            "currentVersion": wf.current_version(rec),
            "liveVersionLabel": ("v%d" % wf.current_version(rec)) if wf.current_version(rec) else (
                "Shipped baseline" if origin == "shipped" else ("Live (before version history)" if legacy else None)),
            "everPublished": ever,
            "draftPending": bool(d),
            "draftSavedAt": (d or {}).get("savedAt"),
            "draftSavedBy": (d or {}).get("savedBy"),
            "draft": draft_detail,
            "pendingChanges": changed,
            "versions": versions,
            "createdAt": rec.get("createdAt"), "createdBy": rec.get("createdBy"),
            "updatedAt": rec.get("updatedAt"), "updatedBy": rec.get("updatedBy"),
            "publishedAt": rec.get("publishedAt"), "publishedBy": rec.get("publishedBy"),
            "retiredAt": rec.get("retiredAt"), "retiredBy": rec.get("retiredBy"), "retiredReason": rec.get("retiredReason"),
            "canPublish": bool(d) and status != "retired",
            "canDelete": origin == "admin" and status == "draft" and not ever,
            "canDiscard": bool(d) and ever,
            "canArchive": ever and status == "active",
            "canRestore": status == "retired",
            "canRollback": ever and status == "active" and not d and len(versions) > 1,
        }

    def _record_response(self, mapping_id, extra=None):
        snap = self._snap(force=True)
        snap.setdefault("baseline_by_id", self.tools.store.baseline_by_id())
        m, meta = self._find(snap, mapping_id)
        view = self._admin_view(snap, mapping_id)
        detail = view["draft"] if meta.get("status") == "draft" else inspect_detail(m, meta, snap["enrichment"], self.tools.R.sources)
        detail = dict(detail or {}, status=meta.get("status"), origin=view["origin"])
        out = {"ok": True, "record": detail, "admin": view}
        if extra:
            out.update(extra)
        return out

    # ------------------------------------------------------------------ reads
    def list(self):
        snap = self._snap()
        return 200, {
            "ok": True,
            "terminology": {
                "sourceCodeRecords": "Shipped Dataset V1 source-code records (manifest count 847). Duplicate mappingIds are collapsed last-wins for lookup, matching Resolver.",
                "uniqueLookupKeys": "Unique mappingId keys in the Resolver lookup table.",
                "effectiveActiveCount": "Unique mapping keys that MCP will actively resolve after overlay merge (retired and drafts excluded).",
                "displayTokens": "Distinct displayed code tokens among active unique lookup keys. Not the same as 847.",
            },
            "sourceCodeRecordCount": snap.get("sourceCodeRecordCount"),
            "baselineMappingCount": snap.get("sourceCodeRecordCount"),
            "uniqueLookupCount": snap["baselineCount"],
            "effectiveActiveCount": snap["effectiveActiveCount"],
            "uniqueDisplayTokens": len({r.get("code") for r in snap["inspect"] if r.get("status") == "active"}),
            "overlay": snap["overlay"],
            "appliances": self._appliances(snap),
            "brands": self._brands(snap),
            "sourceTypes": sorted({t for r in snap["inspect"] for t in (r.get("sourceTypes") or [])}),
            "records": snap["inspect"],
        }

    def item(self, mapping_id, preview=False, make=None, appliance=None, code=None):
        out = self._record_response(mapping_id)
        detail = out["record"]
        if (preview or (make and appliance and code)) and detail.get("status") != "draft":
            mk = make or ((detail.get("brands") or [None])[0])
            ap = appliance or ((detail.get("appliances") or [None])[0])
            cd = code or detail.get("code")
            detail["mcpPreview"] = self.tools.resolve_error_code({
                "make": mk, "appliance": ap, "code": cd, "includeEnrichment": True,
            }) if mk and ap and cd else None
        else:
            detail["mcpPreview"] = None
        return 200, out

    def version(self, mapping_id, n):
        snap = self._snap()
        self._find(snap, mapping_id)
        rec = ((self.tools.store._overlay or {}).get("records") or {}).get(mapping_id) or {}
        origin = self._origin(snap, mapping_id)
        try:
            n = int(n)
        except (TypeError, ValueError):
            raise CatalogueError("invalid", "Invalid version.")
        base = self.tools.store.baseline_by_id().get(mapping_id)
        if n == 0:
            if origin != "shipped" or not base:
                raise CatalogueError("not_found", "This record has no shipped baseline.")
            from catalogue_effective import enr_key, index_enrichment
            enr = index_enrichment(self.tools.store.baseline_enrichment).get(enr_key(base))
            return 200, {"ok": True, "version": {"version": 0, "source": "baseline", "label": "Shipped baseline",
                                                 "record": inspect_detail(base, {"status": "active", "origin": "shipped"},
                                                                          {enr_key(base): enr} if enr else {}, self.tools.R.sources)}}
        hit = [v for v in (rec.get("versions") or []) if v.get("version") == n]
        if not hit:
            raise CatalogueError("not_found", "Version not found.")
        v = hit[0]
        eff = wf.effective_of(origin, base, v.get("mapping")) if origin == "shipped" else v.get("mapping")
        if eff is None and origin == "shipped":
            eff = base
        from catalogue_effective import enr_key
        enr = v.get("enrichment")
        meta = {k: v.get(k) for k in ("version", "publishedAt", "publishedBy", "note", "source", "rolledBackFrom", "changed")}
        meta["record"] = inspect_detail(eff, {"status": "active", "origin": origin}, {enr_key(eff): enr} if enr else {}, self.tools.R.sources)
        return 200, {"ok": True, "version": meta}

    # ------------------------------------------------------------------ writes
    def create(self, body):
        actor = (body or {}).get("actor")

        def fn(overlay, snap):
            new, mid = wf.create_draft(overlay, snap, set(self._appliances(snap)), body, actor)
            return new, mid
        mid = self._write(fn)
        return 201, self._record_response(mid)

    def patch(self, mapping_id, body):
        body = dict(body or {})
        actor = body.pop("actor", None)
        expected = body.pop("expectedRevision", None)

        def fn(overlay, snap):
            _m, meta = self._find(snap, mapping_id)
            origin = self._origin(snap, mapping_id)
            # Live fields are never touched here; for a never-published Admin draft the draft is edited.
            return wf.save_draft(overlay, snap, mapping_id, origin, meta.get("status"), body, expected, actor), None
        self._write(fn)
        return 200, self._record_response(mapping_id)

    def delete(self, mapping_id, body=None):
        body = body or {}

        def fn(overlay, snap):
            self._find(snap, mapping_id)
            origin = self._origin(snap, mapping_id)
            return wf.discard_or_delete(overlay, mapping_id, origin, body.get("expectedRevision"), body.get("actor"))
        deleted = self._write(fn)
        if deleted:
            return 200, {"ok": True, "deleted": mapping_id}
        return 200, self._record_response(mapping_id)

    def publish(self, mapping_id, body=None):
        body = body or {}

        def fn(overlay, snap):
            self._find(snap, mapping_id)
            origin = self._origin(snap, mapping_id)
            return wf.publish(overlay, snap, mapping_id, origin, body.get("expectedRevision"), body.get("note"), body.get("actor"))
        n = self._write(fn)
        return 200, self._record_response(mapping_id, {"published": {"version": n}})

    def rollback(self, mapping_id, body=None):
        body = body or {}

        def fn(overlay, snap):
            self._find(snap, mapping_id)
            origin = self._origin(snap, mapping_id)
            return wf.rollback(overlay, snap, mapping_id, origin, body.get("expectedRevision"),
                               body.get("toVersion"), body.get("note"), body.get("actor"))
        n = self._write(fn)
        return 200, self._record_response(mapping_id, {"published": {"version": n, "rolledBackFrom": body.get("toVersion")}})

    def retire(self, mapping_id, body=None):
        body = body or {}

        def fn(overlay, snap):
            self._find(snap, mapping_id)
            origin = self._origin(snap, mapping_id)
            return wf.archive(overlay, mapping_id, origin, body.get("expectedRevision"), body.get("reason"), body.get("actor")), None
        self._write(fn)
        return 200, self._record_response(mapping_id)

    def restore(self, mapping_id, body=None):
        body = body or {}
        from catalogue_effective import collide

        def fn(overlay, snap):
            m, _meta = self._find(snap, mapping_id)
            origin = self._origin(snap, mapping_id)
            hits = collide(snap.get("active_mappings") or {}, m, ignore_id=mapping_id)
            if hits:
                raise CatalogueError("collision", "Restore would collide with another active record.", {"conflicts": hits})
            return wf.restore(overlay, mapping_id, origin, body.get("expectedRevision"), body.get("actor")), None
        self._write(fn)
        return 200, self._record_response(mapping_id)

    def preview(self, body):
        body = body or {}
        make = body.get("make") or body.get("brand")
        appliance = body.get("appliance")
        code = body.get("code")
        if not make or not appliance or not code:
            raise CatalogueError("invalid", "Preview requires make, appliance and code.")
        self.tools.ensure_catalogue()
        return 200, {"ok": True, "result": self.tools.resolve_error_code({
            "make": make, "appliance": appliance, "code": code, "includeEnrichment": True,
        })}

    async def handle(self, scope, receive):
        method = (scope.get("method") or "GET").upper()
        path = scope.get("path") or ""
        qs = _qs(scope)
        body = {}
        if method in ("POST", "PATCH", "PUT", "DELETE"):
            chunks = []
            while True:
                msg = await receive()
                chunks.append(msg.get("body") or b"")
                if not msg.get("more_body"):
                    break
            raw = b"".join(chunks)
            if raw:
                try:
                    body = json.loads(raw.decode("utf-8") or "{}")
                except Exception:
                    return 400, {"error": "invalid JSON"}
                if not isinstance(body, dict):
                    return 400, {"error": "invalid JSON"}
        try:
            if path == "/catalogue" and method == "GET":
                return self.list()
            if path == "/catalogue" and method == "POST":
                return self.create(body)
            if path == "/catalogue/preview" and method == "POST":
                return self.preview(body)
            if path == "/catalogue/item" and method == "GET":
                return self.item(qs.get("id"), preview=qs.get("preview") in ("1", "true"),
                                 make=qs.get("make"), appliance=qs.get("appliance"), code=qs.get("code"))
            if path == "/catalogue/item" and method == "PATCH":
                return self.patch(qs.get("id"), body)
            if path == "/catalogue/item" and method == "DELETE":
                return self.delete(qs.get("id"), body)
            if path == "/catalogue/item/version" and method == "GET":
                return self.version(qs.get("id"), qs.get("v"))
            if path == "/catalogue/item/publish" and method == "POST":
                return self.publish(qs.get("id"), body)
            if path == "/catalogue/item/rollback" and method == "POST":
                return self.rollback(qs.get("id"), body)
            if path == "/catalogue/item/retire" and method == "POST":
                return self.retire(qs.get("id"), body)
            if path == "/catalogue/item/restore" and method == "POST":
                return self.restore(qs.get("id"), body)
            return 404, {"error": "not found"}
        except CatalogueError as e:
            status = 503 if e.code == "unavailable" else e.status
            return status, {"ok": False, "error": e.code, "message": e.message, **e.extra}


def _enr_of(detail):
    if not detail:
        return None
    dh = detail.get("diagnosticHints") or {}
    return {
        "diagnosticHints": {k: dh.get(k) for k in ("components", "likelyCauses", "checks")} if dh else None,
        "safety": detail.get("safety"),
    }
