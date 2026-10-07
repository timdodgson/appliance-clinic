#!/usr/bin/env python3
"""Deterministic runtime resolver over the generated artifacts (read model).
Pure function, offline, no LLM. Used by tests and future callers.
This is NOT the MCP/transport - just the lookup logic the artifacts are designed for."""
import json, os, re

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "generated", "runtime")

def _load(name): return json.load(open(os.path.join(OUT, name)))

class Resolver:
    def __init__(self, mappings=None, schemes=None, faults=None, sources=None):
        # Optional injected mappings let the MCP serve baseline + admin overlay
        # without changing lookup predicates. Default remains the banked files.
        if mappings is None:
            mappings = {m["mappingId"]: m for m in _load("mappings.json")}
        elif isinstance(mappings, list):
            mappings = {m["mappingId"]: m for m in mappings}
        self.mappings = mappings
        self.schemes = schemes if schemes is not None else {s["schemeId"]: s for s in _load("schemes.json")}
        self.faults = faults if faults is not None else {f["faultId"]: f for f in _load("faults.json")}
        self.sources = sources if sources is not None else {s["sourceId"]: s for s in _load("sources.json")}

    @staticmethod
    def _tok(c): return re.sub(r"\s+", "", str(c).strip().upper())
    @staticmethod
    def _brand(b): return re.sub(r"\s+", " ", str(b).strip().lower())

    @staticmethod
    def _fold(c):
        """Punctuation-insensitive form of a displayed code for lookup.

        Customers write manufacturer subcodes with mixed separators (`E:36-10`,
        `E36/-10`, `E36/E10`, spaces, missing colons). Fold those into one key
        so a mapping is found from the banked token / shown forms / canonical
        code. Letter-repeat on a suffix (`E36/E10`) is treated as the numeric
        subcode (`E36-10`), not as two independent codes. Distinct letter
        prefixes (`E36/F36`) stay distinct. No manufacturer-specific branches.
        """
        t = re.sub(r"\s+", "", str(c or "").strip().upper())
        t = t.replace("<->", "-").replace(":", "").replace("/", "-")
        t = re.sub(r"-{2,}", "-", t).strip("-")
        prev = None
        while prev != t:
            prev = t
            def _drop_repeat(m):
                a, n1, b, n2 = m.group(1), m.group(2), m.group(3), m.group(4)
                return f"{a}{n1}-{n2}" if a == b else m.group(0)
            t = re.sub(r"([A-Z]{1,3})(\d{1,3})-([A-Z]{1,3})(\d{1,3})(?=-|$)", _drop_repeat, t)
        return t

    def _cond_map(self, m): return {c["k"]: c for c in m["applicability"]["conditions"]}

    def _appliance_ok(self, m, appliance):
        c = self._cond_map(m).get("appliance")
        if not c or c["op"] == "any": return True
        a = appliance.strip().lower()
        return a in (c.get("v") or [])

    def _brand_ok(self, m, brand):
        c = self._cond_map(m).get("brand")
        if not c: return True
        return self._brand(brand) in (c.get("v") or [])

    def _token_ok(self, m, token):
        folded = self._fold(token)
        keys = {self._fold(m.get("token")), self._tok(m.get("token"))}
        keys.update(self._fold(x) for x in (m.get("shown") or []))
        keys.update(self._tok(x) for x in (m.get("shown") or []))
        canon = (m.get("provenance") or {}).get("canonicalCode")
        if canon:
            keys.add(self._fold(canon))
            keys.add(self._tok(canon))
        keys.discard("")
        keys.discard(None)
        if token == m["token"] or token in keys:
            return True
        return folded in keys

    def _context_conflict(self, m, ctx):
        """Return set of discriminator keys where provided context contradicts this mapping."""
        bad = set()
        if not ctx: return bad
        for c in m["applicability"]["conditions"]:
            k = c["k"]
            if k in ("appliance", "brand"): continue
            if k in ctx and c.get("op") == "eq":
                if str(ctx[k]).lower() != str(c.get("v")).lower():
                    bad.add(k)
        return bad

    def resolve(self, make, appliance, code, productContext=None):
        token = self._tok(code)
        ctx = {k: v for k, v in (productContext or {}).items()}
        cands = [m for m in self.mappings.values()
                 if self._brand_ok(m, make) and self._appliance_ok(m, appliance) and self._token_ok(m, token)]
        # context filtering: drop mappings whose eq-discriminator contradicts supplied context
        if ctx:
            filtered = [m for m in cands if not self._context_conflict(m, ctx)]
            if filtered: cands = filtered
        if not cands:
            return {"status": "NOT_FOUND", "make": make, "appliance": appliance, "code": code}
        unresolved = [m for m in cands if (m.get("ambiguity") or {}).get("unresolved")]
        faults = sorted({m["faultId"] for m in cands})
        variants = sorted({(m["schemeId"], m["variantId"]) for m in cands})
        # disambiguator dimensions = discriminator condition keys that differ across candidates
        disc_keys = sorted({c["k"] for m in cands for c in m["applicability"]["conditions"]
                            if c["k"] not in ("appliance", "brand")})
        def view(m):
            return {"mappingId": m["mappingId"], "schemeId": m["schemeId"], "variantId": m["variantId"],
                    "shown": m["shown"], "notation": m["notation"], "faultId": m["faultId"],
                    "recordType": m["recordType"], "meaning": m["meaning"], "confidence": m["confidence"],
                    "sources": [self.sources.get(r, {"sourceId": r}) for r in m.get("sourceRefs", [])],
                    "ambiguity": m.get("ambiguity")}
        if unresolved:
            return {"status": "AMBIGUOUS", "reason": "SOURCE_UNRESOLVED",
                    "disambiguateBy": disc_keys or ["source"], "candidates": [view(m) for m in cands]}
        if len(faults) == 1:
            best = sorted(cands, key=lambda m: {"HIGH": 0, "MEDIUM": 1, "LOW": 2}.get(m["confidence"], 3))[0]
            return {"status": "RESOLVED", "faultId": faults[0], "recordType": best["recordType"],
                    "meaning": best["meaning"], "confidence": best["confidence"],
                    "scheme": best["schemeId"], "notation": best["notation"], "shown": best["shown"],
                    "sources": [self.sources.get(r, {"sourceId": r}) for r in best.get("sourceRefs", [])]}
        return {"status": "AMBIGUOUS", "reason": "MULTIPLE_MAPPINGS",
                "disambiguateBy": disc_keys or ["scheme"], "candidates": [view(m) for m in cands]}

if __name__ == "__main__":
    r = Resolver()
    import pprint; pprint.pprint(r.resolve("Bosch", "dishwasher", "E22"))
