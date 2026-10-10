"""Phase 10 regressions from real transcripts (docs/evaluation/phase-10-transcript-findings.md F8-F11, ADR 0016).

Each case reproduces the shape of a real failure with typed state; no customer text is copied.
  F8   a bare displayed code read by Jev as a weak MODEL was committed as the model and the code was lost
  F9   the identity clarify asked for the brand AND type although the type was known, and repeated itself
  F10  the code answer printed catalogue fragments ("Possible causes include stuck / not confirmed") and stopped
  F11  the code answer carried an owner precaution for a step it never gave
  0016 a canonical turn whose diagnose call failed still handed its advanced state back for persistence
"""
import sys
from orchestration import routing
from orchestration.model import ConversationState, OrchestratorResponse, Outcome
from orchestration.orchestrator import Orchestrator
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore, RagUnavailable
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

o = Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())

# F8: the token commit rule (same thresholds as the family gate)
weak_a = {"model": 0.72, "uncertain": 0.18, "error_code": 0.02, "none": 0.05, "other": 0.03}
weak_b = {"model": 0.60, "uncertain": 0.27, "error_code": 0.08, "none": 0.03, "other": 0.02}
strong = {"model": 0.97, "uncertain": 0.02, "error_code": 0.01}
check("weak model reading (0.72 vs 0.18) is not committed", routing.token_meaning_decision("model", weak_a)[0] == "uncertain")
check("weak model reading (0.60 vs 0.27) is not committed", routing.token_meaning_decision("model", weak_b)[0] == "uncertain")
check("a clear model reading is committed", routing.token_meaning_decision("model", strong)[0] == "commit")
check("an error-code reading is never gated", routing.token_meaning_decision("error_code", {"error_code": 0.5, "model": 0.4})[0] == "commit")
check("no distribution (older Jev) commits as before", routing.token_meaning_decision("model", None)[0] == "commit")

def st_with(**kw):
    st = ConversationState(sessionId="p10")
    for k, v in kw.items():
        setattr(st.customer, k, v) if hasattr(st.customer, k) else setattr(st, k, v)
    st._jev = {"decisions": {}}
    return st

# F8: the clarify asks which it is
st = st_with(appliance="tumble-dryer", make="hotpoint", _uncertainToken="F01", _tokenDecision={"reason": "weak_or_near_tie"})
r = o._flow_clarify(st, {})
check("uncertain identifier -> asks code or model, naming the token", "F01" in r.message and "display" in r.message and "model number" in r.message, r.message)
check("...as one question", r.message.count("?") == 1, r.message)
check("...with a non-model pending slot", o._pending_for(st, r) == {"slot": "IDENTIFIER", "purpose": "DISAMBIGUATION", "status": "PENDING"}, o._pending_for(st, r))

# F9: only the missing field, and no word-for-word repeat
st = st_with(appliance="washing-machine", make=None, displayedCode="F06")
r = o._flow_clarify(st, {})
check("code known, type known -> asks only for the make", "make" in r.message and "dishwasher" not in r.message and "F06" in r.message, r.message)
st2 = st_with(appliance="washing-machine", make=None, displayedCode="F06", _conversation=[{"role": "user", "content": "x"}, {"role": "assistant", "content": r.message}])
r2 = o._flow_clarify(st2, {})
check("the same question last turn and still no make -> a different reply that says why", r2.message != r.message and "different brands" in r2.message, r2.message)
st3 = st_with(appliance=None, make="hotpoint", displayedCode="F06")
check("code known, make known -> asks only for the type", "type" in o._flow_clarify(st3, {}).message and "brand" not in o._flow_clarify(st3, {}).message)

# F10 / F11: readable meaning, a next step, no fragments, no owner precaution
mcp = {"status": "RESOLVED", "recordType": "FAULT", "meaning": "Door lock / interlock fault (door stuck / not confirmed)",
       "code": {"input": "F06"}, "enrichment": {"likelyCauses": ["stuck / not confirmed"], "checks": []}}
st = st_with(appliance="washing-machine", make="hotpoint", displayedCode="F06")
st._codeOnlyAnswer = False
r = o._compose_code_only(st, mcp)
check("code meaning stated with a capitalised make", r.message.startswith("F06 on your Hotpoint washing machine means: Door lock"), r.message)
check("catalogue fragments are not printed", "Possible causes include" not in r.message and "stuck / not confirmed." not in r.message.split("means:")[1].split(".")[1], r.message)
check("the reply gives a next step", "narrow it down" in r.message, r.message)
check("code-only answer carries no owner precaution", o._owner_safety_note(st, r) is None)

# ADR 0016: a failed diagnose does not hand back an advanced canonical state
class DownRag(FakeDiagnosticService):
    def diagnose(self, **kw):
        raise RagUnavailable("down")
od = Orchestrator(FakeErrorCodeService(CANNED), DownRag(), InMemoryStateStore())
st = st_with(appliance="washing-machine")
debug = {"latencies": {}, "canonical": {"schema": "cs/1", "version": 3, "state": {}}}
r = od._flow_canonical(st, {"key": "wm-not-draining", "nextAction": {"kind": "ask_check"}}, debug)
check("diagnose failure -> service unavailable", r.outcome == Outcome.SERVICE_UNAVAILABLE.value, r.outcome)
check("...and the canonical result is marked degraded (the BFF will not persist it)", debug["canonical"].get("degraded") == "diagnose_unavailable", debug["canonical"])

print(f"\nPhase 10 identity: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
