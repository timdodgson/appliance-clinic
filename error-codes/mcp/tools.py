#!/usr/bin/env python3
"""ERROR-CODE MCP V1 — deterministic tool layer (transport-agnostic).

Serves ONLY the banked generated artifacts:
  error-codes/runtime-model/generated/runtime/   (Error-Code Dataset V1 — meaning/scheme/applicability)
  error-codes/enrichment/generated/              (Error-Code Enrichment V1 — optional hints/behaviour/safety)

Manufacturer-specific behaviour lives ONLY behind the existing identifier adapters
(error-codes/tools/resolve-identifier.py). This module contains NO manufacturer meaning branches:
code meaning comes exclusively from the V1 runtime resolver.

No LLM. No RAG. No network. No probabilistic guessing. All inputs are treated strictly as data.
"""
import os, re, json, importlib.util

HERE = os.path.dirname(os.path.abspath(__file__))
EC = os.path.dirname(HERE)
RT = os.path.join(EC, "runtime-model", "generated", "runtime")
ENR_DIR = os.path.join(EC, "enrichment", "generated")
SCHEMA_DIR = os.path.join(HERE, "schemas")

# --- load frozen V1 resolver (read model) ---
import sys
_COMPILER = os.path.join(EC, "runtime-model", "compiler")
if _COMPILER not in sys.path:
    sys.path.insert(0, _COMPILER)
from resolve import Resolver  # noqa: E402  (frozen V1 read model — imported, never modified)

# --- load generic identifier adapter (manufacturer edge) ---
def _load_module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

_IDENT = _load_module("ec_resolve_identifier", os.path.join(EC, "tools", "resolve-identifier.py"))

CONF_RANK = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
# discriminator attributes that a product identifier could deterministically resolve
RESOLVABLE_ATTRS = ("scheme", "generation", "platformLineage", "architecture", "region")
# generic (manufacturer-agnostic) mapping of a needed attribute -> identifier types that can supply it
ATTR_SOURCES = {
    "scheme": ["MODEL", "E_NR", "PNC", "12NC"],
    "generation": ["SERIAL", "SERIAL_YEAR", "MODEL"],
    "platformLineage": ["12NC", "MODEL"],
    "architecture": ["MODEL", "TECHNICAL_MODEL"],
    "region": ["MODEL", "COMMERCIAL_CODE"],
}
# conservative appliance synonyms -> canonical dataset appliance values (no brand logic)
APPLIANCE_SYNONYMS = {
    "washing machine": "washing-machine", "washer": "washing-machine",
    "tumble dryer": "tumble-dryer", "dryer": "tumble-dryer",
    "washer dryer": "washer-dryer", "fridge freezer": "fridge-freezer",
    "refrigerator": "fridge", "oven": "cooker-oven", "cooker": "cooker-oven",
    "hob": "hobs", "hood": "cooker-hood", "cooker hood": "cooker-hood",
    "bread maker": "breadmaker", "coffee machine": "coffee-maker",
    # Canonical client tokens whose word-order/plurality differs from the dataset appliance token.
    # The WhichPart boundary canonicalizes oven|cooker -> "oven-cooker" and vacuum -> "vacuum", but
    # the dataset keys these as "cooker-oven" and "vacuum-cleaner"; alias them so customer error
    # codes for those families resolve instead of falling through to NOT_FOUND. Purely additive.
    "oven-cooker": "cooker-oven", "vacuum": "vacuum-cleaner", "vacuum cleaner": "vacuum-cleaner",
}


class ErrorCodeTools:
    def __init__(self, store=None):
        self.R = Resolver()
        recs = json.load(open(os.path.join(ENR_DIR, "enrichment.json")))["records"]
        # index enrichment by the full stable composite (== enrichmentKey inputs), robust to aliased ids
        self.enrichment = {}
        for r in recs:
            mr = r["mappingRef"]; p = mr["provenance"]
            self.enrichment[(mr["mappingId"], p["sourceFile"], p["canonicalCode"],
                             mr["schemeId"], mr["variantId"], mr["token"])] = r
        self.sources = self.R.sources
        self.schemas = {
            "resolve-error-code": self._schema("resolve-error-code"),
            "resolve-appliance-context": self._schema("resolve-appliance-context"),
            "get-error-code-evidence": self._schema("get-error-code-evidence"),
        }
        from catalogue_store import CatalogueStore  # noqa: E402  (overlay is additive; tests inject a store)
        # Raw mappings.json list (847 source-code records). Resolver dict last-wins to 783 keys.
        baseline_mappings = json.load(open(os.path.join(RT, "mappings.json")))
        self.store = store if store is not None else CatalogueStore(
            baseline_mappings, recs, self.R.sources,
        )
        self._snap = None
        self.ensure_catalogue(force=True)

    def ensure_catalogue(self, force=False):
        snap = self.store.reload(force=force)
        if snap is self._snap:
            return snap
        self._snap = snap
        self.R = Resolver(
            mappings=snap["active_mappings"],
            schemes=self.R.schemes,
            faults=self.R.faults,
            sources=self.R.sources,
        )
        self.enrichment = snap["enrichment"]
        return snap

    def catalogue_snapshot(self):
        return self.ensure_catalogue()

    @staticmethod
    def _schema(name):
        return json.load(open(os.path.join(SCHEMA_DIR, name + ".schema.json")))

    # ---------------- normalisation (safe, deterministic; original preserved) ----------------
    @staticmethod
    def norm_make(s):
        return re.sub(r"\s+", " ", str(s).strip()).lower()

    @staticmethod
    def norm_appliance(s):
        a = re.sub(r"\s+", " ", str(s).strip()).lower()
        if a in APPLIANCE_SYNONYMS:
            return APPLIANCE_SYNONYMS[a]
        return a.replace("_", "-").replace(" ", "-")

    # code normalisation is scheme-scoped ONLY (the resolver matches token + scheme 'shown'
    # notations). No global aliases (E1==E01, E==F, i20==AL6) are created here.

    # ---------------- input validation -> INVALID_INPUT ----------------
    def _validate(self, schema, args):
        errs = []
        s = schema["inputSchema"]
        if not isinstance(args, dict):
            return ["input must be an object"]
        for req in s.get("required", []):
            if req not in args:
                errs.append(f"missing required '{req}'")
        props = s.get("properties", {})
        if s.get("additionalProperties") is False:
            for k in args:
                if k not in props:
                    errs.append(f"unexpected property '{k}'")
        for k, v in args.items():
            spec = props.get(k)
            if not spec:
                continue
            t = spec.get("type")
            if t == "string" and not isinstance(v, str):
                errs.append(f"'{k}' must be a string")
            elif t == "boolean" and not isinstance(v, bool):
                errs.append(f"'{k}' must be a boolean")
            elif t == "array" and not isinstance(v, list):
                errs.append(f"'{k}' must be an array")
            if t == "string" and isinstance(v, str) and len(v) < spec.get("minLength", 0):
                errs.append(f"'{k}' must be at least {spec['minLength']} char(s)")
            if t == "array" and isinstance(v, list):
                if len(v) < spec.get("minItems", 0):
                    errs.append(f"'{k}' must have at least {spec['minItems']} item(s)")
                item = spec.get("items", {})
                enum = (item.get("properties", {}).get("type", {}) or {}).get("enum")
                for it in v:
                    if not isinstance(it, dict):
                        errs.append(f"'{k}' items must be objects"); continue
                    for rq in item.get("required", []):
                        if rq not in it:
                            errs.append(f"'{k}' item missing '{rq}'")
                    if item.get("additionalProperties") is False:
                        for ik in it:
                            if ik not in item.get("properties", {}):
                                errs.append(f"'{k}' item has unexpected '{ik}'")
                    if enum and it.get("type") not in enum:
                        errs.append(f"'{k}' item type '{it.get('type')}' not in enum")
        return errs

    # ---------------- candidate gathering (reuses frozen resolver predicates) ----------------
    def _candidates(self, make, appliance, code):
        R = self.R
        token = R._tok(code)
        return [m for m in R.mappings.values()
                if R._brand_ok(m, make) and R._appliance_ok(m, appliance) and R._token_ok(m, token)]

    def _apply_context(self, cands, ctx):
        """Filter candidates by resolved ProductContext. scheme filter first, then eq-conditions.
        Returns (filtered, usedTrue) — context is only *applied* if it actually narrows/matches."""
        used = False
        if not ctx:
            return cands, used
        scheme = ctx.get("scheme")
        if scheme:
            byscheme = [m for m in cands if m["schemeId"] == scheme]
            if byscheme:
                cands = byscheme; used = True
        # eq-condition discriminators (generation/region/architecture/platformLineage)
        eqkeys = {k: v for k, v in ctx.items() if k in RESOLVABLE_ATTRS and k != "scheme" and v}
        if eqkeys:
            filtered = [m for m in cands if not self._context_conflict(m, eqkeys)]
            if filtered and len(filtered) < len(cands):
                cands = filtered; used = True
            elif filtered:
                cands = filtered
        return cands, used

    @staticmethod
    def _context_conflict(m, ctx):
        for c in m["applicability"]["conditions"]:
            k = c["k"]
            if k in ("appliance", "brand"):
                continue
            if k in ctx and c.get("op") == "eq" and str(ctx[k]).lower() != str(c.get("v")).lower():
                return True
        return False

    @staticmethod
    def _disc_keys(cands):
        keys = sorted({c["k"] for m in cands for c in m["applicability"]["conditions"]
                       if c["k"] not in ("appliance", "brand")})
        if len({m["schemeId"] for m in cands}) > 1 and "scheme" not in keys:
            keys = ["scheme"] + keys
        return keys

    def _enrich_for(self, m):
        key = (m["mappingId"], m["provenance"]["sourceFile"], m["provenance"]["canonicalCode"],
               m["schemeId"], m["variantId"], m["token"])
        return self.enrichment.get(key)

    def _candidate_view(self, m):
        return {"schemeId": m["schemeId"], "variantId": m["variantId"], "faultId": m["faultId"],
                "recordType": m["recordType"], "meaning": m["meaning"], "confidence": m["confidence"]}

    # ---------------- TOOL 1: resolve-error-code ----------------
    def resolve_error_code(self, args):
        errs = self._validate(self.schemas["resolve-error-code"], args)
        if errs:
            return {"status": "INVALID_INPUT", "errors": errs}
        self.ensure_catalogue()
        make = self.norm_make(args["make"])
        appliance = self.norm_appliance(args["appliance"])
        raw_code = args["code"]
        include_enr = args.get("includeEnrichment", True)
        observed = args.get("observed") or []
        region = args.get("region")

        # optional ProductContext from observed identifiers (manufacturer edge, behind adapter)
        ctx = {}
        product_context_used = False
        context_attempted = bool(observed)
        if observed:
            ident = self.resolve_appliance_context(
                {"make": args["make"], "appliance": args["appliance"], "observed": observed},
                _internal=True)
            for k in RESOLVABLE_ATTRS:
                v = (ident.get("resolvedAttributes") or {}).get(k)
                if v:
                    ctx[k] = v
        if region:
            ctx["region"] = region
            context_attempted = True

        cands = self._candidates(make, appliance, raw_code)
        if not cands:
            return {"status": "NOT_FOUND", "make": args["make"], "appliance": appliance,
                    "code": {"input": raw_code, "displayed": raw_code},
                    "reason": "No mapping for this make + appliance + code. Bare codes are never globally resolvable."}

        cands, used = self._apply_context(cands, ctx)
        product_context_used = used

        # source-unresolved: the source itself cannot be split by any product attribute
        if any((m.get("ambiguity") or {}).get("unresolved") for m in cands):
            return self._ambiguous(cands, raw_code, reason="SOURCE_UNRESOLVED",
                                   detail="The underlying source does not deterministically separate these meanings.")

        faults = sorted({m["faultId"] for m in cands})
        if len(faults) == 1:
            best = sorted(cands, key=lambda m: CONF_RANK.get(m["confidence"], 3))[0]
            return self._resolved(best, raw_code, product_context_used, include_enr,
                                  make_label=args["make"], appliance_label=appliance)

        # multiple distinct meanings remain
        disc = self._disc_keys(cands)
        resolvable = [k for k in disc if k in RESOLVABLE_ATTRS]
        if not context_attempted and resolvable:
            return {
                "status": "NEEDS_CONTEXT",
                "reason": "The displayed code has different meanings on different "
                          f"{appliance} schemes/platforms; product context is required to resolve it.",
                "code": {"input": raw_code, "displayed": raw_code},
                "make": args["make"], "appliance": appliance,
                "needs": [{"attribute": k, "resolutionSources": ATTR_SOURCES.get(k, ["MODEL"])} for k in resolvable],
                "candidates": [self._candidate_view(m) for m in cands],
            }
        return self._ambiguous(cands, raw_code, reason="MULTIPLE_MAPPINGS",
                               detail="Available context cannot deterministically select one mapping.")

    def _customer_displayed(self, raw_code, shown):
        """The token the customer submitted, never a sibling alias from the mapping.

        A mapping's `shown` list is lookup keys (canonical + aliases). Using shown[0]
        would rewrite a customer E21 into a related E20. If a shown form is the SAME
        code (punctuation-insensitive), use that form; otherwise keep the input.
        """
        folded = self.R._fold(raw_code)
        tok = self.R._tok(raw_code)
        for s in shown or []:
            if not s:
                continue
            if self.R._fold(s) == folded or self.R._tok(s) == tok:
                return s
        return raw_code

    def _resolved(self, m, raw_code, ctx_used, include_enr, make_label=None, appliance_label=None):
        displayed = self._customer_displayed(raw_code, m.get("shown"))
        out = {
            "status": "RESOLVED",
            "code": {"input": raw_code, "displayed": displayed},
            "make": make_label,
            "appliance": appliance_label,
            "recordType": m["recordType"],
            "meaning": m["meaning"],
            "system": m.get("system"),
            "confidence": m["confidence"],
            "scheme": {"schemeId": m["schemeId"], "variantId": m["variantId"]},
            "notation": m.get("notation"),
            "productContextUsed": ctx_used,
            "evidenceRefs": sorted(m.get("sourceRefs", [])),
        }
        if include_enr:
            e = self._enrich_for(m)
            out["enrichment"] = None if e is None else {
                "enrichmentKey": e["enrichmentKey"],
                "components": e["diagnosticHints"]["components"],
                "likelyCauses": e["diagnosticHints"]["likelyCauses"],
                "checks": e["diagnosticHints"]["checks"],
                "behaviour": e["behaviour"],
                "safety": {"class": e["safety"]["class"], "stopUse": e["safety"]["stopUse"],
                           "reason": e["safety"]["reason"]},
                "confidence": e["confidence"],
            }
        return out

    def _ambiguous(self, cands, raw_code, reason, detail):
        return {
            "status": "AMBIGUOUS",
            "reason": reason,
            "detail": detail,
            "code": {"input": raw_code, "displayed": raw_code},
            "ambiguityDimensions": self._disc_keys(cands),
            "candidates": [dict(self._candidate_view(m),
                                confidence=m["confidence"],
                                evidenceRefs=sorted(m.get("sourceRefs", []))) for m in cands],
        }

    # ---------------- TOOL 2: resolve-appliance-context ----------------
    def resolve_appliance_context(self, args, _internal=False):
        errs = self._validate(self.schemas["resolve-appliance-context"], args)
        if errs:
            return {"status": "INVALID_INPUT", "errors": errs}
        make = args["make"]
        appliance = self.norm_appliance(args["appliance"])
        observed = args["observed"]
        r = _IDENT.resolve_identifier(make, appliance, observed)
        if r.get("error"):
            return {"status": "NOT_APPLICABLE",
                    "canonicalProduct": {"make": make, "appliance": appliance, "model": None},
                    "resolvedAttributes": {"scheme": None, "platformLineage": None, "generation": None,
                                           "architecture": None, "region": None},
                    "confidence": "LOW",
                    "evidence": [f"No identifier adapter for '{make}'; code meaning for this brand is "
                                 f"typically identifier-independent (resolve via make+appliance+code)."]}
        ra = r.get("resolvedAttributes", {})
        attrs = {"scheme": ra.get("scheme"), "platformLineage": ra.get("platformLineage"),
                 "generation": ra.get("generation"), "architecture": ra.get("architecture"),
                 "region": None}
        status = self._context_status(r)
        out = {
            "status": status,
            "canonicalProduct": {
                "make": r.get("brand") or make,
                "appliance": appliance,
                "model": (r.get("canonicalProduct") or {}).get("model"),
            },
            "resolvedAttributes": attrs,
            "confidence": r.get("confidence", "LOW"),
            "evidence": r.get("evidence", []),
        }
        if status == "NEEDS_CONTEXT":
            out["needs"] = r.get("needs", [])
        return out

    @staticmethod
    def _context_status(r):
        rs = r.get("resolutionStatus")
        if r.get("resolved"):
            return "RESOLVED"
        if rs == "INVALID_IDENTIFIER":
            return "INVALID_INPUT"
        if rs and rs.startswith("NEEDS_"):
            return "NEEDS_CONTEXT"
        if rs in ("MODEL_SUPPLIED_SCHEME_UNRESOLVED", "IDENTIFIER_UNRESOLVED", "MODEL_RESOLVED_IDENTIFIER_UNKNOWN"):
            return "NEEDS_CONTEXT"
        if rs == "NOT_APPLICABLE":
            return "NOT_APPLICABLE"
        return "AMBIGUOUS"

    # ---------------- TOOL 3 (internal/debug): get-error-code-evidence ----------------
    def get_error_code_evidence(self, args):
        errs = self._validate(self.schemas["get-error-code-evidence"], args)
        if not (args.get("enrichmentKey") or args.get("mappingId")):
            errs.append("one of 'enrichmentKey' or 'mappingId' is required")
        if errs:
            return {"status": "INVALID_INPUT", "errors": errs}
        m = None
        if args.get("mappingId"):
            m = self.R.mappings.get(args["mappingId"])
        if m is None and args.get("enrichmentKey"):
            for rec in self.enrichment.values():
                if rec["enrichmentKey"] == args["enrichmentKey"]:
                    m = self.R.mappings.get(rec["mappingRef"]["mappingId"]); break
        if m is None:
            return {"status": "NOT_FOUND", "reason": "no mapping for supplied reference"}
        srcs = []
        for sid in m.get("sourceRefs", []):
            s = self.sources.get(sid, {"sourceId": sid})
            srcs.append({"sourceId": s.get("sourceId", sid), "sourceType": s.get("sourceType"),
                         "label": (s.get("title") or s.get("publisher") or s.get("url") or "")[:120]})
        return {
            "status": "OK",
            "mappingId": m["mappingId"],
            "scheme": {"schemeId": m["schemeId"], "variantId": m["variantId"]},
            "applicability": m["applicability"]["conditions"],
            "recordType": m["recordType"],
            "confidence": m["confidence"],
            "confidenceRationale": self._conf_rationale(m, srcs),
            "provenance": m["provenance"],
            "sourceIdentity": srcs,
        }

    @staticmethod
    def _conf_rationale(m, srcs):
        types = {s.get("sourceType") for s in srcs}
        if m["confidence"] == "HIGH":
            return f"HIGH: grounded in {sorted(t for t in types if t)} source evidence."
        if m["confidence"] == "MEDIUM":
            return f"MEDIUM: family/heuristic or secondary evidence {sorted(t for t in types if t)}."
        return "LOW: discovery-only / no trusted anchor."

    # ---------------- dispatch ----------------
    def dispatch(self, tool, args):
        if tool == "resolve-error-code":
            return self.resolve_error_code(args)
        if tool == "resolve-appliance-context":
            return self.resolve_appliance_context(args)
        if tool == "get-error-code-evidence":
            return self.get_error_code_evidence(args)
        return {"status": "INVALID_INPUT", "errors": [f"unknown tool '{tool}'"]}

    def tool_manifest(self, include_internal=False):
        out = []
        for name in ("resolve-error-code", "resolve-appliance-context", "get-error-code-evidence"):
            s = self.schemas[name]
            if s.get("internal") and not include_internal:
                continue
            out.append({"name": s["name"], "description": s["description"], "inputSchema": s["inputSchema"]})
        return out


if __name__ == "__main__":
    import pprint
    t = ErrorCodeTools()
    pprint.pprint(t.resolve_error_code({"make": "Bosch", "appliance": "dishwasher", "code": "E15"}))
