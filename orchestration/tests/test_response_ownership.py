#!/usr/bin/env python3
"""Response ownership under ADR 0018 (deterministic, FakeErrorCodeService + FakeDiagnosticService).

Who authors each AC reply when no canonical journey owns the turn:
  - a displayed code's meaning is the Error-Code MCP's (ADR 0015): resolved -> its meaning; unresolved -> what would
    settle it (the model), never a meaning invented elsewhere;
  - a symptom alongside a code is not diagnosed by another path (the legacy diagnosis is never called);
  - safety leads every reply it applies to;
  - more context (the model) advances the MCP lookup.

No network / no LLM / no real RAG. Run: python3 -m orchestration.tests.test_response_ownership
"""
import sys
from orchestration.model import TurnInput, ObservedIdentifier, Outcome, Route, Trust
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService
from orchestration.orchestrator import Orchestrator
from orchestration.tests.cs1_bff import FakeBff
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

DIAG_CALLS = []
_fake_diagnose = FakeDiagnosticService.diagnose
def _recording_diagnose(self, **kw):
    DIAG_CALLS.append(kw)
    return _fake_diagnose(self, **kw)
FakeDiagnosticService.diagnose = _recording_diagnose

def orch():
    return FakeBff(Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService()))

def turn(o, msg, sid="s", **kw):
    DIAG_CALLS.clear()
    return o.handle_turn(TurnInput(message=msg, sessionId=sid, **kw))

print("=== RESPONSE OWNERSHIP (ADR 0018, fake services) ===")

# A. Unresolved code (NEEDS_CONTEXT) + a symptom: the MCP owns the reply; nothing diagnoses the symptom another way.
r = turn(orch(), "My Bosch washing machine shows F06 and it won't drain")
check("A route is the error-code path", r.route == Route.ERROR_CODE.value, r.route)
check("A the MCP asks what would settle the code (the model)", r.outcome == Outcome.CLARIFICATION_REQUIRED.value
      and "model" in (r.message or "").lower(), f"{r.outcome}/{(r.message or '')[:120]}")
check("A no diagnosis call, no diagnosis, no parts", not DIAG_CALLS and r.diagnosis is None and not r.parts,
      f"{len(DIAG_CALLS)}/{r.diagnosis}")
check("A the unresolved state is kept and no meaning is invented", r.codeResult is not None
      and r.codeResult.status == "NEEDS_CONTEXT" and r.codeResult.meaning is None, f"{r.codeResult}")

# B. Resolved code: the authoritative meaning leads.
r = turn(orch(), "My Bosch dishwasher is showing E15")
check("B resolved code ANSWER + meaning", r.outcome == Outcome.ANSWER.value
      and "means" in (r.message or "").lower() and (r.codeResult.meaning or ""), f"{r.outcome}")
check("B resolved meaning is L1", r.provenance.get("meaning") == Trust.L1_DETERMINISTIC.value)

# C. AMBIGUOUS code + a symptom: the MCP's documented meanings, no meaning picked, no other diagnosis.
r = turn(orch(), "My Haier washing machine shows E1 and it won't drain")
check("C ambiguous code -> AMBIGUOUS from the MCP, no diagnosis call", r.outcome == Outcome.AMBIGUOUS.value
      and not DIAG_CALLS and r.diagnosis is None, f"{r.outcome}")
check("C ambiguous state preserved, meaning not invented", r.codeResult is not None
      and r.codeResult.status == "AMBIGUOUS" and r.codeResult.meaning is None, f"{r.codeResult}")

# D. Code without make -> the intake question.
r = turn(orch(), "it's showing F06")
check("D code without make -> CLARIFY", r.route == Route.CLARIFY.value
      and r.outcome == Outcome.CLARIFICATION_REQUIRED.value, f"{r.route}/{r.outcome}")

# E. Safety leads: an unresolved code + a gas smell is the gas stop, with no parts.
r = turn(orch(), "My Bosch washing machine shows F06 and there's a smell of gas")
check("E gas stop leads", r.outcome == Outcome.SAFETY_STOP.value
      and "national gas" in (r.message or "").lower(), f"{r.outcome}/{(r.message or '')[:80]}")
check("E no parts on a safety stop", not r.parts)

# F. Unknown code + a symptom: NOT_FOUND names the customer's code; no meaning, no other diagnosis.
r = turn(orch(), "My Bosch washing machine shows ZZ99 and it won't drain")
check("F unknown code -> NOT_FOUND, code kept, no meaning", r.outcome == Outcome.NOT_FOUND.value
      and r.codeResult is not None and r.codeResult.meaning is None and "zz99" in (r.message or "").lower(),
      f"{r.outcome}/{(r.message or '')[:120]}")
check("F no diagnosis call", not DIAG_CALLS and r.diagnosis is None)

# G. Multi-turn: the model supplied next turn resolves the code (cs/1 carries it).
o = orch()
turn(o, "My Bosch washing machine shows F06 and it won't drain", sid="mt")
r2 = turn(o, "the rating plate says WGG244FCGB/01", sid="mt", observed=[ObservedIdentifier("E_NR", "WGG244FCGB/01")])
check("G model supplied -> the code resolves", r2.outcome == Outcome.ANSWER.value
      and "temperature" in (r2.codeResult.meaning or "").lower(), f"{r2.outcome}/{r2.codeResult}")

print(f"\nResponse-ownership tests: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
