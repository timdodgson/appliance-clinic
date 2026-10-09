"""GOLD v2: the open 'describe the problem' request is ONE question.

When the appliance is known but there is no code and no usable symptom yet, the orchestrator asks one open question
(the same one part-finder asks). It does not ask for a display code in the same breath or offer a menu of faults
(both scored as a generic form). The no-appliance variant is unchanged.
"""
import sys
from orchestration.model import ConversationState
from orchestration.orchestrator import Orchestrator
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

o = Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())

st = ConversationState(sessionId="open-known")
st.customer.appliance = "dishwasher"
r = o._flow_clarify(st, {})
msg = r.message or ""
check("appliance known -> exactly one question", msg.count("?") == 1, msg)
check("appliance known -> no display / code demand in the same question", "display" not in msg.lower() and "code" not in msg.lower(), msg)
check("appliance known -> one open question, no menu of faults", msg == "What is the main thing the dishwasher is doing wrong?", msg)
check("appliance known -> still an open SYMPTOM_DESCRIPTION request", (r.clarification or {}).get("intent") == "SYMPTOM_DESCRIPTION", r.clarification)

st2 = ConversationState(sessionId="open-unknown")
r2 = o._flow_clarify(st2, {})
check("appliance unknown -> still asks what appliance", "appliance" in (r2.message or "").lower(), r2.message)

print(f"\nOpen clarify question: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
