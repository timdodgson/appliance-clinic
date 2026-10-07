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

DATASET_V1_HASH = "0a2a8e0cbc1601fb7018affec5b28f13779b25cd72ce70a2264e013b8f40371a"
ENRICHMENT_V1_HASH = "6301265a2a80ac28e90308b89e47c8404d2009e0c4778e8aee9c3609483a9903"

# raw-bytes sha256 anchors captured from the banked artifacts (tamper detection independent
# of the compilers' content-hash formulas)
RAW_ANCHORS = {
    os.path.join(RT, "mappings.json"): "f6355aef183df161367125f9a36ddc87bc67682de5f790b59364f90175cb68c3",
    os.path.join(RT, "schemes.json"): "ad1ec4677ac0801cc99f6ef46a3f31c835f6b953f3131e93636dd3c458db37cd",
    os.path.join(RT, "faults.json"): "54e4474878de105b4ddd9ad6c56f528ed348a7877e15a1f0de59d7274d63f845",
    os.path.join(RT, "sources.json"): "d78a8b893f205fdb135ee9ba1d23e77f54617906b2494e2eac61c993d6e41b92",
    os.path.join(ENR, "enrichment.json"): "f11cccca3f578471fa8b15f70e6104e96d8ec9146c6bf9937b30ec27be0ff9fe",
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
