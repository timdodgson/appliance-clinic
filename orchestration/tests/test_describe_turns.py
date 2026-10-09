"""GOLD v2: describe-the-problem turns.

A question that only asks the customer to describe the problem asks for no physical step, so it carries no
owner-safety note; and the customer's answer to it is a symptom report, not a completed check, so it does not move
the journey to the model ask.
"""
import sys
from orchestration.model import ConversationState, OrchestratorResponse, Outcome
from orchestration.orchestrator import Orchestrator
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

o = Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore())

def state(appliance="dishwasher", exclusive=False, establishes=None, answered=None):
    st = ConversationState(sessionId="describe")
    st.customer.appliance = appliance
    st._ragExclusiveClarify = exclusive
    st._jev = {"decisions": {"latestTurnEstablishes": establishes, "answeredPrevious": answered}}
    return st

ask = lambda msg: OrchestratorResponse(route="", outcome=Outcome.ANSWER.value, message=msg)

# owner-safety note
check("vague-opener clarification (part-finder exclusive) -> no owner-safety note",
      o._owner_safety_note(state(exclusive=True), ask("What is the main thing the dishwasher is doing wrong?")) is None)
check("ordinary diagnostic answer for the same family -> note still carried",
      o._owner_safety_note(state(), ask("Check the filter at the bottom of the tub. Is it blocked?")) is not None)
desc = OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message="What is the main thing the dishwasher is doing wrong?",
                            clarification={"question": "x", "needs": ["description"], "intent": "SYMPTOM_DESCRIPTION"})
check("SYMPTOM_DESCRIPTION clarify -> no owner-safety note", o._owner_safety_note(state(), desc) is None)
disc = OrchestratorResponse(route="", outcome=Outcome.CLARIFICATION_REQUIRED.value, message="Is the water left in the bottom?",
                            clarification={"question": "x", "needs": ["symptom detail"], "intent": "SYMPTOM_DISCRIMINATOR"})
check("SYMPTOM_DISCRIMINATOR clarify -> note still carried", o._owner_safety_note(state(), disc) is not None)

# journey stage
check("answer to a describe question typed as a symptom -> still diagnosing, no model ask",
      o._journey_stage(state(establishes="symptom", answered="yes"), {}) == "DIAGNOSING")
check("answer typed as a check result -> model required after check",
      o._journey_stage(state(establishes="check_result", answered="yes"), {}) == "MODEL_REQUIRED_AFTER_CHECK")
check("pending check answered (not a symptom) -> model required after check",
      o._journey_stage(state(establishes="confirmation", answered="yes"), {}) == "MODEL_REQUIRED_AFTER_CHECK")

print(f"\nDescribe turns: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
