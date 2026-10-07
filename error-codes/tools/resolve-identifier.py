#!/usr/bin/env python3
"""GENERIC identifier resolver (NOT an MCP, no LLM, no network). Dispatches to
manufacturer-specific adapters and returns ONE standard response shape. The caller stays
manufacturer-agnostic. Adapters: ELECTROLUX (PNC/ELC), WHIRLPOOL (12NC->lineage),
MIELE (model+serial->generation), BSH (E-Nr->scheme)."""
import re, json, os
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def base_resp(mfg, brand, appliance, model=None):
    return {"resolved": False, "manufacturerGroup": mfg, "brand": brand, "appliance": appliance,
            "observedIdentifiers": [],
            "canonicalProduct": {"model": model, "identifiers": []},
            "resolvedAttributes": {"platformLineage": None, "generation": None, "architecture": None, "scheme": None},
            "resolutionStatus": "IDENTIFIER_UNRESOLVED",
            "needs": [], "ambiguity": [], "confidence": "LOW", "evidence": []}

# ---- adapters ----
def adapt_electrolux(brand, appliance, ids):
    r = base_resp("ELECTROLUX", brand, appliance)
    for i in ids:
        v = i["value"].upper()
        if re.match(r'^(9\d{8}|6\d{8})(-\d{2})?$', v):
            base = v.split('-')[0]; elc = v.split('-')[1] if '-' in v else None
            r["canonicalProduct"]["identifiers"].append({"type": "PNC", "value": base, "elc": elc})
            r["resolvedAttributes"]["scheme"] = "ELX_WM_EXX" if base[:3] == "914" else ("ELX_DW_IXX" if base[:3] == "911" else None)
            r["resolved"] = True; r["confidence"] = "HIGH"; r["evidence"].append("PNC prefix->appliance")
        elif re.match(r'^[A-Z]', v):
            r["canonicalProduct"]["model"] = v; r["resolved"] = True; r["confidence"] = "MEDIUM"
            r["evidence"].append("model; PNC recoverable via service PDF (not needed for modern code meaning)")
    return r

def adapt_whirlpool(brand, appliance, ids):
    r = base_resp("WHIRLPOOL", brand, appliance)
    for i in ids:
        v = i["value"].upper()
        if re.match(r'^\d{12}$', v):
            lin = "MERLONI" if v.startswith("8699") else ("WHIRLPOOL_NATIVE" if (v[:3] in ("851","853","857","859","852") or v.startswith("481")) else "UNKNOWN_LINEAGE")
            r["canonicalProduct"]["identifiers"].append({"type": "12NC", "value": v})
            r["resolvedAttributes"]["platformLineage"] = lin
            r["resolvedAttributes"]["scheme"] = "WHIRL_WM_FNN" if lin == "MERLONI" else ("WHIRL_WM_FNEN" if lin == "WHIRLPOOL_NATIVE" else None)
            r["resolved"] = lin != "UNKNOWN_LINEAGE"; r["confidence"] = "MEDIUM"; r["evidence"].append("12NC prefix->lineage")
        elif re.fullmatch(r'\d{1,6}', v):
            r["ambiguity"].append("5-digit spares code, not a 12NC"); r["resolutionStatus"] = "INVALID_IDENTIFIER"
        elif re.match(r'^[A-Z]', v):
            r["canonicalProduct"]["model"] = v
            if brand.lower() in ("hotpoint", "indesit"):
                r["resolvedAttributes"]["platformLineage"] = "MERLONI"; r["resolvedAttributes"]["scheme"] = "WHIRL_WM_FNN"
                r["resolved"] = True; r["confidence"] = "MEDIUM"; r["evidence"].append("brand+family implies Merloni (12NC 8699 recoverable via official URL)")
            else:
                r["needs"].append({"attribute": "platformLineage", "resolutionSources": ["12NC"]})
    return r

def adapt_miele(brand, appliance, ids):
    r = base_resp("MIELE", brand, appliance)
    model = None; serial = None
    for i in ids:
        if i["type"] in ("SERIAL", "SERIAL_YEAR") or re.fullmatch(r'\d{8,9}', i["value"]): serial = i["value"]
        elif re.match(r'^[GWP]', i["value"].upper()): model = i["value"].upper()
    r["canonicalProduct"]["model"] = model
    if model and appliance == "dishwasher":
        m = model.replace(" ", "")
        if re.match(r'^G-?7\d{3}', m): gen = ("DW_G7_NEW", "HIGH")
        elif re.match(r'^G-?[1-46]\d{3}', m): gen = ("DW_G1_G6_OLD", "HIGH")
        elif re.match(r'^G-?5\d{3}', m):
            if serial and re.fullmatch(r'\d{8,9}', serial):
                yy = int(serial[:2]); year = 2000 + yy if yy < 40 else 1900 + yy
                gen = ("DW_G7_NEW" if year >= 2019 else "DW_G1_G6_OLD", "MEDIUM")
            else:
                gen = (None, None); r["needs"].append({"attribute": "generation", "resolutionSources": ["SERIAL_YEAR"]})
        elif re.match(r'^G-?\d{3}(?!\d)', m): gen = ("LEGACY_3DIGIT", "MEDIUM")
        else: gen = (None, None)
        if gen[0]:
            r["resolvedAttributes"]["generation"] = gen[0]; r["resolved"] = True; r["confidence"] = gen[1]
            r["evidence"].append("model-range" + ("+serial-year(MEDIUM)" if gen[1] == "MEDIUM" and serial else ""))
    elif model:
        r["resolved"] = True; r["confidence"] = "MEDIUM"; r["evidence"].append("WM model; generation rarely code-relevant")
    return r

_BSH_INDEX = None
def _bsh_index():
    global _BSH_INDEX
    if _BSH_INDEX is None:
        _BSH_INDEX = json.load(open(os.path.join(BASE, "identifier-map/bsh-enr-scheme-index.json")))
    return _BSH_INDEX

def _split_enr(v):
    """Raw E-Nr -> (base, revision). Revision = /xx (rating plate) or -xx (catalogue). Preserve raw."""
    v = v.strip().upper()
    m = re.match(r'^([A-Z0-9]+)\s*[/\-]\s*(\d{1,2}[A-Z]?)$', v)
    if m:
        return m.group(1), m.group(2)
    return v, None

def adapt_bsh(brand, appliance, ids):
    """REAL trusted BSH data path (NO prefix guess):
       E-Nr base -> exact model anchor -> document -> signature -> scheme   (HIGH)
       else       -> curated collision-checked documented family -> scheme  (MEDIUM)
       else       -> MODEL_SUPPLIED_SCHEME_UNRESOLVED (no silent prefix fallback)."""
    r = base_resp("BSH", brand, appliance)
    idx = _bsh_index()
    for i in ids:
        raw = i["value"].strip().upper()
        # an E-Nr looks like letters/digits, optionally with a /xx or -xx revision
        if not re.match(r'^[A-Z0-9]{3,}([/\-]\d{1,2}[A-Z]?)?$', raw) or re.fullmatch(r'\d{1,6}', raw):
            r["ambiguity"].append(f"'{raw}' is not a BSH E-Nr")
            continue
        base, rev = _split_enr(raw)
        r["observedIdentifiers"] = r.get("observedIdentifiers", []) + [{"type": "E_NR", "value": raw}]
        r["canonicalProduct"]["identifiers"].append({"type": "E_NR_BASE", "value": base})
        if rev:
            # /xx is NON_SEMANTIC for code scheme (scheme set by base->document). Preserve, do not discard.
            r["canonicalProduct"]["identifiers"].append(
                {"type": "E_NR_REVISION", "value": rev, "affectsScheme": False, "note": "non-semantic for code meaning; may affect parts"})

        # 1) EXACT anchor (trusted, HIGH): base == an exact model for this appliance
        exact = next((a for a in idx["exactAnchors"]
                      if a["appliance"] == appliance and a["model"].upper() == base
                      and (not brand or a["brand"].lower() == brand.lower())), None)
        if exact:
            r["resolvedAttributes"]["scheme"] = exact["scheme"]
            r["resolved"] = True; r["confidence"] = "HIGH"
            r["resolutionStatus"] = "RESOLVED"
            sig = exact.get("signatureHash"); doc = exact.get("documentId")
            r["evidence"].append(
                f"E_NR_BASE '{base}' EXACT -> document {doc} -> signature {sig} -> {exact['scheme']} (official BSH doc)")
            continue

        # 2) DOCUMENTED FAMILY (trusted MEDIUM only): collision-checked curated range, never overrides exact
        fam = None
        for f in idx.get("resolverFamilies", []):
            if f["appliance"] != appliance or not f.get("trustedForResolution"):
                continue
            if any(base.startswith(p) for p in f["prefixes"]):
                # longest-prefix wins (avoid S matching before SGS etc.)
                if fam is None or max(len(p) for p in f["prefixes"] if base.startswith(p)) > \
                                  max(len(p) for p in fam["prefixes"] if base.startswith(p)):
                    fam = f
        if fam:
            r["resolvedAttributes"]["scheme"] = fam["scheme"]
            r["resolved"] = True; r["confidence"] = "MEDIUM"
            r["resolutionStatus"] = "RESOLVED"
            matched = max((p for p in fam["prefixes"] if base.startswith(p)), key=len)
            r["evidence"].append(
                f"E_NR_BASE '{base}' -> documented family '{matched}...' -> {fam['scheme']} "
                f"(MEDIUM; {fam.get('guard', 'documented range applicability')})")
            continue

        # 3) candidate-only families (era-spanning): surface as discovery signal, DO NOT resolve
        cand = next((f for f in idx.get("resolverFamilies", [])
                     if f["appliance"] == appliance and not f.get("trustedForResolution")
                     and any(base.startswith(p) for p in f["prefixes"])), None)

        # 4) UNKNOWN: no trusted anchor. NO prefix fallback.
        r["resolved"] = False; r["confidence"] = "LOW"
        r["resolutionStatus"] = "MODEL_SUPPLIED_SCHEME_UNRESOLVED"
        r["needs"].append({"attribute": "scheme", "resolutionSources": ["E_NR", "DOCUMENT"]})
        if cand:
            r["ambiguity"].append(
                f"E_NR_BASE '{base}' matches candidate family {cand['prefixes']} ({cand['scheme']}) but prefix is "
                f"era-spanning/discovery-only; NOT used for trusted resolution (needs exact E-Nr/document)")
        r["evidence"].append(
            f"E_NR_BASE '{base}' has no trusted exact/document anchor; prefix is discovery-only (NOT a trusted scheme signal)")
    return r

ADAPTERS = {"electrolux": adapt_electrolux, "aeg": adapt_electrolux, "zanussi": adapt_electrolux,
            "whirlpool": adapt_whirlpool, "hotpoint": adapt_whirlpool, "indesit": adapt_whirlpool,
            "miele": adapt_miele, "bosch": adapt_bsh, "siemens": adapt_bsh, "neff": adapt_bsh}
GROUP = {"electrolux": "ELECTROLUX", "aeg": "ELECTROLUX", "zanussi": "ELECTROLUX",
         "whirlpool": "WHIRLPOOL", "hotpoint": "WHIRLPOOL", "indesit": "WHIRLPOOL",
         "miele": "MIELE", "bosch": "BSH", "siemens": "BSH", "neff": "BSH"}

_NEEDS_STATUS = {"platformLineage": "NEEDS_PLATFORM", "generation": "NEEDS_GENERATION",
                 "scheme": "NEEDS_SCHEME", "architecture": "NEEDS_ARCHITECTURE"}

def _normalize_status(r):
    """Fill resolutionStatus consistently across all adapters (contract V1). Respects a status an
    adapter already set to something other than the base default."""
    if r.get("resolutionStatus") not in (None, "IDENTIFIER_UNRESOLVED"):
        return r
    if r.get("resolved"):
        r["resolutionStatus"] = "RESOLVED"
    elif r.get("needs"):
        r["resolutionStatus"] = _NEEDS_STATUS.get(r["needs"][0]["attribute"], "NEEDS_IDENTIFIER_TYPE")
    elif any("INVALID" in a.upper() or "not a" in a.lower() for a in r.get("ambiguity", [])):
        r["resolutionStatus"] = "INVALID_IDENTIFIER"
    else:
        r["resolutionStatus"] = "IDENTIFIER_UNRESOLVED"
    return r

def resolve_identifier(make, appliance, observed):
    a = ADAPTERS.get(make.lower())
    if not a: return {"resolved": False, "error": f"no adapter for {make}"}
    r = a(make, appliance, observed); r["manufacturerGroup"] = GROUP.get(make.lower())
    return _normalize_status(r)

if __name__ == "__main__":
    tests = [
        ("Electrolux", "washing-machine", [{"type": "MODEL", "value": "EWF1487"}]),
        ("AEG", "washing-machine", [{"type": "PNC", "value": "914528104-01"}]),
        ("Whirlpool", "washing-machine", [{"type": "12NC", "value": "851693838201"}]),
        ("Hotpoint", "washing-machine", [{"type": "12NC", "value": "869991684430"}]),
        ("Hotpoint", "washing-machine", [{"type": "MODEL", "value": "NSWM1043CWUK"}]),
        ("Miele", "dishwasher", [{"type": "MODEL", "value": "G7100"}]),
        ("Miele", "dishwasher", [{"type": "MODEL", "value": "G5000"}]),
        ("Miele", "dishwasher", [{"type": "MODEL", "value": "G5000"}, {"type": "SERIAL", "value": "19045678"}]),
        ("Bosch", "dishwasher", [{"type": "E_NR", "value": "SMV4HVX32E/01"}]),
        ("Bosch", "dishwasher", [{"type": "E_NR", "value": "SGS4472GB/12"}]),
        ("Bosch", "dishwasher", [{"type": "E_NR", "value": "SMS8YCI03E/45"}]),
        ("Bosch", "washing-machine", [{"type": "E_NR", "value": "WGG244FCGB/01"}]),
        ("Bosch", "washing-machine", [{"type": "E_NR", "value": "WFF1101GB/14"}]),
    ]
    out = []
    for make, app, obs in tests:
        r = resolve_identifier(make, app, obs)
        ra = r["resolvedAttributes"]; attrs = {k: v for k, v in ra.items() if v}
        s = f"{make:11s} {app[:2]} {str(obs[0]['value'])[:16]:16s} -> resolved={r['resolved']} {attrs} needs={[n['attribute'] for n in r['needs']]} [{r['confidence']}]"
        print(s); out.append(s)
    open(os.path.join(BASE, "identifier-layer/identifier-simulation.txt"), "w").write("\n".join(out) + "\n")
