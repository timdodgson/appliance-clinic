#!/usr/bin/env python3
"""Startup integrity check for the deployed Error-Code MCP.

Refuses to serve if the packaged banked artifacts do not match the frozen Dataset V1 /
Enrichment V1 fingerprints. Three independent checks:
  1. Version anchors  — manifest self-reported content hashes equal the frozen constants.
  2. Enrichment tamper — recompute enrichment content hash from records (compiler's method).
  3. Raw-bytes tamper  — sha256 of each generated artifact file equals a captured anchor.

No secrets, no network. Pure stdlib.
"""
import os, json, hashlib

_HERE = os.path.dirname(os.path.abspath(__file__))
_EC = os.path.dirname(os.path.dirname(_HERE))              # .../error-codes
RT = os.path.join(_EC, "runtime-model", "generated", "runtime")
ENR = os.path.join(_EC, "enrichment", "generated")

# Dataset V1.1 (unique mappingIds + Beko hob U): anchors produced by error-codes/tools/repair-runtime-dataset.py
DATASET_V1_HASH = "835496f2dc8da20060ed574c65bc470080c6571a332ea45324cd9605d98cf0da"
ENRICHMENT_V1_HASH = "28c0cc32df74562ba479e8c25f121a8677acf09d9617988767c3e926e3517f20"

# raw-bytes sha256 anchors captured from the banked artifacts (tamper detection independent
# of the compilers' content-hash formulas)
RAW_ANCHORS = {
    os.path.join(RT, "mappings.json"): "0393f021daf7fad6bb779c18fbe46d31e7f16e962095aa4c1c3d5376aebe1500",
    os.path.join(RT, "schemes.json"): "ad1ec4677ac0801cc99f6ef46a3f31c835f6b953f3131e93636dd3c458db37cd",
    os.path.join(RT, "faults.json"): "54e4474878de105b4ddd9ad6c56f528ed348a7877e15a1f0de59d7274d63f845",
    os.path.join(RT, "sources.json"): "f871c5409dd884a8e1512ef317bbc50f28b0df67e7a7415dc183dab6668af70d",
    os.path.join(ENR, "enrichment.json"): "a6fa080688e8a9bbd6c0e5fb3510f5b1733520b517100078ca51da3e157203cd",
}


def _raw(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def verify() -> dict:
    """Run all integrity checks. Raise RuntimeError on any mismatch. Return safe summary."""
    errors = []

    v1man = json.load(open(os.path.join(RT, "manifest.json")))
    if v1man.get("contentHash") != DATASET_V1_HASH:
        errors.append(f"Dataset V1 manifest hash mismatch: {v1man.get('contentHash')}")

    enrman = json.load(open(os.path.join(ENR, "manifest.json")))
    if enrman.get("enrichmentContentHash") != ENRICHMENT_V1_HASH:
        errors.append(f"Enrichment V1 manifest hash mismatch: {enrman.get('enrichmentContentHash')}")

    recs = json.load(open(os.path.join(ENR, "enrichment.json")))["records"]
    recomputed = hashlib.sha256(json.dumps(recs, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    if recomputed != ENRICHMENT_V1_HASH:
        errors.append(f"Enrichment records recompute mismatch: {recomputed}")

    for path, expected in RAW_ANCHORS.items():
        actual = _raw(path)
        if actual != expected:
            errors.append(f"Raw artifact tampered: {os.path.basename(path)} = {actual}")

    if errors:
        raise RuntimeError("STARTUP INTEGRITY CHECK FAILED: " + "; ".join(errors))

    return {
        "datasetV1Hash": DATASET_V1_HASH,
        "enrichmentV1Hash": ENRICHMENT_V1_HASH,
        "mappingCount": v1man.get("counts", {}).get("sourceCodeRecords"),
        "enrichmentRecords": enrman.get("counts", {}).get("enrichmentRecords"),
    }


if __name__ == "__main__":
    print(json.dumps(verify(), indent=2))
