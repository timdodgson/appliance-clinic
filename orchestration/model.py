#!/usr/bin/env python3
"""Customer Diagnostic Orchestrator V1 — data contracts.

Deterministic orchestration layer that puts the (deterministic) Error-Code MCP and the
(probabilistic) Diagnostic RAG behind one customer conversation WITHOUT merging the two
knowledge assets. This module defines the input, state, trusted-context, and response contracts.

Trust tiers (provenance) — NEVER interchangeable:
  L1_DETERMINISTIC     resolved error-code meaning / recordType / scheme / V1-backed safety
  L2_EVIDENCE_BACKED   enrichment possibilities (components, likely causes, suggested checks)
  L3_PROBABILISTIC     RAG symptom diagnosis / inferred fault / candidate component

All customer-provided strings are UNTRUSTED DATA. Nothing here interprets instructions embedded
in customer text; fields carry values verbatim to downstream services.
"""
from __future__ import annotations
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Optional


class Route(str, Enum):
    ERROR_CODE = "ERROR_CODE"
    SYMPTOMS = "SYMPTOMS"
    ERROR_CODE_AND_SYMPTOMS = "ERROR_CODE_AND_SYMPTOMS"
    CLARIFY = "CLARIFY"


class Outcome(str, Enum):
    ANSWER = "ANSWER"
    CLARIFICATION_REQUIRED = "CLARIFICATION_REQUIRED"
    AMBIGUOUS = "AMBIGUOUS"
    NOT_FOUND = "NOT_FOUND"
    SAFETY_STOP = "SAFETY_STOP"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"


class Trust(str, Enum):
    L1_DETERMINISTIC = "L1_DETERMINISTIC"
    L2_EVIDENCE_BACKED = "L2_EVIDENCE_BACKED"
    L3_PROBABILISTIC = "L3_PROBABILISTIC"


# Safety precedence — strongest applicable state wins (monotonic; a downstream probabilistic
# component may only ESCALATE, never weaken, a deterministic safety instruction).
# EMERGENCY_ACTION is the strongest: a suspected gas escape needs bespoke emergency guidance
# (no switches/flames, ventilate, National Gas Emergency line) that OUTRANKS a plain electrical stop.
SAFETY_ORDER = ["NORMAL_DIAGNOSTIC", "STATUS_ONLY", "SERVICE_REQUIRED", "ISOLATE_IF_SAFE", "STOP_USE", "EMERGENCY_ACTION"]


def safety_rank(cls: Optional[str]) -> int:
    try:
        return SAFETY_ORDER.index(cls or "NORMAL_DIAGNOSTIC")
    except ValueError:
        return 0


def strongest_safety(*classes: Optional[str]) -> str:
    best = "NORMAL_DIAGNOSTIC"
    for c in classes:
        if safety_rank(c) > safety_rank(best):
            best = c or best
    return best


# ---------------- input ----------------
@dataclass
class ObservedIdentifier:
    type: str          # MODEL / E_NR / PNC / 12NC / SERIAL / ...
    value: str
    revision: Optional[str] = None


@dataclass
class TurnInput:
    """One customer turn. `message` is free-text (UNTRUSTED). Structured fields are optional
    hints a UI may already hold; they are also treated as data."""
    message: str
    sessionId: str = "default"
    make: Optional[str] = None
    appliance: Optional[str] = None
    displayedCode: Optional[str] = None
    region: Optional[str] = None
    observed: list[ObservedIdentifier] = field(default_factory=list)
    includeEnrichment: bool = True
    image: Optional[str] = None   # rating-plate image (data URL / URL), UNTRUSTED. Passed to the RAG vision pass; extraction is offered for confirmation, never auto-trusted.
    # ---- cross-turn semantic state (client-carried; all OPTIONAL & backward-compatible) ----
    # `pendingRequest` is the STRUCTURED semantic request the assistant made on the PREVIOUS turn:
    # {slot, purpose, status}. It is what lets a bare answer this turn fill the RIGHT slot
    # regardless of token shape (a model reply is a model even if code-shaped, and vice-versa). It
    # is produced structurally at question-creation time (never by parsing the assistant's prose)
    # and carried back by the boundary. Absent -> the orchestrator falls back to shape/observed
    # reconciliation exactly as before. See routing.PendingRequest / fill_pending_slot.
    pendingRequest: Optional[dict] = None
    # The LATEST turn's raw text ALONE (the answer), distinct from `message` which the boundary may
    # send as the whole accumulated conversation. Used to fill the pending slot from just the answer.
    latestMessage: Optional[str] = None
    turnIndex: int = 0            # 0-based customer turn number (0 = opening turn)
    # CANONICAL: the BFF-owned cs/1 block {schema, mode, control, sessionId, version, state, degraded}.
    # Transported VERBATIM to part-finder understand (which merges, routes and decides). The orchestrator
    # never reads the state or persists it; it only gates on the returned journey (_canonical_control).
    canonical: Optional[dict] = None
    identitySource: Optional[str] = None  # customer | inferred | unresolved — never promote inferred
    fuel: Optional[str] = None  # gas | electric | None. Unknown stays unknown; never inferred from spark/heat.
    # Optional LLM (or regex-backstop) extraction from the boundary. When source is "llm",
    # these fields are the meaning of the customer's words and MUST win over token-shape
    # regex (a model series like V6 is not an error code). Absent -> lexical fallback.
    # Shape: {source, make, appliance, model, errorCode, hasSymptoms, codeAbsent}
    intent: Optional[dict] = None
    # Role-separated conversation (user/assistant turns) for the Diagnostic RAG.
    # When present the RAG sees a real multi-turn thread instead of one concatenated user blob.
    conversation: Optional[list] = None


# ---------------- conversation state (provenance-separated) ----------------
@dataclass
class CustomerProvided:
    """What the customer said. Never promoted to a resolved fact on its own."""
    make: Optional[str] = None
    appliance: Optional[str] = None
    # STAGE A: establishment state of `appliance` as conversation identity — "established" (the
    # customer explicitly named/corrected the family, Jev provenance customer_named), "working" (an
    # operational inference), or None (unknown). A genuinely established family is preserved across
    # weak/null/inferred later turns and replaced only by an explicit customer correction.
    applianceState: Optional[str] = None
    fuel: Optional[str] = None  # gas | electric | None. Unknown stays unknown.
    displayedCode: Optional[str] = None
    region: Optional[str] = None
    observed: list[ObservedIdentifier] = field(default_factory=list)
    symptomsText: Optional[str] = None
    # CONVERSATION-STATE PERSISTENCE: the established typed problem/evidence the customer has given
    # over the WHOLE conversation, kept so a sparse follow-up turn (an identity answer, a check
    # result, an "I don't know") can never silently drop what was already established. Jev owns the
    # semantic reading of the latest turn: when its current-turn output carries a set it is
    # authoritative over the whole thread (it both ADDS new evidence and drops anything the customer
    # CORRECTED); when the latest turn is sparse and Jev returns an empty set, deterministic state
    # PRESERVES the established set and re-injects it into the forwarded intent so COMPOSE still sees
    # it. These are L0 customer-said evidence (augmentable, correctable), never promoted to L1 facts.
    fault: Optional[str] = None  # Jev's short established problem phrase (e.g. "not spinning")
    reportedSymptoms: list[str] = field(default_factory=list)
    checksReported: list[str] = field(default_factory=list)
    facts: list[str] = field(default_factory=list)
    # Monotonic: once the customer could not/would not answer something we never re-ask it, so a
    # later sparse turn cannot reopen a declined fact. Union across turns (still correctable by Jev
    # re-reading the thread if the customer later supplies the answer).
    declinedFacts: list[str] = field(default_factory=list)
    # MONOTONIC identity-unavailable latch. Set once the customer has said they cannot find/read the
    # model (Jev modelUnavailable) OR could not answer a MODEL request we made. Once latched, neither
    # the Python model-acquisition gate nor the Node identification gate re-asks for the model — the
    # engine proceeds on the best model-independent route. Cleared implicitly: a later trusted MODEL
    # observation makes _journey_stage return MODEL_KNOWN (checked first), so the latch is moot then.
    modelUnavailable: bool = False
    # MONOTONIC "we have asked for the model at least once" flag. Set the turn after we emit a MODEL
    # request. Drives the anti-loop: if the model was already requested and the customer's reply did
    # not supply one, we must NOT ask again (that reads as "repeats an unanswerable question") — the
    # engine latches modelUnavailable and proceeds model-independently. A later trusted MODEL still
    # wins (MODEL_KNOWN is checked first), so a customer who finds it later is never blocked.
    modelRequestedBefore: bool = False


@dataclass
class DeterministicResolved:
    """L1 facts from the Error-Code MCP / identifier layer."""
    codeStatus: Optional[str] = None       # RESOLVED/NEEDS_CONTEXT/AMBIGUOUS/NOT_FOUND/INVALID_INPUT
    canonicalMeaning: Optional[str] = None
    recordType: Optional[str] = None
    system: Optional[str] = None
    scheme: Optional[dict] = None          # internal only (schemeId/variantId) — never customer-facing
    protectionState: Optional[bool] = None
    safetyClass: Optional[str] = None
    stopUse: Optional[bool] = None
    mappingConfidence: Optional[str] = None
    productContext: Optional[dict] = None  # resolved scheme/generation/etc from identifiers


@dataclass
class ProbabilisticInferred:
    """L3 from the RAG. Explicitly NOT facts."""
    faultId: Optional[str] = None
    faultLabel: Optional[str] = None
    system: Optional[str] = None
    grounded: bool = False
    confidence: Optional[float] = None
    candidateComponents: list[str] = field(default_factory=list)


@dataclass
class ConversationState:
    sessionId: str = "default"
    customer: CustomerProvided = field(default_factory=CustomerProvided)
    resolved: DeterministicResolved = field(default_factory=DeterministicResolved)
    inferred: ProbabilisticInferred = field(default_factory=ProbabilisticInferred)
    clarificationRequested: Optional[str] = None
    safetyState: str = "NORMAL_DIAGNOSTIC"     # monotonic high-water mark across the conversation
    # The CAUSE behind the current safetyState, carried from the RAG's deterministic detector
    # ('gas' | 'shock' | 'burning' | None). Lets _safety_block select cause-specific customer
    # guidance instead of one generic electrical stop. Latched to the most recent non-null reason.
    safetyReason: Optional[str] = None
    # The customer has asked to PERFORM a dangerous action (bypass a safety device, test live,
    # keep resetting the trip, discharge a capacitor, re-gas a sealed system, hunt a gas leak with a
    # flame, …). Distinct from reporting a hazard: we actively WARN and refuse, but do not stop the
    # whole diagnosis. Latched true once seen in the conversation.
    unsafeIntent: bool = False
    turns: int = 0


# ---------------- trusted context handed to the RAG ----------------
@dataclass
class TrustedDiagnosticContext:
    """The ONLY thing the orchestrator hands the RAG from the deterministic side.

    `facts` are L1 (deterministic, authoritative — the RAG must not contradict them).
    `possibilities` are L2 (evidence-backed but NOT facts — components/causes remain candidates).
    `suggestedChecks` are L2 advisory. `safety` is L1 and monotonic.
    """
    source: str = "error-code-mcp"
    facts: dict = field(default_factory=dict)          # code, displayed, make, appliance,
                                                        # canonicalMeaning, recordType, system,
                                                        # protectionState, scheme(internal)
    possibilities: dict = field(default_factory=dict)  # components[], likelyCauses[]  (L2)
    suggestedChecks: list[str] = field(default_factory=list)  # L2
    safety: dict = field(default_factory=dict)         # class, stopUse  (L1)

    def to_prompt_facts(self) -> dict:
        """Compact, safe dict a RAG port may inject as trusted context (no internal ids leaked
        to the customer; schemeId stays internal to the port)."""
        return {"facts": self.facts, "possibilities": self.possibilities,
                "suggestedChecks": self.suggestedChecks, "safety": self.safety}


# ---------------- customer-facing response ----------------
@dataclass
class CodeResultView:
    displayed: Optional[str] = None
    meaning: Optional[str] = None
    recordType: Optional[str] = None
    status: Optional[str] = None


@dataclass
class DiagnosisView:
    summary: Optional[str] = None
    likelyArea: Optional[str] = None     # customer-facing area, not internal faultId
    confidenceBand: Optional[str] = None  # "likely" / "possible" — never "certain" for L3


@dataclass
class OrchestratorResponse:
    route: str
    outcome: str
    message: str
    codeResult: Optional[CodeResultView] = None
    diagnosis: Optional[DiagnosisView] = None
    suggestedChecks: list[str] = field(default_factory=list)
    componentMention: Optional[str] = None  # none | discuss | purchase — diagnosis grain vs catalogue presentation
    parts: Optional[list] = None                # RAG part cards passed through (L3), suppressed for safety/status/maintenance/conflict
    resolvedModel: Optional[str] = None         # customer/OCR model string for staging; NOT by itself a confirmed-fit signal
    catalogueResolvedModel: Optional[str] = None  # unique catalogue model after deterministic lookup
    catalogueMatchType: Optional[str] = None  # exact | unique_suffix | incomplete | ambiguous | make_conflict | not_found | none
    traceId: Optional[str] = None               # RAG feedback token; customer-safe
    safetyInformation: Optional[dict] = None    # pre-written evidence-backed customer safety info for the grounded node; passed through verbatim (NOT a safety-stop, NOT LLM-generated)
    media: Optional[list] = None                # customer instructional media (image/diagram/video) supporting a check on the grounded node; customer-safe fields only; suppressed on stop/status/conflict
    modelRequired: bool = False                 # Stage-1: a fault is grounded BUT the model is needed before parts. Coexists with a populated diagnosis (grounded != ready to sell a part).
    imageExtraction: Optional[dict] = None      # rating-plate vision result awaiting confirmation: {make, model, source:'IMAGE', status:'IMAGE_EXTRACTED_UNCONFIRMED'}. NEVER a resolved/trusted model until the customer confirms.
    clarification: Optional[dict] = None        # {question, needs}
    pendingRequest: Optional[dict] = None       # STRUCTURED semantic request the customer's NEXT turn should answer: {slot, purpose, status}. Emitted at question-creation time; carried back by the boundary so the next answer fills the right slot regardless of token shape. None => nothing outstanding (a request was CONSUMED/answered).
    safety: Optional[dict] = None               # {class, stopUse, message}
    understood: Optional[dict] = None           # customer-safe RESOLVED identity for this turn: {make, appliance, displayedCode}. Reflects the single Jev UNDERSTAND + structural make/code the orchestrator actually routed/submitted on (observability parity for the boundary; NOT a re-parse). Never internal ids.
    provenance: dict = field(default_factory=dict)  # field -> trust tier (customer-safe labels)
    debug: dict = field(default_factory=dict)   # internal-only; NOT for customer display

    def customer_view(self) -> dict:
        """Customer-visible projection — excludes debug and any internal ids."""
        d = asdict(self)
        d.pop("debug", None)
        return d
