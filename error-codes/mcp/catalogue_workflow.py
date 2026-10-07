#!/usr/bin/env python3
"""Error-Code Admin workflow: drafts, explicit publish, append-only versions, rollback, archive.

Pure functions over the existing overlay document (error-code-admin/state.json). No I/O.

Per overlay record (keyed by mappingId), in addition to the live fields merge() already reads
(origin, status, mapping, enrichment):

  revision        int, bumped on every Admin change to the record (optimistic concurrency)
  draft           {mapping, enrichment, savedAt, savedBy, baseVersion} | None — NEVER read by merge()
  versions        append-only list of published versions:
                  {version, publishedAt, publishedBy, note, source, rolledBackFrom, changed,
                   mapping, enrichment}
  currentVersion  version number that is live (0 = shipped baseline, for shipped records)

Live diagnosis only ever sees `mapping` / `enrichment` / `status` (via merge()). Saving a draft
writes `draft` only. Publishing copies the draft into the live fields and appends a version in the
same document write, so a publish either lands completely or not at all.

For an Admin-created record, `mapping` is the full mapping. For a shipped record it is the content
patch merge() applies over the shipped baseline (identity is never editable). `status == "draft"`
marks an Admin-created record that has never been published; merge() keeps it out of the Resolver.
"""
from __future__ import annotations

from catalogue_effective import (
    ALLOWED_CONFIDENCE, ALLOWED_RECORD_TYPES, ALLOWED_SAFETY, CONTENT_FIELDS, CatalogueError,
    _overlay_content, clone, collide, record_action, utcnow, validate_create, validate_patch,
    validate_url,
)

NOTE_MAX = 300


def _actor(a):
    s = str(a or "").strip()
    return s[:200] if s else "admin"


def _note(n):
    s = str(n or "").strip()
    return s[:NOTE_MAX] or None


def _check_revision(rec, expected):
    have = int((rec or {}).get("revision") or 0)
    try:
        exp = int(expected)
    except (TypeError, ValueError):
        exp = None
    if exp is None or exp != have:
        raise CatalogueError("conflict", "This record was changed by someone else. Reload to see the latest version.",
                             {"revision": have})


def _versions(rec):
    return list((rec or {}).get("versions") or [])


def current_version(rec):
    v = _versions(rec)
    if (rec or {}).get("currentVersion") is not None:
        return int(rec["currentVersion"])
    return v[-1]["version"] if v else 0


def ever_published(rec, origin):
    """Shipped records are live from the baseline; Admin records once they have been live."""
    if origin == "shipped":
        return True
    rec = rec or {}
    if _versions(rec):
        return True
    return rec.get("status") in ("active", "retired") and bool(rec.get("mapping"))


def _ensure_rec(overlay, mapping_id, origin):
    overlay.setdefault("records", {})
    rec = overlay["records"].get(mapping_id)
    if rec is None:
        rec = {"origin": origin, "status": "active", "revision": 0}
        overlay["records"][mapping_id] = rec
    return rec


def _touch(overlay, rec, action, mapping_id, actor):
    now = utcnow()
    rec["revision"] = int(rec.get("revision") or 0) + 1
    rec["updatedAt"] = now
    rec["updatedBy"] = _actor(actor)
    overlay["updatedAt"] = now
    record_action(overlay, {"type": action, "id": mapping_id, "at": now})


def effective_of(origin, baseline_mapping, mapping_part):
    """The mapping a version / draft resolves to (what Resolver would see)."""
    if origin == "admin":
        return clone(mapping_part) if mapping_part else None
    return _overlay_content(baseline_mapping, mapping_part or {})


def changed_fields(before_m, before_e, after_m, after_e):
    out = []
    for k in CONTENT_FIELDS + ("provenance",):
        if (before_m or {}).get(k) != (after_m or {}).get(k):
            out.append(k)
    for k in ("diagnosticHints", "safety"):
        if (before_e or {}).get(k) != (after_e or {}).get(k):
            out.append(k)
    return out


# ------------------------------------------------------------------------- drafts
def create_draft(overlay, snap, appliances, body, actor):
    """New Admin record → a DRAFT. Nothing becomes live until publish."""
    mapping, enrichment = validate_create(body, appliances, snap)
    overlay = clone(overlay)
    overlay.setdefault("records", {})
    mid = mapping["mappingId"]
    if mid in overlay["records"]:
        raise CatalogueError("duplicate", "A record with this canonical key already exists.", {"mappingId": mid})
    now = utcnow()
    rec = {
        "origin": "admin", "status": "draft", "revision": 0, "versions": [], "currentVersion": 0,
        "createdAt": now, "createdBy": _actor(actor),
        "draft": {"mapping": mapping, "enrichment": enrichment, "savedAt": now, "savedBy": _actor(actor), "baseVersion": 0},
    }
    overlay["records"][mid] = rec
    _touch(overlay, rec, "create-draft", mid, actor)
    return overlay, mid


def _working(rec, origin, snap, mapping_id):
    """(mapping_part, enrichment, effective_mapping) the next draft edit starts from."""
    base_m = _baseline(snap, mapping_id, origin)
    if rec and rec.get("draft"):
        part = clone(rec["draft"].get("mapping") or {})
        enr = clone(rec["draft"].get("enrichment"))
        eff = effective_of(origin, base_m, part) if origin == "shipped" else clone(part)
        return part, enr, eff
    live_m = (snap.get("all_mappings") or {}).get(mapping_id)
    eff = clone(live_m)
    enr = clone((snap.get("enrichment") or {}).get(_ekey(live_m))) if live_m else None
    if origin == "admin":
        return clone((rec or {}).get("mapping") or base_m or {}), enr, eff
    return clone((rec or {}).get("mapping") or {}), enr, eff


def _baseline(snap, mapping_id, origin):
    """Raw shipped mapping (no overlay) for shipped records; the live mapping for Admin records."""
    if origin == "shipped":
        return (snap.get("baseline_by_id") or {}).get(mapping_id) or (snap.get("all_mappings") or {}).get(mapping_id)
    return (snap.get("all_mappings") or {}).get(mapping_id)


def _ekey(m):
    from catalogue_effective import enr_key
    return enr_key(m)


def save_draft(overlay, snap, mapping_id, origin, status, body, expected_revision, actor):
    """Edit → draft. The live mapping / enrichment / status are not touched."""
    overlay = clone(overlay)
    rec = _ensure_rec(overlay, mapping_id, origin)
    _check_revision(rec, expected_revision)
    if status == "retired":
        raise CatalogueError("invalid_state", "Restore this record before editing it.")
    part, enr, eff = _working(rec, origin, snap, mapping_id)
    if not eff:
        raise CatalogueError("not_found", "Error-code record not found.")
    patch, enr_patch = validate_patch({"mapping": eff, "origin": origin, "status": status}, body, snap)
    part = dict(part or {})
    part.update(patch)
    if enr_patch:
        e = dict(enr or {})
        if enr_patch.get("diagnosticHints"):
            dh = dict(e.get("diagnosticHints") or {})
            for k, v in enr_patch["diagnosticHints"].items():
                if v is not None:
                    dh[k] = v
            e["diagnosticHints"] = dh
        if enr_patch.get("safety"):
            s = dict(e.get("safety") or {})
            for k, v in enr_patch["safety"].items():
                if v is not None:
                    s[k] = v
            e["safety"] = s
        enr = e
    now = utcnow()
    base_version = (rec.get("draft") or {}).get("baseVersion")
    rec["draft"] = {
        "mapping": part, "enrichment": enr, "savedAt": now, "savedBy": _actor(actor),
        "baseVersion": current_version(rec) if base_version is None else base_version,
    }
    _touch(overlay, rec, "save-draft", mapping_id, actor)
    return overlay


def discard_or_delete(overlay, mapping_id, origin, expected_revision, actor):
    """Never-published Admin draft → hard delete. Anything ever live → discard the pending draft only."""
    overlay = clone(overlay)
    rec = (overlay.get("records") or {}).get(mapping_id)
    if not rec:
        raise CatalogueError("not_found", "There is no draft for this record.")
    _check_revision(rec, expected_revision)
    if origin == "admin" and rec.get("status") == "draft" and not _versions(rec) and not rec.get("mapping"):
        del overlay["records"][mapping_id]
        overlay["updatedAt"] = utcnow()
        record_action(overlay, {"type": "delete-draft", "id": mapping_id})
        return overlay, True
    if not rec.get("draft"):
        raise CatalogueError("invalid_state", "This record has been live, so it cannot be deleted. Archive it instead.")
    rec["draft"] = None
    _touch(overlay, rec, "discard-draft", mapping_id, actor)
    return overlay, False


# ------------------------------------------------------------------------- publish / rollback
def _validate_publishable(origin, eff, enrichment):
    """Structural checks on what would become live (the draft was validated when saved)."""
    errs = []
    if not isinstance(eff, dict):
        raise CatalogueError("invalid", "Nothing to publish.")
    if not str(eff.get("meaning") or "").strip():
        errs.append("meaning")
    if not str(eff.get("token") or "").strip():
        errs.append("code")
    if not isinstance(eff.get("shown") or [], list):
        errs.append("aliases")
    if eff.get("recordType") and eff["recordType"] not in ALLOWED_RECORD_TYPES:
        errs.append("recordType")
    if eff.get("confidence") and eff["confidence"] not in ALLOWED_CONFIDENCE:
        errs.append("confidence")
    try:
        validate_url((eff.get("provenance") or {}).get("url"))
    except CatalogueError:
        errs.append("provenance.url")
    if enrichment is not None and not isinstance(enrichment, dict):
        errs.append("enrichment")
    if isinstance(enrichment, dict):
        s = enrichment.get("safety") or {}
        if s.get("class") and s["class"] not in ALLOWED_SAFETY:
            errs.append("safety.class")
        if s.get("stopUse") and not str(s.get("reason") or "").strip():
            errs.append("safety.reason")
        dh = enrichment.get("diagnosticHints") or {}
        for k in ("components", "likelyCauses", "checks"):
            if dh.get(k) is not None and not isinstance(dh.get(k), list):
                errs.append("diagnosticHints." + k)
    if errs:
        raise CatalogueError("invalid", "This draft is not ready to publish.", {"fields": errs})


def _go_live(overlay, snap, rec, mapping_id, origin, mapping_part, enrichment, meta, actor):
    base_m = _baseline(snap, mapping_id, origin)
    eff = effective_of(origin, base_m, mapping_part) if origin == "shipped" else clone(mapping_part)
    if mapping_part is None and origin == "shipped":
        eff = clone(base_m)
    _validate_publishable(origin, eff, enrichment if mapping_part is not None or origin == "admin" else None)
    hits = collide(snap.get("active_mappings") or {}, eff, ignore_id=mapping_id)
    if hits:
        raise CatalogueError("collision", "Publishing would collide with another active record for that brand and appliance.",
                             {"conflicts": hits})
    versions = _versions(rec)
    # A record that was live before versioning existed: keep that content as v1 so it stays recoverable.
    if not versions and (rec.get("mapping") or rec.get("enrichment")):
        versions.append({
            "version": 1, "publishedAt": rec.get("updatedAt"), "publishedBy": None,
            "note": "Live content from before version history", "source": "legacy", "rolledBackFrom": None,
            "changed": [], "mapping": clone(rec.get("mapping")), "enrichment": clone(rec.get("enrichment")),
        })
    n = (versions[-1]["version"] if versions else 0) + 1
    now = utcnow()
    prev_m = effective_of(origin, base_m, rec.get("mapping")) if origin == "shipped" else rec.get("mapping")
    # Compare EFFECTIVE enrichment (overlay value, else the shipped baseline), not the raw overlay field.
    base_enr = snap.get("baseline_enrichment") or {}
    prev_e = rec.get("enrichment") if rec.get("enrichment") is not None else (base_enr.get(_ekey(prev_m)) if prev_m and origin == "shipped" else None)
    next_e = enrichment if enrichment is not None else (base_enr.get(_ekey(eff)) if eff and origin == "shipped" else None)
    entry = dict(meta, **{
        "version": n, "publishedAt": now, "publishedBy": _actor(actor),
        "changed": changed_fields(prev_m, prev_e, eff, next_e),
        "mapping": clone(mapping_part), "enrichment": clone(enrichment),
    })
    versions.append(entry)
    rec["versions"] = versions
    rec["currentVersion"] = n
    rec["mapping"] = clone(mapping_part)
    rec["enrichment"] = clone(enrichment)
    if rec.get("status") in (None, "draft"):
        rec["status"] = "active"
    rec["publishedAt"] = now
    rec["publishedBy"] = _actor(actor)
    return n


def publish(overlay, snap, mapping_id, origin, expected_revision, note, actor):
    overlay = clone(overlay)
    rec = (overlay.get("records") or {}).get(mapping_id)
    if not rec or not rec.get("draft"):
        raise CatalogueError("no_draft", "There is no draft to publish.")
    _check_revision(rec, expected_revision)
    if rec.get("status") == "retired":
        raise CatalogueError("invalid_state", "Restore this record before publishing.")
    d = rec["draft"]
    n = _go_live(overlay, snap, rec, mapping_id, origin, d.get("mapping"), d.get("enrichment"),
                 {"note": _note(note), "source": "draft", "rolledBackFrom": None}, actor)
    rec["draft"] = None
    _touch(overlay, rec, "publish", mapping_id, actor)
    return overlay, n


def rollback(overlay, snap, mapping_id, origin, expected_revision, to_version, note, actor):
    """Rollback = a NEW version carrying an older version's content. History is never rewritten."""
    overlay = clone(overlay)
    rec = _ensure_rec(overlay, mapping_id, origin)
    _check_revision(rec, expected_revision)
    if rec.get("status") == "retired":
        raise CatalogueError("invalid_state", "Restore this record before rolling back.")
    if rec.get("draft"):
        raise CatalogueError("draft_pending", "Publish or discard the pending draft before rolling back.")
    try:
        k = int(to_version)
    except (TypeError, ValueError):
        raise CatalogueError("invalid", "Choose a version to roll back to.")
    if k == current_version(rec):
        raise CatalogueError("invalid", "That version is already live.")
    if k == 0:
        if origin != "shipped":
            raise CatalogueError("invalid", "Admin-created records have no shipped baseline.")
        part, enr = None, None
    else:
        src = [v for v in _versions(rec) if v.get("version") == k]
        if not src:
            raise CatalogueError("not_found", "Version v%d not found." % k)
        part, enr = clone(src[0].get("mapping")), clone(src[0].get("enrichment"))
    n = _go_live(overlay, snap, rec, mapping_id, origin, part, enr,
                 {"note": _note(note), "source": "rollback", "rolledBackFrom": k}, actor)
    _touch(overlay, rec, "rollback", mapping_id, actor)
    return overlay, n


# ------------------------------------------------------------------------- archive / restore
def archive(overlay, mapping_id, origin, expected_revision, reason, actor):
    overlay = clone(overlay)
    rec = _ensure_rec(overlay, mapping_id, origin)
    _check_revision(rec, expected_revision)
    if rec.get("status") == "draft":
        raise CatalogueError("invalid_state", "A never-published draft cannot be archived. Delete it instead.")
    if rec.get("status") == "retired":
        raise CatalogueError("invalid_state", "Already archived.")
    now = utcnow()
    rec["status"] = "retired"
    rec["retiredAt"] = now
    rec["retiredBy"] = _actor(actor)
    rec["retiredReason"] = str(reason or "").strip()[:NOTE_MAX] or None
    _touch(overlay, rec, "retire", mapping_id, actor)
    return overlay


def restore(overlay, mapping_id, origin, expected_revision, actor):
    overlay = clone(overlay)
    rec = (overlay.get("records") or {}).get(mapping_id)
    if not rec or rec.get("status") != "retired":
        raise CatalogueError("invalid_state", "This record is not archived.")
    _check_revision(rec, expected_revision)
    rec["status"] = "active"
    rec["restoredAt"] = utcnow()
    rec["restoredBy"] = _actor(actor)
    _touch(overlay, rec, "restore", mapping_id, actor)
    return overlay


# ------------------------------------------------------------------------- read helpers
def version_list(rec, origin):
    out = []
    for v in reversed(_versions(rec)):
        out.append({k: v.get(k) for k in ("version", "publishedAt", "publishedBy", "note", "source", "rolledBackFrom", "changed")})
    if origin == "shipped":
        out.append({"version": 0, "source": "baseline", "label": "Shipped baseline", "publishedAt": None, "publishedBy": None,
                    "note": None, "rolledBackFrom": None, "changed": []})
    return out
