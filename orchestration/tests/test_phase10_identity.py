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

# GOLD-v2.3 G2-EC-02 (found by the new scenario): after the code meaning, the customer's symptom reached nobody and
# the same code answer was repeated. A latest turn that establishes a real symptom carries a symptom.
from orchestration.model import TurnInput
def loaded(decisions, error_code="F01"):
    ol = Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())
    ol.rag.understand = lambda **kw: {"jev": {"decisions": decisions}, "understand": {"errorCode": error_code, "applianceType": "tumble-dryer"}}
    return ol._load(TurnInput(message="x", sessionId="ec02", make="hotpoint"))
base = {"candidateTokenMeaning": "error_code", "userIntent": "EVIDENCE_UPDATE", "partReadiness": "diagnosis_only",
        "applianceFamily": "tumble-dryer", "applianceFamilyProvenance": "customer_named"}
check("code + a latest symptom report -> symptom present (code stays)", loaded({**base, "symptomFamily": "other", "latestTurnEstablishes": "symptom"})._sympt is True)
check("code + 'still showing the code' (error_display) -> code path only", loaded({**base, "symptomFamily": "error_display", "latestTurnEstablishes": "symptom"})._sympt is False)
check("code + an identity answer -> code path only", loaded({**base, "symptomFamily": "other", "latestTurnEstablishes": "identity"})._sympt is False)

# Post-release journey: "F06 <misspelt brand> washing machine" -> we ask code or model -> "that's ok, still error".
# The answer is about the token our question named; the code must not be asked for again.
check("our code-or-model question is recognised and names its token", routing.code_or_model_token(routing.code_or_model_question("F06")) == "F06")
check("any other reply names no token", routing.code_or_model_token("To look up F06 I just need the make") is None)
ol = Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())
ol.rag.understand = lambda **kw: {"jev": {"decisions": {"candidateTokenMeaning": "none", "symptomFamily": "error_display", "userIntent": "EVIDENCE_UPDATE",
                                                         "latestTurnEstablishes": "symptom", "applianceFamily": "washing-machine", "applianceFamilyProvenance": "customer_named"}},
                                  "understand": {"applianceType": "washing-machine"}}
st = ol._load(TurnInput(message="x", sessionId="carry", conversation=[{"role": "user", "content": "a"}, {"role": "assistant", "content": routing.code_or_model_question("F06")}, {"role": "user", "content": "b"}]))
check("the answer to our code-or-model question keeps the token as the displayed code", st.customer.displayedCode == "F06", st.customer.displayedCode)
check("...so the turn is not a 'what is the exact code?' intake", getattr(st, "_codePresentNoValue", False) is False)

# The engine shares the account's Lambda concurrency: one short retry on 429, never on other failures.
from orchestration.services import RealDiagnosticService as HttpDiagnosticService
class R:
    def __init__(self, code, text=""): self.status_code, self.text = code, text
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(f"HTTP {self.status_code}")
class FakeHttpx:
    def __init__(self, codes): self.codes, self.calls = list(codes), 0
    def post(self, *a, **k):
        self.calls += 1; return R(self.codes.pop(0), "ok")
svc = HttpDiagnosticService.__new__(HttpDiagnosticService); svc.url, svc.timeout = "http://x", 1
svc.THROTTLE_RETRY_S = 0
fx = FakeHttpx([429, 200]); check("429 then 200 -> retried once and succeeds", svc._post(fx, {}) == "ok" and fx.calls == 2)
fx = FakeHttpx([429, 429])
try:
    svc._post(fx, {}); ok = False
except RuntimeError:
    ok = fx.calls == 2
check("two 429s -> fails after one retry", ok)
fx = FakeHttpx([500, 200])
try:
    svc._post(fx, {}); ok = False
except RuntimeError:
    ok = fx.calls == 1
check("a 500 is not retried", ok)

print(f"\nPhase 10 identity: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
