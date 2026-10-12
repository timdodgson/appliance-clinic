#!/usr/bin/env python3
"""Deterministic, idempotent repair of the banked runtime dataset (error-codes/runtime-model/generated/runtime).

The compiler that produced Dataset V1 is not in this repository, so the repair is applied to the
generated artefacts directly and every derived artefact is recomputed from the result:

1. Unique mappingIds. V1 shipped 847 source-code records but only 783 distinct mappingIds: 50 ids
   were shared by 2..11 records from different source files, and every loader keyed by mappingId
   (last wins), silently dropping 64 records (e.g. Bosch oven E011 replaced by the Tecnik record).
   Every member of a colliding group gets the suffix '@<sourceFile without .json>', e.g.
   'BSH_OVEN_E::default::E011@bsh-oven'. Non-colliding ids are unchanged. Enrichment mappingRefs are
   rewritten to match (joined on old id + sourceFile + canonicalCode); enrichmentKeys are unchanged.
2. Beko induction hob 'U': Beko documents that the hob display shows U when no (induction-compatible)
   pan is detected on the zone, or the pan was removed. The existing BEKO_HOB PAN-DETECT record gains
   the shown form 'U' and the manufacturer source (record count unchanged).

Recomputed: indexes/*.json, manifest.json (counts, contentHash), enrichment.json/manifest.json/coverage.json
hashes. contentHash formula (from this revision on): sha256 of
json.dumps({"faults","mappings","schemes","sources"}, sort_keys=True, ensure_ascii=False).
After running, update the frozen anchors in error-codes/mcp/deploy/integrity.py (the script prints them).

Run: python3 error-codes/tools/repair-runtime-dataset.py
"""
import hashlib
import json
import os
from collections import Counter, defaultdict

EC = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RT = os.path.join(EC, "runtime-model", "generated", "runtime")
ENR = os.path.join(EC, "enrichment", "generated")


def load(path):
    with open(path) as f:
        return json.load(f)


def dump(path, obj):
    with open(path, "w") as f:
        f.write(json.dumps(obj, indent=2, sort_keys=True))


def sha_file(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


BEKO_U_SOURCE = {
    "accessed": "2026-10-12",
    "publisher": "Beko UK (official support FAQ)",
    "reference": "Induction hob shows U: no induction-compatible pan detected on the zone (pan not magnetic, "
                 "too small, not covering the zone, or removed); check pan, then child lock",
    "sourceType": "MANUFACTURER",
    "url": "https://www.beko.co.uk/support/faqs/hobs/hob-does-not-work-on-induction-hobs-u-symbol",
}
BEKO_U_SOURCE["sourceId"] = "src_" + hashlib.sha256(BEKO_U_SOURCE["url"].encode()).hexdigest()[:10]


def dedupe_ids(mappings, enrichment):
    counts = Counter(m["mappingId"] for m in mappings)
    groups = {k for k, v in counts.items() if v > 1}
    renamed = {}  # (oldId, sourceFile, canonicalCode) -> newId
    for m in mappings:
        if m["mappingId"] not in groups:
            continue
        p = m.get("provenance") or {}
        stem = os.path.splitext(os.path.basename(p["sourceFile"]))[0]
        key = (m["mappingId"], p["sourceFile"], p.get("canonicalCode"))
        assert key not in renamed, f"cannot disambiguate {key}"
        renamed[key] = f'{m["mappingId"]}@{stem}'
        m["mappingId"] = renamed[key]
    ids = [m["mappingId"] for m in mappings]
    assert len(set(ids)) == len(ids), "mappingIds still not unique"
    hit = 0
    for r in enrichment:
        mr = r["mappingRef"]
        p = mr.get("provenance") or {}
        new = renamed.get((mr["mappingId"], p.get("sourceFile"), p.get("canonicalCode")))
        if new:
            mr["mappingId"] = new
            hit += 1
    assert hit == len(renamed), f"enrichment rewrite {hit} != {len(renamed)}"
    return len(groups), len(renamed) - len(groups)


def add_beko_u(mappings, sources):
    rec = next(m for m in mappings if m["mappingId"] == "BEKO_HOB::default::PAN-DETECT")
    if "U" not in rec["shown"]:
        rec["shown"].append("U")
    if BEKO_U_SOURCE["sourceId"] not in rec["sourceRefs"]:
        rec["sourceRefs"].append(BEKO_U_SOURCE["sourceId"])
    rec["meaning"] = "Pan not detected / unsuitable cookware (display shows U on induction models)"
    if not any(s["sourceId"] == BEKO_U_SOURCE["sourceId"] for s in sources):
        sources.append(dict(BEKO_U_SOURCE))
        sources.sort(key=lambda s: s["sourceId"])


def build_indexes(mappings):
    code, scheme_code, brand_app = defaultdict(set), defaultdict(set), defaultdict(set)
    for m in mappings:
        mid = m["mappingId"]
        code[m["token"]].add(mid)
        scheme_code[f'{m["schemeId"]}::{m["token"]}'].add(mid)
        conds = {c["k"]: c for c in m["applicability"]["conditions"]}
        for b in conds.get("brand", {}).get("v") or []:
            for a in conds.get("appliance", {}).get("v") or []:
                brand_app[f"{b}|{a}"].add(mid)
    srt = lambda d: {k: sorted(v) for k, v in d.items()}
    return srt(code), srt(scheme_code), srt(brand_app)


def main():
    mappings = load(os.path.join(RT, "mappings.json"))
    sources = load(os.path.join(RT, "sources.json"))
    schemes = load(os.path.join(RT, "schemes.json"))
    faults = load(os.path.join(RT, "faults.json"))
    enr_doc = load(os.path.join(ENR, "enrichment.json"))
    enrichment = enr_doc["records"]

    # brand-appliance index must be reproducible before we trust the rebuild
    old_ba = load(os.path.join(RT, "indexes", "brand-appliance.json"))
    old = (load(os.path.join(RT, "indexes", "code.json")), load(os.path.join(RT, "indexes", "scheme-code.json")), old_ba)
    assert build_indexes(mappings) == old, "index formula does not reproduce the banked indexes"

    groups, overwritten = dedupe_ids(mappings, enrichment)
    add_beko_u(mappings, sources)

    code, scheme_code, brand_app = build_indexes(mappings)
    dump(os.path.join(RT, "mappings.json"), mappings)
    dump(os.path.join(RT, "sources.json"), sources)
    dump(os.path.join(RT, "indexes", "code.json"), code)
    dump(os.path.join(RT, "indexes", "scheme-code.json"), scheme_code)
    dump(os.path.join(RT, "indexes", "brand-appliance.json"), brand_app)

    content_hash = hashlib.sha256(json.dumps(
        {"faults": faults, "mappings": mappings, "schemes": schemes, "sources": sources},
        sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    man = load(os.path.join(RT, "manifest.json"))
    man["counts"]["sources"] = len(sources)
    man["counts"]["mappings"] = len(mappings)
    man["counts"]["sourceCodeRecords"] = len(mappings)
    man["counts"]["uniqueMappingIds"] = len({m["mappingId"] for m in mappings})
    man["contentHash"] = content_hash
    man["datasetRevision"] = "1.1"
    man["revisionNotes"] = ("1.1: mappingIds made unique (colliding ids suffixed '@<sourceFile>'); "
                            "Beko induction hob 'U' shown form added. Repaired by error-codes/tools/repair-runtime-dataset.py")
    dump(os.path.join(RT, "manifest.json"), man)

    enr_hash = hashlib.sha256(json.dumps(enrichment, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    enr_doc["_manifestRef"] = enr_hash
    dump(os.path.join(ENR, "enrichment.json"), enr_doc)
    em = load(os.path.join(ENR, "manifest.json"))
    em["enrichmentContentHash"] = enr_hash
    em["sourceRuntimeContentHash"] = content_hash
    em["v1FrozenHashExpected"] = content_hash
    dump(os.path.join(ENR, "manifest.json"), em)
    cov = load(os.path.join(ENR, "coverage.json"))
    cov["contentHash"] = enr_hash
    dump(os.path.join(ENR, "coverage.json"), cov)

    print(json.dumps({
        "collidingGroupsFixed": groups, "recordsPreviouslyOverwritten": overwritten,
        "uniqueMappingIds": man["counts"]["uniqueMappingIds"], "mappings": len(mappings),
        "DATASET_V1_HASH": content_hash, "ENRICHMENT_V1_HASH": enr_hash,
        "RAW_ANCHORS": {n: sha_file(os.path.join(RT, n)) for n in ("mappings.json", "schemes.json", "faults.json", "sources.json")}
        | {"enrichment.json": sha_file(os.path.join(ENR, "enrichment.json"))},
    }, indent=2))


if __name__ == "__main__":
    main()
