#!/usr/bin/env python3
"""Effective Error-Code catalogue = shipped baseline mappings + durable admin overlay.

Pure functions. No I/O, no LLM. Used by:
  - live MCP resolve-error-code (active mappings only)
  - admin inspect / create / edit / retire / restore

Overlay records never rewrite the banked JSON files. A missing overlay is shipped
baseline. Retiring a shipped mapping is a durable tombstone so deleting an overlay
add cannot resurrect it.
"""
from __future__ import annotations

import copy
import json
import re
from datetime import datetime, timezone

from resolve import Resolver

OVERLAY_VERSION = 1
ADMIN_SCHEME = "ADMIN_CATALOGUE"
CONTENT_FIELDS = (
    "meaning", "shown", "applicabilityNote", "system", "recordType",
    "confidence", "declaredConfidence", "faultId", "notation", "sourceRefs",
)
IDENTITY_FIELDS = ("mappingId", "token", "schemeId", "variantId", "applicability")
ALLOWED_RECORD_TYPES = ("FAULT", "WARNING", "STATUS", "MAINTENANCE", "INFORMATION")
ALLOWED_CONFIDENCE = ("LOW", "MEDIUM", "HIGH")
ALLOWED_SAFETY = ("NORMAL_DIAGNOSTIC", "STATUS_ONLY", "SERVICE_REQUIRED", "STOP_USE")
SOURCE_TYPE_LABELS = {
    "MANUFACTURER": "Manufacturer documentation",
    "SERVICE_DOCUMENTATION": "Service documentation",
    "SPECIALIST_REPAIR": "Specialist repair source",
    "TIER2_SERVICE": "Service documentation",
    "TIER3_SPECIALIST": "Specialist repair source",
    "TIER4_AGGREGATOR": "Existing curated dataset",
    "TIER4_DISCOVERY": "Existing curated dataset",
    "OTHER": "Other recorded source",
    "ADMIN_CURATED": "Admin-curated (not a manufacturer document)",
}
PROTECTED_URL = re.compile(r"^(https?)://", re.I)
JS_OR_DATA = re.compile(r"^(javascript|data|vbscript):", re.I)


class CatalogueError(Exception):
    def __init__(self, code, message, extra=None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.extra = extra or {}
        self.status = 404 if code in ("not_found",) else 409 if code in (
            "duplicate", "collision", "conflict", "invalid_state", "draft_pending", "no_draft",
        ) else 400


def utcnow():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def clone(x):
    return copy.deepcopy(x)


def empty_overlay():
    return {"version": OVERLAY_VERSION, "updatedAt": None, "records": {}, "actions": []}


def tok(code):
    return Resolver._tok(code)


def fold(code):
    return Resolver._fold(code)


def brand_norm(b):
    return Resolver._brand(b)


APPLIANCE_SYNONYMS = {
    "washing machine": "washing-machine", "washer": "washing-machine",
    "tumble dryer": "tumble-dryer", "dryer": "tumble-dryer",
    "washer dryer": "washer-dryer", "fridge freezer": "fridge-freezer",
    "refrigerator": "fridge", "oven": "cooker-oven", "cooker": "cooker-oven",
    "hob": "hobs", "hood": "cooker-hood", "cooker hood": "cooker-hood",
    "bread maker": "breadmaker", "coffee machine": "coffee-maker",
    "oven-cooker": "cooker-oven", "vacuum": "vacuum-cleaner", "vacuum cleaner": "vacuum-cleaner",
}


def appliance_norm(a):
    s = re.sub(r"\s+", " ", str(a or "").strip()).lower()
    if s in APPLIANCE_SYNONYMS:
        return APPLIANCE_SYNONYMS[s]
    return s.replace("_", "-").replace(" ", "-")


def mapping_brands(m):
    for c in (m.get("applicability") or {}).get("conditions") or []:
        if c.get("k") == "brand":
            return [brand_norm(v) for v in (c.get("v") or [])]
    return []


def mapping_appliances(m):
    for c in (m.get("applicability") or {}).get("conditions") or []:
        if c.get("k") == "appliance":
            return [str(v).strip().lower() for v in (c.get("v") or [])]
    return []


def lookup_keys(m):
    keys = {fold(m.get("token")), tok(m.get("token"))}
    for x in m.get("shown") or []:
        keys.add(fold(x))
        keys.add(tok(x))
    canon = (m.get("provenance") or {}).get("canonicalCode")
    if canon:
        keys.add(fold(canon))
        keys.add(tok(canon))
    keys.discard("")
    keys.discard(None)
    return keys


def enr_key(m, rec=None):
    p = (rec or {}).get("mappingRef", {}).get("provenance") if rec else None
    p = p or (m.get("provenance") or {})
    mr = (rec or {}).get("mappingRef") or {}
    return (
        mr.get("mappingId") or m.get("mappingId"),
        p.get("sourceFile"),
        p.get("canonicalCode"),
        mr.get("schemeId") or m.get("schemeId"),
        mr.get("variantId") or m.get("variantId"),
        mr.get("token") or m.get("token"),
    )


def index_enrichment(records):
    out = {}
    for r in records or []:
        mr = r.get("mappingRef") or {}
        p = mr.get("provenance") or {}
        out[(mr.get("mappingId"), p.get("sourceFile"), p.get("canonicalCode"),
             mr.get("schemeId"), mr.get("variantId"), mr.get("token"))] = r
    return out


def source_type_label(source_type):
    if not source_type:
        return "Not recorded"
    return SOURCE_TYPE_LABELS.get(source_type, source_type.replace("_", " ").title())


def safe_url(url):
    if not url:
        return None
    s = str(url).strip()
    if JS_OR_DATA.search(s):
        return None
    if not PROTECTED_URL.match(s):
        return None
    return s


def record_action(overlay, action):
    overlay["actions"] = [{
        "at": action.get("at") or utcnow(),
        "type": action.get("type"),
        "id": action.get("id"),
    }] + list(overlay.get("actions") or [])
    overlay["actions"] = overlay["actions"][:40]


def _overlay_content(base, patch):
    out = clone(base)
    for k in CONTENT_FIELDS:
        if k in (patch or {}) and patch[k] is not None:
            out[k] = clone(patch[k])
    if patch and isinstance(patch.get("provenance"), dict):
        prov = dict(out.get("provenance") or {})
        for pk, pv in patch["provenance"].items():
            if pk in ("sourceFile", "canonicalCode") and out.get("provenance") and pk in out["provenance"]:
                continue
            if pv is not None:
                prov[pk] = pv
        out["provenance"] = prov
    return out


def origin_admin(m):
    return str(m.get("schemeId") or "").startswith("ADMIN") or str(m.get("mappingId") or "").startswith("ADMIN::")


def merge(baseline_mappings, baseline_enrichment, overlay, sources=None):
    """Return effective catalogue facts.

    active_mappings: dict used by Resolver (retired excluded)
    inspect: list of admin-facing records (including retired)
    enrichment: keyed like ErrorCodeTools
    """
    overlay = overlay if isinstance(overlay, dict) else empty_overlay()
    records = overlay.get("records") if isinstance(overlay.get("records"), dict) else {}
    mappings = {m["mappingId"]: clone(m) for m in (baseline_mappings or []) if m.get("mappingId")}
    shipped_ids = set(mappings)
    enrichment = index_enrichment(clone(baseline_enrichment or []))
    meta = {mid: {"status": "active", "origin": "shipped"} for mid in mappings}

    drafts_only = {}
    for mid, rec in records.items():
        if not mid or not isinstance(rec, dict):
            continue
        origin = rec.get("origin") or ("shipped" if mid in shipped_ids else "admin")
        status = rec.get("status") or "active"
        if origin == "shipped" and mid not in shipped_ids:
            continue
        if status == "draft":
            # Never published: visible to Admin only. NEVER enters the live Resolver mappings.
            if origin == "admin" and isinstance((rec.get("draft") or {}).get("mapping"), dict):
                drafts_only[mid] = rec
            continue
        if rec.get("mapping") and origin == "admin":
            mappings[mid] = clone(rec["mapping"])
        elif rec.get("mapping") and mid in mappings:
            mappings[mid] = _overlay_content(mappings[mid], rec["mapping"])
        if rec.get("enrichment") is not None and mid in mappings:
            e = clone(rec["enrichment"])
            enrichment[enr_key(mappings[mid], e)] = e
        meta[mid] = dict(record_admin_meta(rec), **{
            "status": status if status in ("active", "retired") else "active",
            "origin": origin,
            "updatedAt": rec.get("updatedAt"),
            "retiredAt": rec.get("retiredAt"),
            "retiredReason": rec.get("retiredReason"),
        })

    active = {mid: m for mid, m in mappings.items() if meta.get(mid, {}).get("status") == "active"}
    inspect = []
    sources = sources or {}
    for mid, m in mappings.items():
        st = meta.get(mid) or {"status": "active", "origin": "shipped"}
        inspect.append(inspect_summary(m, st, enrichment, sources))
    draft_mappings = {}
    for mid, rec in drafts_only.items():
        dm = clone(rec["draft"]["mapping"])
        draft_mappings[mid] = dm
        de = rec["draft"].get("enrichment")
        st = dict(record_admin_meta(rec), status="draft", origin="admin", updatedAt=rec.get("updatedAt"))
        meta[mid] = st
        inspect.append(inspect_summary(dm, st, {enr_key(dm): de} if de else {}, sources))
    inspect.sort(key=lambda r: (
        (r["appliances"][:1] or [""])[0],
        (r["brands"][:1] or [""])[0],
        r.get("code") or "",
        r.get("mappingId") or "",
    ))

    overlay_present = bool(records)
    retired_n = sum(1 for v in meta.values() if v.get("status") == "retired")
    admin_n = sum(1 for v in meta.values() if v.get("origin") == "admin" and v.get("status") == "active")
    override_n = sum(1 for mid, v in meta.items() if v.get("origin") == "shipped" and mid in records and v.get("status") == "active")
    return {
        "active_mappings": active,
        "all_mappings": mappings,
        "draft_mappings": draft_mappings,
        "draft_enrichment": {mid: (rec["draft"].get("enrichment")) for mid, rec in drafts_only.items()},
        "inspect": inspect,
        "enrichment": enrichment,
        "meta": meta,
        "sourceCodeRecordCount": len(baseline_mappings or []),
        "baselineCount": len(shipped_ids),
        "effectiveActiveCount": len(active),
        "overlay": {
            "present": overlay_present,
            "state": "active" if overlay_present else "none",
            "records": len(records),
            "retired": retired_n,
            "adminActive": admin_n,
            "shippedOverrides": override_n,
            "updatedAt": overlay.get("updatedAt"),
            "version": overlay.get("version") or OVERLAY_VERSION,
            "drafts": sum(1 for r in records.values() if isinstance(r, dict) and r.get("draft")),
        },
    }


def record_admin_meta(rec):
    """Admin bookkeeping carried alongside live status (never read by the Resolver)."""
    rec = rec or {}
    versions = rec.get("versions") or []
    return {
        "revision": int(rec.get("revision") or 0),
        "currentVersion": int(rec.get("currentVersion") or (versions[-1]["version"] if versions else 0)),
        "draftPending": bool(rec.get("draft")),
        "versionCount": len(versions),
        "legacyLive": bool(rec.get("mapping") or rec.get("enrichment")) and not versions,
    }


def inspect_summary(m, st, enrichment, sources):
    brands = mapping_brands(m)
    apps = mapping_appliances(m)
    e = enrichment.get(enr_key(m))
    src_types = []
    for sid in m.get("sourceRefs") or []:
        s = sources.get(sid) or {}
        if s.get("sourceType") and s["sourceType"] not in src_types:
            src_types.append(s["sourceType"])
    if not src_types and (m.get("provenance") or {}).get("sourceType"):
        src_types.append(m["provenance"]["sourceType"])
    search = " ".join([
        m.get("token") or "",
        " ".join(m.get("shown") or []),
        " ".join(brands),
        " ".join(apps),
        m.get("meaning") or "",
        m.get("mappingId") or "",
        (m.get("provenance") or {}).get("canonicalCode") or "",
        (m.get("provenance") or {}).get("sourceFile") or "",
        " ".join(((e or {}).get("diagnosticHints") or {}).get("components") or []),
        " ".join(src_types),
        st.get("origin") or "",
        st.get("status") or "",
    ]).lower()
    return {
        "mappingId": m.get("mappingId"),
        "code": m.get("token"),
        "shown": list(m.get("shown") or []),
        "brands": brands,
        "appliances": apps,
        "meaning": m.get("meaning"),
        "recordType": m.get("recordType"),
        "confidence": m.get("confidence"),
        "status": st.get("status") or "active",
        "origin": st.get("origin") or "shipped",
        "sourceTypes": src_types,
        "sourceTypeLabels": [source_type_label(t) for t in src_types] or ["Not recorded"],
        "applicabilityNote": m.get("applicabilityNote"),
        "searchText": search,
        "updatedAt": st.get("updatedAt"),
        "retiredAt": st.get("retiredAt"),
        "draftPending": bool(st.get("draftPending")),
        "revision": int(st.get("revision") or 0),
        "currentVersion": int(st.get("currentVersion") or 0),
    }


def inspect_detail(m, st, enrichment, sources):
    summary = inspect_summary(m, st, enrichment, sources)
    e = enrichment.get(enr_key(m))
    srcs = []
    for sid in m.get("sourceRefs") or []:
        s = sources.get(sid) or {"sourceId": sid}
        srcs.append({
            "sourceId": s.get("sourceId") or sid,
            "sourceType": s.get("sourceType"),
            "sourceTypeLabel": source_type_label(s.get("sourceType")),
            "publisher": s.get("publisher"),
            "reference": s.get("reference"),
            "accessed": s.get("accessed"),
            "url": safe_url(s.get("url")),
        })
    safety = None
    hints = None
    if e:
        safety = {
            "class": (e.get("safety") or {}).get("class"),
            "stopUse": bool((e.get("safety") or {}).get("stopUse")),
            "reason": (e.get("safety") or {}).get("reason"),
        }
        dh = e.get("diagnosticHints") or {}
        hints = {
            "components": list(dh.get("components") or []),
            "likelyCauses": list(dh.get("likelyCauses") or []),
            "checks": list(dh.get("checks") or []),
            "behaviour": e.get("behaviour") or {},
        }
    summary.update({
        "system": m.get("system"),
        "notation": m.get("notation"),
        "schemeId": m.get("schemeId"),
        "variantId": m.get("variantId"),
        "faultId": m.get("faultId"),
        "ambiguity": m.get("ambiguity"),
        "provenance": {
            "canonicalCode": (m.get("provenance") or {}).get("canonicalCode"),
            "sourceFile": (m.get("provenance") or {}).get("sourceFile"),
            "sourceType": (m.get("provenance") or {}).get("sourceType"),
            "publisher": (m.get("provenance") or {}).get("publisher"),
            "reference": (m.get("provenance") or {}).get("reference"),
            "url": safe_url((m.get("provenance") or {}).get("url")),
        },
        "sources": srcs,
        "safety": safety,
        "diagnosticHints": hints,
        "identityLocked": st.get("origin") != "admin",
        "retiredReason": st.get("retiredReason"),
        "raw": m,
    })
    return summary


def collide(active_mappings, candidate, ignore_id=None):
    """Return collision errors using the same token/fold keys as MCP lookup."""
    c_brands = set(mapping_brands(candidate)) or {brand_norm(b) for b in candidate.get("_brands") or []}
    c_apps = set(mapping_appliances(candidate)) or {str(a).lower() for a in candidate.get("_appliances") or []}
    c_keys = lookup_keys(candidate)
    hits = []
    for mid, m in (active_mappings or {}).items():
        if ignore_id and mid == ignore_id:
            continue
        if c_brands and c_apps:
            if not (c_brands & set(mapping_brands(m))):
                continue
            if not (c_apps & set(mapping_appliances(m))):
                continue
        overlap = c_keys & lookup_keys(m)
        if overlap:
            hits.append({"mappingId": mid, "code": m.get("token"), "keys": sorted(overlap)})
    return hits


def validate_url(url):
    if url is None or url == "":
        return None
    s = str(url).strip()
    if JS_OR_DATA.search(s):
        raise CatalogueError("invalid_provenance", "Source URL must be http or https.")
    if not PROTECTED_URL.match(s):
        raise CatalogueError("invalid_provenance", "Source URL must be http or https.")
    return s


def validate_create(body, appliances, merged):
    if not isinstance(body, dict):
        raise CatalogueError("invalid", "Body must be an object.")
    appliance = appliance_norm(body.get("appliance") or "")
    brand = brand_norm(body.get("brand") or body.get("make") or "")
    code = str(body.get("code") or "").strip()
    meaning = str(body.get("meaning") or "").strip()
    if not appliance:
        raise CatalogueError("invalid", "Appliance is required.")
    if appliances and appliance not in appliances:
        raise CatalogueError("invalid_family", "Appliance is not in the Error Code catalogue.", {"appliance": appliance})
    if not brand:
        raise CatalogueError("invalid", "Brand is required.")
    if not code:
        raise CatalogueError("invalid", "Error code is required.")
    if not meaning:
        raise CatalogueError("invalid", "Meaning is required.")
    token = tok(code)
    if not token:
        raise CatalogueError("invalid", "Error code is empty after normalisation.")
    aliases = body.get("aliases") or body.get("shown") or []
    if not isinstance(aliases, list):
        raise CatalogueError("invalid", "Aliases must be a list of strings.")
    shown = []
    for x in [code] + list(aliases):
        s = str(x or "").strip()
        if s and s not in shown:
            shown.append(s)
    record_type = str(body.get("recordType") or "FAULT").upper()
    if record_type not in ALLOWED_RECORD_TYPES:
        raise CatalogueError("invalid", "Invalid record type.")
    confidence = str(body.get("confidence") or "LOW").upper()
    if confidence not in ALLOWED_CONFIDENCE:
        raise CatalogueError("invalid", "Invalid confidence.")
    if confidence == "HIGH":
        confidence = "MEDIUM"  # admin cannot self-assert HIGH
    safety_class = str((body.get("safety") or {}).get("class") or "NORMAL_DIAGNOSTIC")
    if safety_class not in ALLOWED_SAFETY:
        raise CatalogueError("invalid", "Invalid safety class.")
    if body.get("safety") and not isinstance(body.get("safety"), dict):
        raise CatalogueError("invalid", "Safety must be an object with stored fields only.")
    url = validate_url((body.get("provenance") or {}).get("url") if isinstance(body.get("provenance"), dict) else None)
    brand_slug = re.sub(r"[^a-z0-9]+", "-", brand).strip("-") or "brand"
    mapping_id = f"ADMIN::{appliance}::{brand_slug}::{token}"
    mapping = {
        "mappingId": mapping_id,
        "schemeId": ADMIN_SCHEME,
        "variantId": "default",
        "token": token,
        "shown": shown,
        "notation": "alpha-numeric",
        "meaning": meaning,
        "system": str(body.get("system") or "").strip() or None,
        "faultId": str(body.get("faultId") or "admin").strip() or "admin",
        "recordType": record_type,
        "confidence": confidence,
        "declaredConfidence": confidence,
        "ambiguity": None,
        "applicabilityNote": str(body.get("applicabilityNote") or "").strip() or None,
        "applicability": {
            "conditions": [
                {"k": "appliance", "op": "in", "v": [appliance]},
                {"k": "brand", "op": "in", "v": [brand]},
            ]
        },
        "provenance": {
            "canonicalCode": mapping_id,
            "sourceFile": "admin-overlay",
            "sourceType": str((body.get("provenance") or {}).get("sourceType") or "ADMIN_CURATED"),
            "publisher": str((body.get("provenance") or {}).get("publisher") or "").strip() or None,
            "reference": str((body.get("provenance") or {}).get("reference") or "").strip() or None,
            "url": url,
        },
        "sourceRefs": [],
    }
    if mapping_id in (merged.get("active_mappings") or {}) or mapping_id in (merged.get("meta") or {}):
        raise CatalogueError("duplicate", "A record with this canonical key already exists.", {"mappingId": mapping_id})
    hits = collide(merged.get("active_mappings") or {}, mapping)
    if hits:
        raise CatalogueError("collision", "This code or an alias already resolves to another active record for that brand and appliance.", {"conflicts": hits})
    hints = body.get("diagnosticHints") or {}
    enrichment = {
        "enrichmentKey": "enr_admin_" + mapping_id,
        "mappingRef": {
            "mappingId": mapping_id,
            "provenance": {"canonicalCode": mapping_id, "sourceFile": "admin-overlay"},
            "schemeId": ADMIN_SCHEME,
            "token": token,
            "variantId": "default",
        },
        "faultId": mapping["faultId"],
        "recordType": record_type,
        "system": mapping["system"],
        "diagnosticHints": {
            "components": [str(x) for x in (hints.get("components") or []) if str(x).strip()],
            "likelyCauses": [str(x) for x in (hints.get("likelyCauses") or []) if str(x).strip()],
            "checks": [str(x) for x in (hints.get("checks") or []) if str(x).strip()],
        },
        "behaviour": {"mayPreventStart": False, "mayRunPumpContinuously": False, "protectionState": False},
        "safety": {
            "class": safety_class,
            "stopUse": bool((body.get("safety") or {}).get("stopUse")) if safety_class == "STOP_USE" else False,
            "reason": str((body.get("safety") or {}).get("reason") or "").strip() or None,
        },
        "confidence": {"mapping": confidence, "components": None, "likelyCauses": None, "checks": None, "behaviour": None, "safety": None},
        "evidenceRefs": [],
        "rawNote": None,
    }
    if enrichment["safety"]["stopUse"] and not enrichment["safety"]["reason"]:
        raise CatalogueError("invalid", "STOP_USE safety requires a stored reason. Safety is not inferred from the code.")
    return mapping, enrichment


def validate_patch(existing, body, merged):
    if not isinstance(body, dict):
        raise CatalogueError("invalid", "Body must be an object.")
    identity_touch = [k for k in ("code", "token", "brand", "make", "appliance", "mappingId") if k in body and body[k] not in (None, "")]
    # Allow aliases/shown and content fields only. Identity changes are rejected.
    if existing.get("origin") != "admin":
        if identity_touch:
            raise CatalogueError("identity_locked", "Shipped identity (brand, appliance, code) cannot be edited. Create a replacement and retire this record.")
    else:
        if any(k in body for k in ("brand", "make", "appliance", "code", "token", "mappingId")):
            raise CatalogueError("identity_locked", "Identity fields cannot be patched. Create a replacement and retire this record.")
    patch = {}
    if "meaning" in body:
        meaning = str(body.get("meaning") or "").strip()
        if not meaning:
            raise CatalogueError("invalid", "Meaning is required.")
        patch["meaning"] = meaning
    if "aliases" in body or "shown" in body:
        aliases = body.get("aliases") if "aliases" in body else body.get("shown")
        if not isinstance(aliases, list):
            raise CatalogueError("invalid", "Aliases must be a list of strings.")
        shown = []
        token_shown = existing["mapping"].get("token")
        if token_shown:
            shown.append(token_shown)
        for x in aliases:
            s = str(x or "").strip()
            if s and s not in shown:
                shown.append(s)
        patch["shown"] = shown
    for k in ("applicabilityNote", "system", "faultId", "notation"):
        if k in body:
            patch[k] = (str(body.get(k) or "").strip() or None)
    if "recordType" in body:
        rt = str(body.get("recordType") or "").upper()
        if rt not in ALLOWED_RECORD_TYPES:
            raise CatalogueError("invalid", "Invalid record type.")
        patch["recordType"] = rt
    if "confidence" in body:
        c = str(body.get("confidence") or "").upper()
        if c not in ALLOWED_CONFIDENCE:
            raise CatalogueError("invalid", "Invalid confidence.")
        if c == "HIGH" and existing.get("origin") == "admin":
            c = "MEDIUM"
        patch["confidence"] = c
        patch["declaredConfidence"] = c
    if "provenance" in body:
        if not isinstance(body.get("provenance"), dict):
            raise CatalogueError("invalid_provenance", "Provenance must be an object.")
        p = body["provenance"]
        patch["provenance"] = {
            "sourceType": str(p.get("sourceType") or "").strip() or None,
            "publisher": str(p.get("publisher") or "").strip() or None,
            "reference": str(p.get("reference") or "").strip() or None,
            "url": validate_url(p.get("url")),
        }
    candidate = _overlay_content(existing["mapping"], patch)
    hits = collide(merged.get("active_mappings") or {}, candidate, ignore_id=existing["mapping"]["mappingId"])
    if existing.get("status") != "retired" and hits:
        raise CatalogueError("collision", "This alias already resolves to another active record for that brand and appliance.", {"conflicts": hits})
    enrichment_patch = None
    if "diagnosticHints" in body or "safety" in body:
        hints = body.get("diagnosticHints") if isinstance(body.get("diagnosticHints"), dict) else {}
        safety = body.get("safety") if isinstance(body.get("safety"), dict) else {}
        if "class" in safety and safety.get("class") not in ALLOWED_SAFETY:
            raise CatalogueError("invalid", "Invalid safety class.")
        if safety.get("stopUse") and not str(safety.get("reason") or "").strip():
            raise CatalogueError("invalid", "STOP_USE safety requires a stored reason.")
        enrichment_patch = {
            "diagnosticHints": {
                "components": [str(x) for x in (hints.get("components") or []) if str(x).strip()] if "components" in hints else None,
                "likelyCauses": [str(x) for x in (hints.get("likelyCauses") or []) if str(x).strip()] if "likelyCauses" in hints else None,
                "checks": [str(x) for x in (hints.get("checks") or []) if str(x).strip()] if "checks" in hints else None,
            } if hints else None,
            "safety": {
                "class": safety.get("class"),
                "stopUse": bool(safety.get("stopUse")) if "stopUse" in safety else None,
                "reason": str(safety.get("reason") or "").strip() or None,
            } if safety else None,
        }
    return patch, enrichment_patch


def apply_create(overlay, mapping, enrichment):
    overlay = clone(overlay or empty_overlay())
    overlay.setdefault("records", {})
    mid = mapping["mappingId"]
    overlay["records"][mid] = {
        "origin": "admin",
        "status": "active",
        "updatedAt": utcnow(),
        "mapping": mapping,
        "enrichment": enrichment,
    }
    overlay["updatedAt"] = utcnow()
    record_action(overlay, {"type": "create", "id": mid})
    return overlay


def apply_patch(overlay, mapping_id, origin, patch, enrichment_patch, current_enrichment):
    overlay = clone(overlay or empty_overlay())
    overlay.setdefault("records", {})
    rec = dict(overlay["records"].get(mapping_id) or {"origin": origin, "status": "active"})
    rec["origin"] = origin
    rec["status"] = rec.get("status") or "active"
    rec["updatedAt"] = utcnow()
    rec["mapping"] = dict(rec.get("mapping") or {})
    rec["mapping"].update(patch)
    if enrichment_patch:
        e = dict(current_enrichment or rec.get("enrichment") or {})
        if enrichment_patch.get("diagnosticHints"):
            dh = dict(e.get("diagnosticHints") or {})
            for k, v in enrichment_patch["diagnosticHints"].items():
                if v is not None:
                    dh[k] = v
            e["diagnosticHints"] = dh
        if enrichment_patch.get("safety"):
            s = dict(e.get("safety") or {})
            for k, v in enrichment_patch["safety"].items():
                if v is not None:
                    s[k] = v
            e["safety"] = s
        rec["enrichment"] = e
    overlay["records"][mapping_id] = rec
    overlay["updatedAt"] = utcnow()
    record_action(overlay, {"type": "edit", "id": mapping_id})
    return overlay


def apply_retire(overlay, mapping_id, origin, reason=None):
    overlay = clone(overlay or empty_overlay())
    overlay.setdefault("records", {})
    rec = dict(overlay["records"].get(mapping_id) or {"origin": origin, "status": "active"})
    rec["origin"] = origin
    rec["status"] = "retired"
    rec["retiredAt"] = utcnow()
    rec["retiredReason"] = str(reason or "").strip() or None
    rec["updatedAt"] = utcnow()
    overlay["records"][mapping_id] = rec
    overlay["updatedAt"] = utcnow()
    record_action(overlay, {"type": "retire", "id": mapping_id})
    return overlay


def apply_restore(overlay, mapping_id, origin):
    overlay = clone(overlay or empty_overlay())
    overlay.setdefault("records", {})
    rec = dict(overlay["records"].get(mapping_id) or {"origin": origin, "status": "retired"})
    rec["origin"] = origin
    rec["status"] = "active"
    rec["restoredAt"] = utcnow()
    rec["updatedAt"] = utcnow()
    overlay["records"][mapping_id] = rec
    overlay["updatedAt"] = utcnow()
    record_action(overlay, {"type": "restore", "id": mapping_id})
    return overlay


def apply_delete(overlay, mapping_id, origin, status):
    if origin != "admin":
        raise CatalogueError("forbidden", "Shipped baseline records cannot be deleted. Retire them instead.")
    overlay = clone(overlay or empty_overlay())
    overlay.setdefault("records", {})
    if mapping_id not in overlay["records"]:
        raise CatalogueError("not_found", "Admin overlay record not found.")
    del overlay["records"][mapping_id]
    overlay["updatedAt"] = utcnow()
    record_action(overlay, {"type": "delete", "id": mapping_id})
    return overlay
