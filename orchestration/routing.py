"""Deterministic routing for the orchestrator — NO LLM, NO customer-language semantics.

Story 3: Jev is the single semantic authority. The orchestrator runs ONE Jev UNDERSTAND pass
BEFORE routing (orchestrator._load) and routes on Jev's TYPED decisions — appliance family, symptom
presence and model-vs-error-code meaning all come from Jev, never from re-reading the customer's
prose here. The legacy prose parsers (detect_appliance / _cue_appliance / has_symptoms /
reconcile_identifiers / detect_code + shape regexes / fill_pending_slot / code_answer_expected /
latest_answer_identifier / code_present_no_value) have been REMOVED — they duplicated meaning Jev
now supplies. What remains in this module is strictly STRUCTURAL:

  * detect_make      — recognise a KNOWN brand token (catalogue-brand lookup, not "meaning")
  * customer_speech  — strip advisor-labelled transcript lines (transcript hygiene)
  * _norm_ident / _collapse_code — identifier normalisation
  * collapse_code_list — presentation restraint (never dump a code inventory into a reply)
  * route            — select the route from already-typed semantic state

Route decision (from typed state):
  code + symptoms + make     -> ERROR_CODE_AND_SYMPTOMS
  code + symptoms, no make   -> SYMPTOMS
  code only + make           -> ERROR_CODE
  code only, no make         -> CLARIFY (need make to resolve the code)
  symptoms only              -> SYMPTOMS
  nothing usable             -> CLARIFY
"""
from __future__ import annotations
import re
from .model import Route

# Known brand tokens — a presence hint for the MCP call (a make is not a family). Recognising a
# catalogue brand name is structural identity matching, not interpreting customer meaning; Jev does
# not classify make, so this stays deterministic.
MAKES = {
    "bosch", "siemens", "neff", "gaggenau", "aeg", "electrolux", "zanussi", "hotpoint",
    "indesit", "whirlpool", "hoover", "candy", "beko", "haier", "samsung", "lg", "miele",
    "panasonic", "smeg", "bauknecht", "gorenje", "hisense", "sharp", "belkin",
}

_CUSTOMER_LINE = re.compile(r"^(?:Customer|User)\s*:\s*", re.I)
_ADVISOR_LINE = re.compile(r"^(?:Advisor(?:\s+asked)?)\s*:\s*", re.I)


def customer_speech(text: str | None) -> str:
    """Customer utterances only. Advisor-labelled lines must not become identity facts.

    The boundary may send a labelled transcript (`Customer: ...\\nAdvisor asked: ...`).
    Words in our own questions (e.g. 'drum') are not the customer naming an appliance.
    Unlabelled text is returned unchanged. Structural transcript hygiene, not semantics.
    """
    if not text:
        return text or ""
    lines = text.splitlines()
    labelled = any(_CUSTOMER_LINE.match(ln.strip()) or _ADVISOR_LINE.match(ln.strip())
                    for ln in lines)
    if not labelled:
        return text
    kept = []
    for ln in lines:
        s = ln.strip()
        if not s or _ADVISOR_LINE.match(s):
            continue
        if _CUSTOMER_LINE.match(s):
            kept.append(_CUSTOMER_LINE.sub("", s, count=1).strip())
    return "\n".join(kept) if kept else text


def _present(text: str, vocab: set[str]) -> str | None:
    low = (text or "").lower()
    # longest match first (so "washing machine" beats "washer"); real word boundaries so a brand
    # followed by punctuation ("bosch," / "bosch.") is still recognised.
    for term in sorted(vocab, key=len, reverse=True):
        if re.search(r"\b" + re.escape(term) + r"\b", low):
            return term
    return None


def detect_make(text: str, explicit: str | None = None) -> str | None:
    """Structural brand-catalogue lookup: is a KNOWN brand token present? (Not customer meaning.)"""
    if explicit:
        return explicit.strip()
    return _present(customer_speech(text or ""), MAKES)


def _norm_ident(s: str | None) -> str:
    """Normalise an identifier token for comparison (strip non-alphanumerics, upper-case)."""
    return re.sub(r"[^A-Z0-9]", "", str(s or "").upper())


# Structural shape of a displayed-code token (letters+digits, optional trailing letter). Used ONLY to
# read back the VALUES of code tokens Jev has already SEMANTICALLY classified as error codes — never
# to decide that a token IS a code (that is Jev's job).
_CODE_SHAPE_RE = re.compile(r"[A-Za-z]{1,3}\d{1,4}[A-Za-z]?")


def compound_displayed_code(text: str | None, primary: str) -> str:
    """STRUCTURAL provenance of a COMPOUND displayed code. Jev decides the customer's code-shaped
    tokens ARE error codes (candidateTokenMeaning + secondaryTokenMeaning == 'error_code') but only
    returns the PRIMARY value; this reads back the sibling code-token VALUES the customer literally
    typed so a compound like "E36 or E10" is preserved verbatim rather than truncated to the primary.
    No meaning is assigned here. Only tokens sharing the primary's leading-letter prefix are joined
    (so a model number or unrelated figure in the same sentence is excluded). Returns the primary
    alone when there is no distinct same-scheme sibling."""
    prim = _collapse_code(primary)
    pm = re.match(r"[A-Za-z]+", prim)
    pfx = pm.group(0).upper() if pm else ""
    seq: list[str] = []
    for m in _CODE_SHAPE_RE.findall(text or ""):
        tok = _collapse_code(m)
        tm = re.match(r"[A-Za-z]+", tok)
        tpfx = tm.group(0).upper() if tm else ""
        if tpfx and tpfx == pfx and tok not in seq:
            seq.append(tok)
    if prim not in seq or len(seq) < 2:
        return prim
    return "/".join(seq)


def displayed_codes_in(text: str | None) -> list[str]:
    """All SHORT code-shaped tokens in the text (deduped, in order). Structural: used ONLY to recover
    the VALUE(s) of a code Jev has already SEMANTICALLY classified as an error code but returned
    without a value. The <=5 char cap keeps this to code shapes (E36, F05, E10), never model numbers."""
    seq: list[str] = []
    for m in _CODE_SHAPE_RE.findall(text or ""):
        tok = _collapse_code(m)
        if tok and len(tok) <= 5 and tok not in seq:
            seq.append(tok)
    return seq


# An EXPLICIT customer code label: "error"/"fault"/"code"/"err" (optionally "code"/"no."/"number")
# immediately before a code-shaped token — allowing an internal space the customer typed ("e 21").
# Reading a code the CUSTOMER labelled as such is structural provenance, not deciding whether an
# unlabelled ambiguous token is a code (that stays Jev's job).
_CODE_CUE_RE = re.compile(
    r"\b(?:error|fault|err|code)\s*(?:code|no\.?|number)?\s*[:#\-]?\s*"
    r"([A-Za-z]{1,3}\s?\d{1,4}[A-Za-z]?)\b",
    re.I)


def code_from_cue(text: str | None) -> str | None:
    """The code VALUE the customer EXPLICITLY labelled (e.g. 'error e 21' -> 'E21'). None if there is
    no customer-labelled code. Structural provenance of a labelled code; capped at a code shape."""
    m = _CODE_CUE_RE.search(text or "")
    if not m:
        return None
    tok = _collapse_code(m.group(1))
    return tok if 0 < len(tok) <= 5 else None


# A SLASH-joined pair of same-scheme code-shaped tokens ("E36/E10") is an unambiguous displayed
# COMPOUND code — models are never written that way. Structural form recognition (not meaning); used
# only to recover the value when Jev flip-flops on flagging the compound and did NOT call it a model.
_SLASH_CODE_RE = re.compile(r"\b([A-Za-z]{1,3}\d{1,4}[A-Za-z]?)/([A-Za-z]{1,3}\d{1,4}[A-Za-z]?)\b")


def slash_compound_code(text: str | None) -> str | None:
    """Recover a slash-joined compound displayed code ("E36/E10") verbatim, when both tokens are the
    same short code scheme. None otherwise. Structural; the caller must not apply this when Jev
    classified the token as a model."""
    m = _SLASH_CODE_RE.search((text or "").upper())
    if not m:
        return None
    a, b = _collapse_code(m.group(1)), _collapse_code(m.group(2))
    pa = re.match(r"[A-Z]+", a)
    pb = re.match(r"[A-Z]+", b)
    if not pa or not pb or pa.group(0) != pb.group(0):
        return None
    if len(a) > 5 or len(b) > 5:
        return None
    return f"{a}/{b}"


def _collapse_code(tok: str) -> str:
    """Structural normalisation of a code token the customer/Jev supplied (strip spaces, upper)."""
    return re.sub(r"\s+", "", tok).upper()


# A run of >=4 enumerated code-shaped tokens is an INTERNAL inventory, never customer prose. Collapse
# it so a composed reply can never dump a manufacturer code list ("Is it F01, F02, F03 ... F80?").
# Deterministic presentation restraint; a short realistic ambiguity ("E18 or E19") is left intact.
_CODE_TOKEN = r"[A-Za-z]{1,3}\d{1,3}[A-Za-z]?|\d{1,2}[A-Za-z]"
_CODE_LIST_RE = re.compile(
    r"(?:\b(?:" + _CODE_TOKEN + r")\b\s*[,/]\s*){3,}(?:\b(?:" + _CODE_TOKEN + r")\b)"
    r"(?:\s*[,/]?\s*(?:etc\.?|and\s+so\s+on|\.\.\.|…|or\s+(?:" + _CODE_TOKEN + r")))?",
    re.I)


def collapse_code_list(text: str) -> str:
    """Collapse an enumerated run of >=4 code-shaped tokens in customer-facing prose to a neutral
    phrase, so an internal code inventory never leaks into the reply. No-op when absent. Presentation
    hygiene on the composed reply — not routing, not semantics."""
    if not text:
        return text
    return _CODE_LIST_RE.sub("the exact code", text)


def route(text: str | None = None, *, code: str | None, make: str | None, appliance: str | None,
          symptoms: bool) -> Route:
    """Select the route from already-typed semantic state (no prose inspection; `text` is unused and
    kept only for call-site compatibility)."""
    if code and symptoms:
        # A displayed code plus MAKE is enough to attempt MCP. Family may still be unknown
        # (a make is not a family). Do not invoke MCP on family-alone without a make.
        if make:
            return Route.ERROR_CODE_AND_SYMPTOMS
        return Route.SYMPTOMS
    if code and not symptoms:
        return Route.ERROR_CODE if make else Route.CLARIFY
    if symptoms and not code:
        return Route.SYMPTOMS
    return Route.CLARIFY


# --- Stage B: deterministic first-turn appliance-family proceed/clarify decision --------------
# Jev owns the family SEMANTICS + probability distribution; this decides whether that evidence is
# strong enough to COMMIT the family (proceed) or too weak / too close to call (clarify). It reads
# ONLY the typed Jev evidence (provenance + probability distribution) — no customer text, no regex,
# no per-family thresholds, and no second semantic classifier (identitySufficiency) may override it.
#
# Thresholds were chosen from the observed first-turn family probability distribution across the
# ACTIVE GOLD corpus (26 grounded openers), to separate broad evidence classes rather than to fit
# any single benchmark case:
#   proceed-class inferred openers:  selected-family prob >= ~0.75, top-vs-runner-up margin >= ~0.58
#     (e.g. strong distinctive-symptom washing-machine / tumble-dryer / dishwasher inferences)
#   clarify / near-tie openers:      margin <= ~0.51, or a non-family (unknown/uncertain) argmax
#     (e.g. a bare "dishes hot but not dry", "motor runs drum doesn't turn", generic redirects)
# There is a real empirical gap in the margin (~0.51 -> ~0.58); the margin does the primary
# separation and the probability floor is a secondary guard. An explicit customer naming is trusted
# directly and never subjected to the probability/margin test.
FAMILY_PROCEED_MIN_CONFIDENCE = 0.70   # selected-family probability floor (inferred families)
FAMILY_PROCEED_MIN_MARGIN = 0.55       # required top-vs-runner-up separation (inferred families)

_NON_FAMILY_CHOICES = {"unknown", "uncertain", "none", "", None}


def token_meaning_decision(token_meaning, probabilities=None,
                           min_conf=FAMILY_PROCEED_MIN_CONFIDENCE, min_margin=FAMILY_PROCEED_MIN_MARGIN):
    """Whether Jev's MODEL reading of an identifier token is strong enough to COMMIT as the model.

    The same commit rule as the appliance family (below): the selected meaning must be both confident and
    decisively ahead of the runner-up. Returns ("commit" | "uncertain", detail). Only a model reading is gated:
    committing a wrong model silently discards a displayed error code, and the customer is never asked again.
    A missing distribution (older Jev) commits, as before. Deterministic; reads only Jev's typed output.
    """
    probs = probabilities if isinstance(probabilities, dict) else {}
    ordered = sorted(((k, float(v)) for k, v in probs.items() if isinstance(v, (int, float))), key=lambda kv: -kv[1])
    detail = {"meaning": token_meaning}
    if token_meaning != "model" or not ordered:
        detail["reason"] = "not_gated"
        return "commit", detail
    top, top_p = ordered[0]
    runner_up_p = ordered[1][1] if len(ordered) > 1 else 0.0
    detail.update({"top": top, "topP": round(top_p, 4), "margin": round(top_p - runner_up_p, 4)})
    if top == "model" and top_p >= min_conf and (top_p - runner_up_p) >= min_margin:
        detail["reason"] = "strong"
        return "commit", detail
    detail["reason"] = "weak_or_near_tie"
    return "uncertain", detail


def first_turn_family_decision(*, provenance, probabilities=None, confidence=None,
                               min_conf=FAMILY_PROCEED_MIN_CONFIDENCE,
                               min_margin=FAMILY_PROCEED_MIN_MARGIN):
    """Return (decision, detail) where decision is "proceed" or "clarify".

    provenance    — Jev applianceFamilyProvenance: customer_named | inferred | none | uncertain.
    probabilities — Jev probabilities.applianceFamily: {familyOrOutcome: prob}. The selected family
                    is the argmax; a non-family argmax (unknown/uncertain) is never committed.
    confidence    — Jev confidence.applianceFamily; only used as a fallback when no distribution is
                    supplied (older Jev responses).

    Deterministic, pure. No customer-language inspection.
    """
    probs = probabilities if isinstance(probabilities, dict) else {}
    ordered = sorted(((k, float(v)) for k, v in probs.items() if isinstance(v, (int, float))),
                     key=lambda kv: -kv[1])
    top, top_p = ordered[0] if ordered else (None, 0.0)
    runner_up, runner_up_p = ordered[1] if len(ordered) > 1 else (None, 0.0)
    margin = round(top_p - runner_up_p, 4)
    detail = {"top": top, "topP": round(top_p, 4), "runnerUp": runner_up,
              "runnerUpP": round(runner_up_p, 4), "margin": margin, "provenance": provenance}

    # 1. Explicit customer identification / correction: trust Jev's naming; no margin test.
    if provenance == "customer_named":
        detail["reason"] = "customer_named"
        return "proceed", detail

    # 2. No probability distribution available (older Jev): fall back to a confidence floor only.
    if not ordered:
        if isinstance(confidence, (int, float)) and confidence >= min_conf:
            detail["reason"] = "confidence_fallback"
            return "proceed", detail
        detail["reason"] = "no_distribution"
        return "clarify", detail

    # 3. A non-family argmax (unknown / uncertain) is never committed.
    if top in _NON_FAMILY_CHOICES:
        detail["reason"] = "no_family_argmax"
        return "clarify", detail

    # 4. Inferred family: proceed only when the selected family is BOTH confident and decisively
    #    ahead of the runner-up. Otherwise the evidence is weak or near-tied -> clarify consistently.
    if top_p >= min_conf and margin >= min_margin:
        detail["reason"] = "strong_inferred"
        return "proceed", detail
    detail["reason"] = "weak_or_near_tie"
    return "clarify", detail
