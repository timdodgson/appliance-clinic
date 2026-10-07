#!/usr/bin/env python3
"""Ports (interfaces) + service implementations for the orchestrator.

Ports:
  ErrorCodeService       -> resolve_error_code / resolve_appliance_context (deterministic MCP)
  DiagnosticService      -> diagnose (probabilistic RAG) — FAKE in this prototype
  ConversationStateStore -> get / put session state
  ResponseComposer       -> deterministic customer-facing text (lives in orchestrator.py)

Implementations here:
  FakeErrorCodeService   -> canned MCP-shaped responses (deterministic core tests)
  McpErrorCodeService    -> calls the REAL deployed Error-Code MCP over Streamable HTTP + bearer
  FakeDiagnosticService  -> deterministic stand-in for the Diagnostic RAG (NEVER the real RAG here)

All inputs are treated as data. No implementation interprets instructions embedded in strings.
"""
from __future__ import annotations
from typing import Protocol, Optional, Any
import os
import re as _re


def rag_safety_from_done(done: dict, reason=None):
    """Map a RAG done-event onto orchestrator safety class.

    Isolation before proposed physical access is a SYSTEM_SAFETY_RULE on that
    action, not a customer-reported hazard. It must never become STOP_USE and
    must never override a PROFESSIONAL_ONLY refuse (microwave HV internals).
    """
    done = done or {}
    reason = reason if reason is not None else done.get("safetyStop")
    safety_cls = {"gas": "EMERGENCY_ACTION", "shock": "STOP_USE", "burning": "STOP_USE",
                  "electrical": "STOP_USE"}.get(reason, "NORMAL_DIAGNOSTIC")
    si = done.get("safetyInformation") or {}
    si_class = si.get("classification") if isinstance(si, dict) else None
    if si_class == "PROFESSIONAL_ONLY":
        return "NORMAL_DIAGNOSTIC", reason
    if safety_cls == "NORMAL_DIAGNOSTIC" and done.get("isolationAdvisory"):
        safety_cls = "ISOLATE_IF_SAFE"
    if safety_cls == "NORMAL_DIAGNOSTIC" and si_class in ("STOP_USE", "EMERGENCY_ACTION"):
        safety_cls = "EMERGENCY_ACTION" if si_class == "EMERGENCY_ACTION" else "STOP_USE"
        if not reason:
            reason = "gas" if si_class == "EMERGENCY_ACTION" else "electrical"
    return safety_cls, reason


# ---------------- ports ----------------
class ErrorCodeService(Protocol):
    def resolve_error_code(self, make: str, appliance: str, code: str,
                           observed: Optional[list] = None, region: Optional[str] = None,
                           includeEnrichment: bool = True) -> dict: ...
    def resolve_appliance_context(self, make: str, appliance: str, observed: list) -> dict: ...


class DiagnosticService(Protocol):
    # Story 3: understand() runs the SINGLE Jev UNDERSTAND before routing; diagnose() consumes the
    # SAME typed result (understand=) instead of re-running Jev.
    def understand(self, *, symptoms: str, image: Optional[str] = None,
                   conversation: Optional[list] = None,
                   established: Optional[dict] = None,
                   canonical: Optional[dict] = None) -> dict: ...
    def diagnose(self, *, symptoms: str, appliance: Optional[str], make: Optional[str],
                 trusted: Optional[dict] = None, conversation: Optional[list] = None,
                 understand: Optional[dict] = None,
                 established: Optional[dict] = None,
                 canonical: Optional[dict] = None) -> dict: ...
    # `canonical` is the BFF-owned cs/1 block (understand) or the merged result (diagnose), transported
    # verbatim. It is passed ONLY when the BFF supplied one, so implementations without it are unaffected.


class ConversationStateStore(Protocol):
    def get(self, session_id: str): ...
    def put(self, state) -> None: ...


# ---------------- in-memory state store ----------------
class InMemoryStateStore:
    def __init__(self):
        self._m: dict[str, Any] = {}

    def get(self, session_id: str):
        return self._m.get(session_id)

    def put(self, state) -> None:
        self._m[state.sessionId] = state


# ---------------- FAKE Diagnostic RAG (deterministic; stands in for services/part-finder) ----------------
class FakeDiagnosticService:
    """Deterministic stand-in for the two-pass Diagnostic RAG. Returns a RAG-shaped result.

    Rules are keyword-based ONLY so orchestration tests are reproducible. It intentionally does
    NOT know error-code meanings; when given `trusted` context it may align/refine but never
    fabricates certainty. Mirrors the real RAG's contract: {grounded, faultId, faultLabel,
    system, confidence, candidateComponents, clarifyingQuestion, safety}.
    """
    RULES = [
        (("lost suction", "no suction", "pulsing", "pulsating", "surges", "cuts out then starts"),
         ("lost-suction", "Lost suction / airflow blockage", "airflow", 0.88,
          ["filter", "hose blockage", "bin"])),
        (("won't drain", "wont drain", "not draining", "water left in the drum", "won't empty"),
         ("not-draining", "Not draining / won't empty", "drain", 0.86, ["drain pump", "pump filter", "drain hose"])),
        (("leaking underneath", "water underneath", "puddle", "water on the floor", "leaking water", "leak"),
         ("leak-flood", "Leak", "leak", 0.85, ["door seal", "sump hose", "drain pump"])),
        (("won't spin", "wont spin", "not spinning"),
         ("motor-drum", "Motor / drum", "motor", 0.72, ["carbon brushes", "drive belt", "motor"])),
        (("no heat", "not heating", "stays cold", "cold wash", "won't heat"),
         ("heater", "Heater / heating fault", "heating", 0.8, ["heating element", "thermostat", "ntc"])),
        (("won't fill", "not filling", "no water", "trickles in"),
         ("inlet-valve", "Fill / water inlet fault", "fill", 0.8, ["inlet valve", "inlet filter"])),
        (("fridge fan", "evaporator fan", "fan not spinning", "fan isn't spinning", "fan not running"),
         ("evaporator-fan", "Evaporator fan fault", "evaporator-fan", 0.82,
          ["evaporator fan motor", "fan blade", "defrost heater", "defrost thermostat"])),
    ]
    # Error-code -> fault grounding. Mirrors the REAL part-finder's resolveFault(errorCode), which
    # resolves a RECOGNISED code to a fault node independently of symptom prose AND is isolated by
    # make+appliance (Samsung FF 22C -> evaporator-fan; LG 22C / Samsung washing-machine 22C /
    # no-make 22C stay UNRESOLVED). Keyed by (make, appliance-normalised, code) so that isolation is
    # preserved. Consulted ONLY when no symptom rule matched, so the symptom-driven tests above are
    # unaffected. (The FakeErrorCodeService owns code MEANING/ambiguity; this owns the runtime
    # diagnostic resolution the orchestrator reconciles against — the two are deliberately separate.)
    _FAN = ("evaporator-fan", "Evaporator fan fault", "evaporator-fan", 0.82,
            ["evaporator fan motor", "fan blade", "defrost heater", "defrost thermostat"])
    CODE_FAULTS = {
        ("samsung", "fridge-freezer", "22c"): _FAN,
        ("samsung", "fridge-freezer", "22e"): _FAN,
        ("samsung", "fridge-freezer", "23e"): _FAN,
        # runtime grounds a FAN fault for 40E too; the MCP's meanings for 40E diverge (fan vs
        # compressor), so the orchestrator must still clarify — this exercises that conflict gate.
        ("samsung", "fridge-freezer", "40e"): ("evaporator-fan", "Evaporator fan fault",
                                               "evaporator-fan", 0.80, ["evaporator fan motor", "fan blade"]),
    }
    # Mirror the real RAG's deterministic categories: (cue, reason). Gas is an EMERGENCY_ACTION
    # (bespoke gas guidance); shock/burning are STOP_USE with cause-specific wording downstream.
    SAFETY_HINTS = (("smell of gas", "gas"), ("gas leak", "gas"),
                    ("burning", "burning"), ("burnt smell", "burning"), ("smells electrical", "burning"),
                    ("shock", "shock"))
    _REASON_CLASS = {"gas": "EMERGENCY_ACTION", "shock": "STOP_USE", "burning": "STOP_USE"}
    _UNSAFE_HINTS = ("test the element live", "test it live", "live terminals", "bypass the",
                     "keep resetting the rcd", "discharge the capacitor", "re-gas", "regas",
                     "look for the leak with", "while it's plugged in", "while its plugged in")

    # ---- Story 3: Jev UNDERSTAND stand-in (test-only deterministic classifier) ----
    # Mirrors the SINGLE Jev UNDERSTAND the real part-finder runs. Deterministic keyword/shape
    # classification is acceptable HERE because this is a test stand-in FOR Jev (the production
    # semantic authority); the orchestrator under test consumes these typed decisions exactly as it
    # consumes the real Jev result. Returns {"jev": {decisions}, "understand": <raw intent>}.
    _FAKE_FAMILY = (
        ("washer-dryer", ("washer dryer", "washer-dryer")),
        ("tumble-dryer", ("tumble dryer", "tumble-dryer", "tumble", "dryer")),
        ("dishwasher", ("dishwasher", "dish washer", "dishes")),
        ("oven-cooker", ("oven", "cooker", "grill")),
        ("hobs", ("hob", "induction", "ceramic hob", "cooktop", "hotplate")),
        ("fridge-freezer", ("fridge", "freezer", "refrigerat")),
        ("vacuum", ("vacuum", "hoover", "henry", "dyson", "brush bar")),
        ("microwave", ("microwave",)),
        ("washing-machine", ("washing machine", "washer", "spin", "rinse", "detergent drawer")),
    )
    _FAKE_SYMPTOM = (
        (("lost suction", "no suction", "pulsing", "pulsating", "surge", "surging"), "no_suction", "no suction"),
        (("won't drain", "wont drain", "not draining", "water left", "won't empty", "wont empty"), "not_draining", "not draining"),
        (("leak", "leaking", "puddle", "water underneath", "water on the floor"), "leaking", "leaking"),
        (("won't spin", "wont spin", "not spinning"), "not_spinning", "not spinning"),
        (("no heat", "not heating", "stays cold", "cold wash", "won't heat", "comes out cold", "still cold"), "not_heating", "not heating"),
        (("won't fill", "not filling", "no water", "trickles in"), "not_filling", "not filling"),
        (("noise", "noisy", "grinding", "rattle", "rattling", "banging", "bang", "loud", "humming", "screech"), "noisy", "noisy"),
        (("won't lock", "door won't", "door wont", "won't open", "door open", "latch"), "door", "door won't lock"),
        (("no power", "won't turn on", "wont turn on", "dead", "won't start", "nothing happens"), "no_power", "no power"),
        (("fan not spinning", "fan isn't spinning", "fan not running", "evaporator fan", "not cooling", "warm"), "not_cooling", "not cooling"),
        (("trips", "tripping", "rcd", "breaker", "blows the fuse"), "trips_electrics", "trips electrics"),
        (("won't light", "wont light", "no spark", "not igniting"), "wont_light", "won't light"),
        (("gas", "burning", "burnt", "shock", "smoke", "spark", "sparking", "electric shock"), "other", "safety"),
    )
    _FAKE_CODE_CUE = ("error code", "fault code", "error", "fault", "code", "showing", "shows",
                      "displays", "display", "flashing", "reads", "says")
    # Short alnum code shape (E15, F06, D80, ZZ99, 4C, LOC). Long model numbers are matched first.
    _FAKE_CODE_SHAPE = _re.compile(r"\b([A-Z]{1,3}\d{1,3}[A-Z]?|\d{1,2}[CE]|OE|LE|LC|UE|DE|TE|CL|HC|LOC|PF|SUD|IE|PE|OD)\b")
    _FAKE_MODEL_SHAPE = _re.compile(r"\b([A-Z]{2,5}\d{2,}[A-Z0-9]*(?:[/-]\d{1,2}[A-Z]?)?)\b")
    _FAKE_IDENTITY_STOP = {"it", "its", "it's", "the", "a", "an", "is", "model", "number", "no",
                           "nr", "code", "error", "fault", "my", "on", "of", "s4r", "that", "showing",
                           "shows", "displays", "display", "reads", "says", "serial", "dyson"}
    # The stand-in authority's "customer can't provide the model" recogniser (mirrors Jev's typed
    # modelUnavailable question). Only the FAKE interprets prose; production code consumes the typed
    # field.
    _FAKE_NO_MODEL_RE = _re.compile(
        r"can'?t find|cannot find|can'?t read|cannot read|can'?t see|scratch(?:ed)? off|worn off|"
        r"rubbed off|faded|illegible|unreadable|no model|without (?:the |a )?model|"
        r"don'?t have (?:the |a )?model|haven'?t got (?:the |a )?model|don'?t know (?:the )?model|"
        r"(?:label|sticker|rating plate|model(?: number)?) (?:is )?(?:gone|missing|worn|scratched|faded|rubbed|off)",
        _re.I)

    def understand(self, *, symptoms: str, image=None, conversation=None, established=None,
                   canonical=None) -> dict:
        text = symptoms or ""
        low = text.lower()
        appliance = next((fam for fam, cues in self._FAKE_FAMILY if any(c in low for c in cues)), None)
        symptom_family, fault = "none", None
        for cues, fam, phrase in self._FAKE_SYMPTOM:
            if any(c in low for c in cues):
                symptom_family, fault = fam, phrase
                break
        code_cued = any(c in low for c in self._FAKE_CODE_CUE)
        brand = any(_re.search(r"\b" + _re.escape(b) + r"\b", low) for b in
                    ("bosch", "siemens", "neff", "aeg", "zanussi", "hotpoint", "indesit", "whirlpool",
                     "hoover", "candy", "beko", "haier", "samsung", "lg", "miele", "smeg", "electrolux"))
        up = text.upper()
        code, model, token_meaning = None, None, "none"
        m_model = self._FAKE_MODEL_SHAPE.search(up)
        m_code = self._FAKE_CODE_SHAPE.search(up)
        # A long alnum token is a MODEL. A short code-shape is a CODE when the customer cued a code
        # OR the appliance/brand context makes it unambiguous (mirrors Jev reading "Bosch dishwasher
        # E15" as a code without an explicit cue word). Series like V6/DC40 do not match the code
        # shape, so they stay models. Explicit "model is X" is always a model.
        code_context = code_cued or bool(appliance) or brand
        short_code = bool(m_code and len(m_code.group(1)) <= 5)
        # A vacuum series token (Dyson V6 / DC40) is a MODEL, never a code (Jev reads it from context).
        if appliance == "vacuum" and m_model is None and m_code:
            model, token_meaning = m_code.group(1), "model"
        elif _re.search(r"\bmodel\b|\bserial\b|rating plate|e-?nr", low) and m_model:
            model, token_meaning = m_model.group(1), "model"
        elif code_cued and short_code:
            # an explicit code cue + a short token is a code even if it also matches the model shape
            code, token_meaning = m_code.group(1), "error_code"
        elif code_context and m_code and not (m_model and m_code.group(1) in m_model.group(1)):
            code, token_meaning = m_code.group(1), "error_code"
        elif m_model:
            model, token_meaning = m_model.group(1), "model"
        if code_cued and not code and symptom_family == "none":
            symptom_family = "error_display"
        # ON-TOPIC, NOT a pure identity/code turn -> the RAG is the understanding authority (it
        # reassures / advises / diagnoses). Mirror that by treating such a turn as a symptom so it
        # routes to the RAG rather than a bare clarify. A lone identifier/code answer is NOT this.
        if not fault and not code and not m_code and symptom_family == "none":
            content = [w for w in _re.split(r"[^a-z0-9]+", low)
                       if w and w not in self._FAKE_IDENTITY_STOP and not _re.fullmatch(r"[a-z0-9]*\d[a-z0-9]*", w)]
            if len(content) >= 3:
                symptom_family, fault = "other", "general appliance issue"
        establishes = "symptom" if fault else ("identity" if (model or code) else "none")
        # Safety significance (Jev classifies this separately from symptomFamily). The orchestrator
        # routes any safety-significant turn to the RAG, which owns the deterministic safety stop.
        safety_sig = "none"
        if "gas" in low:
            safety_sig, establishes = "gas_smell", "hazard"
        elif "shock" in low:
            safety_sig, establishes = "electric_shock", "hazard"
        elif "burning" in low or "burnt" in low or "smoke" in low:
            safety_sig, establishes = "burning", "hazard"
        # modelUnavailable is Jev's TYPED decision ("did the customer say they can't find/read the
        # model?"). As the stand-in semantic authority for offline tests, the fake derives it from the
        # customer's words here so the orchestrator can consume the typed field (it no longer parses
        # prose itself). Real Jev answers the same question in jev-understand.js.
        model_unavail = bool(self._FAKE_NO_MODEL_RE.search(low))
        raw = {
            "onTopic": True, "needMoreInfo": bool(not fault and not code and not appliance),
            "userIntent": "NEW_PROBLEM", "make": None, "model": model, "applianceType": appliance,
            "fault": fault, "faultId": None, "errorCode": code, "modelUnavailable": model_unavail,
            "confidence": 0.8, "alternatives": [], "candidateComponents": [], "provenGood": [],
            "alreadyReplaced": [], "nextBestCheck": None, "clarifyingQuestion": None,
            "primaryFindingKind": "unknown", "customerTheories": [], "declinedFacts": [],
            "checksReported": [], "reportedSymptoms": [fault] if fault else [], "facts": [],
            "_tokenMeaning": token_meaning, "_cannotAnswer": False,
            "_jevEvidence": {"source": "jev", "facts": [], "intervention": None},
        }
        # Stage B: the orchestrator's first-turn family gate now reads Jev's typed probability
        # distribution + provenance (not identitySufficiency). Emit a distribution consistent with
        # the fake's detected family so the deterministic gate commits a detected family (strong,
        # decisive margin) and clarifies when none is detected — mirroring the prior fake behaviour.
        if appliance:
            fam_probs = {appliance: 0.95, "unknown": 0.03, "uncertain": 0.02}
            fam_conf = 0.95
            fam_prov = "inferred"
        else:
            fam_probs = {"unknown": 0.9, "uncertain": 0.1}
            fam_conf = 0.2
            fam_prov = "none"
        jev = {"decisions": {"onTopic": True, "applianceFamily": appliance or "unknown",
                             "symptomFamily": symptom_family, "candidateTokenMeaning": token_meaning,
                             "latestTurnEstablishes": establishes, "cannotAnswer": False,
                             "safetySignificance": safety_sig,
                             "applianceFamilyProvenance": fam_prov,
                             "identitySufficiency": "sufficient" if appliance else "need_appliance"},
               "confidence": {"applianceFamily": fam_conf},
               "probabilities": {"applianceFamily": fam_probs},
               "customerEvidence": {"source": "jev", "facts": [], "intervention": None}}
        return {"jev": jev, "understand": raw}

    def diagnose(self, *, symptoms: str, appliance=None, make=None, trusted=None, image=None,
                 conversation=None, understand=None, established=None, canonical=None) -> dict:
        s = (symptoms or "").lower()
        # Simulate vision extraction for offline tests: an image yields an extracted make/model.
        _extracted = {"make": "Beko", "model": "WMB71442W"} if image else {"make": None, "model": None}
        unsafe = any(h in s for h in self._UNSAFE_HINTS)
        isolation = (
            not any(x in s for x in ("already replaced", "i replaced", "i've replaced", "i have replaced"))
            and any(x in s for x in ("going to", "i'll", "i will", "about to", "how do i", "can i", "should i"))
            and any(x in s for x in ("take the", "take it", "remove", "check the plug", "open the panel", "take apart"))
        )
        safety_normal = (
            {"class": "ISOLATE_IF_SAFE", "stopUse": False} if isolation
            else {"class": "NORMAL_DIAGNOSTIC", "stopUse": False}
        )
        # Gas requires "gas" + a smell/leak cue (so "gas oven won't heat" is not an emergency).
        if ("gas" in s and any(c in s for c in ("smell", "leak"))):
            return {"grounded": False, "faultId": None, "faultLabel": None, "system": "safety",
                    "confidence": 0.0, "candidateComponents": [], "clarifyingQuestion": None,
                    "safety": {"class": "EMERGENCY_ACTION", "stopUse": True},
                    "safetyReason": "gas", "unsafeIntent": unsafe}
        for needle, reason in self.SAFETY_HINTS:
            if needle in s:
                cls = self._REASON_CLASS[reason]
                return {"grounded": False, "faultId": None, "faultLabel": None, "system": "safety",
                        "confidence": 0.0, "candidateComponents": [], "clarifyingQuestion": None,
                        "safety": {"class": cls, "stopUse": True},
                        "safetyReason": reason, "unsafeIntent": unsafe}
        # Normal-behaviour reassurance (mirrors the RAG's deterministic backstop for offline tests):
        # an "is it normal?" question about a long eco/cycle with NO failure symptom -> reassure.
        if (("is it normal" in s or "is this normal" in s) and ("eco" in s or "long" in s or "hours" in s)
                and not any(k in s for k in ("cold", "not heat", "won't heat", "wont heat", "drain",
                                             "not filling", "won't fill", "error", "leak", "stall"))):
            return {"grounded": False, "faultId": None, "faultLabel": None, "system": None,
                    "confidence": 0.0, "candidateComponents": [], "clarifyingQuestion": None,
                    "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False},
                    "safetyReason": None, "unsafeIntent": unsafe, "normalBehaviour": True,
                    "reply": ("That's normal for an eco programme — it runs long to save energy by "
                              "heating slowly and soaking, so there's nothing to replace.")}
        # if a trusted deterministic code system is present, prefer aligning to it
        trusted_system = ((trusted or {}).get("facts") or {}).get("system") if trusted else None
        best = None
        for needles, res in self.RULES:
            if any(n in s for n in needles):
                best = res
                break
        if not best and make and appliance:
            # no symptom rule matched -> try resolving a recognised error-code token in the text,
            # ISOLATED by make+appliance (mirrors part-finder resolveFault(errorCode) isolation);
            # leaves symptom-driven tests untouched.
            mk = str(make).strip().lower()
            ap = str(appliance).strip().lower().replace(" ", "-")
            toks = set(_re.split(r"[^a-z0-9]+", s))
            for (fmk, fap, code_key), res in self.CODE_FAULTS.items():
                if fmk == mk and fap == ap and code_key in toks:
                    best = res
                    break
        if not best:
            # vague -> ask (mirrors RAG calibrated clarification)
            return {"grounded": False, "faultId": None, "faultLabel": None, "system": None,
                    "confidence": 0.0, "candidateComponents": [], "parts": [],
                    "resolvedModel": _extracted["model"], "extractedMake": _extracted["make"],
                    "traceId": None, "safetyInformation": None, "media": [],
                    "clarifyingQuestion": "Can you describe what the appliance is doing in a bit more detail?",
                    "safety": safety_normal,
                    "safetyReason": None, "unsafeIntent": unsafe}
        fid, label, system, conf, comps = best
        return {"grounded": True, "faultId": fid, "faultLabel": label, "system": system,
                "confidence": conf, "candidateComponents": comps, "clarifyingQuestion": None,
                "parts": [], "resolvedModel": _extracted["model"], "extractedMake": _extracted["make"],
                "traceId": None, "safetyInformation": None, "media": [],
                "safety": safety_normal,
                "safetyReason": None, "unsafeIntent": unsafe,
                "alignedToTrustedSystem": (trusted_system == system) if trusted_system else None}


# ---------------- FAKE Error-Code service (canned; for deterministic core tests) ----------------
class FakeErrorCodeService:
    """Canned MCP-shaped responses keyed by (make-lowered, appliance-normalised, code-upper).
    Lets the A-Z matrix run fully offline/deterministically. Shapes match the real MCP."""
    def __init__(self, table: dict | None = None):
        self.table = table or {}

    @staticmethod
    def _key(make, appliance, code):
        return ((make or "").strip().lower(), (appliance or "").strip().lower().replace(" ", "-"),
                (code or "").strip().upper())

    def resolve_error_code(self, make, appliance, code, observed=None, region=None, includeEnrichment=True):
        # observed may select a variant (e.g. F06 + E-Nr). Encode variant keys as CODE|SCHEME.
        variant = None
        for o in (observed or []):
            v = (o.get("value") if isinstance(o, dict) else getattr(o, "value", "")) or ""
            if v.upper().startswith("WGG"):
                variant = "EF"
            elif v.upper().startswith("WFF"):
                variant = "WFF"
            elif v.upper().startswith("RF"):   # Samsung fridge-freezer model -> pins the FF scheme
                variant = "SAMSUNG_FF"
        k = self._key(make, appliance, code)
        if variant and (k + (variant,)) in self.table:
            resp = dict(self.table[k + (variant,)])
        elif k in self.table:
            resp = dict(self.table[k])
        else:
            return {"status": "NOT_FOUND", "make": make, "appliance": appliance,
                    "code": {"input": code, "displayed": code},
                    "reason": "No mapping for this make + appliance + code."}
        if not includeEnrichment:
            resp.pop("enrichment", None)
        resp.setdefault("productContextUsed", bool(variant))
        return resp

    def resolve_appliance_context(self, make, appliance, observed):
        for o in (observed or []):
            v = (o.get("value") if isinstance(o, dict) else getattr(o, "value", "")) or ""
            if v.upper().startswith("WGG"):
                return {"status": "RESOLVED", "resolvedAttributes": {"scheme": "BSH_WM_EF"}, "confidence": "HIGH"}
            if v.upper().startswith("WFF"):
                return {"status": "RESOLVED", "resolvedAttributes": {"scheme": "BSH_WM_WFF"}, "confidence": "MEDIUM"}
        return {"status": "NEEDS_CONTEXT", "resolvedAttributes": {}, "confidence": "LOW"}


# ---------------- REAL Diagnostic RAG adapter (banked part-finder Function URL) ----------------
def _conversation_window(items, cap=12):
    """Keep the latest turns without starting on an assistant message.

    An assistant-first window is invalid for the UNDERSTAND LM (system + assistant)
    and also drops the customer's opening report.
    """
    if not items:
        return []
    first_user = next((i for i, m in enumerate(items) if m.get("role") == "user"), -1)
    if first_user < 0:
        return []
    start = max(0, len(items) - cap)
    if start < first_user:
        start = first_user
    if items[start].get("role") != "user":
        opening = items[first_user]
        tail = [m for m in items[-(cap - 1):] if m is not opening]
        return [opening] + tail
    return items[start:]


def build_rag_messages(*, symptoms="", image=None, conversation=None):
    """Build the Diagnostic RAG `messages` array.

    When a role-separated conversation is supplied, send it as a real multi-turn thread
    (user/assistant) so UNDERSTAND can distinguish established facts from the latest evidence.
    Fallback (no conversation): one user message, matching the historical contract.
    """
    msgs = []
    if isinstance(conversation, list):
        for m in conversation:
            if not isinstance(m, dict):
                continue
            role = m.get("role")
            if role not in ("user", "assistant"):
                continue
            content = m.get("content")
            if isinstance(content, str):
                text = content.strip()
            elif isinstance(content, list):
                text = " ".join(
                    (p.get("text") or "") for p in content
                    if isinstance(p, dict) and p.get("type") == "text"
                ).strip()
            else:
                text = ""
            if not text:
                continue
            limit = 900 if role == "assistant" else 2000
            rec = {"role": role, "content": text[:limit]}
            if role == "assistant" and isinstance(m.get("media"), list):
                compact = []
                for item in m.get("media")[:4]:
                    if not isinstance(item, dict):
                        continue
                    compact.append({
                        "id": (str(item["id"])[:80] if item.get("id") else None),
                        "type": (str(item.get("type") or "")[:20] or None),
                        "title": str(item.get("title") or "")[:160],
                        "url": (str(item["url"])[:400] if item.get("url") else None),
                        "videoId": (str(item["videoId"])[:40] if item.get("videoId") else None),
                    })
                if compact:
                    rec["media"] = compact
            if role == "assistant" and m.get("safetyInformation") is not None:
                shown = m.get("safetyInformation")
                text_si = shown if isinstance(shown, str) else (shown.get("text") if isinstance(shown, dict) else None)
                if text_si:
                    rec["safetyInformation"] = {"text": str(text_si)[:900]}
            msgs.append(rec)
        msgs = _conversation_window(msgs, 12)
    if not msgs:
        if image:
            content = [{"type": "text", "text": symptoms or "Please read the rating plate."},
                       {"type": "image_url", "image_url": {"url": image}}]
        else:
            content = symptoms or ""
        return [{"role": "user", "content": content}]
    if image:
        for i in range(len(msgs) - 1, -1, -1):
            if msgs[i]["role"] == "user":
                prev = msgs[i]["content"]
                text = prev if isinstance(prev, str) else (symptoms or "Please read the rating plate.")
                msgs[i]["content"] = [
                    {"type": "text", "text": text},
                    {"type": "image_url", "image_url": {"url": image}},
                ]
                break
    return msgs


class RealDiagnosticService:
    """Adapter over the banked Diagnostic RAG (part-finder Function URL, NDJSON stream).

    Translates orchestration request -> RAG request ({messages, seed}) and the RAG `done.understood`
    -> DiagnosticService port shape. When the boundary supplies a role-separated conversation,
    that thread is forwarded so UNDERSTAND sees prior advisor turns and the latest evidence
    separately. Trusted deterministic facts are enforced by the ORCHESTRATOR
    (authority + conflict + composer), never by asking the RAG to own code meaning.
    Raises RagUnavailable on transport failure/timeout so the orchestrator can degrade gracefully.
    """
    def __init__(self, url: Optional[str] = None, seed: int = 42, timeout: float = 90.0):
        self.url = (url or os.environ["RAG_URL"]).rstrip("/") + "/"
        self.seed = seed
        self.timeout = timeout

    def understand(self, *, symptoms: str, image=None, conversation=None, established=None,
                   canonical=None) -> dict:
        """Story 3: run the SINGLE Jev UNDERSTAND pass (mode:'understand') and return its typed
        result BEFORE routing. This is the one and only Jev invocation for the turn; the raw typed
        intent is forwarded verbatim into `diagnose(understand=...)` so part-finder does NOT run Jev
        again. Returns {"jev": <typed decisions/observability>, "understand": <raw intent to inject>}
        or {} on transport failure (the orchestrator then degrades to a clarify, never a prose guess).

        Stage A: `established` ({applianceFamily, familyState}) carries the PRIOR established
        conversation identity so Jev is anchored to what is already known instead of re-inferring.
        """
        import httpx, json as _json
        msgs = build_rag_messages(symptoms=symptoms, image=image, conversation=conversation)
        payload = {"messages": msgs, "seed": self.seed, "mode": "understand"}
        if isinstance(established, dict) and established.get("applianceFamily"):
            payload["established"] = established
        # CANONICAL: forward the BFF's cs/1 block verbatim; part-finder merges, routes and decides.
        if isinstance(canonical, dict):
            payload["canonical"] = canonical
        try:
            r = httpx.post(self.url, json=payload, timeout=self.timeout,
                           headers={"content-type": "application/json"})
            r.raise_for_status()
            text = r.text
        except Exception as e:
            raise RagUnavailable(str(e))
        for line in text.split("\n"):
            t = line.strip()
            if not t:
                continue
            try:
                obj = _json.loads(t)
            except Exception:
                continue
            if obj.get("type") == "understand":
                out = {"jev": obj.get("jev") or {}, "understand": obj.get("understand") or {}}
                if isinstance(obj.get("canonical"), dict):
                    out["canonical"] = obj["canonical"]   # merged canonical result, opaque here
                return out
        raise RagUnavailable("no understand event in RAG response")

    def diagnose(self, *, symptoms: str, appliance=None, make=None, trusted=None, image=None,
                 conversation=None, understand=None, established=None, canonical=None) -> dict:
        import httpx
        # When a rating-plate image is supplied, send OpenAI-style multimodal content so the RAG's
        # existing vision UNDERSTAND pass can read the plate. The RAG contract already supports this
        # (images in the messages array) and already returns understood.make/model — no RAG change.
        msgs = build_rag_messages(symptoms=symptoms, image=image, conversation=conversation)
        payload = {"messages": msgs, "seed": self.seed}
        # Story 3: forward the EXACT Jev intent produced by the earlier understand() call so
        # part-finder consumes it instead of running Jev a second time (one Jev call per turn).
        if isinstance(understand, dict) and understand:
            payload["understand"] = understand
        # Stage A: carry the (current) established conversation identity so part-finder preserves a
        # genuinely established family into the diagnosis even when this turn's Jev output is weak.
        if isinstance(established, dict) and established.get("applianceFamily"):
            payload["established"] = established
        # CANONICAL: the merged result from understand; part-finder words its NextAction when it controls.
        if isinstance(canonical, dict):
            payload["canonical"] = canonical
        try:
            r = httpx.post(self.url, json=payload, timeout=self.timeout,
                           headers={"content-type": "application/json"})
            r.raise_for_status()
            text = r.text
        except Exception as e:  # transport/timeout -> degrade
            raise RagUnavailable(str(e))
        done, reply = None, ""
        for line in text.split("\n"):
            t = line.strip()
            if not t:
                continue
            try:
                obj = __import__("json").loads(t)
            except Exception:
                continue
            if obj.get("type") == "delta" and obj.get("text"):
                reply += obj["text"]
            if obj.get("type") == "done":
                done = obj
        if done is None:
            raise RagUnavailable("no done event in RAG response")
        u = done.get("understood") or {}
        # SAFETY CLASS from the RAG's AUTHORITATIVE deterministic gas/shock stop signal
        # (done.safetyStop), NOT from reply wording. The old reply-keyword heuristic falsely
        # tripped STOP_USE on benign advice ("unplug it", "get a qualified engineer"), collapsing a
        # normal grounded diagnosis into a safety-stop nondeterministically. Electrical/thermal
        # stop guidance is delivered by the (evidence-backed) safetyInformation block, not by
        # collapsing the whole answer. Genuine gas/shock emergencies still stop deterministically.
        # Map the RAG's deterministic safety CATEGORY to a class, PRESERVING the cause so the
        # orchestrator can give cause-specific guidance: a suspected gas escape is an EMERGENCY_ACTION
        # (bespoke: no switches/flames, ventilate, National Gas Emergency line) — it must NOT be
        # flattened into a generic electrical stop. Shock/burning are STOP_USE with cause-specific
        # wording downstream. The category itself is carried through as `safetyReason`.
        reason = done.get("safetyStop")  # 'gas' | 'shock' | 'burning' | 'electrical' | None
        safety_cls, reason = rag_safety_from_done(done, reason)
        si = done.get("safetyInformation") or {}
        return {
            "grounded": bool(u.get("grounded")),
            "faultId": u.get("faultId"),
            "faultLabel": u.get("fault"),
            "system": u.get("faultId"),   # orchestrator area-union compares this with MCP system
            "confidence": u.get("confidence"),
            "candidateComponents": u.get("candidateComponents") or [],
            "componentMention": done.get("componentMention") or u.get("componentMention") or None,
            "purchaseAppropriate": bool(done.get("purchaseAppropriate") if done.get("purchaseAppropriate") is not None else u.get("purchaseAppropriate")),
            "clarifyingQuestion": u.get("clarifyingQuestion"),
            "safety": {"class": safety_cls, "stopUse": safety_cls in ("STOP_USE", "EMERGENCY_ACTION")},
            "safetyReason": reason,                 # 'gas'|'shock'|'burning'|None — cause-specific guidance
            "unsafeIntent": bool(done.get("unsafeIntent")),  # customer asked to DO something dangerous
            "normalBehaviour": bool(done.get("normalBehaviour")),  # asked "is this normal?" + plausibly-normal -> reassure (not a fault)
            # passthrough for the retailer boundary (NOT interpreted by the orchestrator):
            "parts": done.get("parts") or [],       # raw RAG part cards (L3)
            "resolvedModel": u.get("model"),         # customer/OCR model string (staging + plate confirm)
            "catalogueResolvedModel": done.get("catalogueResolvedModel"),  # unique catalogue model or None
            "catalogueMatchType": done.get("catalogueMatchType") or "none",
            "extractedMake": u.get("make"),          # vision-read make (for image-plate conflict checks)
            "extractedAppliance": u.get("appliance"),  # vision-read appliance (conflict checks)
            "reply": reply,                          # RAG prose — combined compose does not paste this
            "traceId": done.get("traceId"),          # feedback token
            "checksReported": u.get("checksReported") or [],
            "userIntent": u.get("userIntent"),
            # Pre-written, evidence-backed customer SAFETY INFORMATION for the grounded node
            # (node-identity lookup done inside the RAG). Passed through verbatim; NOT interpreted,
            # merged, rewritten or safety-state-transitioned by the orchestrator.
            "safetyInformation": done.get("safetyInformation") or None,
            # Customer instructional media (customer-safe subset) for the grounded node; passed
            # through verbatim, never interpreted/merged. Suppressed downstream on stop/status/conflict.
            "media": done.get("media") or [],
            "cards": len(done.get("parts") or []),
            "diagnosticTrace": done.get("diagnosticTrace"),
            # Canonical control: the typed NextAction COMPOSE worded for this reply (opaque passthrough).
            "canonicalControl": done.get("canonicalControl") if isinstance(done.get("canonicalControl"), dict) else None,
        }


class RagUnavailable(Exception):
    pass


class McpUnavailable(Exception):
    pass


# ---------------- REAL deployed MCP service ----------------
class McpErrorCodeService:
    """Calls the REAL deployed Error-Code MCP (Streamable HTTP + bearer). Requires the mcp SDK
    (run under error-codes/mcp/.venv). Env: MCP_URL, MCP_BEARER_TOKEN. Synchronous wrapper around
    the async client; opens a short-lived session per call (stateless server)."""
    def __init__(self, url: Optional[str] = None, token: Optional[str] = None):
        self.url = (url or os.environ["MCP_URL"]).rstrip("/") + "/mcp"
        self.token = token or os.environ["MCP_BEARER_TOKEN"]

    def _call(self, tool: str, args: dict) -> dict:
        import asyncio, httpx
        from mcp.client.streamable_http import streamable_http_client
        from mcp.client.session import ClientSession

        async def go():
            hc = httpx.AsyncClient(headers={"Authorization": f"Bearer {self.token}"})
            async with streamable_http_client(self.url, http_client=hc) as (r, w):
                async with ClientSession(r, w) as s:
                    await s.initialize()
                    res = await s.call_tool(tool, args)
                    sc = getattr(res, "structured_content", None) or {}
                    if isinstance(sc, dict) and set(sc.keys()) == {"result"}:
                        return sc["result"]
                    return sc
        try:
            return asyncio.run(go())
        except Exception as e:
            raise McpUnavailable(str(e))

    def resolve_error_code(self, make, appliance, code, observed=None, region=None, includeEnrichment=True):
        # The MCP schema requires a non-empty appliance family. Make+code without a family is a
        # valid WhichPart routing state (a make is not a family). Do not invent a family, and do
        # not treat a protocol-empty payload as "this code does not exist".
        if not (appliance or "").strip():
            return {
                "status": "INVALID_INPUT",
                "make": make,
                "appliance": appliance,
                "code": {"input": code, "displayed": code},
                "reason": "Appliance family is required to resolve a manufacturer code; the displayed code is retained.",
                "errors": ["appliance"],
            }
        args = {"make": make, "appliance": appliance, "code": code, "includeEnrichment": includeEnrichment}
        if observed:
            args["observed"] = [o if isinstance(o, dict) else {"type": o.type, "value": o.value}
                                for o in observed]
        if region:
            args["region"] = region
        result = self._call("resolve-error-code", args)
        if not isinstance(result, dict) or not result.get("status"):
            return {
                "status": "INVALID_INPUT",
                "make": make,
                "appliance": appliance,
                "code": {"input": code, "displayed": code},
                "reason": "Error-code lookup returned no status; the displayed code is retained.",
            }
        return result

    def resolve_appliance_context(self, make, appliance, observed):
        obs = [o if isinstance(o, dict) else {"type": o.type, "value": o.value} for o in (observed or [])]
        return self._call("resolve-appliance-context", {"make": make, "appliance": appliance, "observed": obs})
