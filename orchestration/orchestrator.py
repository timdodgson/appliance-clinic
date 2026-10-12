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

from .model import (Route, Outcome, Trust, TurnInput, ConversationState,
                    OrchestratorResponse, CodeResultView, DiagnosisView, ObservedIdentifier,
                    strongest_safety)
from . import routing
from .services import (ErrorCodeService, DiagnosticService,
                       McpUnavailable, RagUnavailable)

NON_FAULT_RECORD_TYPES = {"STATUS", "INFORMATION", "MAINTENANCE", "WARNING"}


def _facing_code(st: ConversationState, mcp: Optional[dict] = None) -> Optional[str]:
    """The code the customer supplied, not a mapping alias/canonical sibling."""
    cust = getattr(st.customer, "displayedCode", None)
    code = (mcp or {}).get("code") or {}
    return cust or code.get("input") or code.get("displayed")


# Fixed, safe in-scope redirect for an input Jev typed as a prompt attack or an
# unrelated (non-appliance) request. Mirrors the engine's REFUSAL_TEXT so the
# customer sees one consistent redirect regardless of which boundary refuses.
# Jev decides the MEANING (requestClass); this is only the deterministic reply.
SCOPE_REFUSAL_TEXT = (
    "I can only help with domestic appliance faults and spare parts, so I can't help with that. "
    "If you've got a problem with an appliance, tell me the make, model and what it's doing and "
    "I'll help you find the right part."
)


def _load_canonical_journeys() -> dict:
    """Canonical journey key -> likely area (faultId), from the ONE shared registry
    (services/diagnosis-engine/canonical/journeys.json; copied next to this module in the Lambda image).
    Fails closed: no readable registry -> no key is recognised -> no journey owns any turn (ADR 0018: never another
    diagnosis path)."""
    import json, logging, os
    here = os.path.dirname(os.path.abspath(__file__))
    for path in (os.path.join(here, "canonical_journeys.json"),
                 os.path.join(here, "..", "services", "diagnosis-engine", "canonical", "journeys.json")):
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


class Orchestrator:
    def __init__(self, error_code: ErrorCodeService, diagnostic: DiagnosticService):
        # ADR 0014: no state store. Each turn starts from the BFF's persisted cs/1 (the canonical block in the
        # request) plus the request itself; nothing the orchestrator computes survives the invocation.
        self.ec = error_code
        self.rag = diagnostic

    # ---------------- canonical transport (canonical-architecture.md §1) ----------------
    @staticmethod
    def _canonical_result(block: dict, res) -> dict:
        """Pass the engine's merged canonical result through unchanged, or a degraded envelope (that turn
        is an explicit error, ADR 0018). Only the session binding is checked; the state itself is never read here."""
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
        """The diagnostic RAG call. Records whether its reply is the engine's single vague-opener clarification
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
    # cs/1 hazard -> the cause _safety_block words a stop for (canonical/cs1.js HAZARD_LEVEL).
    _HAZARD_REASON = {"gas_escape": "gas", "gas_smell": "gas", "burning": "burning", "smoke": "burning",
                      "electric_shock": "shock", "electrical_water": "electrical", "supply_trip": "electrical",
                      "sparks_at_supply": "electrical", "exposed_live_wiring": "electrical"}

    @classmethod
    def _seed_from_cs1(cls, st: ConversationState, state) -> None:
        """ADR 0014: what earlier turns established comes from cs/1 — the state the engine merged on the previous
        turn and the BFF persisted — never from process memory. Identity, the displayed code, model status and the
        active safety level are read here; this turn's Jev reading then applies on top, exactly as before."""
        st._priorProblem = False
        st._priorToken = None
        if not isinstance(state, dict):
            return
        c = st.customer
        ident = state.get("identity") or {}

        def active(f):
            return f.get("value") if isinstance(f, dict) and f.get("status", "active") == "active" else None
        appliance, establishment = active(ident.get("appliance")), ident.get("applianceEstablishment")
        if appliance and establishment in ("established", "working"):
            c.appliance, c.applianceState = appliance, establishment
        make = active(ident.get("make"))
        if make:
            c.make = make
        model_fact = ident.get("model") or {}
        model = active(model_fact)
        if model and (model_fact.get("confirmed") or model_fact.get("basis") == "stated"):
            c.observed.append(ObservedIdentifier("MODEL", model))
        codes = [f.get("value") for f in ident.get("displayedCodes") or []
                 if isinstance(f, dict) and f.get("status") == "active" and f.get("value")]
        if codes:
            c.displayedCode = codes[-1]
        st._priorToken = active(ident.get("unconfirmedToken"))   # a code-or-model token not yet settled (token-gate.js)
        c.modelUnavailable = ident.get("modelStatus") == "unavailable" and not c.observed
        safety = state.get("safety") or {}
        if safety.get("activeLevel"):
            st.safetyState = safety["activeLevel"]
        live = [h for h in safety.get("hazards") or [] if isinstance(h, dict) and h.get("status", "active") == "active"]
        if live:
            st.safetyReason = cls._HAZARD_REASON.get(live[-1].get("hazard"))
        st._priorProblem = (any(isinstance(p, dict) and p.get("status") == "active" for p in state.get("problems") or [])
                            or any(isinstance(h, dict) and h.get("intent") == "report_fault"
                                   for h in (state.get("intent") or {}).get("history") or []))

    def _load(self, turn: TurnInput) -> ConversationState:
        st = ConversationState(sessionId=turn.sessionId)
        st.turns = int(turn.turnIndex or 0) or 1
        canon_block = getattr(turn, "canonical", None)
        self._seed_from_cs1(st, canon_block.get("state") if isinstance(canon_block, dict) else None)
        st._journeyStage = None
        c = st.customer
        _MODEL_ID_TYPES = ("MODEL", "E_NR", "PNC", "12NC")

        # ---- SINGLE Jev UNDERSTAND (Story 3): run ONCE, BEFORE routing ----
        # Jev is the sole semantic authority. We run the one Jev UNDERSTAND pass here (the engine
        # understand-only mode) and route on its TYPED decisions — routing NO LONGER re-reads the
        # customer's prose to infer appliance family, symptom presence or model-vs-error-code. The
        # exact typed intent is stored and forwarded verbatim to the RAG diagnose call so the engine
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
        # understand only when present (the engine merges and decides), and the merged result is handed
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
        # A weak MODEL reading of the token is not committed: a displayed code read as a model would otherwise be dropped
        # silently, so the clarify flow asks which it is. The decision is the engine's (canonical/token-gate.js, the only
        # implementation of the rule), carried on the understand intent; no threshold is recomputed here. A missing
        # decision (understand unavailable) commits, as a missing distribution always has.
        engine_token = raw.get("tokenDecision") if isinstance(raw.get("tokenDecision"), dict) else {}
        token_decision = "uncertain" if engine_token.get("decision") == "uncertain" else "commit"
        st._tokenDecision = engine_token or {"reason": "not_reported"}
        st._uncertainToken = None
        # The engine names the token it held; a weak model reading also arrives as Jev's model value.
        uncertain_token = engine_token.get("token") or jev_model
        if uncertain_token and not jev_code and token_decision == "uncertain":
            st._uncertainToken = uncertain_token
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
                     or bool(jev_code)
                     or bool(st._uncertainToken))   # a token our commit rule held is a code-or-model question, every time
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
        # A code conversation in which the LATEST message reports what the appliance is doing (Jev: the turn
        # establishes a symptom, of a real symptom family) carries a symptom too: the code stays known and the turn
        # routes to code + symptoms, instead of repeating the code meaning and dropping what the customer said.
        code_then_symptom = code_case and establishes == "symptom" and real_symptom
        jev_symptom = (bool(raw.get("fault"))
                       or jev_hazard
                       or code_then_symptom
                       or ((diagnostic_turn or real_symptom) and not code_case))

        # MAKE stays a STRUCTURAL brand-catalogue lookup (recognising a KNOWN brand token is not
        # interpreting customer meaning). Jev does not classify make; identity retention is state.
        make = routing.detect_make(turn.message, turn.make)
        # The make the engine's typed identity holds for this turn (mc/1 reads misspellings Jev accepts as the brand).
        merged_state = st._canonical.get("state") if isinstance(st._canonical, dict) and not st._canonical.get("degraded") else None
        merged_ident = (merged_state or {}).get("identity") or {} if isinstance(merged_state, dict) else {}
        merged_make = (merged_ident.get("make") or {}).get("value")
        if not make and merged_make:
            make = merged_make
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
            # The customer is answering OUR "is it a code or the model?" question and Jev reads the conversation as a
            # code one: the code is the token that question named (read from our own fixed question, never their text).
            if not code and (jev_says_code or decisions.get("symptomFamily") == "error_display"):
                asked = st._priorToken or routing.code_or_model_token(
                    self._last_assistant_text_of(getattr(turn, "conversation", None)))
                if asked:
                    code = asked
        explicit_model_tokens = [jev_model] if jev_model else []

        # PENDING-SLOT STATE remains deterministic (what the assistant asked for last turn); the
        # SEMANTIC "did this turn answer it / is it a model or a code" is now Jev's job, so there is
        # no prose fill/correction here.
        st._ragExclusiveClarify = False  # set by _rag_diagnose for this turn only
        st._codeOnlyAnswer = False       # set by _compose_code_only for this turn only
        st._pendingModelTokens = [jev_model] if jev_model else []
        # "Code present but no usable value" is now a Jev decision (symptomFamily == error_display
        # with no resolved code value), not a prose scan. Used by the clarify flow to ask for the
        # EXACT code rather than a generic description.
        st._codePresentNoValue = (decisions.get("symptomFamily") == "error_display"
                                  and not (jev_code or code or c.displayedCode))

        if make:
            c.make = make
        # The engine reads identity from the forwarded intent only: a make held by cs/1 (or found in the transcript) that
        # Jev's UNDERSTAND left empty is forwarded, so the engine never asks for a make the customer already gave.
        if c.make and not raw.get("make"):
            raw["make"] = c.make
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
        if sympt or st._priorProblem:
            # The problem is this turn's symptom or one cs/1 already holds (a later identity-only answer keeps it).
            # The customer's own words: the boundary sends the labelled transcript ("Customer: … / Advisor asked:
            # …"); our advisor prose is never captured as the symptom. customer_speech strips advisor lines.
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

        # ---- MODEL UNAVAILABLE (Journey Policy v2+: no model re-ask loop) ----
        # Unavailable when cs/1 holds modelStatus 'unavailable' (merge M9: the customer could not answer our model
        # request, monotonic until a confirmed model) or Jev types it this turn. A trusted model clears it. Seeded
        # in _seed_from_cs1; nothing is latched in process memory (ADR 0014).
        _has_trusted_model = any(o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value
                                 for o in c.observed)
        merged = st._canonical.get("state") if isinstance(st._canonical, dict) and not st._canonical.get("degraded") else None
        merged_unavailable = isinstance(merged, dict) and (merged.get("identity") or {}).get("modelStatus") == "unavailable"
        if _has_trusted_model:
            c.modelUnavailable = False
        elif bool(raw.get("modelUnavailable")) or merged_unavailable:
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
        """Stage A: the established conversation identity handed to the engine (understand +
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

        # ADR 0018: an AC turn is canonical, an explicit non-diagnostic outcome, or an explicit error. Nothing that
        # failed on the canonical path is answered by another path, so the canonical result must be present and
        # healthy, and the understanding it was built from must not be degraded.
        failure = self._canonical_failure_reason(st)
        if failure:
            return self._finish_turn(st, self._canonical_unavailable(debug, failure), debug, Route.SYMPTOMS, t0)

        # CANONICAL CONTROL (any allow-listed registry journey, behind the BFF journey gate).
        # Part-finder decided the typed NextAction in understand mode (cs/1 -> diagnostics -> policy); the
        # diagnose call only WORDS it.
        canonical = self._canonical_control(st)
        if canonical:
            debug["route"] = Route.SYMPTOMS.value
            debug["canonicalControl"] = canonical.get("key")
            resp = self._flow_canonical(st, canonical, debug)
            warn = self._unsafe_intent_warning(st, resp)
            if warn and resp.outcome != Outcome.SAFETY_STOP.value and warn not in (resp.message or ""):
                resp.message = (warn + " " + (resp.message or "")).strip()
            return self._finish_turn(st, resp, debug, Route.SYMPTOMS, t0)

        # NO JOURNEY OWNS THIS TURN (the canonical path ran and is healthy). What the merged cs/1 state says decides
        # the outcome; the legacy diagnosis is never called (ADR 0018):
        #   a hazard            -> the canonical safety stop (fixed copy)
        #   an unsafe request   -> the fixed decline
        #   a displayed code    -> the error-code MCP (the code's owner, ADR 0015), or the intake question it needs
        #   a typed problem no journey owns (appliance known) -> an explicit "not supported yet"
        #   nothing typed yet   -> the intake question (what is it / what is it doing)
        merged = self._merged_state(st)
        hazard = self._active_hazard(merged)
        if hazard:
            debug["route"] = Route.SYMPTOMS.value
            return self._finish_turn(st, self._flow_hazard(st, hazard, debug), debug, Route.SYMPTOMS, t0)
        if self._unsafe_request_this_turn(merged):
            debug["route"] = Route.SYMPTOMS.value
            return self._finish_turn(st, self._flow_unsafe_request(debug), debug, Route.SYMPTOMS, t0)
        # multi-turn: if we previously needed context for a code and the customer just supplied
        # model/identifiers (this turn added observed but no new code), retry the code resolution.
        supplied_context_followup = (bool(c.observed) and c.displayedCode
                                     and st.resolved.codeStatus in ("NEEDS_CONTEXT", None)
                                     and not st._sympt)
        symptoms_present = st._sympt or bool(c.symptomsText)
        r = routing.route(turn.message, code=c.displayedCode, make=c.make,
                          appliance=c.appliance, symptoms=symptoms_present)
        if supplied_context_followup and c.make and c.appliance:
            r = Route.ERROR_CODE
        unowned = self._unowned_problem(merged)
        if r == Route.ERROR_CODE_AND_SYMPTOMS:
            # The code's meaning comes from the MCP. Once it was given on an earlier turn, a typed problem no journey owns is
            # said plainly rather than answered with the same code meaning again.
            r = Route.UNSUPPORTED if (unowned and c.appliance and self._code_answered_earlier(merged)) else Route.ERROR_CODE
        elif r == Route.SYMPTOMS:
            r = Route.UNSUPPORTED if (unowned and c.appliance) else Route.CLARIFY
        debug["route"] = r.value

        if r == Route.ERROR_CODE:
            resp = self._flow_error_code(st, debug)
        elif r == Route.UNSUPPORTED:
            resp = self._flow_unsupported(st, unowned, debug)
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
        # composed a diagnostic (symptom) clarify for a hazardous family, the engine's owner
        # precaution never reached the customer (that branch uses only the short question). Carry it
        # here so safe framing is reliable on those turns too — narrow and additive (see
        # _owner_safety_note); never on identity asks, safety stops, reassurance or grounded answers.
        if getattr(st, "_ragExclusiveClarify", False) and resp.message and resp.message.strip() == (self._last_assistant_text(st) or ""):
            resp.message = self._DESCRIBE_AGAIN
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
        return resp

    # ---------------- canonical control ----------------
    def _canonical_control(self, st) -> Optional[dict]:
        """The deciding canonical journey when it owns this turn: a healthy result (the same transport shape the
        engine's controls() accepts) whose `journey` is a registry key, applies, is allow-listed (control) and carries
        a typed NextAction. Anything else: no journey owns the turn."""
        out = getattr(st, "_canonical", None)
        if not self._healthy_transport(out):
            return None
        j = out.get("journey")
        if isinstance(j, dict) and j.get("control") and j.get("applies") and isinstance(j.get("nextAction"), dict) \
                and j.get("key") in self._CANONICAL_JOURNEYS:
            return j
        return None

    # key -> likely area, from the shared journey registry (services/diagnosis-engine/canonical/journeys.json).
    _CANONICAL_JOURNEYS = _load_canonical_journeys()

    # ---------------- ADR 0018: canonical or explicit ----------------
    _UNAVAILABLE_MSG = "I can't run the diagnosis right now. Please try again shortly."

    @staticmethod
    def _healthy_transport(out) -> bool:
        """The canonical result shape the engine's controls() accepts (canonical-runtime.js isTransportResult): cs/1,
        not degraded, integer versions and a cs/1 state. The orchestrator never applies a looser gate than the engine."""
        if not isinstance(out, dict) or out.get("schema") != "cs/1" or out.get("degraded"):
            return False
        if not isinstance(out.get("priorVersion"), int) or not isinstance(out.get("version"), int):
            return False
        state = out.get("state")
        return isinstance(state, dict) and state.get("schemaVersion") == "cs/1"

    def _canonical_failure_reason(self, st) -> Optional[str]:
        """Why this AC turn cannot be decided on the canonical path, or None. A missing block, a degraded or malformed
        canonical result, and a degraded understanding (the engine's Jev pass failed) are all explicit errors."""
        out = getattr(st, "_canonical", None)
        if out is None:
            return "canonical_block_missing"
        if isinstance(out, dict) and out.get("degraded"):
            return str(out.get("degraded"))[:60]
        if not self._healthy_transport(out):
            return "canonical_result_invalid"
        raw = getattr(st, "_understand", None) or {}
        if raw.get("_degraded") or not (getattr(st, "_jev", None) or {}).get("decisions"):
            return "understand_degraded"
        return None

    def _canonical_unavailable(self, debug: dict, reason: str) -> OrchestratorResponse:
        """ADR 0016 / 0018: the explicit error for a turn the canonical path could not decide. The canonical result
        is marked degraded so the BFF persists nothing from this turn."""
        debug["canonicalUnavailable"] = reason
        if isinstance(debug.get("canonical"), dict):
            debug["canonical"] = {**debug["canonical"], "degraded": debug["canonical"].get("degraded") or reason}
        return self._service_unavailable("canonical", self._UNAVAILABLE_MSG)

    @staticmethod
    def _merged_state(st) -> dict:
        out = getattr(st, "_canonical", None)
        return out.get("state") if isinstance(out, dict) and isinstance(out.get("state"), dict) else {}

    @staticmethod
    def _active_hazard(state: dict) -> Optional[str]:
        """The hazard cs/1 holds active at a stop level (merge M14), or None."""
        safety = (state or {}).get("safety") or {}
        if safety.get("activeLevel") not in ("EMERGENCY_ACTION", "STOP_USE"):
            return None
        live = [h for h in safety.get("hazards") or [] if isinstance(h, dict) and h.get("status", "active") == "active"]
        return live[-1].get("hazard") if live else None

    @staticmethod
    def _unsafe_request_this_turn(state: dict) -> bool:
        """The customer asked how to do something unsafe on this turn (cs/1 safety.unsafeActions, merge M15)."""
        ver = (state or {}).get("version")
        return any(isinstance(u, dict) and u.get("turn") == ver for u in ((state or {}).get("safety") or {}).get("unsafeActions") or [])

    @staticmethod
    def _unowned_problem(state: dict) -> Optional[str]:
        """The latest active problem cs/1 typed (its mc/1 journey value), when no journey took the turn; else None."""
        active = [p for p in (state or {}).get("problems") or [] if isinstance(p, dict) and p.get("status") == "active"]
        j = active[-1].get("journey") if active else None
        j = j.get("value") if isinstance(j, dict) else j     # a cs/1 Fact
        # 'error-code-only' is a placeholder (a code with no described behaviour), not a problem to diagnose
        return j if isinstance(j, str) and j and j not in ("none", "error-code-only") else None

    @staticmethod
    def _code_answered_earlier(state: dict) -> bool:
        """The active displayed code was stated on an earlier turn than this one (cs/1 identity.displayedCodes)."""
        codes = [f for f in ((state or {}).get("identity") or {}).get("displayedCodes") or [] if isinstance(f, dict) and f.get("status", "active") == "active"]
        turn, ver = (codes[-1].get("turn") if codes else None), (state or {}).get("version")
        return isinstance(turn, int) and isinstance(ver, int) and turn < ver

    def _flow_hazard(self, st: ConversationState, hazard: str, debug: dict) -> OrchestratorResponse:
        """A hazard with no journey to carry it: the canonical safety stop, from cs/1, in the fixed stop copy."""
        level = (self._merged_state(st).get("safety") or {}).get("activeLevel")
        st.safetyState = strongest_safety(st.safetyState, level)
        st.safetyReason = self._HAZARD_REASON.get(hazard) or st.safetyReason
        block = self._safety_block(st) or {"class": "STOP_USE", "stopUse": True, "message": self.GENERIC_STOP_MSG}
        debug["canonicalSafety"] = hazard
        return OrchestratorResponse(route="", outcome=Outcome.SAFETY_STOP.value, message=block["message"], safety=block,
                                    provenance={"safety": Trust.L1_DETERMINISTIC.value})

    def _flow_unsafe_request(self, debug: dict) -> OrchestratorResponse:
        """An unsafe request with no journey to decline it: the fixed decline, no procedure."""
        debug["unsafeRequestDeclined"] = True
        return OrchestratorResponse(route="", outcome=Outcome.ANSWER.value, message=self.UNSAFE_INTENT_MSG,
                                    provenance={"safety": Trust.L1_DETERMINISTIC.value})

    def _flow_unsupported(self, st: ConversationState, problem: Optional[str], debug: dict) -> OrchestratorResponse:
        """ADR 0018: a typed problem no canonical journey owns yet. Said plainly, with the safety line; no cause, no part."""
        fam = str(st.customer.appliance or "appliance").replace("-", " ").replace("hobs", "hob")
        debug["unsupported"] = problem
        msg = (f"I can't diagnose that problem with your {fam} here yet, so I won't guess at a cause or a part. "
               "If there's any burning smell, sparking, smoke or water near the electrics, stop using it and switch it off "
               "at the wall. Otherwise an appliance engineer can look at it, or tell me about a different problem with it.")
        return OrchestratorResponse(route="", outcome=Outcome.UNSUPPORTED.value, message=msg,
                                    provenance={"scope": Trust.L1_DETERMINISTIC.value})

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
            # The customer never saw the NextAction this state records (its issued request included): the canonical
            # result is marked degraded so the BFF does not persist it, and the next turn starts from the prior state.
            return self._canonical_unavailable(debug, "diagnose_unavailable")
        debug["latencies"]["rag_ms"] = round((time.perf_counter() - t) * 1000, 1)
        debug["ragInvoked"] = True
        debug["ragTrace"] = rag.get("diagnosticTrace")
        # The engine must prove this reply is the canonical one (diagnose `done.canonicalControl`). A reply without it
        # was produced some other way (e.g. a dropped signature) and is never presented as the journey's answer.
        cj = rag.get("canonicalControl")
        if not isinstance(cj, dict) or not isinstance(cj.get("nextAction"), dict):
            return self._canonical_unavailable(debug, "diagnose_not_canonical")
        self._apply_rag_safety(st, rag)
        a = cj["nextAction"]
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
            # The customer-facing label is the engine's (conclusion.summary, canonical/cause-summary.js), passed through.
            # A cause without one gets no label, never its raw key; the orchestrator keeps no copy of the vocabulary.
            diag = DiagnosisView(summary=concl.get("summary") or None,
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

    def _ambiguous_code_reply(self, st, mcp: dict) -> str:
        """A code with more than one documented meaning: say what it can mean (the MCP's structured candidates) and
        what would settle it. Never the same message twice in a row: a repeat gives the other way forward."""
        shown = _facing_code(st, mcp)
        fam = str(st.customer.appliance or "appliance").replace("-", " ")
        make = str(st.customer.make or "").strip()
        where = f"your {(make[:1].upper() + make[1:] + ' ' + fam).strip()}" if make else f"this {fam}"
        meanings = []
        for c in mcp.get("candidates") or []:
            m = str((c or {}).get("meaning") or "").strip().rstrip(".")
            if m and m.lower() not in {x.lower() for x in meanings}:
                meanings.append(m)
        listed = "; or ".join(meanings[:3])
        settle = ("If you tell me what the machine is doing when the code shows, I can help from that."
                  if st.customer.modelUnavailable else
                  "The model number on the rating plate would tell me which one applies to your machine.")
        msg = (f"{shown} on {where} has more than one documented meaning: {listed}. {settle}" if listed else
               "That code has more than one documented meaning on this appliance and I can't pin it down for certain. "
               "If you can give the model/rating-plate number I can try to narrow it.")
        if msg.strip() == (self._last_assistant_text(st) or "").strip():
            msg = (f"Without the model number I can't tell which of those meanings {shown} has on your machine. "
                   "If you tell me what the machine is doing when the code shows, I'll help from that.")
        return msg

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
        # ADR 0018: the code's meaning is the MCP's (ADR 0015). An unresolved code is answered from what the MCP knows
        # (its documented meanings, or what would settle it); it is never reconciled with another diagnosis path.
        return self._compose_code_only(st, mcp)


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
        models = [o.value for o in c.observed
                  if o.type in ("MODEL", "E_NR", "PNC", "12NC") and o.value]
        if models and not any(m in joined for m in models):
            parts.append(f"The model number is {models[0]}.")
        return "  ".join(parts).strip()


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
            q = routing.code_or_model_question(tok)
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
                # ONE open question (GOLD v2), the same one the engine asks; a display code can come later, so
                # it is not asked in the same breath, and no menu of faults is offered.
                fam = str(c.appliance).replace("-", " ")
                q = f"What is the main thing the {fam} is doing wrong?"
            # Asked this exact question last turn and got no usable description: ask it differently, still one
            # question, rather than repeating it word for word (GOLD-v2.3 G2-DW-05).
            if q == self._last_assistant_text(st):
                q = self._DESCRIBE_AGAIN
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
    # for a risky appliance family. The engine carries this on the diagnostic replies IT
    # composes (ensureOwnerCheckSafety); but the orchestrator composes some diagnostic CLARIFY turns
    # itself (the conf>=0.7 "narrow it down" branch and the generic symptom clarify) from only the
    # short question field, discarding the engine's note. This mirrors that note so an
    # orchestrator-owned diagnostic clarify for a hazardous family still carries safe framing. Keyed
    # on the canonical family (st.customer.appliance). Verbatim-consistent with the engine's map.
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
    # Isolation/precaution cues already present → do not double the note (mirrors the engine's regex).
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
        the engine already framed the reply we never double it."""
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


    # The describe-the-problem question asked a second way (one question, no menu), used when the same question was
    # our last reply and the customer still gave no usable description.
    _DESCRIBE_AGAIN = ("No problem — let's take it one step at a time. When you start a programme, what happens "
                       "that shouldn't, or what doesn't happen that should?")

    @classmethod
    def _last_assistant_text(cls, st: ConversationState) -> Optional[str]:
        """Our own previous reply, from the client-carried conversation (structure only: role + text)."""
        return cls._last_assistant_text_of(getattr(st, "_conversation", None))

    @staticmethod
    def _last_assistant_text_of(conv) -> Optional[str]:
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
            msg = (f"I couldn't find a documented meaning for {_facing_code(st, mcp) or 'that code'} on a "
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
            msg = self._ambiguous_code_reply(st, mcp)
            return OrchestratorResponse(route="", outcome=Outcome.AMBIGUOUS.value, message=msg,
                                        codeResult=CodeResultView(displayed=_facing_code(st, mcp),
                                                                  status=status))
        rt = mcp.get("recordType")
        meaning = mcp.get("meaning")
        if status != "RESOLVED" or not meaning:
            # An incomplete lookup: the code is kept and nothing is said about what it means.
            shown = _facing_code(st, mcp)
            fam = str(st.customer.appliance or "appliance").replace("-", " ")
            q = (f"I couldn't confirm what {shown or 'that code'} means on your {fam} from the documented codes. "
                 "What's the model number on the rating plate so I can look it up for your exact machine?")
            st.clarificationRequested = q
            return OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message=q,
                                        codeResult=CodeResultView(displayed=shown, status=status),
                                        clarification={"question": q, "needs": ["model"], "intent": "MODEL"},
                                        provenance={"clarification": Trust.L1_DETERMINISTIC.value})
        # RESOLVED
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

