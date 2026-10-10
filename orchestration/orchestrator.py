#!/usr/bin/env python3
"""Customer Diagnostic Orchestrator V1 — deterministic control flow.

Authority rule: the Error-Code MCP owns error-code MEANING; the Diagnostic RAG owns SYMPTOM
diagnosis. For code+symptom turns the MCP runs FIRST; its deterministic result becomes a
TrustedDiagnosticContext that the RAG may refine but never contradict. Safety is monotonic.
recordType is respected (a STATUS/MAINTENANCE code is never promoted to a component fault).
No LLM at the orchestration layer. All customer text is untrusted data.
"""
from __future__ import annotations
import re as _re
import time
from typing import Optional

from .model import (Route, Outcome, Trust, TurnInput, ConversationState, CustomerProvided,
                    DeterministicResolved, ProbabilisticInferred, TrustedDiagnosticContext,
                    OrchestratorResponse, CodeResultView, DiagnosisView, ObservedIdentifier,
                    strongest_safety)
from . import routing
from .services import (ErrorCodeService, DiagnosticService, InMemoryStateStore,
                       McpUnavailable, RagUnavailable)

NON_FAULT_RECORD_TYPES = {"STATUS", "INFORMATION", "MAINTENANCE", "WARNING"}


def _fault_phrase(rag, default: str = "fault") -> str:
    """Safe customer-facing fault label. dict.get(key, default) does not replace an explicit None."""
    label = rag.get("faultLabel") if isinstance(rag, dict) else None
    if isinstance(label, str) and label.strip():
        return label.strip().lower()
    return default


def _with_safety_prefix(msg: str, safety: Optional[dict], safety_info) -> str:
    """Do not prepend the same safety sentence when structured safetyInformation already carries it."""
    if not safety or not safety.get("message"):
        return msg
    if isinstance(safety_info, dict) and (
        str(safety_info.get("text") or "").strip()
        or safety_info.get("classification") == "PROFESSIONAL_ONLY"
    ):
        return msg
    return safety["message"] + " " + msg

# coarse fault-family map to compare a deterministic (MCP) system with a probabilistic (RAG) one
_FAMILY = {
    "leak-flood": "leak", "leak": "leak", "leak-protection": "leak",
    "drain": "drain", "not-draining": "drain", "circulation": "drain",
    "fill": "fill", "inlet": "fill", "inlet-valve": "fill", "overflow": "leak",
    "heating": "heat", "heater": "heat", "temperature-sensing": "heat", "temp-sensor": "heat",
    "motor-drive": "motor", "motor": "motor", "motor-drum": "motor", "balance": "motor",
    "door-lock": "door", "door": "door",
}
def _family(system: Optional[str]) -> Optional[str]:
    if not system:
        return None
    return _FAMILY.get(system.lower(), system.lower())


def _facing_code(st: ConversationState, mcp: Optional[dict] = None) -> Optional[str]:
    """The code the customer supplied, not a mapping alias/canonical sibling."""
    cust = getattr(st.customer, "displayedCode", None)
    code = (mcp or {}).get("code") or {}
    return cust or code.get("input") or code.get("displayed")


# Coarse "diagnostic area" normaliser. The Error-Code MCP (code MEANING) and the part-finder
# runtime resolver (SYMPTOM/fault diagnosis) are two INDEPENDENT deterministic authorities with
# their own vocabularies (MCP: faultId/system like "cooling-fan"/"fan"; runtime: system/faultId
# like "evaporator-fan"). To reconcile them on a code-only turn we need a small SHARED set of
# physical fault areas so an unresolved-code candidate set can be compared with a grounded runtime
# diagnosis STRUCTURALLY — no prose, no LLM, no per-code fact table. This is a taxonomy bridge like
# `_FAMILY`: it holds NO code->meaning facts and NO make/model literals. Keyword-ordered — the
# FIRST area whose keyword is a substring of the normalised token wins — so "cooling-fan" and
# "evaporator-fan" both resolve to `fan` (not `compressor`/`cooling`).
_DIAGNOSTIC_AREAS = [
    ("fan", ("fan",)),
    ("defrost", ("defrost", "frost", "de-ice", "ice-buildup", "icing")),
    ("compressor", ("compressor", "sealed-system", "sealed system", "refrigerant",
                    "cooling", "cold-control", "gas-leak-sealed")),
    ("drain", ("drain", "not-draining", "circulation", "sump", "pump")),
    ("fill", ("fill", "inlet", "overflow", "aquastop", "water-supply", "no-water")),
    ("leak", ("leak", "flood")),
    ("heat", ("heat", "heater", "heating", "element", "temperature-sens", "temp-sensor",
              "ntc", "thermistor", "thermostat")),
    ("motor", ("motor", "drum", "tacho", "brush", "belt", "balance", "bearing")),
    ("door", ("door", "lock", "latch", "interlock")),
    ("sensor", ("sensor", "sensing")),
    ("control", ("control", "pcb", "board", "mainboard", "module")),
]


# Internal enumeration/bucket labels that the diagnostic engine may emit as differential entries
# (e.g. "STAGE draining / water remains — pump / filter"). They are INTERNAL routing taxonomy, not
# customer-facing "checks", and must never be dumped into the reply or the suggested-checks list.
# Deterministic presentation restraint (§ question-cardinality / no-internal-enum-leak): drop a
# leading internal bucket word and over-long enumerations; NOT a per-journey rule.
_INTERNAL_CHECK_LABEL = _re.compile(r"^\s*(?:stage|phase|mode|step|route)\b", _re.I)

# Fixed, safe in-scope redirect for an input Jev typed as a prompt attack or an
# unrelated (non-appliance) request. Mirrors the part-finder REFUSAL_TEXT so the
# customer sees one consistent redirect regardless of which boundary refuses.
# Jev decides the MEANING (requestClass); this is only the deterministic reply.
SCOPE_REFUSAL_TEXT = (
    "I can only help with domestic appliance faults and spare parts, so I can't help with that. "
    "If you've got a problem with an appliance, tell me the make, model and what it's doing and "
    "I'll help you find the right part."
)


def _load_canonical_journeys() -> dict:
    """Canonical journey key -> likely area (faultId), from the ONE shared registry
    (services/part-finder/canonical/journeys.json; copied next to this module in the Lambda image).
    Fails safe: no readable registry -> no key is recognised -> every turn takes the legacy path."""
    import json, logging, os
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, "canonical_journeys.json"),
                 os.path.join(here, "..", "services", "part-finder", "canonical", "journeys.json")):
        try:
            with open(path, encoding="utf-8") as f:
                rows = json.load(f).get("journeys") or []
            out = {r["key"]: r["faultId"] for r in rows if isinstance(r, dict) and r.get("key") and r.get("faultId")}
            if out:
                return out
        except (OSError, ValueError, AttributeError):
            continue
    logging.getLogger("diag-orchestrator").warning("canonical journey registry not found: canonical control disabled")
    return {}


def _clean_checks(items, limit: int = 6) -> list:
    """Filter a differential/checks list to customer-safe, concise suspect names. Drops internal
    bucket labels (STAGE/PHASE/...) and over-long enumeration strings, de-dups, and caps the count
    so a large internal candidate set is never enumerated into customer prose."""
    out: list = []
    seen = set()
    for it in (items or []):
        s = str(it or "").strip()
        if not s or _INTERNAL_CHECK_LABEL.match(s) or len(s) > 60:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= limit:
            break
    return out


def _component_mention(rag) -> str:
    """How far retrieved candidates may be shown to the customer.

    Production RAG always sends componentMention. Older/fake RAG without the field
    keeps prior behaviour when it already listed candidates (offline tests).
    Explicit 'none' always wins.
    """
    m = str((rag or {}).get("componentMention") or "").strip().lower()
    if m in ("none", "discuss", "purchase"):
        return m
    if (rag or {}).get("candidateComponents"):
        return "purchase"
    return "none"


def _customer_facing_components(rag, limit: int = 6) -> list:
    mention = _component_mention(rag)
    if mention == "none":
        return []
    comps = _clean_checks((rag or {}).get("candidateComponents") or [], limit=limit)
    if mention == "discuss":
        return comps[:2]
    return comps


def _diagnostic_area(token: Optional[str]) -> Optional[str]:
    """Normalise an MCP or runtime fault token to a coarse shared diagnostic area (structural,
    keyword-based). Returns the raw normalised token if nothing matches so unrelated areas stay
    distinct (i.e. still compare as a conflict)."""
    if not token:
        return None
    t = str(token).strip().lower().replace("_", "-")
    if not t:
        return None
    for area, keys in _DIAGNOSTIC_AREAS:
        if any(k in t for k in keys):
            return area
    return t


def _areas_of(token: Optional[str]) -> set:
    """Every diagnostic area a structured token matches.

    First-match `_diagnostic_area` is too coarse for RESOLVED-code conflict: MCP may say
    `sensor` while the runtime uses `temperature-sensor`. Those are the same physical
    area; first-match maps the latter only to `heat` and manufactures a conflict.
    Collecting every matching area lets a more specific token overlap the coarser one.
    Unrelated areas (leak vs drain) still have an empty intersection.
    """
    if not token:
        return set()
    t = str(token).strip().lower().replace("_", "-")
    if not t:
        return set()
    found = {area for area, keys in _DIAGNOSTIC_AREAS if any(k in t for k in keys)}
    return found if found else {t}


def _union_areas(*tokens) -> set:
    out = set()
    for tok in tokens:
        if tok is None:
            continue
        if isinstance(tok, (list, tuple)):
            for item in tok:
                out |= _areas_of(item)
        else:
            out |= _areas_of(tok)
    return out


def _code_conflicts_with_rag(mcp: Optional[dict], rag: Optional[dict]) -> bool:
    """True only when a grounded RAG diagnosis sits in a DIFFERENT diagnostic area from the
    resolved code. Same-area vocabulary differences (sensor vs temperature-sensor) are not
    a conflict. Uses structured MCP/RAG fields only — not customer prose, not catalogue
    component shopping lists (those can mention a pump on a leak-protection code)."""
    if not isinstance(rag, dict) or not rag.get("grounded"):
        return False
    mcp = mcp or {}
    enr = mcp.get("enrichment") if isinstance(mcp.get("enrichment"), dict) else {}
    mcp_areas = _union_areas(
        mcp.get("system"), mcp.get("faultId"),
        enr.get("system"), enr.get("faultId"),
    )
    rag_areas = _union_areas(rag.get("system"), rag.get("faultId"))
    if not mcp_areas or not rag_areas:
        return False
    return mcp_areas.isdisjoint(rag_areas)


def _parts_in_coded_area(parts, mcp: Optional[dict]) -> list:
    """Keep only part cards whose title sits in the resolved code's diagnostic area.

    A model lookup can return popular unrelated parts (pump, door lock) for the same
    machine. Those must not be sold as the coded-area replacement.
    """
    mcp_areas = _union_areas((mcp or {}).get("system"), (mcp or {}).get("faultId"))
    if not mcp_areas:
        return []
    out = []
    for p in parts or []:
        if not isinstance(p, dict):
            continue
        title = p.get("title") or p.get("name") or ""
        if _areas_of(title) & mcp_areas:
            out.append(p)
    return out


def _customer_has_model(st: ConversationState) -> bool:
    _MODEL_TYPES = ("MODEL", "E_NR", "PNC", "12NC")
    return any(
        getattr(o, "type", None) in _MODEL_TYPES and getattr(o, "value", None)
        for o in (st.customer.observed or [])
    )


class Orchestrator:
    def __init__(self, error_code: ErrorCodeService, diagnostic: DiagnosticService,
                 store: Optional[InMemoryStateStore] = None):
        self.ec = error_code
        self.rag = diagnostic
        self.store = store or InMemoryStateStore()

    # ---------------- canonical transport (canonical-architecture.md §1) ----------------
    @staticmethod
    def _canonical_result(block: dict, res) -> dict:
        """Pass part-finder's merged canonical result through unchanged, or a degraded envelope (that turn
        is legacy). Only the session binding is checked; the state itself is never read here."""
        def degraded(reason):
            mode = "control" if block.get("mode") == "control" else "shadow"
            return {"schema": "cs/1", "mode": mode, "sessionId": block.get("sessionId"),
                    "priorVersion": block.get("version"), "version": block.get("version"),
                    "state": None, "classification": None, "rulesFired": [], "degraded": reason}
        if not isinstance(res, dict):
            return degraded("understand_unavailable")
        out = res.get("canonical")
        if not isinstance(out, dict):
            return degraded("understand_no_canonical")
        if out.get("sessionId") != block.get("sessionId"):
            return degraded("session_mismatch")
        return out

    def _rag_diagnose(self, st: ConversationState, **kw) -> dict:
        """The diagnostic RAG call. Records whether its reply is part-finder's single vague-opener clarification
        (describe the problem): that turn asks for no physical step, so it carries no owner-safety note."""
        rag = self.rag.diagnose(**kw)
        st._ragExclusiveClarify = bool(isinstance(rag, dict) and rag.get("exclusiveClarify"))
        return rag

    @staticmethod
    def _canon_kw(st) -> dict:
        """diagnose() receives the merged canonical result for its trace only — never for decisions."""
        out = getattr(st, "_canonical", None)
        if isinstance(out, dict) and not out.get("degraded"):
            return {"canonical": out}
        return {}

    # ---------------- state ----------------
    def _load(self, turn: TurnInput) -> ConversationState:
        st = self.store.get(turn.sessionId) or ConversationState(sessionId=turn.sessionId)
        st.turns += 1
        c = st.customer
        _MODEL_ID_TYPES = ("MODEL", "E_NR", "PNC", "12NC")

        # ---- SINGLE Jev UNDERSTAND (Story 3): run ONCE, BEFORE routing ----
        # Jev is the sole semantic authority. We run the one Jev UNDERSTAND pass here (part-finder
        # understand-only mode) and route on its TYPED decisions — routing NO LONGER re-reads the
        # customer's prose to infer appliance family, symptom presence or model-vs-error-code. The
        # exact typed intent is stored and forwarded verbatim to the RAG diagnose call so part-finder
        # does NOT run Jev again (one Jev call per turn). On a Jev transport failure we degrade to a
        # clarify (never a regex/prose guess); there is no second semantic authority.
        jev, raw = {}, {}
        # STAGE A: the PRIOR established conversation identity (from earlier turns) is threaded into
        # the Jev UNDERSTAND as context so Jev interprets the new turn against what is already known
        # instead of re-inferring the family from scratch. c.appliance/c.applianceState still hold the
        # PRIOR state here (they are updated later in this method), so this is genuinely last turn's
        # identity. It is context only — an explicit customer correction this turn still wins.
        prior_established = {"applianceFamily": c.appliance, "familyState": c.applianceState} \
            if (c.appliance and c.applianceState) else None
        # CANONICAL: the BFF-owned cs/1 block is TRANSPORTED, never interpreted. It is forwarded to
        # understand only when present (part-finder merges and decides), and the merged result is handed
        # back to the BFF untouched. The only reader is _canonical_control (the journey gate below).
        canon_in = getattr(turn, "canonical", None)
        canon_kw = {"canonical": canon_in} if isinstance(canon_in, dict) else {}
        res = None
        try:
            res = self.rag.understand(symptoms=turn.message, image=turn.image,
                                      conversation=getattr(turn, "conversation", None),
                                      established=prior_established, **canon_kw)
            jev = res.get("jev") or {}
            raw = res.get("understand") or {}
        except RagUnavailable:
            jev, raw = {}, {}
        st._canonical = self._canonical_result(canon_in, res) if canon_kw else None
        st._understand = raw            # forwarded verbatim to diagnose (no 2nd Jev call)
        st._jev = jev                   # typed decisions (routing + observability)
        decisions = (jev.get("decisions") or {}) if isinstance(jev, dict) else {}

        # Jev's TYPED meaning -> exactly the fields routing needs. No prose parsing here.
        jev_appliance = raw.get("applianceType") or None            # Jev applianceFamily
        jev_model = raw.get("model") or None                        # candidateTokenMeaning == model
        jev_code = raw.get("errorCode") or None                     # candidateTokenMeaning == error_code
        token_meaning = raw.get("_tokenMeaning") or decisions.get("candidateTokenMeaning")
        # A weak MODEL reading of the token (the family commit rule, applied to the token) is not committed: a
        # displayed code read as a model would otherwise be dropped silently. The clarify flow asks which it is.
        token_probs = (jev.get("probabilities") or {}).get("candidateTokenMeaning") if isinstance(jev, dict) else None
        token_decision, st._tokenDecision = routing.token_meaning_decision(token_meaning, token_probs)
        st._uncertainToken = None
        if jev_model and not jev_code and token_decision == "uncertain":
            st._uncertainToken = jev_model
            jev_model = None
        establishes = decisions.get("latestTurnEstablishes")
        # A turn goes to the RAG (which owns diagnosis AND the deterministic safety stop) when Jev
        # classified a diagnosable symptom (raw.fault) OR flagged a safety significance (gas / shock /
        # burning / supply-trip / microwave-arcing). Safety is NOT a symptomFamily, so it must be read
        # from Jev's safetySignificance or a hazard turn would clarify instead of stopping use.
        jev_safety = decisions.get("safetySignificance")
        jev_hazard = bool(jev_safety and jev_safety not in ("none", "uncertain")) \
            or establishes == "hazard"
        # SYMPTOM PRESENCE for routing is Jev's typed decision, NOT just a crisp `fault` string. Jev
        # leaves `fault` empty for real diagnosable problems it can't label as one component
        # (oversudsing foam, "hot but not dry"); those still belong to the RAG (which owns diagnosis
        # and grounded advice), never the orchestrator's generic "tell me more" clarify. A turn is a
        # diagnosable symptom when Jev typed it as a NEW_PROBLEM / EVIDENCE_UPDATE that is
        # diagnosis-ready — UNLESS it is a code-lookup turn (a code token, present or uncertain, or a
        # displayed-code family), which must stay on the code/clarify path so the MCP is used.
        symptom_family = decisions.get("symptomFamily")
        code_case = (token_meaning in ("error_code", "uncertain")
                     or decisions.get("secondaryTokenMeaning") == "error_code"
                     or symptom_family == "error_display"
                     or bool(jev_code))
        # FITTING_HELP (customer asking HOW to do a repair/test) also belongs to the RAG: it owns
        # fitting guidance AND the deterministic unsafe-intent refusal (e.g. microwave HV capacitor
        # discharge). Left on the orchestrator's generic clarify, an unsafe DIY request would get a
        # bland question instead of the mandated professional-only refusal.
        diagnostic_turn = (decisions.get("userIntent") in ("NEW_PROBLEM", "EVIDENCE_UPDATE", "FITTING_HELP")
                           and decisions.get("partReadiness") == "diagnosis_only")
        # A REAL symptom family Jev reports over the whole conversation is a diagnosable symptom even
        # when the LATEST turn is an identity/detail answer (e.g. userIntent ADDING_DETAIL as the
        # customer supplies the model). Without this the established symptom is dropped on that turn
        # and the diagnosis regresses to a generic clarify. Structured Jev state only; a code-display
        # family is NOT a diagnosable symptom (it belongs to the code path).
        real_symptom = bool(symptom_family) and symptom_family not in ("none", "uncertain", "error_display")
        jev_symptom = (bool(raw.get("fault"))
                       or jev_hazard
                       or ((diagnostic_turn or real_symptom) and not code_case))

        # MAKE stays a STRUCTURAL brand-catalogue lookup (recognising a KNOWN brand token is not
        # interpreting customer meaning). Jev does not classify make; identity retention is state.
        make = routing.detect_make(turn.message, turn.make)
        # APPLIANCE family is Jev's (applianceFamily) — never a BFF/regex fallback (that would be a
        # second semantic authority). Retention across turns is state (c.appliance below). We DEFER
        # to Jev's own confidence: when Jev says the family is not established (identitySufficiency ==
        # need_appliance) or is only a low-confidence guess, we DO NOT commit the guess — the turn is
        # treated as family-unknown so the RAG/clarify asks, rather than inventing a family the
        # customer never stated. This is Jev's uncertainty signal, not a second parser.
        fam_conf = (jev.get("confidence") or {}).get("applianceFamily") if isinstance(jev, dict) else None
        fam_probs = (jev.get("probabilities") or {}).get("applianceFamily") if isinstance(jev, dict) else None
        fam_provenance = decisions.get("applianceFamilyProvenance")
        # STAGE B: the first-turn proceed/clarify decision is a DETERMINISTIC function of the family
        # evidence itself (Jev's typed provenance + probability distribution: selected-family
        # probability, runner-up, margin) — NOT of the separate `identitySufficiency` field, which was
        # a second semantic classifier that could flip need_appliance/sufficient and randomly veto an
        # otherwise stable family decision. identitySufficiency is retained in Jev's decisions purely
        # as telemetry and no longer has routing authority here. A customer-supplied MODEL still
        # anchors identity structurally (never re-ask "which appliance?" after a stated model).
        # If the customer has given a MODEL, their identity is established — trust Jev's family and
        # never re-ask (asking "which appliance?" then reads as discarding the stated model =
        # FAMILY_INVENTED). Only withhold a weak / near-tied inferred family guess when there is NO
        # model to anchor identity (e.g. a bare "it fills but the drum won't turn").
        has_model_signal = bool(jev_model) or any(
            o.type in _MODEL_ID_TYPES and o.value for o in c.observed)
        if has_model_signal:
            family_decision, family_detail = "proceed", {"reason": "model_signal"}
        else:
            family_decision, family_detail = routing.first_turn_family_decision(
                provenance=fam_provenance, probabilities=fam_probs, confidence=fam_conf)
        family_established = (family_decision == "proceed")
        st._familyDecision = family_detail  # telemetry: how the first-turn family gate decided
        appliance = jev_appliance if (jev_appliance and family_established) else None

        # CODE: Jev owns model-vs-code classification over the whole conversation. We only NORMALISE
        # the token structurally and RETAIN it across turns; a Jev correction (it re-classified the
        # token as a model) clears a stale retained code. No shape/cue detection.
        code = routing._collapse_code(jev_code) if jev_code else None
        # COMPOUND displayed code: when Jev classified a SECOND code token (secondaryTokenMeaning ==
        # error_code) but only returned the primary value, preserve the customer's full displayed
        # code verbatim (e.g. "E36 or E10" -> "E36/E10"). Structural provenance of Jev-classified
        # code tokens, read from THIS turn's evidence — no code-vs-model decision is made here.
        if code and decisions.get("secondaryTokenMeaning") == "error_code":
            latest_evidence = raw.get("newEvidenceThisTurn") or turn.message or ""
            code = routing.compound_displayed_code(latest_evidence, code)
        elif not code:
            # Jev sometimes TYPES the token as an error code (candidate/secondary meaning) yet returns
            # no `errorCode` value, or misclassifies a customer-labelled code on messy input. Recover
            # the displayed code VALUE structurally from THIS turn's evidence — Jev still owns the
            # code-vs-model MEANING; this only reads the value it (or the customer's explicit label)
            # says is a code. No unlabelled/ambiguous token is promoted to a code here.
            jev_says_code = (token_meaning == "error_code"
                             or decisions.get("secondaryTokenMeaning") == "error_code")
            latest_evidence = raw.get("newEvidenceThisTurn") or turn.message or ""
            # VALUE recovery. Jev owns whether an UNLABELLED / AMBIGUOUS token means a code; when Jev
            # has positively classified it we read the sibling value(s). The remaining two recoveries
            # read the CUSTOMER'S OWN EXPLICIT statement, not an inference, so they are not a second
            # semantic authority:
            #   * code_from_cue — the customer explicitly LABELLED the token ("error e21", "fault E21").
            #     Recognising that explicit label is reading their words (syntax), not deciding meaning.
            #   * slash_compound_code — an unambiguous displayed-code SHAPE ("E36/E10"); models are
            #     never written that way. Deferred to Jev only when Jev classified the token as a MODEL.
            # These are never applied to a bare, unlabelled token Jev left ambiguous.
            if jev_says_code:
                toks = routing.displayed_codes_in(latest_evidence)
                if toks:
                    code = routing.compound_displayed_code(latest_evidence, toks[0])
            if not code:
                code = routing.code_from_cue(latest_evidence)
            if not code and token_meaning != "model":
                code = routing.slash_compound_code(latest_evidence)
        explicit_model_tokens = [jev_model] if jev_model else []

        # PENDING-SLOT STATE remains deterministic (what the assistant asked for last turn); the
        # SEMANTIC "did this turn answer it / is it a model or a code" is now Jev's job, so there is
        # no prose fill/correction here.
        st._pendingIn = turn.pendingRequest if isinstance(turn.pendingRequest, dict) else None
        st._ragExclusiveClarify = False  # set by _rag_diagnose for this turn only
        st._codeOnlyAnswer = False       # set by _compose_code_only for this turn only
        st._pendingFilled = False
        st._turnIndex = int(turn.turnIndex or 0)
        st._pendingModelTokens = [jev_model] if jev_model else []
        st._suppressModelLine = []
        # "Code present but no usable value" is now a Jev decision (symptomFamily == error_display
        # with no resolved code value), not a prose scan. Used by the clarify flow to ask for the
        # EXACT code rather than a generic description.
        st._codePresentNoValue = (decisions.get("symptomFamily") == "error_display"
                                  and not (jev_code or c.displayedCode))

        if make:
            c.make = make
        # STAGE A: deterministic cross-turn appliance-identity precedence. Jev owns the SEMANTIC
        # provenance (applianceFamilyProvenance: customer_named = the customer stated OR corrected the
        # family in their own words); this code owns the STATE precedence. No phrase/keyword parsing.
        #   1. An explicit customer identification/correction this turn (customer_named) is ESTABLISHED
        #      and wins — including correcting a previously established family to a different one.
        #   2. An already-ESTABLISHED family is PRESERVED: a weak / null / uncertain / inferred current
        #      turn (the existing Stage-B gate may still withhold `appliance`) does NOT overwrite it.
        #   3. Otherwise commit this turn's operational family (`appliance`, from the unchanged gate)
        #      as WORKING; a null/weak turn leaves the retained family untouched.
        # This adds only cross-turn persistence + explicit-correction override; the single-turn commit
        # gate (has_model_signal / identitySufficiency / fam_conf) is unchanged (Stage B untouched).
        provenance = decisions.get("applianceFamilyProvenance")
        explicit_named = provenance == "customer_named" and bool(jev_appliance)
        if explicit_named:
            c.appliance = jev_appliance
            c.applianceState = "established"
        elif c.applianceState == "established" and c.appliance:
            pass  # preserve the established family against a weak/null/inferred current turn
        elif appliance:
            c.appliance = appliance
            c.applianceState = "working"
        if code:
            c.displayedCode = code
        elif (token_meaning == "model" and jev_model and c.displayedCode
              and routing._norm_ident(c.displayedCode) == routing._norm_ident(jev_model)):
            # Jev reclassified the retained code-shaped token as the model -> clear the stale code.
            c.displayedCode = None
        if turn.region:
            c.region = turn.region
        ncode = routing._norm_ident(c.displayedCode) if c.displayedCode else None
        # Merge structurally-extracted observed identifiers (token EXTRACTION is structural); never
        # keep one Jev classified as the error code.
        if turn.observed:
            seen = {(o.type, o.value) for o in c.observed}
            for o in turn.observed:
                if ncode and o.type in _MODEL_ID_TYPES and routing._norm_ident(o.value) == ncode:
                    continue
                if (o.type, o.value) not in seen:
                    c.observed.append(o)
                    seen.add((o.type, o.value))
        # The model Jev classified becomes a MODEL observation (unless it IS the code).
        for mt in explicit_model_tokens:
            if ncode and routing._norm_ident(mt) == ncode:
                continue
            if not any(routing._norm_ident(o.value) == routing._norm_ident(mt)
                       and o.type in _MODEL_ID_TYPES for o in c.observed):
                c.observed.append(ObservedIdentifier("MODEL", mt))

        sympt = jev_symptom
        if sympt:
            # A later identity-only answer (Jev: latestTurnEstablishes == identity) must not erase
            # the persisted symptom by overwriting it with a bare model/identifier turn.
            model_answer_only = (establishes == "identity" and bool(c.symptomsText))
            if not model_answer_only:
                # Store the CUSTOMER's own words. The boundary may send a labelled transcript
                # ("Customer: … / Advisor asked: …"); our own advisor prose must never be captured as
                # the symptom. customer_speech strips advisor lines (unlabelled text is unchanged).
                c.symptomsText = routing.customer_speech(turn.message) or turn.message

        # TYPED-EVIDENCE RECONCILIATION (conversation-state persistence). Jev owns the semantic
        # reading of the latest turn; deterministic state owns what is already established and must
        # not silently lose it. Jev reads the whole thread each turn, so its current-turn typed lists
        # already fold in earlier turns. Rules, using Jev's OWN typed fields (no prose parsing):
        #   * Add (default): union this turn's items into the established set — a sparse turn with an
        #     empty list then simply PRESERVES what was established (variance can't drop it).
        #   * Correct: an explicit customer correction (Jev userIntent == CORRECTION, or
        #     latestTurnEstablishes == correction) REPLACES the set with this turn's corrected list.
        #   * declinedFacts are monotonic (never re-ask) — always union.
        # The established set is then written back onto the forwarded intent so COMPOSE sees the whole
        # established problem/checks/facts even when the latest turn is sparse. L0 customer evidence
        # (augmentable/correctable) — never promoted to an L1 trusted fact here.
        self._reconcile_typed_evidence(c, raw, decisions, establishes)

        # ---- MODEL-UNAVAILABLE LATCH (Journey Policy v2+: no model re-ask loop) ----
        # The model is UNAVAILABLE for the rest of the journey when EITHER Jev typed it this turn
        # (modelUnavailable: the customer cannot find/read the plate), OR we ASKED for the model on
        # the previous turn (pendingRequest.slot == MODEL) and the customer could not answer it this
        # turn (Jev answeredPrevious == cannot_answer / no, or cannotAnswer). "I don't know the model
        # offhand" is a cannot-answer to the model ask that Jev does not always type as the narrower
        # modelUnavailable, so without this the engine re-asks the same model question verbatim. The
        # latch is MONOTONIC and PERSISTED on customer state: once set, _cannot_provide_model is true
        # and the forwarded intent carries modelUnavailable, so NEITHER the Python model-acquisition
        # gate NOR the Node identification gate re-asks. A later trusted MODEL still wins (stage
        # MODEL_KNOWN is checked first). Typed-state only; no prose parsing. A trusted model supplied
        # THIS turn clears the latch (they found it after all).
        _pend = getattr(st, "_pendingIn", None) or {}
        _asked_model_last_turn = _pend.get("slot") == "MODEL"
        _could_not_answer = (decisions.get("answeredPrevious") in ("cannot_answer", "no")
                             or decisions.get("cannotAnswer") is True)
        _has_trusted_model = any(o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value
                                 for o in c.observed)
        # Durable record that a MODEL request has gone out at least once (survives an intermediate
        # degenerate/sparse turn that would otherwise lose the pendingRequest=MODEL signal).
        if _asked_model_last_turn:
            c.modelRequestedBefore = True
        if _has_trusted_model:
            c.modelUnavailable = False
        elif (bool(raw.get("modelUnavailable"))
              or (_asked_model_last_turn and _could_not_answer)
              # ANTI-LOOP: we already asked for the model and the customer's reply still did not
              # supply one — do not ask a second time, proceed model-independently. This fires on a
              # plain deflection ("not sure how old it is", a new symptom) that Jev does not type as
              # a narrow model cannot-answer, which is exactly the "repeats an unanswerable question"
              # loop. A model volunteered later still clears the latch (checked above).
              or (c.modelRequestedBefore and not _has_trusted_model)):
            c.modelUnavailable = True
        # Forward the latched state to BOTH consumers: _cannot_provide_model (reads raw) and the Node
        # diagnose pass (receives the forwarded intent), so each layer independently stops re-asking.
        if c.modelUnavailable:
            raw["modelUnavailable"] = True

        st._sympt = sympt  # transient
        st._includeEnrichment = turn.includeEnrichment
        # Clean latest-turn customer text for RAG context: prefer the boundary's latestMessage (the
        # latest customer utterance alone); fall back to advisor-stripped customer speech. Never the
        # full labelled transcript, which would feed our own advisor prose back as customer evidence.
        st._lastMessage = (turn.latestMessage or routing.customer_speech(turn.message)
                           or turn.message or "")
        st._image = turn.image                 # transient: this turn's rating-plate image (if any)
        st._conversation = getattr(turn, "conversation", None)
        return st

    @staticmethod
    def _reconcile_typed_evidence(c, raw, decisions, establishes) -> None:
        """Deterministic Preserve/Add/Correct reconciliation of Jev's typed customer evidence across
        turns, then re-inject the established set onto the forwarded intent (raw) so COMPOSE always
        receives the whole established problem/checks/facts. See caller for the rules."""
        def _clean(v):
            return [s.strip() for s in v if isinstance(s, str) and s.strip()] if isinstance(v, list) else []
        is_correction = (decisions.get("userIntent") == "CORRECTION" or establishes == "correction")

        # fault: short established problem phrase. Jev's current value wins (and a correction replaces
        # it); an empty latest turn preserves the established one.
        cur_fault = raw.get("fault")
        if isinstance(cur_fault, str) and cur_fault.strip():
            c.fault = cur_fault.strip()
        elif c.fault and not raw.get("fault"):
            raw["fault"] = c.fault

        for name in ("reportedSymptoms", "checksReported", "facts"):
            current = _clean(raw.get(name))
            if is_correction and current:
                established = current                       # Correct: corrected set replaces
            elif current:
                established = list(getattr(c, name) or [])  # Add: union, established order first
                seen = {s.lower() for s in established}
                for item in current:
                    if item.lower() not in seen:
                        established.append(item)
                        seen.add(item.lower())
            else:
                established = list(getattr(c, name) or [])  # Preserve: latest turn is sparse
            setattr(c, name, established)
            raw[name] = list(established)                   # forward the established set to COMPOSE

        # declinedFacts: monotonic union (once the customer could not answer, never re-ask).
        merged = list(c.declinedFacts or [])
        seen = {s.lower() for s in merged}
        for d in _clean(raw.get("declinedFacts")):
            if d.lower() not in seen:
                merged.append(d)
                seen.add(d.lower())
        c.declinedFacts = merged
        raw["declinedFacts"] = list(merged)

        # ESTABLISHED PROBLEM FALLBACK. Jev types some genuine symptoms with no mapped fault label
        # (symptomFamily 'other', e.g. "dishwasher isn't drying"), leaving fault/reportedSymptoms
        # empty. The problem is still established — it lives in c.symptomsText (the customer's own
        # words, retained across turns). Carry it as the established reportedSymptoms so a later
        # sparse turn (a model/identity answer) cannot drop the problem and COMPOSE never re-asks the
        # customer to describe what is wrong. This is the established problem text, not phrase/keyword
        # parsing; the symptom's existence was Jev's typed decision (a real symptomFamily this turn or
        # earlier). Only seeds when nothing typed is already carried, so a mapped fault still wins.
        if not c.reportedSymptoms and getattr(c, "symptomsText", None):
            problem = c.symptomsText.strip()
            if problem:
                c.reportedSymptoms = [problem[:180]]
                raw["reportedSymptoms"] = list(c.reportedSymptoms)

    @staticmethod
    def _established_identity(c):
        """Stage A: the established conversation identity handed to part-finder (understand +
        diagnose) so a genuinely established family is preserved into the diagnosis even when this
        turn's Jev output is weak. None unless an established/working family is actually held."""
        if c.appliance and c.applianceState:
            return {"applianceFamily": c.appliance, "familyState": c.applianceState}
        return None

    # ---------------- public entry ----------------
    def handle_turn(self, turn: TurnInput) -> OrchestratorResponse:
        t0 = time.perf_counter()
        st = self._load(turn)
        c = st.customer
        debug = {"latencies": {}, "sessionTurns": st.turns}
        if getattr(st, "_canonical", None) is not None:
            debug["canonical"] = st._canonical   # returned to the BFF only (persisted there, never shown)

        # INPUT SCOPE / SECURITY (single Jev typed decision, applied before routing).
        # Jev decided what the input MEANS in the one UNDERSTAND pass: requestClass is
        # appliance_request | prompt_attack | unrelated_request | ambiguous. Code applies the
        # deterministic consequence: a prompt attack or an unrelated (non-appliance) request is
        # redirected in-scope with the fixed refusal — no routing, no MCP, no diagnosis, no COMPOSE.
        # appliance_request and ambiguous fall through to normal WhichPart flow (ambiguous is NEVER
        # hard-blocked, so a real but terse/messy customer or a model token like "Dyson V6" is never
        # refused). This is NOT a regex gate; there is no phrase table and no wording-based override.
        _decisions = (getattr(st, "_jev", None) or {}).get("decisions") or {}
        _request_class = _decisions.get("requestClass")
        if _request_class in ("prompt_attack", "unrelated_request"):
            debug["requestClass"] = _request_class
            debug["scopeRefused"] = True
            return OrchestratorResponse(
                route=Route.CLARIFY.value, outcome=Outcome.ANSWER.value,
                message=SCOPE_REFUSAL_TEXT,
                provenance={"scope": Trust.L1_DETERMINISTIC.value},
                debug=debug)

        # CANONICAL CONTROL (any allow-listed registry journey, behind the BFF journey gate).
        # Part-finder decided the typed NextAction in understand mode (cs/1 -> diagnostics -> policy); the
        # RAG diagnose call only WORDS it. None of the legacy overrides run on this turn (_journey_stage /
        # model-acquisition, clarify routes, MCP code flows, owner note). Rollback: BFF CANONICAL_MODE=shadow
        # (all journeys) or drop one key from CANONICAL_CONTROL_JOURNEYS (that journey).
        canonical = self._canonical_control(st)
        if canonical:
            debug["route"] = Route.SYMPTOMS.value
            debug["canonicalControl"] = canonical.get("key")
            resp = self._flow_canonical(st, canonical, debug)
            warn = self._unsafe_intent_warning(st, resp)
            if warn and resp.outcome != Outcome.SAFETY_STOP.value and warn not in (resp.message or ""):
                resp.message = (warn + " " + (resp.message or "")).strip()
            return self._finish_turn(st, resp, debug, Route.SYMPTOMS, t0)

        # multi-turn: if we previously needed context for a code and the customer just supplied
        # model/identifiers (this turn added observed but no new code), retry the code resolution.
        supplied_context_followup = (bool(c.observed) and c.displayedCode
                                     and st.resolved.codeStatus in ("NEEDS_CONTEXT", None)
                                     and not st._sympt)

        # symptoms persist across turns until diagnosed (multi-turn accumulation)
        symptoms_present = st._sympt or bool(c.symptomsText)
        r = routing.route(turn.message, code=c.displayedCode, make=c.make,
                          appliance=c.appliance, symptoms=symptoms_present)
        if supplied_context_followup and c.make and c.appliance:
            r = Route.ERROR_CODE
        debug["route"] = r.value

        if r == Route.ERROR_CODE:
            resp = self._flow_error_code(st, debug)
        elif r == Route.SYMPTOMS:
            resp = self._flow_symptoms(st, debug)
        elif r == Route.ERROR_CODE_AND_SYMPTOMS:
            resp = self._flow_combined(st, debug)
        else:
            resp = self._flow_clarify(st, debug)

        # ACTIVE UNSAFE-INTENT WARNING (single choke point). If the customer asked to PERFORM a
        # dangerous action, prepend an explicit "don't do that" warning to whatever we compose —
        # unless the reply is already a safety-stop that leads with the authoritative action (e.g. a
        # gas-with-a-flame request already returns the gas emergency). Additive; never suppresses the
        # underlying diagnosis and never adds procedural detail.
        warn = self._unsafe_intent_warning(st, resp)
        if warn and resp.outcome != Outcome.SAFETY_STOP.value and warn not in (resp.message or ""):
            resp.message = (warn + " " + (resp.message or "")).strip()
            resp.provenance = {**(resp.provenance or {}), "safety": Trust.L1_DETERMINISTIC.value}

        # FAMILY-STANDING OWNER-SAFETY NOTE (single choke point). When the orchestrator itself
        # composed a diagnostic (symptom) clarify for a hazardous family, the part-finder's owner
        # precaution never reached the customer (that branch uses only the short question). Carry it
        # here so safe framing is reliable on those turns too — narrow and additive (see
        # _owner_safety_note); never on identity asks, safety stops, reassurance or grounded answers.
        note = self._owner_safety_note(st, resp)
        if note and note not in (resp.message or ""):
            resp.message = (note + " " + (resp.message or "")).strip()
            resp.provenance = {**(resp.provenance or {}), "safety": Trust.L1_DETERMINISTIC.value}

        # PRESENTATION RESTRAINT (deterministic): an enumerated run of code-shaped tokens is an
        # INTERNAL inventory, never customer prose. Collapse it so no composed reply can dump a
        # manufacturer code list ("Is it F01, F02, F03 ... F80?"). A short realistic ambiguity is kept.
        if resp.message:
            resp.message = routing.collapse_code_list(resp.message)

        # STRUCTURAL pending-request emission (single choke point). Derive the semantic slot we are
        # asking the customer to answer NEXT from the STRUCTURED response we just composed (its
        # outcome / clarification.needs / modelRequired / codeStatus) — NEVER from its prose. The
        # boundary carries this back so the next turn's answer fills the right slot. A grounded,
        # non-clarifying ANSWER with nothing outstanding emits None (the request is CONSUMED).
        resp.pendingRequest = self._pending_for(st, resp)

        # Journey Policy v2 telemetry (internal only): the explicit stage this turn resolved to.
        if getattr(st, "_journeyStage", None):
            debug["journeyStage"] = st._journeyStage
        return self._finish_turn(st, resp, debug, r, t0)


    def _finish_turn(self, st: ConversationState, resp: OrchestratorResponse, debug: dict, r, t0) -> OrchestratorResponse:
        c = st.customer
        debug["latencies"]["total_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        debug["state"] = {
            "customer": {
                "make": st.customer.make, "appliance": st.customer.appliance,
                "displayedCode": st.customer.displayedCode,
                "observed": [{"type": o.type, "value": o.value} for o in st.customer.observed],
                "symptomsText": st.customer.symptomsText,
                "fault": st.customer.fault,
                "reportedSymptoms": list(st.customer.reportedSymptoms or []),
                "checksReported": list(st.customer.checksReported or []),
                "facts": list(st.customer.facts or []),
                "declinedFacts": list(st.customer.declinedFacts or []),
            },
            "resolved": {
                "codeStatus": st.resolved.codeStatus, "canonicalMeaning": st.resolved.canonicalMeaning,
                "recordType": st.resolved.recordType, "system": st.resolved.system,
                "safetyClass": st.resolved.safetyClass, "stopUse": st.resolved.stopUse,
            },
            "inferred": {
                "faultId": st.inferred.faultId, "faultLabel": st.inferred.faultLabel,
                "system": st.inferred.system, "grounded": st.inferred.grounded,
                "confidence": st.inferred.confidence,
                "candidateComponents": list(st.inferred.candidateComponents or []),
            },
            "clarificationRequested": st.clarificationRequested,
        }
        debug["safetyState"] = st.safetyState
        debug["safetyReason"] = st.safetyReason
        debug["unsafeIntent"] = st.unsafeIntent
        debug["familyDecision"] = getattr(st, "_familyDecision", None)
        resp.route = r.value
        # RESOLVED identity for boundary observability (customer-safe). This is the make / appliance
        # family / displayed code the orchestrator ACTUALLY routed and (for a code) submitted to the
        # MCP this turn — the single Jev UNDERSTAND's family + the structural make/code. The BFF logs
        # it as mcpSubmitted so telemetry reflects the single authority, not a boundary re-parse.
        resp.understood = {
            "make": c.make,
            "appliance": c.appliance,
            "displayedCode": c.displayedCode,
        }
        resp.debug = {**resp.debug, **debug}
        self.store.put(st)
        return resp

    # ---------------- canonical control ----------------
    def _canonical_control(self, st) -> Optional[dict]:
        """The deciding canonical journey when it owns this turn: a non-degraded result whose `journey` is a
        registry key, applies, is allow-listed (control) and carries a typed NextAction. Anything else -> legacy."""
        out = getattr(st, "_canonical", None)
        if not isinstance(out, dict) or out.get("degraded"):
            return None
        j = out.get("journey")
        if isinstance(j, dict) and j.get("control") and j.get("applies") and isinstance(j.get("nextAction"), dict) \
                and j.get("key") in self._CANONICAL_JOURNEYS:
            return j
        return None

    # key -> likely area, from the shared journey registry (services/part-finder/canonical/journeys.json).
    _CANONICAL_JOURNEYS = _load_canonical_journeys()

    # typed conclusion cause -> customer-facing diagnosis summary (all journeys)
    _CAUSE_LABEL = {
        "filter-blockage": "Blocked pump filter", "impeller-obstruction": "Obstruction at the pump impeller",
        "hose-or-waste-restriction": "Drain hose or waste restriction", "household-waste-backflow": "Household waste plumbing",
        "excess-suds": "Excess foam", "drain-pump": "Drain pump", "pressure-or-level": "Water-level (pressure) sensing",
        "control": "Control circuit", "obstruction-beyond-reach": "Blockage beyond the filter",
        # Journey 2 (not spinning)
        "load-imbalance": "Out-of-balance load", "programme-setting": "Programme / spin setting",
        "suspension-or-movement": "Suspension / levelling", "door-lock": "Door lock (interlock)", "drive-belt": "Drive belt",
        "motor-brushes": "Motor carbon brushes", "motor-drive": "Motor / motor control / speed sensing",
        "mechanical-resistance": "Drum bearings / mechanical resistance",
        # Journey 3 (leaking)
        "door-seal": "Door seal", "dispenser": "Detergent drawer", "oversudsing": "Excess detergent / foam",
        "filter-seal": "Pump filter cap / seal", "inlet-connection": "Fill hose / tap connection", "inlet-valve-or-fill": "Inlet valve / fill side",
        "drain-connection": "Drain hose / standpipe connection", "household-backflow": "Household waste plumbing", "pump-body": "Drain pump body",
        "internal-hose": "Internal hose", "tub-or-major-internal": "Tub / internal leak", "leak-source-unconfirmed": "Leak source not confirmed",
        # batch 2
        "fault-source-unconfirmed": "Cause not confirmed", "household-supply": "Household water supply", "tap-or-fill-hose": "Tap / fill hose",
        "inlet-mesh-filter": "Inlet mesh filter", "door-interlock": "Door lock (interlock)", "inlet-valve": "Inlet (fill) valve",
        "pressure-or-control": "Level sensing / control", "inlet-valve-stuck-open": "Inlet valve sticking open", "drain-hose-siphon": "Drain hose installation (siphon)",
        "waste-backflow": "Household waste backflow", "foam-level": "Excess detergent foam", "level-sensing-or-control": "Level sensing / control",
        "normal-release-delay": "Normal door-lock delay", "child-lock": "Child lock", "handle-or-catch": "Door handle / catch",
        "transit-bolts": "Transit bolts", "levelling-or-floor": "Levelling / floor", "suspension-dampers": "Suspension / shock absorbers",
        "drum-support-or-bearings": "Drum support / bearings", "normal-operating-noise": "Normal operating noise", "pump-obstruction": "Object in the drain pump",
        "foreign-object": "Object in the drum / tub", "load-or-installation": "Load / installation", "drain-pump-worn": "Drain pump",
        "belt-pulley-or-motor": "Belt / pulley / motor", "drum-bearings": "Drum bearings", "normal-low-temperature": "Normal low-temperature washing",
        "heater-element": "Heater element", "temperature-sensor": "Temperature sensor",
        "fill-or-level": "Fill / water level", "heating-control": "Heating control / wiring",
        # dishwasher family
        "filter-or-sump-blockage": "Blocked filter / sump", "drain-hose-restriction": "Drain hose restriction",
        "household-waste-or-spigot": "Household waste / sink spigot", "level-or-control": "Drain control side",
        "tap-hose-or-aquastop": "Tap / inlet hose / AquaStop", "door-not-recognised": "Door latch / switch",
        "fill-sensing-or-control": "Fill sensing / control", "foam-or-wrong-detergent": "Foam / wrong detergent",
        "loading-or-spray-escape": "Loading / spray escaping",
        "internal-leak": "Internal leak (flood protection)", "dirty-filter": "Dirty filter",
        "spray-arm-jets": "Spray arm jets", "loading": "Loading", "detergent-or-dispenser": "Detergent / dispenser",
        "programme-choice": "Programme choice", "spray-arm-damaged": "Spray arm damaged", "circulation-or-distribution": "Wash circulation / distribution",
        "normal-condensation-drying": "Normal condensation drying", "rinse-aid": "Rinse aid", "drying-system": "Drying system", "heater": "Heater",
        "power-supply": "Power supply", "mains-or-control-dead": "Mains input / control", "child-or-control-lock": "Child / control lock",
        "delay-start-or-programme": "Delay start / programme", "door-obstruction-or-alignment": "Door obstruction / alignment",
        "door-latch": "Door latch / switch", "start-control": "Start control",
        # fridge / freezer family
        "door-left-open": "Door left open / warm food", "temperature-setting": "Temperature setting / mode",
        "blocked-vents-or-overpacking": "Blocked vents / over-packing", "condenser-coils-or-clearance": "Condenser coils / clearance",
        "room-temperature-location": "Room temperature / location", "internal-fan-or-airflow": "Internal fan / airflow",
        "sealed-system-or-compressor": "Sealed cooling system", "food-against-back-wall": "Food against the back wall",
        "thermostat-sensor-or-damper": "Thermostat / sensor / damper", "internal-fan": "Internal fan",
        "touching-or-loose-at-back": "Touching / loose at the back", "runs-constantly-coils": "Runs constantly (coils / space)",
        "condenser-fan-or-compressor-area": "Condenser fan / compressor area", "blocked-defrost-drain": "Blocked defrost drain",
        "condensation-door-or-warm-food": "Condensation (door / warm food)", "drip-tray-or-drain-tube": "Drip tray / drain tube",
        "water-supply-line": "Water supply line", "one-off-door-or-loading": "One-off frost (door / loading)",
        "door-seal-air-leak": "Door seal letting air in", "defrost-system": "Defrost system",
        "door-obstruction-or-level": "Door obstruction / levelling", "door-hinge-or-alignment": "Door hinge / alignment",
        "door-handle": "Door handle", "door-closes-fine": "Door closes and seals", "lights-on-not-running": "Compressor not being started",
        "click-start-relay-or-compressor": "Compressor start device / compressor", "running-not-cooling": "Running but not cooling",
        # tumble dryer family
        "airflow-thermal-cut-out": "Airflow tripping the thermal cut-out", "heat-pump-runs-cooler": "Normal heat-pump drying",
        "heat-pump-system": "Heat-pump system", "heater-or-thermal-cut-out": "Heater / thermal cut-out / thermostat",
        "lint-filter": "Lint filter", "load-size-or-spin": "Load size / spin", "condenser-blocked": "Clogged condenser", "vent-hose-restricted": "Restricted vent hose",
        "moisture-sensor-strips": "Moisture-sensor strips", "programme-or-dryness-level": "Programme / dryness level",
        "drying-airflow-system": "Internal airflow (fan / ducting)", "overload-or-bulky-item": "Overload / bulky item",
        "drum-seized-rollers-or-bearing": "Drum rollers / bearing seized", "motor-or-control": "Motor / control",
        "drum-rollers-or-idler": "Drum rollers / idler wheel", "drive-area": "Belt / drive area",
        "normal-pump-or-compressor-hum": "Normal pump / compressor hum", "airflow-overheating": "Airflow overheating",
        "load-size": "Load size", "sensor-ends-early": "Moisture sensor ending early",
        "thermal-protection-or-thermostat": "Overheat protection / thermostat", "control-or-power": "Control / power",
        "container-full-or-not-seated": "Water container full / not seated", "container-damaged": "Water container damaged",
        "drain-kit-fitted": "Drain kit fitted", "condensate-pump-or-float": "Condensate pump / float",
        "internal-hose-or-seal-leak": "Internal hose / seal", "vented-no-container": "Vented dryer (no container)", "object-out-of-reach": "Item stuck out of reach", "unsafe-request-declined": "Unsafe request declined",
        # final pass: oven / cooker, hob, microwave, vacuum, washer-dryer
        "pan-compatibility": "Pan not suiting induction", "key-or-child-lock": "Key / child lock",
        "induction-zone-or-power-board": "That zone's induction coil or power board",
        "element-or-zone-control": "That zone's element or its control", "control-or-power-side": "Hob control or power side",
        "supply-or-isolator": "Supply", "mains-connection-or-power-side": "Hob's mains connection or power side", "touch-control": "Touch control",
        "cooling-or-ventilation": "Hob's cooling / ventilation", "temperature-sensor-or-control": "Temperature sensor or control",
        "zone-stuck-on": "Zone stuck on", "burner-cap-wet-or-misaligned": "Burner cap that was wet, dirty or not seated",
        "igniter-or-spark-unit": "Igniter / spark unit", "flame-failure-device": "Flame-failure safety device", "gas-supply": "Gas supply",
        "power-level-or-mode": "Power level or mode", "high-voltage-heating-system": "High-voltage heating system",
        "overheat-cut-out-or-control": "Overheat cut-out or control", "supply-or-plug-fuse": "Socket or plug fuse",
        "internal-fuse-cut-out-or-control": "Internal fuse, a thermal cut-out or the control", "control-or-child-lock": "Control / child lock",
        "clock-or-programme-not-set": "Clock or programme not being set", "dirt-or-obstruction": "Grease or food stopping the latch",
        "door-hook-or-latch": "Broken door hook / latch", "door-release-mechanism": "Door release mechanism",
        "interlock-switches": "Door interlock switches", "door-glass-cracked": "Cracked door glass",
        "tray-seating-or-obstruction": "Tray not sitting on its drive or something catching",
        "coupler-or-roller-ring": "Broken coupler or roller ring", "turntable-motor": "Turntable motor",
        "metal-or-foil-inside": "Metal or foil inside", "waveguide-cover": "Burnt waveguide cover",
        "cavity-paint-burnt": "Burnt / chipped paint inside", "arcing-high-voltage-side": "High-voltage side", "turntable-noise": "Turntable parts",
        "high-voltage-noise": "High-voltage parts", "door-interlock-or-control": "Door interlock or control",
        "clock-or-auto-mode": "Clock / timer being in auto mode", "function-or-setting": "Function or temperature setting",
        "fan-oven-element": "Fan-oven element", "thermostat-or-sensor": "Thermostat or temperature sensor",
        "selector-or-control": "Function selector or control", "setting-or-function": "Setting or function",
        "circulation-fan": "Oven fan not circulating the heat", "cooling-fan-or-overheat-cut-out": "Cooling fan / overheat cut-out",
        "thermostat-sensor-or-control": "Thermostat, temperature sensor or control", "control-stuck-on": "Control stuck on",
        "grill-setting-or-door-position": "Grill setting or door position", "grill-element": "Grill element",
        "grill-control-or-selector": "Grill control or selector", "fan-motor": "Oven fan motor",
        "loose-fan-blade-or-cover": "Loose fan blade or back cover", "cooling-fan": "Cooling fan", "cooling-fan-run-on": "Cooling fan running on",
        "supply-or-cooker-switch": "Supply", "mains-input-or-control": "Oven's mains input or control",
        "lock-released-after-cooling": "Door lock not having released yet",
        "door-obstruction-or-seating": "Something in the way or the door not seated", "door-hinge": "Door hinge",
        "door-fine": "Nothing wrong with the door", "moisture-after-cleaning": "Moisture in an element after cleaning",
        "element-insulation": "Element's insulation breaking down", "wiring-terminal-or-control": "Wiring, terminal block or control",
        "bin-or-filters": "Full bin or clogged filters", "airflow-blockage": "Blockage in the hose, wand or floorhead",
        "brush-bar-tangled": "Tangled brush bar", "internal-seal-or-motor-area": "Internal seal or the motor area",
        "brush-bar-jammed": "Jammed brush bar", "battery-or-charging": "Battery or charging",
        "internal-motor-or-electronics": "Motor or electronics inside", "mains-supply-or-fuse": "Socket or plug fuse",
        "charger-or-dock": "Charger, socket or charging contacts", "thermal-cut-out-after-blockage": "Thermal cut-out after a blockage",
        "battery-or-charger-fault": "Battery or charger", "switch-cable-or-motor": "Switch, cable or motor inside",
        "damaged-cable-stop-use": "Damaged mains cable or plug", "brush-bar-tangled-or-jammed": "Hair or thread jamming the brush bar",
        "brush-bar-damaged": "Broken brush bar", "floorhead-drive": "Floorhead's own drive or motor",
        "charger-socket-or-contacts": "Charger, socket or charging contacts", "boost-or-max-mode": "Boost / max mode",
        "filters-choking-motor": "Clogged filters", "battery-or-charger-not-charging": "Battery or the charger", "battery-worn": "Worn battery",
        "brush-bar-or-head": "Something caught in the brush bar or floorhead", "bin-or-filter-seating": "Bin or filter not seated properly",
        "motor-bearing-or-fan": "Motor bearing or fan", "drying-load-over-capacity": "Drying load bigger than the dry capacity",
        "drying-programme-not-set": "Drying programme or dryness setting", "condenser-water-supply": "Cold water supply the condenser needs",
        "pump-filter-fluff": "Fluff in the pump filter", "drying-heater-or-thermostat": "Drying heater or its thermostat",
        "drying-sensor": "Drying sensor", "drying-fan-or-air-duct": "Drying fan or air duct",
    }

    def _flow_canonical(self, st: ConversationState, journey: dict, debug: dict) -> OrchestratorResponse:
        c = st.customer
        t = time.perf_counter()
        try:
            rag = self._rag_diagnose(st, **self._canon_kw(st), understand=getattr(st, "_understand", None),
                                    symptoms=self._rag_symptoms(st) or c.symptomsText or "",
                                    appliance=c.appliance, make=c.make, image=getattr(st, "_image", None),
                                    established=self._established_identity(c),
                                    conversation=getattr(st, "_conversation", None))
        except RagUnavailable as e:
            debug["ragError"] = str(e)[:120]
            # The customer never saw the NextAction this state records (its issued request included): mark the
            # canonical result degraded so the BFF does not persist it, and the next turn starts from the prior state.
            if isinstance(debug.get("canonical"), dict):
                debug["canonical"] = {**debug["canonical"], "degraded": "diagnose_unavailable"}
            return self._service_unavailable("symptom", "I can't run the diagnosis right now. Please try again shortly.")
        debug["latencies"]["rag_ms"] = round((time.perf_counter() - t) * 1000, 1)
        debug["ragInvoked"] = True
        debug["ragTrace"] = rag.get("diagnosticTrace")
        self._apply_rag_safety(st, rag)
        # The NextAction COMPOSE worded (diagnose `done.canonicalControl`); falls back to the understand-time one.
        cj = rag.get("canonicalControl") or {}
        a = cj.get("nextAction") if isinstance(cj.get("nextAction"), dict) else journey.get("nextAction") or {}
        debug["canonicalAction"] = {"journey": journey.get("key"), "rule": a.get("rule"), "kind": a.get("kind"),
                                    "target": a.get("target"), "compose": cj.get("compose")}
        kind = a.get("kind")
        msg = (rag.get("reply") or "").strip()
        media = rag.get("media") or None
        prov = {"diagnosis": Trust.L1_DETERMINISTIC.value, "journey": Trust.L1_DETERMINISTIC.value}
        if kind == "safety_stop":
            cls = (rag.get("safety") or {}).get("class") or "STOP_USE"
            return OrchestratorResponse(route="", outcome=Outcome.SAFETY_STOP.value, message=msg,
                                        safety={"class": cls, "stopUse": True, "message": msg},
                                        provenance={"safety": Trust.L1_DETERMINISTIC.value})
        concl = a.get("conclusion") or {}
        diag = None
        if kind in ("conclude", "close_resolved", "recommend_part") and concl.get("cause"):
            diag = DiagnosisView(summary=self._CAUSE_LABEL.get(concl.get("cause"), concl.get("cause")),
                                 likelyArea=self._CANONICAL_JOURNEYS.get(journey.get("key")),
                                 confidenceBand="likely" if concl.get("confidence") == "likely" else "possible")
        pending = a.get("pending") or None
        if kind == "ask_identity" and a.get("target") == "model":
            resp = OrchestratorResponse(route="", outcome=Outcome.ANSWER.value, message=msg, media=media,
                                        modelRequired=True, traceId=rag.get("traceId"), provenance=prov,
                                        clarification={"question": "What is the model number?",
                                                       "needs": [{"attribute": "model", "resolutionSources": ["MODEL", "E_NR", "RATING_PLATE"]}]})
            resp.pendingRequest = {"slot": "MODEL", "purpose": "PART_FIT", "status": "PENDING"}
            return resp
        parts = (rag.get("parts") or None) if kind == "recommend_part" else None
        resp = OrchestratorResponse(route="", outcome=Outcome.ANSWER.value, message=msg, diagnosis=diag,
                                    componentMention="purchase" if kind == "recommend_part" else "none",
                                    parts=parts, resolvedModel=rag.get("resolvedModel") if parts else None,
                                    traceId=rag.get("traceId"), media=media, modelRequired=False, provenance=prov)
        resp._reassurance = kind in ("close_resolved",)
        resp.pendingRequest = ({"slot": "SYMPTOM_DISCRIMINATOR", "purpose": "DIAGNOSIS", "status": "PENDING"}
                               if pending else None)
        return resp

    # ---------------- MCP mapping ----------------
    def _apply_mcp(self, st: ConversationState, mcp: dict) -> None:
        rv = st.resolved
        rv.codeStatus = mcp.get("status")
        if mcp.get("status") == "RESOLVED":
            rv.canonicalMeaning = mcp.get("meaning")
            rv.recordType = mcp.get("recordType")
            rv.system = mcp.get("system")
            rv.scheme = mcp.get("scheme")
            rv.mappingConfidence = mcp.get("confidence")
            enr = mcp.get("enrichment") or {}
            beh = enr.get("behaviour") or {}
            rv.protectionState = beh.get("protectionState")
            saf = enr.get("safety") or {}
            rv.safetyClass = saf.get("class")
            rv.stopUse = saf.get("stopUse")
        # monotonic safety high-water mark
        st.safetyState = strongest_safety(st.safetyState, rv.safetyClass)

    @staticmethod
    def _mcp_candidate_areas(mcp: dict) -> set:
        """Coarse diagnostic areas of the MCP's candidate meanings for an UNRESOLVED code, derived
        ONLY from the structured candidate fields (faultId / system) — never prose. Used to test
        whether a grounded runtime diagnosis conflicts with what the code could mean. NEEDS_CONTEXT
        and AMBIGUOUS responses both carry `candidates[]`; NOT_FOUND carries none (empty set)."""
        areas: set = set()
        for cand in (mcp.get("candidates") or []):
            if not isinstance(cand, dict):
                continue
            area = _diagnostic_area(cand.get("faultId") or cand.get("system"))
            if area:
                areas.add(area)
        return areas

    def _trusted_context(self, st: ConversationState, mcp: dict) -> TrustedDiagnosticContext:
        enr = mcp.get("enrichment") or {}
        return TrustedDiagnosticContext(
            facts={
                "code": mcp.get("code"),
                "make": st.customer.make, "appliance": st.customer.appliance,
                "canonicalMeaning": mcp.get("meaning"),
                "recordType": mcp.get("recordType"),
                "system": mcp.get("system"),
                "protectionState": (enr.get("behaviour") or {}).get("protectionState"),
                "scheme": mcp.get("scheme"),  # internal to the port; never surfaced to customer
            },
            possibilities={
                "components": (enr.get("components") or []),      # L2 — NOT facts
                "likelyCauses": (enr.get("likelyCauses") or []),  # L2 — NOT facts
            },
            suggestedChecks=(enr.get("checks") or []),            # L2
            safety={"class": (enr.get("safety") or {}).get("class"),
                    "stopUse": (enr.get("safety") or {}).get("stopUse")},
        )

    # ---------------- flows ----------------
    def _flow_error_code(self, st: ConversationState, debug: dict) -> OrchestratorResponse:
        c = st.customer
        t = time.perf_counter()
        try:
            mcp = self.ec.resolve_error_code(c.make, c.appliance, c.displayedCode,
                                             observed=[{"type": o.type, "value": o.value} for o in c.observed] or None,
                                             region=c.region, includeEnrichment=getattr(st, "_includeEnrichment", True))
        except McpUnavailable as e:
            debug["mcpError"] = str(e)[:120]
            return self._service_unavailable("code",
                "I can't look up that error code right now. Please try again shortly — "
                "I won't guess what the code means.")
        debug["latencies"]["mcp_ms"] = round((time.perf_counter() - t) * 1000, 1)
        debug["mcpStatus"] = mcp.get("status")
        debug["mcpEvidence"] = {
            "status": mcp.get("status"), "displayedCode": _facing_code(st, mcp),
            "meaning": mcp.get("meaning"), "recordType": mcp.get("recordType"),
            "system": mcp.get("system"), "confidence": mcp.get("confidence"),
            "candidateCount": len(mcp.get("candidates") or []),
        }
        self._apply_mcp(st, mcp)
        status = mcp.get("status")

        # DETERMINISTIC AUTHORITY RECONCILIATION (code-only turn).
        # Precedence: safety (monotonic, already folded in via _apply_mcp) > MCP RESOLVED meaning >
        #   MCP-unresolved (NEEDS_CONTEXT / AMBIGUOUS / NOT_FOUND) reconciled with a NON-CONFLICTING
        #   grounded runtime diagnosis > clarify. When the MCP recognises the code but cannot pin its
        #   EXACT meaning (scheme/model dependent), we must NOT reflexively demand the model: the
        #   part-finder runtime resolver is an equally-deterministic authority that may already
        #   ground the fault from the make + appliance + code in hand. We ask it (its own staged
        #   contract runs), then compare STRUCTURALLY — MCP candidate faultId/system areas vs the
        #   runtime system/faultId area — with NO prose/LLM comparison. If the runtime diagnosis does
        #   not CONFLICT with the MCP's documented meanings, that grounded diagnosis leads and the
        #   model is requested only to refine the EXACT part (never "to read the code"). A genuinely
        #   model-dependent code whose candidate meanings DIVERGE (or a runtime area outside the
        #   candidate set) stays a clarification — we never silently pick one meaning. RESOLVED /
        #   INVALID_INPUT keep their existing single-authority handling below.
        if status in ("NEEDS_CONTEXT", "AMBIGUOUS", "NOT_FOUND"):
            t = time.perf_counter()
            try:
                rag = self._rag_diagnose(st, **self._canon_kw(st), understand=getattr(st, '_understand', None), symptoms=self._rag_symptoms(st), appliance=c.appliance,
                                        make=c.make, image=getattr(st, "_image", None),
                                        established=self._established_identity(c),
                                        conversation=getattr(st, "_conversation", None))
            except RagUnavailable as e:
                debug["ragError"] = str(e)[:120]
                rag = None
            debug["latencies"]["rag_ms"] = round((time.perf_counter() - t) * 1000, 1)
            if rag and rag.get("grounded"):
                self._apply_rag_safety(st, rag)
                debug["ragTrace"] = rag.get("diagnosticTrace")
                runtime_area = _diagnostic_area(rag.get("system") or rag.get("faultId"))
                cand_areas = self._mcp_candidate_areas(mcp)
                # non-conflicting when: (a) the MCP documented NO competing meaning (NOT_FOUND, or no
                #   candidates) so the runtime diagnosis stands alone; OR (b) all candidate meanings
                #   collapse to the SAME single area and the runtime agrees with it (structural
                #   ambiguity the model only refines). Divergent candidate areas, or a runtime area
                #   outside the candidate set, is a genuine conflict -> clarify (never silently pick).
                non_conflicting = (len(cand_areas) == 0
                                   or (len(cand_areas) == 1 and runtime_area in cand_areas))
                debug["codeOnlyRuntimeArea"] = runtime_area
                debug["codeOnlyMcpAreas"] = sorted(cand_areas)
                debug["codeOnlyReconciled"] = non_conflicting
                if non_conflicting:
                    return self._compose_unresolved_code_plus_symptoms(st, mcp, rag)
            else:
                debug["codeOnlyReconciled"] = False
        return self._compose_code_only(st, mcp)

    # "The customer cannot give the model" is Jev's TYPED decision (understand.modelUnavailable), NOT
    # something the orchestrator re-derives from prose. When Jev flags it we must STOP re-asking for
    # the model (no loop) and fall back to the RAG's brand-scoped VERIFY_FIT parts / advice. Jev is
    # the single semantic authority; there is no second phrase/regex parser here.
    def _cannot_provide_model(self, st: ConversationState) -> bool:
        raw = getattr(st, "_understand", None) or {}
        return bool(raw.get("modelUnavailable"))

    def _rag_symptoms(self, st: ConversationState) -> str:
        """Assemble the symptom text handed to the RAG so its OWN staged conversation contract can
        execute. We DO NOT diagnose here — we simply stop starving the RAG of context:
          - the accumulated symptom (persists across turns),
          - the latest turn's raw text (e.g. a model number, or "I can't find the model"),
          - any model/identifier the customer has provided (so the RAG can resolve model-specific
            parts — Stage 2 — even when the model arrived on a later turn).
        Non-manufacturer-specific; no RAG knowledge duplicated; the RAG remains the authority."""
        c = st.customer
        # Strip any code-shaped token the pending MODEL slot reclaimed as a model answer, so the RAG
        # never sees a bare "E18" it could read as an error code; it is re-added as an explicit MODEL
        # line below. No-op when nothing was reclaimed (normal flows unchanged).
        suppress = getattr(st, "_pendingModelTokens", None) or []
        def _strip(text: str) -> str:
            if not text or not suppress:
                return text
            for tok in suppress:
                text = _re.sub(r"\b" + _re.escape(tok) + r"\b", " ", text, flags=_re.I)
            return _re.sub(r"\s{2,}", " ", text).strip(" .,;")
        parts: list[str] = []
        if c.symptomsText:
            parts.append(_strip(c.symptomsText))
        last = _strip(getattr(st, "_lastMessage", "") or "")
        if last and last != _strip(c.symptomsText or ""):
            parts.append(last)
        joined = "  ".join(parts)
        # The displayed error code is persistent customer-provided context. On a LATER turn (e.g. the
        # customer replies with only their model number) the raw message no longer contains the code,
        # so without this the runtime resolver would lose the code it could diagnose from. Re-attach
        # it if it isn't already present in the text. Non-manufacturer-specific; no code MEANING is
        # asserted here — the resolver still owns whether the code grounds a fault.
        if c.displayedCode and c.displayedCode.lower() not in joined.lower():
            parts.append(f"The displayed error code is {c.displayedCode}.")
            joined = "  ".join(parts)
        _suppress_line = {routing._norm_ident(t) for t in (getattr(st, "_suppressModelLine", None) or [])}
        models = [o.value for o in c.observed
                  if o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value
                  and routing._norm_ident(o.value) not in _suppress_line]
        if models and not any(m in joined for m in models):
            parts.append(f"The model number is {models[0]}.")
        return "  ".join(parts).strip()

    def _flow_symptoms(self, st: ConversationState, debug: dict) -> OrchestratorResponse:
        c = st.customer
        t = time.perf_counter()
        try:
            rag = self._rag_diagnose(st, **self._canon_kw(st), understand=getattr(st, '_understand', None), symptoms=self._rag_symptoms(st) or c.symptomsText or "",
                                    appliance=c.appliance, make=c.make,
                                    image=getattr(st, "_image", None),
                                    established=self._established_identity(c),
                                    conversation=getattr(st, "_conversation", None))
        except RagUnavailable as e:
            debug["ragError"] = str(e)[:120]
            return self._service_unavailable("symptom",
                "I can't run the symptom diagnosis right now. Please try again shortly.")
        debug["latencies"]["rag_ms"] = round((time.perf_counter() - t) * 1000, 1)
        debug["ragInvoked"] = True
        self._apply_rag_safety(st, rag)
        debug["ragTrace"] = rag.get("diagnosticTrace")
        return self._compose_symptoms_only(st, rag)

    def _flow_combined(self, st: ConversationState, debug: dict) -> OrchestratorResponse:
        c = st.customer
        # MCP FIRST (authority)
        t = time.perf_counter()
        try:
            mcp = self.ec.resolve_error_code(c.make, c.appliance, c.displayedCode,
                                             observed=[{"type": o.type, "value": o.value} for o in c.observed] or None,
                                             region=c.region, includeEnrichment=getattr(st, "_includeEnrichment", True))
        except McpUnavailable as e:
            # can't trust code meaning; still offer the symptom side, clearly labelled
            debug["mcpError"] = str(e)[:120]
            try:
                rag = self._rag_diagnose(st, **self._canon_kw(st), understand=getattr(st, '_understand', None), symptoms=c.symptomsText or "", appliance=c.appliance, make=c.make,
                                        established=self._established_identity(c),
                                        conversation=getattr(st, "_conversation", None))
                self._apply_rag_safety(st, rag)
                debug["ragTrace"] = rag.get("diagnosticTrace")
                sym = (f"the symptoms are {self._band(rag.get('confidence'))} a {_fault_phrase(rag)}"
                       if rag.get("grounded") else "I couldn't pin down the symptoms either")
                return OrchestratorResponse(route="", outcome=Outcome.SERVICE_UNAVAILABLE.value,
                    message=f"I can't look up that error code right now (I won't guess it). In the meantime, {sym}.",
                    diagnosis=(DiagnosisView(summary=rag.get("faultLabel"), confidenceBand=self._band(rag.get('confidence'))) if rag.get("grounded") else None),
                    provenance={"diagnosis": Trust.L3_PROBABILISTIC.value}, debug={"mcpError": True})
            except RagUnavailable:
                return self._service_unavailable("both", "The diagnostic service is temporarily unavailable. Please try again shortly.")
        debug["latencies"]["mcp_ms"] = round((time.perf_counter() - t) * 1000, 1)
        debug["mcpStatus"] = mcp.get("status")
        debug["mcpEvidence"] = {
            "status": mcp.get("status"), "displayedCode": _facing_code(st, mcp),
            "meaning": mcp.get("meaning"), "recordType": mcp.get("recordType"),
            "system": mcp.get("system"), "confidence": mcp.get("confidence"),
            "candidateCount": len(mcp.get("candidates") or []),
        }
        self._apply_mcp(st, mcp)

        # INVALID_INPUT with a missing appliance family: preserve the customer's code and ask only
        # for the appliance type. Do NOT fall through to the RAG-compose path, which second-guesses
        # the displayed code ("Zanussi E21 isn't standard... might be F05?") — a CUSTOMER_CODE_CHANGED
        # violation. This mirrors the code-only flow's handling.
        if mcp.get("status") == "INVALID_INPUT":
            missing = self._code_needs_appliance_clarify(st, mcp)
            if missing is not None:
                return missing

        if mcp.get("status") != "RESOLVED":
            # MCP could not resolve deterministically. Do NOT block the symptom side, but keep
            # the code status honest (ask for context / ambiguous / not found) AND run RAG on
            # symptoms as a SEPARATE probabilistic investigation.
            t = time.perf_counter()
            try:
                rag = self._rag_diagnose(st, **self._canon_kw(st), understand=getattr(st, '_understand', None), symptoms=self._rag_symptoms(st) or c.symptomsText or "",
                                        appliance=c.appliance, make=c.make,
                                        established=self._established_identity(c),
                                        conversation=getattr(st, "_conversation", None))
            except RagUnavailable as e:
                debug["ragError"] = str(e)[:120]
                rag = {"grounded": False, "clarifyingQuestion": None, "safety": {}}
            debug["latencies"]["rag_ms"] = round((time.perf_counter() - t) * 1000, 1)
            debug["ragInvoked"] = True
            self._apply_rag_safety(st, rag)
            debug["ragTrace"] = rag.get("diagnosticTrace")
            return self._compose_unresolved_code_plus_symptoms(st, mcp, rag)

        # MCP RESOLVED -> trusted context -> RAG refine
        trusted = self._trusted_context(st, mcp)
        t = time.perf_counter()
        try:
            rag = self._rag_diagnose(st, **self._canon_kw(st), understand=getattr(st, '_understand', None), symptoms=c.symptomsText or "", appliance=c.appliance,
                                    make=c.make, trusted=trusted.to_prompt_facts(),
                                    established=self._established_identity(c),
                                    conversation=getattr(st, "_conversation", None))
        except RagUnavailable as e:
            # RAG down but code resolved deterministically -> still return the trusted code meaning.
            debug["ragError"] = str(e)[:120]
            resp = self._compose_code_only(st, mcp)
            if resp.outcome == Outcome.ANSWER.value:
                resp.message += " (Symptom-based refinement is temporarily unavailable.)"
            resp.debug = {**resp.debug, "ragError": True}
            return resp
        debug["latencies"]["rag_ms"] = round((time.perf_counter() - t) * 1000, 1)
        debug["ragInvoked"] = True
        self._apply_rag_safety(st, rag)
        debug["ragTrace"] = rag.get("diagnosticTrace")

        # conflict: only when a grounded RAG diagnosis is a DIFFERENT diagnostic area from
        # the resolved code. Same-area vocabulary (MCP `sensor` vs runtime `temperature-sensor`)
        # is not a conflict — do not argue the code against itself.
        conflict = _code_conflicts_with_rag(mcp, rag)
        debug["conflict"] = conflict
        debug["trustedContextUsed"] = True
        return self._compose_combined(st, mcp, rag, conflict)

    def _intake_text(self, st: ConversationState) -> str:
        """Customer text used for deterministic intake detection (this turn's message + accumulated
        symptom). Customer words only — never any prior composed prose."""
        return f"{getattr(st, '_lastMessage', '') or ''}  {st.customer.symptomsText or ''}".strip()

    def _code_intake_clarify(self, st: ConversationState) -> OrchestratorResponse:
        """CODE PRESENT but VALUE MISSING: ask for the EXACT code (high-value), not a generic
        description. Emits a pending ERROR_CODE request (needs=['code']); asks the make too if it is
        still unknown. Concise — never enumerates a code list."""
        c = st.customer
        q = "What's the exact error code showing on the display?"
        needs = ["code"]
        if not c.make:
            q += " And what make is the appliance?"
            needs.append("make")
        st.clarificationRequested = q
        return OrchestratorResponse(
            route=Route.CLARIFY.value, outcome=Outcome.CLARIFICATION_REQUIRED.value,
            message=q, clarification={"question": q, "needs": needs, "intent": "ERROR_CODE"},
            provenance={"clarification": Trust.L1_DETERMINISTIC.value})

    def _flow_clarify(self, st: ConversationState, debug: dict) -> OrchestratorResponse:
        c = st.customer
        # CODE PRESENT but VALUE MISSING (no symptom to diagnose either): the customer says a code is
        # showing but gave no usable value -> ask for the EXACT code, not a generic description.
        if getattr(st, '_codePresentNoValue', False):
            debug["codeIntake"] = "present_no_value"
            return self._code_intake_clarify(st)
        if getattr(st, "_uncertainToken", None) and not c.displayedCode:
            # Jev could not tell whether the identifier is a displayed code or the model (weak reading): ask
            # rather than guess. The answer is typed by Jev on the next turn like any other.
            tok = st._uncertainToken
            debug["identifierUncertain"] = st._tokenDecision
            q = f"Is {tok} a code showing on the display, or is it the model number?"
            needs = ["code_or_other"]
            intent = "CODE_OR_MODEL"
        elif c.displayedCode and not (c.make and c.appliance):
            # We already HAVE a code value but need the brand and/or type to look it up: ask for exactly what
            # is missing (the type is never asked again once known). Intent is MAKE/APPLIANCE, never ERROR_CODE.
            needs = []
            if not c.make:
                needs.append("make")
            if not c.appliance:
                needs.append("appliance")
            shown = _facing_code(st) or "that code"
            if needs == ["make"]:
                fam = str(c.appliance).replace("-", " ")
                q = f"To look up {shown} I just need the make of your {fam} — which brand is it?"
            elif needs == ["appliance"]:
                q = f"To look up {shown} I just need the appliance type — is it a washing machine, dishwasher, oven or something else?"
            else:
                q = (f"To look up {shown} I need the make and the type of appliance — "
                     "which brand is it, and is it a washing machine, dishwasher, oven or something else?")
            # The same identity question was our last reply and nothing it asked for arrived: say why it is
            # needed and offer a way on, rather than repeating it word for word.
            if q == self._last_assistant_text(st):
                missing = " and ".join("make" if n == "make" else "appliance type" for n in needs)
                q = (f"Sorry — I still need the {missing} to look {shown} up, because the same code means different "
                     "things on different brands. If you'd rather not say, tell me what the appliance is doing when "
                     "the code shows and I'll help from that.")
            intent = "MAKE" if not c.make else "APPLIANCE"
        else:
            # OPEN FAULT / SYMPTOM DESCRIPTION. No code, no usable symptom yet, and no single
            # specific field is authoritative (a bare warning symbol/light with no known meaning
            # lands here). Ask the customer to DESCRIBE the problem — the highest-value OPEN request.
            # This is deliberately NOT an ERROR_CODE request: a code would ALSO be useful, but the
            # question does not specifically demand one, so the pending slot must not claim it does.
            if not c.appliance:
                q = ("Could you tell me a bit more — what kind of appliance is it, what is it doing, "
                     "and is anything showing on the display or control panel?")
            else:
                # ONE open question (GOLD v2), the same one part-finder asks; a display code can come later, so
                # it is not asked in the same breath, and no menu of faults is offered.
                fam = str(c.appliance).replace("-", " ")
                q = f"What is the main thing the {fam} is doing wrong?"
            needs = ["description"]
            intent = "SYMPTOM_DESCRIPTION"
        debug["clarifyIntent"] = intent
        st.clarificationRequested = q
        return OrchestratorResponse(
            route=Route.CLARIFY.value, outcome=Outcome.CLARIFICATION_REQUIRED.value,
            message=q, clarification={"question": q, "needs": needs, "intent": intent},
            provenance={"clarification": Trust.L1_DETERMINISTIC.value})

    def _service_unavailable(self, which: str, message: str) -> OrchestratorResponse:
        return OrchestratorResponse(route="", outcome=Outcome.SERVICE_UNAVAILABLE.value,
                                    message=message, debug={"unavailable": which})

    # ---------------- RAG safety ----------------
    def _apply_rag_safety(self, st: ConversationState, rag: dict) -> None:
        rs = (rag.get("safety") or {}).get("class")
        st.safetyState = strongest_safety(st.safetyState, rs)
        # Latch the CAUSE behind the safety state (gas/shock/burning) so the reply can be cause-
        # specific, and whether the customer asked to perform a dangerous action (active warning).
        reason = rag.get("safetyReason")
        if reason:
            st.safetyReason = reason
        if rag.get("unsafeIntent"):
            st.unsafeIntent = True
        inf = st.inferred
        inf.faultId = rag.get("faultId")
        inf.faultLabel = rag.get("faultLabel")
        inf.system = rag.get("system")
        inf.grounded = bool(rag.get("grounded"))
        inf.confidence = rag.get("confidence")
        inf.candidateComponents = rag.get("candidateComponents") or []

    # ---------------- composers (deterministic, no LLM) ----------------
    # Bespoke gas-escape emergency guidance (matches the RAG's gas card / safety-information EMERGENCY
    # card): no switches/flames, turn off at the meter, ventilate/leave, National Gas Emergency line,
    # Gas Safe engineer. Owns its own text so it can never be diluted to a generic electrical stop.
    GAS_EMERGENCY_MSG = (
        "If you can smell gas, treat it as an emergency: don't turn any switches on or off and no "
        "naked flames. Turn the gas off at the meter / emergency control valve if you safely can, "
        "open doors and windows to ventilate, and leave the property if the smell is strong. Call "
        "the National Gas Emergency line on 0800 111 999 and have a Gas Safe registered engineer "
        "check the appliance before using it again."
    )
    BURNING_MSG = (
        "A burning or hot-plastic smell (or signs of overheating) can mean an electrical fault or a "
        "fire risk. Stop using the appliance now, switch it off and unplug it (or turn it off at the "
        "fuse box), and don't use it again until it has been checked by a qualified engineer."
    )
    SHOCK_MSG = (
        "Stop using the appliance immediately, switch it off at the socket and unplug it (or turn off "
        "its circuit at the consumer unit). A shock usually means an earth/insulation fault — don't "
        "use it again until a qualified electrician or appliance engineer has found and fixed it."
    )
    ELECTRICAL_MSG = (
        "Stop using the appliance, switch it off and unplug it (or isolate it at the consumer unit). "
        "Don't keep resetting a trip. Have it checked by a qualified electrician or appliance engineer "
        "before using it again."
    )
    GENERIC_STOP_MSG = "Stop using the appliance now and unplug it / turn off its supply — this can be dangerous."

    def _safety_block(self, st: ConversationState) -> Optional[dict]:
        cls = st.safetyState
        if cls in ("NORMAL_DIAGNOSTIC", "STATUS_ONLY", None):
            return None
        # EMERGENCY_ACTION (gas) is the strongest and gets bespoke emergency guidance.
        if cls == "EMERGENCY_ACTION":
            return {"class": cls, "stopUse": True, "message": self.GAS_EMERGENCY_MSG}
        if cls == "STOP_USE":
            # Cause-specific stop wording, keyed off the latched reason from the RAG detector.
            reason = st.safetyReason
            if reason == "gas":
                return {"class": cls, "stopUse": True, "message": self.GAS_EMERGENCY_MSG}
            if reason == "burning":
                return {"class": cls, "stopUse": True, "message": self.BURNING_MSG}
            if reason == "shock":
                return {"class": cls, "stopUse": True, "message": self.SHOCK_MSG}
            if reason == "electrical":
                return {"class": cls, "stopUse": True, "message": self.ELECTRICAL_MSG}
            return {"class": cls, "stopUse": True, "message": self.GENERIC_STOP_MSG}
        msgs = {
            "ISOLATE_IF_SAFE": "If it is safe to do so, isolate the appliance from the mains before any further checks.",
            "SERVICE_REQUIRED": "This needs a qualified engineer rather than a DIY repair.",
        }
        return {"class": cls, "stopUse": False, "message": msgs.get(cls, "")}

    # Active warning when the customer asks to PERFORM a dangerous action (bypass a safety device,
    # test live, keep resetting the trip, discharge a capacitor, re-gas a sealed system, hunt a gas
    # leak with a flame). We explicitly tell them not to and redirect to a qualified engineer —
    # WITHOUT giving any procedural detail. Additive: does not suppress the underlying diagnosis.
    UNSAFE_INTENT_MSG = (
        "Please don't do that — it isn't safe. Working on a live circuit, bypassing a safety device, "
        "or handling gas/refrigerant yourself risks a shock, fire or gas escape and should only be "
        "done by a qualified engineer (Gas Safe registered for anything gas). Switch the appliance "
        "off and have it checked rather than testing it that way."
    )

    # Family-standing owner-safety note — the standing precaution/boundary a competent advisor states
    # for a risky appliance family. The part-finder carries this on the diagnostic replies IT
    # composes (ensureOwnerCheckSafety); but the orchestrator composes some diagnostic CLARIFY turns
    # itself (the conf>=0.7 "narrow it down" branch and the generic symptom clarify) from only the
    # short question field, discarding the part-finder's note. This mirrors that note so an
    # orchestrator-owned diagnostic clarify for a hazardous family still carries safe framing. Keyed
    # on the canonical family (st.customer.appliance). Verbatim-consistent with part-finder's map.
    OWNER_SAFETY_NOTE = {
        "vacuum": "Switch it off and unplug it (or take the battery out) before reaching into the bin, filters, hose or brush bar.",
        "tumble-dryer": "Switch it off and unplug it before clearing the filter or condenser, and keep the lint filter clear — trapped lint is a fire risk.",
        "washer-dryer": "Switch it off and unplug it before clearing the filter or condenser, and keep the lint filter clear — trapped lint is a fire risk.",
        "washing-machine": "Switch it off and unplug it first, with towels or a tray ready as water can spill.",
        "dishwasher": "Switch it off and unplug it first (isolate at the fuse box if the socket sits behind the unit near water).",
        "fridge-freezer": "Unplug it first before any internal check.",
        "oven-cooker": "Switch it off at the wall before any inspection — never test it live, and leave replacing a hard-wired cooker element to a qualified engineer.",
        "hob": "Switch it off at the wall or its spur before any access, and never lift or prise off a bonded glass top.",
        "hobs": "Switch it off at the wall or its spur before any access, and never lift or prise off a bonded glass top.",
    }
    # Isolation/precaution cues already present → do not double the note (mirrors part-finder regex).
    _ISOLATION_CUE_RE = _re.compile(
        r"\b(unplug|unplugg|switch(?:ed)?\s+(?:it\s+)?off|turn(?:ed)?\s+(?:it\s+)?off|isolate|isolat|"
        r"power(?:ed)?\s+off|disconnect|take the battery out|remove the battery|at the wall|at the spur)\b",
        _re.I)

    def _owner_safety_note(self, st: ConversationState, resp: Optional[OrchestratorResponse]) -> Optional[str]:
        """The family-standing owner precaution to prepend on an orchestrator-owned DIAGNOSTIC turn
        for a hazardous family when the text carries no isolation cue. Covers the two turn shapes the
        non-deterministic COMPOSE can take for the same symptom: a symptom-detail CLARIFY (the
        'narrow it down' branch) and a grounded diagnostic ANSWER that carries a diagnosis. Returns
        None otherwise. Deliberately excludes identity/model asks, safety stops and normal-behaviour /
        recovery reassurance (no diagnosis). The isolation-cue presence check means that when the
        part-finder already framed the reply we never double it."""
        if resp is None:
            return None
        if getattr(resp, "safety", None) and (resp.safety or {}).get("stopUse"):
            return None
        # A describe-the-problem question, or a code meaning, asks for no physical step, so it carries no precaution.
        if getattr(st, "_ragExclusiveClarify", False) or getattr(st, "_codeOnlyAnswer", False):
            return None
        outcome = resp.outcome
        applies = False
        if outcome == Outcome.CLARIFICATION_REQUIRED.value:
            clar = getattr(resp, "clarification", None) or {}
            needs = clar.get("needs") or []
            # Only a symptom/diagnostic clarify — not a MAKE/APPLIANCE/MODEL/CODE identity ask.
            applies = any(
                (isinstance(n, str) and "symptom" in n.lower()) for n in needs
            ) or clar.get("intent") == "SYMPTOM_DISCRIMINATOR"
            if clar.get("intent") == "SYMPTOM_DESCRIPTION":
                applies = False
        elif outcome == Outcome.ANSWER.value:
            # A diagnostic answer that is NOT a bare model-ask and NOT a reassurance / recovery
            # closure (those are tagged _reassurance and imply no owner physical action). This catches
            # the confident single-cause answer the COMPOSE sometimes gives instead of a clarify (e.g.
            # an induction-hob single-zone diagnosis) even when it is ungrounded prose with no
            # DiagnosisView attached.
            applies = (not getattr(resp, "_reassurance", False)
                       and not getattr(resp, "modelRequired", False))
        if not applies:
            return None
        fam = (st.customer.appliance or "").strip().lower()
        note = self.OWNER_SAFETY_NOTE.get(fam)
        if not note:
            return None
        msg = resp.message or ""
        if self._ISOLATION_CUE_RE.search(msg):
            return None
        # COMPOSE sometimes echoes just the hazard clause of the note (e.g. "...never lift or prise
        # off a bonded glass top") without an isolation verb, which the cue check above misses and
        # which would then be duplicated. Skip if the note's distinctive trailing clause already
        # appears in the reply.
        tail = _re.split(r",\s*(?:and\s+)?", note)[-1].strip().rstrip(".").lower()
        if tail and len(tail) >= 12 and tail in msg.lower():
            return None
        return note

    def _unsafe_intent_warning(self, st: ConversationState, resp: Optional[OrchestratorResponse] = None) -> Optional[str]:
        if not st.unsafeIntent:
            return None
        si = getattr(resp, "safetyInformation", None) if resp is not None else None
        if isinstance(si, dict) and si.get("classification") == "PROFESSIONAL_ONLY":
            return None
        rag_cls = None
        if resp is not None:
            rag_cls = ((getattr(resp, "safety", None) or {}) or {}).get("class")
        # HV refuse already owns the customer reply; do not prepend a generic
        # live-circuit / Gas Safe warning that mis-flavours PROFESSIONAL_ONLY.
        if rag_cls == "ISOLATE_IF_SAFE" and isinstance(si, dict) and si.get("classification") == "PROFESSIONAL_ONLY":
            return None
        return self.UNSAFE_INTENT_MSG

    # Slot in `clarification.needs` -> a MODEL request (identity/scheme/plate). Same vocabulary the
    # whichpart-api boundary uses for `needsModel`, kept here so the emitted pending slot matches.
    _MODEL_NEED_RE = _re.compile(
        r"scheme|model|e_?nr|pnc|12nc|serial|plate|identif|generation|platform|architecture", _re.I)

    # AUTHORITATIVE clarification INTENT -> pending (slot, purpose). A clarify path declares exactly
    # ONE semantic intent — the single thing it asked the customer for — and this map is the sole
    # source of truth for the pending slot. The pending request therefore always describes what the
    # assistant actually requested; it is NEVER inferred by scanning a compound needs[] list (an
    # "A or B" question can no longer collapse into concrete slot A). SYMPTOM_DESCRIPTION is the
    # honest OPEN-description request used when no specific field is authoritative.
    _INTENT_PENDING = {
        "ERROR_CODE": ("ERROR_CODE", "CODE_RESOLUTION"),
        "MAKE": ("MAKE", "DISAMBIGUATION"),
        "APPLIANCE": ("APPLIANCE", "DISAMBIGUATION"),
        "SYMPTOM_DISCRIMINATOR": ("SYMPTOM_DISCRIMINATOR", "DIAGNOSIS"),
        "SYMPTOM_DESCRIPTION": ("SYMPTOM_DESCRIPTION", "DIAGNOSIS"),
        "CODE_OR_MODEL": ("IDENTIFIER", "DISAMBIGUATION"),
    }

    def _pending_for(self, st: ConversationState, resp: "OrchestratorResponse") -> Optional[dict]:
        """The STRUCTURED semantic request the customer's next turn should answer, derived from the
        response we just composed (never from prose). Purpose distinguishes why the MODEL is wanted:
        CODE_RESOLUTION (a recognised but scheme/model-dependent code), PART_FIT (a grounded fault
        needing the exact part) or DIAGNOSIS. Returns None when nothing is outstanding."""
        clar = resp.clarification or {}
        needs = clar.get("needs") or []
        needs_str = " ".join(
            (n.get("attribute") or n.get("resolutionSources") and "model" or "")
            if isinstance(n, dict) else str(n) for n in needs).lower()
        # exact tokens (NOT substrings) for the legacy fallback, so a compound "A-or-B" token can
        # never be mistaken for the specific field A (the root cause of the code-masquerade defect).
        need_tokens = {str(n).lower() for n in needs if not isinstance(n, dict)}
        code_status = st.resolved.codeStatus
        model_purpose = ("CODE_RESOLUTION" if code_status in ("NEEDS_CONTEXT", "AMBIGUOUS")
                         else "PART_FIT" if st.customer.displayedCode else "DIAGNOSIS")
        # A MODEL request: either the staged model-for-parts signal, or a clarification asking for
        # model/scheme/plate identity.
        if resp.modelRequired or self._MODEL_NEED_RE.search(needs_str):
            return {"slot": "MODEL", "purpose": model_purpose, "status": "PENDING"}
        if resp.outcome == Outcome.CLARIFICATION_REQUIRED.value:
            # AUTHORITATIVE: a clarify path that declared its semantic intent wins outright — the
            # pending slot is exactly what the assistant asked for, with no list-scanning guesswork.
            intent = clar.get("intent")
            if intent in self._INTENT_PENDING:
                slot, purpose = self._INTENT_PENDING[intent]
                return {"slot": slot, "purpose": purpose, "status": "PENDING"}
            # LEGACY fallback for clarify paths that have not declared an intent. Exact-token match
            # only: "code" is ERROR_CODE solely when the code is genuinely THE request (e.g. an MCP
            # INVALID_INPUT needs=["code"]), never when it is one option in a compound OR-need.
            if "code" in need_tokens:
                return {"slot": "ERROR_CODE", "purpose": "CODE_RESOLUTION", "status": "PENDING"}
            if "make" in need_tokens:
                return {"slot": "MAKE", "purpose": "DISAMBIGUATION", "status": "PENDING"}
            if "appliance" in need_tokens:
                return {"slot": "APPLIANCE", "purpose": "DISAMBIGUATION", "status": "PENDING"}
            # a symptom-detail clarification is a diagnostic discriminator
            return {"slot": "SYMPTOM_DISCRIMINATOR", "purpose": "DIAGNOSIS", "status": "PENDING"}
        # an unresolved code we could not pin still wants the model to resolve it
        if resp.outcome in (Outcome.AMBIGUOUS.value,) and code_status in ("AMBIGUOUS", "NEEDS_CONTEXT"):
            return {"slot": "MODEL", "purpose": "CODE_RESOLUTION", "status": "PENDING"}
        return None

    def _band(self, conf: Optional[float]) -> str:
        if conf is None:
            return "possible"
        return "likely" if conf >= 0.75 else "possible"

    @staticmethod
    def _last_assistant_text(st: ConversationState) -> Optional[str]:
        """Our own previous reply, from the client-carried conversation (structure only: role + text)."""
        conv = getattr(st, "_conversation", None)
        if not isinstance(conv, list):
            return None
        for m in reversed(conv):
            if isinstance(m, dict) and m.get("role") == "assistant":
                return str(m.get("content") or "").strip() or None
        return None

    def _code_needs_appliance_clarify(self, st: ConversationState, mcp: dict) -> Optional[OrchestratorResponse]:
        """MCP INVALID_INPUT is USUALLY the appliance FAMILY missing (customer gave make + model +
        code but never named the appliance type; Jev could not classify the family from the model
        alone), NOT a malformed code. In that case NEVER question or rewrite the customer's displayed
        code (that is a CUSTOMER_CODE_CHANGED violation and blocks progression) and NEVER hand the
        code to the RAG compose, which will second-guess it ("might be F05?"). PRESERVE the code and
        ask only for the appliance type. Returns None when the code itself is genuinely the problem."""
        errors = mcp.get("errors") or []
        shown = _facing_code(st, mcp)
        # If the customer ALREADY gave a model number, the appliance family is derivable from it —
        # asking "which appliance is it?" then reads as discarding their stated identity (the judge
        # flags FAMILY_INVENTED). Fall through (return None) so the flow uses the RAG, which resolves
        # the family from the model and diagnoses. Only ask for the appliance type when NO model is
        # available to derive it from.
        has_model = any(o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value
                        for o in st.customer.observed)
        if shown and not has_model and ("appliance" in errors or not st.customer.appliance):
            q = (f"To look up {shown} I just need the appliance type — "
                 "is it a washing machine, dishwasher, oven, etc.?")
            st.clarificationRequested = q
            return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message=q,
                                        codeResult=CodeResultView(displayed=shown, status="INVALID_INPUT"),
                                        clarification={"question": q, "needs": ["appliance"], "intent": "APPLIANCE"},
                                        provenance={"clarification": Trust.L1_DETERMINISTIC.value})
        return None

    def _compose_code_only(self, st: ConversationState, mcp: dict) -> OrchestratorResponse:
        status = mcp.get("status")
        safety = self._safety_block(st)
        prov = {}
        if status == "NOT_FOUND":
            msg = (f"I couldn't find a documented meaning for that code on a "
                   f"{st.customer.make or ''} {st.customer.appliance or 'appliance'}. "
                   "Please double-check the exact code on the display.")
            return OrchestratorResponse(route="", outcome=Outcome.NOT_FOUND.value, message=msg,
                                        codeResult=CodeResultView(displayed=_facing_code(st, mcp),
                                                                  status=status))
        if status == "INVALID_INPUT":
            missing = self._code_needs_appliance_clarify(st, mcp)
            if missing is not None:
                return missing
            shown = _facing_code(st, mcp)
            if shown:
                # We DO have the customer's displayed code; the deterministic lookup just couldn't
                # run (usually family/model still needed). NEVER tell the customer their code is
                # incomplete — preserve it and ask for the model to complete the lookup.
                q = (f"Thanks — I've noted {shown}. What's the model number on the rating plate so I "
                     "can look that code up for your exact machine?")
                st.clarificationRequested = q
                return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message=q,
                                            codeResult=CodeResultView(displayed=shown, status=status),
                                            clarification={"question": q, "needs": ["model"], "intent": "MODEL"},
                                            provenance={"clarification": Trust.L1_DETERMINISTIC.value})
            msg = "That doesn't look like a complete error code. What exactly is shown on the display?"
            return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message=msg,
                                        clarification={"question": msg, "needs": ["code"]})
        if status == "NEEDS_CONTEXT":
            needs = mcp.get("needs") or []
            q = (mcp.get("reason") or "This code means different things on different models.") + \
                " Could you give me the model or rating-plate number?"
            st.clarificationRequested = q
            return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message=q,
                                        clarification={"question": q, "needs": needs},
                                        codeResult=CodeResultView(displayed=_facing_code(st, mcp),
                                                                  status=status))
        if status == "AMBIGUOUS":
            msg = ("That code has more than one documented meaning on this appliance and I can't "
                   "pin it down for certain. If you can give the model/rating-plate number I can try to narrow it.")
            return OrchestratorResponse(route="", outcome=Outcome.AMBIGUOUS.value, message=msg,
                                        codeResult=CodeResultView(displayed=_facing_code(st, mcp),
                                                                  status=status))
        # RESOLVED
        rt = mcp.get("recordType")
        meaning = mcp.get("meaning")
        enr = mcp.get("enrichment") or {}
        checks = enr.get("checks") or []
        causes = enr.get("likelyCauses") or []
        prov = {"meaning": Trust.L1_DETERMINISTIC.value, "recordType": Trust.L1_DETERMINISTIC.value}
        if rt in NON_FAULT_RECORD_TYPES:
            kind = {"STATUS": "a status message", "INFORMATION": "an information message",
                    "MAINTENANCE": "a maintenance prompt", "WARNING": "a warning"}.get(rt, "a message")
            shown = _facing_code(st, mcp)
            msg = f"{shown} is {kind}, not a fault: {meaning}."
        else:
            shown = _facing_code(st, mcp)
            fam = str(st.customer.appliance or "appliance").replace("-", " ")
            make = str(st.customer.make or "").strip()
            make = make[:1].upper() + make[1:] if make else ""
            msg = f"{shown} on your {(make + ' ' + fam).strip()} means: {meaning}."
            # The catalogue's likelyCauses are mostly fragments ("off", "stuck / not confirmed"): they stay in the
            # structured result for the trace but are never printed as prose. The reply gives the next step instead.
            msg += (" Tell me what it's doing when the code shows — for example whether it stops part-way or "
                    "won't start — and I'll help you narrow it down.")
            if causes:
                prov["possibleCauses"] = Trust.L2_EVIDENCE_BACKED.value
        if checks:
            prov["suggestedChecks"] = Trust.L2_EVIDENCE_BACKED.value
        if safety:
            msg = safety["message"] + " " + msg
        st._codeOnlyAnswer = True  # a code meaning gives no physical step, so it carries no owner precaution
        return OrchestratorResponse(
            route="", outcome=(Outcome.SAFETY_STOP.value if safety and safety["stopUse"] else Outcome.ANSWER.value),
            message=msg,
            codeResult=CodeResultView(displayed=_facing_code(st, mcp),
                                      meaning=meaning, recordType=rt, status=status),
            suggestedChecks=checks, safety=safety, provenance=prov,
            debug={"system": mcp.get("system"), "scheme": mcp.get("scheme")})

    def _journey_stage(self, st: ConversationState, rag: dict) -> str:
        """Journey Policy v2 — derive the EXPLICIT journey stage from Jev's TYPED decisions and the
        established evidence set (no prose parsing, no hard-coded appliance/make). Reuses existing
        typed state; adds no persisted dataclass field.

        Stages:
          IMAGE_IN_PROGRESS            — a rating-plate photo this turn is being read/confirmed.
          MODEL_KNOWN                  — a trusted/typed model (or a confirmed extraction) is held.
          MODEL_UNAVAILABLE            — the customer has said they cannot provide the model.
          MODEL_REQUIRED_AFTER_CHECK   — a safe, model-independent first check has been COMPLETED and
                                         the fault remains; the next useful step is model-dependent, so
                                         obtain the model before further narrowing / any part decision.
          DIAGNOSING                   — still giving a safe generic first check / generic advice.
        """
        if bool(getattr(st, "_image", None)):
            return "IMAGE_IN_PROGRESS"
        trusted_model = any(o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value
                            for o in st.customer.observed)
        if trusted_model or rag.get("resolvedModel"):
            return "MODEL_KNOWN"
        if self._cannot_provide_model(st):
            return "MODEL_UNAVAILABLE"
        d = (getattr(st, "_jev", None) or {}).get("decisions") or {}
        establishes = d.get("latestTurnEstablishes")
        answered = d.get("answeredPrevious")
        # A safe generic check has been COMPLETED this journey when Jev typed the latest turn as a
        # check result, OR classified it as answering the pending check (yes/partial), OR an earlier
        # completed check is already in the established set. "cannot_answer" / "no" are NOT completions.
        # A turn Jev typed as a symptom, identity, correction or hazard report answers a question about the problem or
        # the appliance; it is not a check result.
        check_completed = (establishes == "check_result"
                           or (answered in ("yes", "partial")
                               and establishes not in ("symptom", "identity", "correction", "hazard"))
                           or bool(st.customer.checksReported))
        # The fault still remains unless Jev typed a recovery / normal-behaviour outcome.
        fault_remains = (not rag.get("normalBehaviour")) and establishes != "recovery"
        if check_completed and fault_remains:
            return "MODEL_REQUIRED_AFTER_CHECK"
        return "DIAGNOSING"

    def _compose_model_acquisition(self, st: ConversationState, rag: dict,
                                   safety: Optional[dict]) -> OrchestratorResponse:
        """Journey Policy v2 (rule B) — a safe generic first check has completed and the fault
        remains, so the next step is model-dependent: ask for the make/model (a rating-plate photo is
        acceptable). Concise; acknowledges the completed check; never re-asks a fact already grounded
        in the conversation; never claims a part or fit yet. A grounded diagnosis (if any) is retained
        as structured context but the customer-facing action this turn is identification."""
        ack = "Thanks — that's a useful step, and it tells us the simplest cause isn't the answer here."
        ask = ("Before we narrow it down further, what's the make and full model number if you can "
               "find it? It's on the rating plate — usually around the door opening, inside the frame, "
               "or on the back — and a clear photo of the plate is fine too.")
        msg = _with_safety_prefix(f"{ack} {ask}", safety, None)
        diag = (DiagnosisView(summary=rag.get("faultLabel"), likelyArea=rag.get("system"),
                              confidenceBand=self._band(rag.get("confidence")))
                if rag.get("grounded") else None)
        return OrchestratorResponse(
            route="", outcome=Outcome.ANSWER.value, message=msg,
            diagnosis=diag, suggestedChecks=[], componentMention="none",
            parts=None, resolvedModel=None, traceId=rag.get("traceId"),
            safety=safety, modelRequired=True,
            clarification={"question": "What is the make and model number?",
                           "needs": [{"attribute": "model",
                                      "resolutionSources": ["MODEL", "E_NR", "RATING_PLATE"]}],
                           "intent": "MODEL"},
            provenance={"diagnosis": Trust.L3_PROBABILISTIC.value,
                        "journey": Trust.L1_DETERMINISTIC.value})

    def _compose_symptoms_only(self, st: ConversationState, rag: dict) -> OrchestratorResponse:
        safety = self._safety_block(st)
        if safety and safety["stopUse"]:
            return OrchestratorResponse(route="", outcome=Outcome.SAFETY_STOP.value,
                                        message=safety["message"], safety=safety,
                                        provenance={"safety": Trust.L1_DETERMINISTIC.value})
        # NORMAL-BEHAVIOUR reassurance (deterministic signal from the RAG). The customer asked whether
        # a plausibly-normal condition is a fault; the RAG suppressed parts and composed a reassurance.
        # Surface it as an ANSWER (no clarifying question, no parts) — needing no fault is the point.
        if rag.get("normalBehaviour"):
            prose = (rag.get("reply") or "").strip()
            msg = prose if len(prose) >= 40 else (
                "That sounds like normal, expected behaviour rather than a fault — there's nothing to "
                "replace. If it changes (for example it stops getting hot, leaks, won't drain or shows "
                "an error code), come back and we'll take a look.")
            _resp = OrchestratorResponse(route="", outcome=Outcome.ANSWER.value, message=msg,
                                        provenance={"diagnosis": Trust.L3_PROBABILISTIC.value})
            _resp._reassurance = True  # no owner physical action implied — never prepend a precaution
            return _resp
        # ---- RECOVERY / SOLVED CLOSURE (Journey Policy v2+) ----
        # If Jev typed the LATEST turn as a genuine recovery (the original failed function now works /
        # it is fixed — e.g. "I straightened the hose and it's drying fine now"), the journey is
        # COMPLETE. Close cleanly: acknowledge the fix, offer a one-line come-back-if-it-returns, and
        # STOP — no model request, no part, no further check, no generic probe. This is the missing
        # "a check fixed it" terminal (normal-behaviour reassurance is handled just above). Driven
        # entirely by Jev's TYPED latestTurnEstablishes == 'recovery' (no prose parsing); the Node
        # recovery suppression (nextBestCheck null, no identification) is mirrored here so the
        # deterministic layer owns the closure even if the RAG prose drifts.
        _dec = (getattr(st, "_jev", None) or {}).get("decisions") or {}
        if _dec.get("latestTurnEstablishes") == "recovery":
            prose = (rag.get("reply") or "").strip()
            msg = prose if len(prose) >= 40 else (
                "Glad that's sorted it. Since it's working again there's nothing that needs replacing. "
                "If the same problem comes back, come back to me and we'll take another look.")
            _resp = OrchestratorResponse(
                route="", outcome=Outcome.ANSWER.value,
                message=_with_safety_prefix(msg, safety, None),
                diagnosis=None, suggestedChecks=[], componentMention="none",
                parts=None, resolvedModel=None, modelRequired=False, traceId=rag.get("traceId"),
                provenance={"diagnosis": Trust.L3_PROBABILISTIC.value,
                            "journey": Trust.L1_DETERMINISTIC.value})
            _resp._reassurance = True  # solved/closed — no further owner action, never prepend a precaution
            return _resp
        # ---- JOURNEY POLICY v2: acquire the model once diagnosis becomes model-dependent ----
        # A safe, broadly-applicable first check is given WITHOUT blocking on identification (that
        # happens in the grounded/ungrounded branches below and in the RAG prose). But once such a
        # check has been COMPLETED and the fault still remains, the next useful step is model-dependent
        # narrowing / a part decision — so we obtain the model NOW (exact number or a rating-plate
        # photo) instead of chaining further generic questions or re-asking facts already grounded in
        # the conversation. This is Journey Policy v2 rule B (identification timing). It is driven
        # entirely by Jev's TYPED decisions + the established evidence set (no prose parsing, no
        # hard-coded appliance/make), so it generalises across families. Safety has already returned
        # above, so a stop-use always precedes identification.
        stage = self._journey_stage(st, rag)
        st._journeyStage = stage
        if stage == "MODEL_REQUIRED_AFTER_CHECK":
            return self._compose_model_acquisition(st, rag, safety)
        if not rag.get("grounded"):
            # CODE PRESENT but VALUE MISSING wins over a generic (or code-dumped) symptom clarify:
            # the exact code is the highest-value next fact. Replaces the RAG's clarifyingQuestion
            # (which may be generic or an enumerated code list). The symptom stays in state, so the
            # next turn combines the code with it. Only when the RAG did NOT ground a diagnosis.
            if getattr(st, '_codePresentNoValue', False):
                return self._code_intake_clarify(st)
            q = rag.get("clarifyingQuestion") or "Could you describe the problem in a bit more detail?"
            comps = _customer_facing_components(rag)
            conf = rag.get("confidence") or 0
            # A useful generic diagnosis can be composed without locking an appliance family.
            # Do not discard that prose in favour of a bare "tell me more".
            prose = (rag.get("reply") or "").strip()
            if len(prose) >= 60 and prose != q:
                safety_info = rag.get("safetyInformation")
                # Current-action media is instructional for the check in this reply.
                # It must not require a committed fault node — Type 1 generic help
                # (filter/trap, lint, blockage) is useful before a named failed part.
                media_val = rag.get("media") or None
                return OrchestratorResponse(
                    route="", outcome=Outcome.ANSWER.value, message=_with_safety_prefix(prose, safety, safety_info),
                    diagnosis=None, suggestedChecks=[], componentMention="none",
                    parts=None, resolvedModel=None, traceId=rag.get("traceId"),
                    media=media_val, safety=safety, safetyInformation=safety_info, modelRequired=False,
                    provenance={"diagnosis": Trust.L3_PROBABILISTIC.value})
            # BOUNDARY-DROP FIX: when the RAG is confident about the likely causes but hasn't locked
            # onto a single fault, still talk the customer through what's worth checking (an engineer
            # lists the possibilities) instead of a bare "tell me more". We stay in CLARIFICATION —
            # no diagnosis claim and no parts are offered — and still ask the clarifying question.
            if comps and conf >= 0.7 and _component_mention(rag) == "purchase":
                label = (rag.get("faultLabel") or "").strip().lower()
                lead = (f"From what you've described this could be a {label}, but I'd like to narrow it down."
                        if label else "From what you've described there are a few likely causes.")
                msg = f"{lead} {q}"
                return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value,
                                            message=_with_safety_prefix(msg, safety, None),
                                            clarification={"question": q, "needs": ["symptom-detail"]},
                                            safety=safety,
                                            provenance={"clarification": Trust.L3_PROBABILISTIC.value})
            return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value,
                                        message=_with_safety_prefix(q, safety, None),
                                        clarification={"question": q, "needs": ["symptom-detail"]},
                                        safety=safety,
                                        provenance={"clarification": Trust.L3_PROBABILISTIC.value})
        # GROUNDED. Honour the RAG's STAGED conversation contract (grounded diagnosis != ready to
        # sell a part). We NEVER show a part before the model is known.
        band = self._band(rag.get("confidence"))
        comps = _customer_facing_components(rag)
        fault = _fault_phrase(rag)
        rag_parts = rag.get("parts") or []
        diag = DiagnosisView(summary=rag.get("faultLabel"), likelyArea=rag.get("system"), confidenceBand=band)
        safety_info = rag.get("safetyInformation")
        media_val = rag.get("media") or None   # instructional media for the grounded node (customer-safe subset)
        # Never emit a generic "a fault." stub: _fault_phrase defaults to the literal "fault" when the
        # RAG grounded without a usable label, which produced broken customer stubs like
        # "this is possible a fault." Gate on the REAL faultLabel; otherwise fall back to the area, or
        # a neutral next-step line.
        _fault_label = (rag.get("faultLabel") or "").strip()
        if _fault_label:
            base = f"Based on what you've described, this is {band} a {fault}."
        else:
            area = (rag.get("system") or "").strip()
            base = (f"Based on what you've described, the {area} area is the most likely place to look next."
                    if area else "Based on what you've described, I'd like to narrow it down a little more.")
        # Surface the full grounded differential the RAG produced (an appliance engineer lists the
        # several things worth checking, not just the top one). Cap at 6 so the reply stays readable.
        mention = _component_mention(rag)
        # Never fold a catalogue of components into customer prose. The next action lives in
        # the RAG reply; suggestedChecks stay structured for the UI/grader.
        checks = ""
        # G1/G3: the RAG's compose pass already writes a concise, PRIORITISED engineering explanation
        # from the node's knowledge — most-likely cause, the free/safe CHECK to do first, and credible
        # alternatives (see part-finder compose: "MOST LIKELY CAUSES IN ORDER" + "DISTINGUISHING
        # DETAILS / free-fix first"). Surface THAT prose to the customer instead of a flat component
        # list, so the engineering reasoning actually reaches them. Used only for the NON-IMAGE
        # grounded branches below; image-confirmation branches keep their bespoke wording. Falls back
        # to the structured reconstruction if the prose is missing/too short.
        rag_prose = (rag.get("reply") or "").strip()
        engineer_prose = rag_prose if len(rag_prose) >= 40 else None

        # RATING-PLATE / MEDIA. A model the RAG read from an IMAGE this turn is UNCONFIRMED — it must
        # be confirmed by the customer before it can drive part fit (a blurry plate can yield a
        # plausible-but-wrong model). A TRUSTED model is one the customer typed, or a prior extraction
        # they confirmed (both arrive as observed[] / resolvedModel on a NON-image turn).
        had_image = bool(getattr(st, "_image", None))
        trusted_model = any(o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value
                            for o in st.customer.observed)
        extracted_model = rag.get("resolvedModel")
        has_model = trusted_model or (bool(extracted_model) and not had_image)

        if had_image and not has_model:
            if extracted_model:
                # IMAGE_EXTRACTED_UNCONFIRMED — offer the model for confirmation. NEVER a part /
                # never MODEL_CONFIRMED here. Keep the diagnostic prose (an unanswered
                # discriminator must survive identification). Identity is a candidate, not missing.
                confirm = (
                    f"I've read the model as {extracted_model} from the photo \u2014 is that correct? "
                    "If not, send a clearer photo or type the model.")
                if engineer_prose:
                    msg = f"{engineer_prose.rstrip()} {confirm}"
                else:
                    msg = (base + checks + " " + confirm).strip()
                msg = _with_safety_prefix(msg, safety, safety_info)
                return OrchestratorResponse(
                    route="", outcome=Outcome.ANSWER.value, message=msg,
                    diagnosis=diag, suggestedChecks=comps, componentMention=mention, parts=None, resolvedModel=None,
                    traceId=rag.get("traceId"), safetyInformation=safety_info, media=media_val, safety=safety,
                    modelRequired=False,
                    imageExtraction={"make": rag.get("extractedMake"), "model": extracted_model,
                                     "source": "IMAGE", "status": "IMAGE_EXTRACTED_UNCONFIRMED"},
                    clarification={"question": f"Is the model {extracted_model}?",
                                   "needs": [{"attribute": "model-confirmation", "candidate": extracted_model}]},
                    provenance={"diagnosis": Trust.L3_PROBABILISTIC.value})
            # Image present but nothing readable -> ask for a clearer photo / manual entry. No guess.
            msg = _with_safety_prefix(base + checks + (
                " I couldn't read the rating plate clearly \u2014 please send a sharper photo of it, "
                "or type the model number (it's on the rating plate)."), safety, safety_info)
            return OrchestratorResponse(
                route="", outcome=Outcome.ANSWER.value, message=msg,
                diagnosis=diag, suggestedChecks=comps, componentMention=mention, parts=None, resolvedModel=None,
                traceId=rag.get("traceId"), safetyInformation=safety_info, media=media_val, safety=safety,
                modelRequired=True,
                clarification={"question": "What is the make and model number?",
                               "needs": [{"attribute": "model",
                                          "resolutionSources": ["MODEL", "E_NR", "RATING_PLATE"]}]},
                provenance={"diagnosis": Trust.L3_PROBABILISTIC.value})

        cannot_model = self._cannot_provide_model(st)
        if mention != "purchase":
            # Subsystem / advice / discuss grain: do not gate on the model or fold a shopping list.
            msg = _with_safety_prefix(engineer_prose or base, safety, safety_info)
            return OrchestratorResponse(
                route="", outcome=Outcome.ANSWER.value, message=msg,
                diagnosis=diag, suggestedChecks=(comps if mention == "discuss" else []),
                componentMention=mention,
                parts=None, resolvedModel=None, traceId=rag.get("traceId"),
                safetyInformation=safety_info, media=media_val, safety=safety, modelRequired=False,
                provenance={"diagnosis": Trust.L3_PROBABILISTIC.value})
        if not has_model and not rag_parts and not cannot_model:
            # STAGE 1 — grounded fault, but we need the model before recommending a part.
            # G1/G3: use the RAG's prioritised engineering prose (it already leads with the likely
            # cause, the free/safe check, and asks for the model). Fall back to the structured line.
            msg = _with_safety_prefix(engineer_prose or (base + checks + (
                " To match a candidate part, could you tell me the make and model? "
                "It's on the rating plate — often inside the door or around the opening, or on the back.")), safety, safety_info)
            return OrchestratorResponse(
                route="", outcome=Outcome.ANSWER.value, message=msg,
                diagnosis=diag, suggestedChecks=comps, componentMention=mention,
                parts=None, resolvedModel=None, traceId=rag.get("traceId"),
                safetyInformation=safety_info, media=media_val, safety=safety, modelRequired=True,
                clarification={"question": "What is the make and model number?",
                               "needs": [{"attribute": "model",
                                          "resolutionSources": ["MODEL", "E_NR", "RATING_PLATE"]}]},
                provenance={"diagnosis": Trust.L3_PROBABILISTIC.value,
                            "suggestedChecks": Trust.L3_PROBABILISTIC.value})

        # STAGE 2 (model known) / STAGE 3 (customer can't give the model). Parts flow where the RAG
        # returned them; the fit invariant downstream marks anything not model-confirmed as
        # VERIFY_FIT. In Stage 3 we do NOT re-ask for the model (no loop).
        if has_model:
            msg = engineer_prose or (base + checks)
        elif rag_parts:
            msg = (engineer_prose + (
                " As you can't give the model, these are brand-compatible options — "
                "please check they fit your exact machine before buying.")) if engineer_prose else (base + checks + (
                " As you can't give the model, here are brand-compatible options — "
                "please check they fit your exact machine before buying."))
        else:
            # Stage 3, no brand-compatible part available: give the diagnosis + checks, acknowledge
            # the missing model, and stop asking rather than looping.
            msg = engineer_prose or (base + checks + (
                " Without the model number I can't confirm a candidate part for your machine, "
                "so start with the checks above."))
        msg = _with_safety_prefix(msg, safety, safety_info)
        return OrchestratorResponse(
            route="", outcome=Outcome.ANSWER.value, message=msg,
            diagnosis=diag, suggestedChecks=comps, componentMention=mention, parts=(rag_parts or None),
            resolvedModel=rag.get("resolvedModel"), traceId=rag.get("traceId"),
            # informational, node-identity safety info + instructional media (verbatim passthrough);
            # only on a genuine grounded ANSWER, never on a safety-stop (handled by the early return).
            safetyInformation=safety_info, media=media_val, safety=safety,
            provenance={"diagnosis": Trust.L3_PROBABILISTIC.value, "suggestedChecks": Trust.L3_PROBABILISTIC.value,
                        "parts": Trust.L3_PROBABILISTIC.value})

    def _compose_combined(self, st: ConversationState, mcp: dict, rag: dict, conflict: bool) -> OrchestratorResponse:
        safety = self._safety_block(st)
        rt = mcp.get("recordType")
        meaning = mcp.get("meaning")
        displayed = _facing_code(st, mcp)
        prov = {"meaning": Trust.L1_DETERMINISTIC.value, "recordType": Trust.L1_DETERMINISTIC.value}
        has_model = _customer_has_model(st)
        mention = _component_mention(rag)
        comps = _customer_facing_components(rag)
        model_required = False
        # L1 authoritative code statement first
        if rt in NON_FAULT_RECORD_TYPES:
            kind = {"STATUS": "a status message", "INFORMATION": "an information message",
                    "MAINTENANCE": "a maintenance prompt", "WARNING": "a warning"}.get(rt, "a message")
            lead = f"{displayed} is {kind}, not a fault: {meaning}."
            # recordType guard: do NOT let the RAG promote a status/maintenance code into a fault.
            rag_note = ""
            if rag.get("grounded"):
                rag_note = (f" Separately, the symptoms you describe are {self._band(rag.get('confidence'))} "
                            f"a {_fault_phrase(rag)}, which is a different matter from the {displayed} message.")
            msg = lead + rag_note
            prov["diagnosis"] = Trust.L3_PROBABILISTIC.value
            mention = "none"
            comps = []
            model_required = False
        elif conflict:
            # symptoms don't align with the deterministic code meaning — present both, discard neither
            msg = (f"{displayed} on your {st.customer.make} {st.customer.appliance} means: {meaning}. "
                   f"The symptoms you describe point more towards a {_fault_phrase(rag, 'different fault')}, "
                   f"which doesn't fully line up with that code. Both are worth looking at — "
                   f"can you confirm exactly what the machine is doing so we can tell whether it's the "
                   f"coded fault or a separate problem?")
            prov["diagnosis"] = Trust.L3_PROBABILISTIC.value
            out = Outcome.CLARIFICATION_REQUIRED.value if not (safety and safety["stopUse"]) else Outcome.SAFETY_STOP.value
            if safety:
                msg = safety["message"] + " " + msg
            return OrchestratorResponse(route="", outcome=out, message=msg,
                                        codeResult=CodeResultView(displayed=displayed, meaning=meaning, recordType=rt, status="RESOLVED"),
                                        diagnosis=DiagnosisView(summary=rag.get("faultLabel"), confidenceBand=self._band(rag.get("confidence"))),
                                        safety=safety, provenance=prov,
                                        debug={"conflict": True, "system": mcp.get("system"), "ragSystem": rag.get("system")})
        else:
            # aligned: code meaning is the anchor. RAG may refine checks/components, but must
            # not be phrased as a competing diagnosis of the same area.
            prior_asst = " ".join(
                str(m.get("content") or "") for m in (getattr(st, "_conversation", None) or [])
                if isinstance(m, dict) and m.get("role") == "assistant"
            )
            already = bool(meaning) and meaning.lower() in prior_asst.lower()
            if already:
                msg = f"{displayed} still names that coded fault area ({meaning})."
            else:
                msg = f"{displayed} on your {st.customer.make} {st.customer.appliance} means: {meaning}."
            enr = mcp.get("enrichment") or {}
            if enr.get("behaviour", {}).get("protectionState") and not already:
                msg += " This is a protection state — the appliance has detected water where it shouldn't be; investigate the underlying leak."
            if not already:
                msg += (" That is the coded fault area to investigate — not a confirmed failed part "
                        "on its own, and not a reason to replace a different part that was only suggested.")
            if not has_model:
                msg += (" To take the next useful check or match a part, I need the model number "
                        "or a photo of the rating plate.")
                model_required = True
                mention = "none"
                comps = []
            else:
                # Do not dump a catalogue of candidate components (that re-opens a suggested
                # replacement) and do not paste runtime COMPOSE prose (it can invent completed
                # checks). Progress from STRUCTURED runtime state: unanswered check vs reported
                # check / part request vs actual part cards.
                checks_done = bool(rag.get("checksReported"))
                intent = str(rag.get("userIntent") or "").strip().upper()
                wants_part = intent in ("PART_REQUEST", "PRICE_QUERY", "AVAILABILITY_QUERY")
                already_asked_check = "check that coded area" in prior_asst.lower()
                coded_parts = _parts_in_coded_area(rag.get("parts") or [], mcp)
                has_cards = bool(coded_parts)
                if has_cards:
                    msg += (" A matching part is below if you want to proceed after the coded-area "
                            "checks.")
                    mention = "purchase"
                elif checks_done or wants_part or already_asked_check:
                    msg += (" If the accessible check on that coded area is already done and the "
                            "fault remains, the next step is the matching part or an engineer "
                            "test — not a different part that was only suggested.")
                    msg += " I don't currently have a matching part card for this model."
                    mention = "discuss" if mention == "purchase" else mention
                    if mention == "discuss":
                        comps = comps[:2]
                else:
                    msg += (" Next useful step: check that coded area on the machine before "
                            "replacing anything.")
                    if mention == "purchase":
                        mention = "discuss"
                    if mention == "discuss":
                        comps = comps[:2]
                prov["suggestedChecks"] = Trust.L3_PROBABILISTIC.value if rag.get("candidateComponents") else Trust.L2_EVIDENCE_BACKED.value
                rag = dict(rag)
                rag["parts"] = coded_parts
        if safety:
            msg = safety["message"] + " " + msg
        stop = bool(safety and safety["stopUse"])
        out = Outcome.SAFETY_STOP.value if stop else Outcome.ANSWER.value
        # part cards flow through ONLY for a genuine fault answer (never for STATUS/MAINTENANCE via
        # the recordType guard above, never on safety-stop, never on conflict). No model → no parts.
        parts = (rag.get("parts") or None) if (
            not stop and mention == "purchase" and _customer_has_model(st)
        ) else None
        # Customer safety information flows only on a genuine grounded ANSWER that is not a stop —
        # mirrors parts. Suppressed on stop (deterministic safety reply leads), and never reached on
        # the status/maintenance (recordType guard) or conflict branches (they return earlier).
        safety_info = rag.get("safetyInformation") if (not stop and rag.get("grounded")) else None
        media_c = (rag.get("media") or None) if not stop else None
        return OrchestratorResponse(
            route="", outcome=out, message=msg,
            codeResult=CodeResultView(displayed=displayed, meaning=meaning, recordType=rt, status="RESOLVED"),
            diagnosis=(DiagnosisView(summary=rag.get("faultLabel"), confidenceBand=self._band(rag.get("confidence"))) if rag.get("grounded") else None),
            suggestedChecks=comps if has_model else [],
            componentMention=mention,
            parts=parts, resolvedModel=rag.get("resolvedModel"), traceId=rag.get("traceId"),
            safetyInformation=safety_info, media=media_c, safety=safety, modelRequired=model_required,
            provenance=prov,
            debug={"conflict": False, "trustedContextUsed": True, "system": mcp.get("system"),
                   "scheme": mcp.get("scheme"), "ragSystem": rag.get("system")})

    def _compose_unresolved_code_plus_symptoms(self, st: ConversationState, mcp: dict, rag: dict) -> OrchestratorResponse:
        status = mcp.get("status")
        displayed = _facing_code(st, mcp)

        # RESPONSE OWNERSHIP. NEEDS_CONTEXT / AMBIGUOUS mean the code IS a RECOGNISED manufacturer
        # code whose EXACT meaning is model/scheme-dependent — the MCP just can't pin the scheme
        # deterministically. When the RAG has GROUNDED a diagnosis it has effectively interpreted the
        # code for the customer (e.g. "The 22E error code … indicates an evaporator-fan fault"), so
        # that grounded diagnostic answer OWNS the reply. It is composed in exactly ONE place,
        # `_compose_symptoms_only`, which surfaces the part-finder's own grounded prose, stages the
        # model request for EXACT PART FIT (not "to read the code"), and preserves fit state
        # (VERIFY_FIT / MODEL_CONFIRMED), safetyInformation, media, normal-behaviour and the
        # safety-stop precedence. Previously this composer authored a SECOND, competing message that
        # led with "To read the <code> code exactly I'd need the model…" and relegated the grounded
        # diagnosis to a "Separately…" afterthought — discarding the good part-finder answer and
        # misleadingly implying the model was needed to INTERPRET a code we can actually diagnose.
        # The unresolved-code state stays visible in the structured `codeResult`. (Authority rule
        # intact: only runs when the MCP resolved NO meaning, so nothing deterministic is contradicted.)
        if status in ("NEEDS_CONTEXT", "AMBIGUOUS") and rag.get("grounded"):
            resp = self._compose_symptoms_only(st, rag)
            if displayed and displayed.lower() not in (resp.message or "").lower():
                resp.message = f"The displayed code is {displayed}. " + (resp.message or "")
            resp.codeResult = CodeResultView(displayed=displayed, status=status)
            resp.provenance = {**(resp.provenance or {}), "codeStatus": Trust.L1_DETERMINISTIC.value}
            resp.debug = {**(resp.debug or {}), "mcpStatus": status,
                          "unresolvedCodeGroundedDiagnosis": True, "ragSystem": rag.get("system")}
            return resp

        # An incomplete or undocumented MCP lookup is not a conversation dead-end when the
        # customer also reported symptoms. Keep the unresolved status on structured codeResult;
        # continue diagnosis. INVALID_INPUT and a missing/empty MCP status include
        # "make+code known, family not yet supplied" — the protocol schema requires a family, so
        # the lookup never completed. That is not "this code does not exist". If the RAG grounded
        # a unique make+code mapping, that grounded answer owns the reply. Preserve the
        # customer-facing displayed code; do not rewrite it to a sibling alias.
        rag_prose = (rag.get("reply") or rag.get("answer") or "").strip()
        lookup_incomplete = status in ("NOT_FOUND", "INVALID_INPUT") or not status
        if lookup_incomplete and (rag.get("grounded") or len(rag_prose) >= 40):
            resp = self._compose_symptoms_only(st, rag)
            if displayed and displayed.lower() not in (resp.message or "").lower():
                resp.message = f"The displayed code is {displayed}. " + (resp.message or "")
            resp.codeResult = CodeResultView(displayed=displayed, status=status or "INVALID_INPUT")
            resp.provenance = {**(resp.provenance or {}), "codeStatus": Trust.L1_DETERMINISTIC.value}
            resp.debug = {**(resp.debug or {}), "mcpStatus": status,
                          "unresolvedIndicationSymptomLead": True, "ragSystem": rag.get("system")}
            return resp

        # Otherwise: either the RAG has no grounded diagnosis (an honest code clarification is all we
        # can offer — a genuinely model-dependent code, or an unknown/partial one), OR the code is
        # genuinely UNRECOGNISED (NOT_FOUND / INVALID_INPUT), where being honest that we have no
        # documented meaning is correct (NOT misleading); any grounded symptom diagnosis is surfaced
        # SEPARATELY rather than fabricating a code meaning. Safety still leads.
        safety = self._safety_block(st)
        if status == "NEEDS_CONTEXT":
            code_note = f"To read the {displayed} code exactly I'd need the model/rating-plate number."
            out = Outcome.CLARIFICATION_REQUIRED.value
        elif status == "AMBIGUOUS":
            code_note = f"The {displayed} code has more than one documented meaning here and I can't pin it down."
            out = Outcome.AMBIGUOUS.value
        else:  # NOT_FOUND / INVALID_INPUT — genuinely unrecognised code; be honest, never invent a meaning
            code_note = f"I couldn't find a documented meaning for {displayed} on this appliance."
            out = Outcome.NOT_FOUND.value if status == "NOT_FOUND" else Outcome.CLARIFICATION_REQUIRED.value
        if rag.get("grounded"):
            _cc = _customer_facing_components(rag)
            mention = _component_mention(rag)
            sym = (f" Separately, from your description this is {self._band(rag.get('confidence'))} a "
                   f"{_fault_phrase(rag)}"
                   + ((" \u2014 worth checking " + ", ".join(_cc) + ".") if (_cc and mention == "purchase") else "."))
        else:
            sym = " " + (rag.get("clarifyingQuestion") or "")
        msg = (code_note + sym).strip()
        if safety and safety["stopUse"]:
            msg = safety["message"] + " " + msg
            out = Outcome.SAFETY_STOP.value
        return OrchestratorResponse(
            route="", outcome=out, message=msg,
            codeResult=CodeResultView(displayed=displayed, status=status),
            diagnosis=(DiagnosisView(summary=rag.get("faultLabel"), confidenceBand=self._band(rag.get("confidence"))) if rag.get("grounded") else None),
            safety=safety,
            provenance={"codeStatus": Trust.L1_DETERMINISTIC.value,
                        **({"diagnosis": Trust.L3_PROBABILISTIC.value} if rag.get("grounded") else {})},
            debug={"mcpStatus": status, "ragSystem": rag.get("system")})
