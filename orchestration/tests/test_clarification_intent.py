#!/usr/bin/env python3
"""Semantic clarification intent: pendingRequest must describe what the assistant ACTUALLY asked.

A generic/open clarification must NOT masquerade as a specific ERROR_CODE (or MODEL/MAKE/APPLIANCE)
request just because that field would also have been useful, or because "code" appears inside a
compound OR-need. Each clarify path declares ONE authoritative semantic intent; the pending slot is
derived from that intent, never by substring-scanning needs[].

Contract:
  SPECIFIC : ERROR_CODE | MODEL | MAKE | APPLIANCE | SYMPTOM_DISCRIMINATOR
  OPEN     : SYMPTOM_DESCRIPTION  (honest "describe the problem" request; no specific field claimed)

Run: python3 -m orchestration.tests.test_clarification_intent
"""
import sys
from orchestration import routing
from orchestration.model import (TurnInput, Outcome, Route, OrchestratorResponse,
                                  ConversationState)
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator, _with_safety_prefix
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

def orch():
    return Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())
def turn(o, msg, sid="s", **kw):
    return o.handle_turn(TurnInput(message=msg, sessionId=sid, latestMessage=kw.pop("latest", msg), **kw))
def slot(r):
    return (r.pendingRequest or {}).get("slot")

# ================= A. PRIMARY: warning symbol / generic open -> NOT ERROR_CODE ==================
# A bare warning symbol has no code semantics and no usable symptom -> OPEN description request.
o = orch()
r = turn(o, "there is a warning triangle on my dishwasher", appliance="dishwasher")
check("A1 warning triangle -> not ERROR_CODE", slot(r) != "ERROR_CODE", r.pendingRequest)
check("A2 warning triangle -> SYMPTOM_DESCRIPTION", slot(r) == "SYMPTOM_DESCRIPTION", r.pendingRequest)
check("A3 warning triangle -> open question, no code demand",
      "error code" not in (r.message or "").lower() and "?" in (r.message or ""), r.message)
# "something is wrong" (no symptom hint, no code) also lands on the open path.
o = orch()
r = turn(o, "something is wrong with my washing machine", appliance="washing machine")
check("A4 'something is wrong' -> not ERROR_CODE", slot(r) != "ERROR_CODE", r.pendingRequest)
check("A5 'something is wrong' -> SYMPTOM_DESCRIPTION", slot(r) == "SYMPTOM_DESCRIPTION", r.pendingRequest)
# bare, no appliance either
o = orch()
r = turn(o, "there's a problem with it")
check("A6 bare vague -> not ERROR_CODE", slot(r) != "ERROR_CODE", r.pendingRequest)
check("A7 bare vague -> SYMPTOM_DESCRIPTION + asks what appliance", slot(r) == "SYMPTOM_DESCRIPTION"
      and "appliance" in (r.message or "").lower(), r.message)

# ================= B. _pending_for INTENT AUTHORITY (unit) ======================================
o = orch()
def pend_for(clar, outcome=Outcome.CLARIFICATION_REQUIRED.value, code_status=None, displayed=None,
             modelRequired=False):
    st = ConversationState(sessionId="u"); st.resolved.codeStatus = code_status
    st.customer.displayedCode = displayed
    resp = OrchestratorResponse(route="", outcome=outcome, message="", clarification=clar,
                                modelRequired=modelRequired)
    return o._pending_for(st, resp)
check("B1 intent ERROR_CODE -> ERROR_CODE", pend_for({"intent": "ERROR_CODE", "needs": ["code"]})["slot"] == "ERROR_CODE")
check("B2 intent SYMPTOM_DESCRIPTION -> SYMPTOM_DESCRIPTION", pend_for({"intent": "SYMPTOM_DESCRIPTION", "needs": ["description"]})["slot"] == "SYMPTOM_DESCRIPTION")
check("B3 intent MAKE -> MAKE", pend_for({"intent": "MAKE", "needs": ["make", "appliance"]})["slot"] == "MAKE")
check("B4 intent APPLIANCE -> APPLIANCE", pend_for({"intent": "APPLIANCE", "needs": ["appliance"]})["slot"] == "APPLIANCE")
check("B5 intent SYMPTOM_DISCRIMINATOR -> SYMPTOM_DISCRIMINATOR", pend_for({"intent": "SYMPTOM_DISCRIMINATOR", "needs": ["symptom-detail"]})["slot"] == "SYMPTOM_DISCRIMINATOR")
check("B6 SYMPTOM_DESCRIPTION purpose is DIAGNOSIS", pend_for({"intent": "SYMPTOM_DESCRIPTION", "needs": ["description"]})["purpose"] == "DIAGNOSIS")

# ================= C. COMPOUND OR-NEEDS never collapse to a false concrete slot =================
# Legacy-style compound tokens with NO declared intent must NOT become ERROR_CODE via substring.
check("C1 ['make','appliance','code-or-symptom'] -> NOT ERROR_CODE",
      pend_for({"needs": ["make", "appliance", "code-or-symptom"]})["slot"] != "ERROR_CODE")
check("C2 ['code-or-symptom'] alone -> NOT ERROR_CODE (compound token)",
      pend_for({"needs": ["code-or-symptom"]})["slot"] != "ERROR_CODE")
check("C3 ['make','description'] -> NOT ERROR_CODE",
      pend_for({"needs": ["make", "description"]})["slot"] != "ERROR_CODE")
check("C4 ['model','description'] -> MODEL (genuine model need)",
      pend_for({"needs": ["model", "description"]})["slot"] == "MODEL")
# genuine specific single-field code need (e.g. MCP INVALID_INPUT) is STILL ERROR_CODE via fallback.
check("C5 exact ['code'] (no intent) -> ERROR_CODE", pend_for({"needs": ["code"]})["slot"] == "ERROR_CODE")

# ================= D. SPECIFIC REQUESTS preserved (integration) ==================================
# D1 genuine code-present/value-missing -> ERROR_CODE
o = orch()
r = turn(o, "my dishwasher is showing an error code", appliance="dishwasher")
check("D1 code present -> ERROR_CODE", slot(r) == "ERROR_CODE", r.pendingRequest)
# D2 code value present + no make/appliance -> MAKE (we have the code, need the brand/type)
o = orch()
r = turn(o, "E15", displayedCode="E15")
check("D2 code + missing make/appliance -> MAKE (not ERROR_CODE)", slot(r) == "MAKE", r.pendingRequest)
# D3 grounded fault, no model -> MODEL
o = orch()
r = turn(o, "my washing machine won't drain", make="bosch", appliance="washing machine")
check("D3 grounded fault -> MODEL", slot(r) == "MODEL", f"{r.pendingRequest} :: {r.message[:80]}")
# D4 vague-but-routed symptom, ungrounded -> SYMPTOM_DISCRIMINATOR
o = orch()
r = turn(o, "my washing machine is making a noise", make="bosch", appliance="washing machine")
check("D4 ungrounded symptom -> SYMPTOM_DISCRIMINATOR", slot(r) == "SYMPTOM_DISCRIMINATOR", r.pendingRequest)

# ================= E. ERROR-CODE INTAKE (prior task) still intact ===============================
o = orch()
r = turn(o, "my Bosch dishwasher E15", make="bosch", appliance="dishwasher", displayedCode="E15")
check("E1 code value present -> resolves, no clarify", r.outcome != Outcome.CLARIFICATION_REQUIRED.value
      or slot(r) not in ("ERROR_CODE", "SYMPTOM_DESCRIPTION"), f"{r.outcome}/{r.pendingRequest}")
o = orch()
r = turn(o, "my washing machine won't drain, no error code showing", make="bosch", appliance="washing machine")
check("E2 explicit no-code + symptom -> not ERROR_CODE", slot(r) != "ERROR_CODE", r.pendingRequest)
o = orch()
r = turn(o, "Sharp microwave shows a code and won't start", make="sharp", appliance="microwave")
check("E3 code-present intake -> ERROR_CODE (unchanged)", slot(r) == "ERROR_CODE", r.pendingRequest)

# ================= F. OPEN-DESCRIPTION ANSWER PROGRESSES ========================================
# open request this turn, then the customer describes a real symptom next turn -> diagnosis proceeds
o = orch()
turn(o, "something is wrong with my dishwasher", sid="P", appliance="dishwasher")
r2 = turn(o, "something is wrong with my dishwasher. it won't drain", sid="P", appliance="dishwasher",
          latest="it won't drain")
check("F1 open -> drain symptom progresses (not stuck on open/ERROR_CODE)",
      slot(r2) != "SYMPTOM_DESCRIPTION" and slot(r2) != "ERROR_CODE", f"{r2.pendingRequest} :: {r2.message[:80]}")
# open request, then an explicit code arrives -> code recognised (open must not suppress it)
o = orch()
turn(o, "there is a warning triangle on my bosch dishwasher", sid="Q", make="bosch", appliance="dishwasher")
r2 = turn(o, "there is a warning triangle on my bosch dishwasher. E15", sid="Q", make="bosch",
          appliance="dishwasher", displayedCode="E15", latest="E15")
check("F2 open -> explicit E15 recognised", (r2.codeResult and r2.codeResult.displayed == "E15")
      or "anti-flood" in (r2.message or "").lower(), f"{r2.codeResult} :: {r2.message[:80]}")

# ================= G. MUTATION PROOFS ===========================================================
check("G1 MUTATION: compound 'code-or-symptom' must not be ERROR_CODE",
      pend_for({"needs": ["make", "appliance", "code-or-symptom"]})["slot"] != "ERROR_CODE")
check("G2 MUTATION: OPEN intent must not be ERROR_CODE",
      pend_for({"intent": "SYMPTOM_DESCRIPTION", "needs": ["description"]})["slot"] != "ERROR_CODE")
check("G3 MUTATION: genuine CODE_VALUE_MISSING still maps to ERROR_CODE",
      turn(orch(), "my dishwasher is showing an error code", appliance="dishwasher").pendingRequest.get("slot") == "ERROR_CODE")
check("G4 MUTATION: genuine model request stays MODEL (not open description)",
      slot(turn(orch(), "my washing machine won't drain", make="bosch", appliance="washing machine")) == "MODEL")
check("G5 MUTATION: warning triangle must NOT be ERROR_CODE",
      slot(turn(orch(), "there is a warning triangle on my dishwasher", appliance="dishwasher")) != "ERROR_CODE")
check("G6 SYMPTOM_DESCRIPTION is a registered pending slot", "SYMPTOM_DESCRIPTION" in routing.PENDING_SLOTS)

# ================= H. SOURCE GUARDS =============================================================
import os as _os
_orch = open(_os.path.join(_os.path.dirname(__file__), "..", "orchestrator.py")).read()
_routing = open(_os.path.join(_os.path.dirname(__file__), "..", "routing.py")).read()
def _codeblob(src): return "\n".join(l for l in src.splitlines() if not l.strip().startswith("#")).lower()
ob, rb = _codeblob(_orch), _codeblob(_routing)
check("H1 no warning-triangle special-case", "triangle" not in ob and "triangle" not in rb)
check("H2 no journey ids", not any(j in ob for j in ("fp-triangle", "mw-006", "wm-008")))
check("H3 no assistant-prose parsing for intent",
      "previousassistant" not in ob and "lastassistant" not in ob and ".includes(" not in ob)
check("H4 no LLM/frontier in the clarification layer", not any(s in ob for s in ("openai", "lmstudio", "anthropic")))
check("H5 intent is structural (authoritative map present)", "_intent_pending" in ob)

# Ungrounded does not mean "no useful advice": a generic diagnosis that does not lock a family
# must still reach the customer.
o = orch()
st = ConversationState(sessionId="u")
r = o._compose_symptoms_only(st, {
    "grounded": False,
    "clarifyingQuestion": "Could you describe the problem in a bit more detail?",
    "reply": "This still points at a drainage or pump path. The accessible trap being clear is useful. Next, notice whether the pump hums when it should empty.",
    "media": [{"id": "wm-pump-filter", "type": "DIAGRAM", "title": "Pump filter"}],
    "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False},
    "confidence": 0.55,
    "candidateComponents": [],
})
check("I1 ungrounded generic advice is surfaced", "drainage" in (r.message or "").lower(), r.message)
check("I2 ungrounded generic advice is not the describe-more fallback",
      "describe the problem" not in (r.message or "").lower(), r.message)
check("I5 ungrounded current-action media still reaches the customer",
      isinstance(r.media, list) and r.media[0]["id"] == "wm-pump-filter", r.media)

o = orch()
st = ConversationState(sessionId="u")
r = o._compose_symptoms_only(st, {
    "grounded": True,
    "faultLabel": None,
    "confidence": 0.4,
    "reply": "Thanks for confirming the model. Next we should look at the next likely leak path rather than repeating the filter check.",
    "clarifyingQuestion": None,
    "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False},
    "candidateComponents": [],
})
check("I3 grounded with no faultLabel does not crash", bool(r.message), r.message)

# J. rating-plate confirmation keeps diagnostic prose; identity is not "missing"
o = orch()
st = ConversationState(sessionId="u")
st._image = "data:image/jpeg;base64,xx"
r = o._compose_symptoms_only(st, {
    "grounded": True,
    "faultLabel": "electrical trip",
    "confidence": 0.72,
    "reply": "This is likely an earth-leakage path. The most useful next check is when in the cycle it trips — as soon as it starts, once it has been running, or on a later stage. What is the make and model?",
    "resolvedModel": "ABC123",
    "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False},
    "safetyInformation": {"text": "Stop using a machine that trips the electrics.", "classification": "STOP_USE"},
    "candidateComponents": ["heater"],
    "componentMention": "discuss",
})
check("J1 OCR turn keeps diagnostic prose", "earth-leakage" in (r.message or "").lower(), r.message)
check("J2 OCR turn asks to confirm the extracted model", "ABC123" in (r.message or "") and "is that correct" in (r.message or "").lower(), r.message)
check("J3 OCR turn does not promise an exact part", "exact part" not in (r.message or "").lower(), r.message)
check("J4 extracted model is confirmation, not a missing-model prompt", r.modelRequired is False, r.modelRequired)
check("J5 image extraction status is unconfirmed", (r.imageExtraction or {}).get("status") == "IMAGE_EXTRACTED_UNCONFIRMED")
check("J6 unanswered discriminator is still in the customer-facing message", "when in the cycle" in (r.message or "").lower(), r.message)

check("K1 structured safety information is not duplicated into the prose",
      _with_safety_prefix("hello", {"message": "Stop using it now."}, {"text": "Stop using it."}) == "hello")
check("K2 safety prefix still applies when no structured block is present",
      _with_safety_prefix("hello", {"message": "Stop using it now."}, None).startswith("Stop using it now."))

from orchestration.routing import _cue_appliance
check("K3 drum tumbling is not a tumble dryer", _cue_appliance("It fills and tumbles then the electrics trip") != "tumble-dryer")
check("K4 the wash still cues a washing machine", _cue_appliance("part way through the wash") == "washing-machine")
check("K5 tumble dryer wording is unchanged", _cue_appliance("my tumble dryer will not heat") == "tumble-dryer")

print(f"\nSemantic clarification intent: {passed} passed / {failed} failed  (total {passed+failed})")
sys.exit(1 if failed else 0)
