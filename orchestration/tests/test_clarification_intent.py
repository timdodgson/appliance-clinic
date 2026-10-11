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
from orchestration.model import (TurnInput, Outcome, Route, OrchestratorResponse,
                                  ConversationState)
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService
from orchestration.orchestrator import Orchestrator
from orchestration.tests.cs1_bff import FakeBff
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

class TypedProblemRag(FakeDiagnosticService):
    """The fake understanding plus the mc/1 problem journey value a real classifier types for a described symptom."""
    def understand(self, **kw):
        res = super().understand(**kw)
        if res["understand"].get("fault"):
            res["understand"]["_problemJourney"] = "dw-not-draining"
        return res

def orch(rag=None):
    return FakeBff(Orchestrator(FakeErrorCodeService(CANNED), rag or FakeDiagnosticService()))
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
# The code value comes from Jev or cs/1 (never a TurnInput field), so this is driven on the clarify flow directly.
st = ConversationState(sessionId="d2"); st.customer.displayedCode = "E15"
r = o._flow_clarify(st, {})
check("D2 code + missing make/appliance -> MAKE (not ERROR_CODE)", o._pending_for(st, r)["slot"] == "MAKE", r.clarification)
st.customer.make = "bosch"; r = o._flow_clarify(st, {})
check("D2b code + make known, appliance missing -> APPLIANCE", o._pending_for(st, r)["slot"] == "APPLIANCE", r.clarification)

# ================= E. ERROR-CODE INTAKE (prior task) still intact ===============================
o = orch()
r = turn(o, "my Bosch dishwasher E15", make="bosch", appliance="dishwasher", displayedCode="E15")
check("E1 code value present -> resolves, no clarify", r.outcome != Outcome.CLARIFICATION_REQUIRED.value
      or slot(r) not in ("ERROR_CODE", "SYMPTOM_DESCRIPTION"), f"{r.outcome}/{r.pendingRequest}")
o = orch()
r = turn(o, "my washing machine won't drain, no error code showing", make="bosch", appliance="washing machine")
check("E2 explicit no-code + symptom -> not ERROR_CODE", slot(r) != "ERROR_CODE", r.pendingRequest)
o = orch()
r = turn(o, "my Sharp microwave is showing a code", make="sharp", appliance="microwave")
check("E3 code-present intake (no value) -> ERROR_CODE", slot(r) == "ERROR_CODE", r.pendingRequest)

# ================= F. OPEN-DESCRIPTION ANSWER PROGRESSES ========================================
# open request this turn, then the customer describes a real symptom next turn -> the conversation moves on (here no
# journey is allow-listed, so the typed problem gets the explicit not-supported reply, never the same open question)
o = orch(TypedProblemRag())
turn(o, "something is wrong with my dishwasher", sid="P", appliance="dishwasher")
r2 = turn(o, "something is wrong with my dishwasher. it won't drain", sid="P", appliance="dishwasher",
          latest="it won't drain")
check("F1 open -> described symptom moves on (not stuck on open/ERROR_CODE)",
      slot(r2) != "SYMPTOM_DESCRIPTION" and slot(r2) != "ERROR_CODE" and r2.outcome == Outcome.UNSUPPORTED.value,
      f"{r2.outcome} {r2.pendingRequest} :: {r2.message[:80]}")
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
check("G5 MUTATION: warning triangle must NOT be ERROR_CODE",
      slot(turn(orch(), "there is a warning triangle on my dishwasher", appliance="dishwasher")) != "ERROR_CODE")
check("G6 SYMPTOM_DESCRIPTION is a registered pending slot",
      Orchestrator._INTENT_PENDING.get("SYMPTOM_DESCRIPTION") == ("SYMPTOM_DESCRIPTION", "DIAGNOSIS"))

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

print(f"\nSemantic clarification intent: {passed} passed / {failed} failed  (total {passed+failed})")
sys.exit(1 if failed else 0)
