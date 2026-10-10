"""ADR 0014: cs/1 is the only conversation state. The orchestrator starts every turn from the request (the BFF's
persisted cs/1 block plus the transcript) and keeps nothing between invocations.

State transitions, each with typed fakes (no customer text copied, no phrase matching):
  volunteered facts, "not sure", corrections, code-vs-model clarification, identity progression,
  a failed turn that must not advance state, and no container affinity (two instances, one answer).
"""
import copy, sys
from orchestration import routing
from orchestration.model import TurnInput, Outcome
from orchestration.orchestrator import Orchestrator
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, RagUnavailable
from orchestration.tests.cs1_bff import FakeBff, cs1_state, block
from orchestration.tests.fixtures import CANNED

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))


class Scripted(FakeDiagnosticService):
    """Jev UNDERSTAND scripted per latest customer turn; diagnose() is the deterministic fake."""
    def __init__(self, script, fail_diagnose=False):
        self.script, self.fail_diagnose = script, fail_diagnose

    def understand(self, *, symptoms, image=None, conversation=None, established=None, canonical=None):
        latest = routing.customer_speech(symptoms).split("\n")[-1] if "Customer:" in symptoms else symptoms
        latest = latest.replace("Customer:", "").strip()
        sp = self.script.get(latest, {})
        raw = {"onTopic": True, "userIntent": sp.get("userIntent", "NEW_PROBLEM"), "make": sp.get("make"),
               "model": sp.get("model"), "applianceType": sp.get("appliance"), "fault": sp.get("fault"),
               "errorCode": sp.get("code"), "modelUnavailable": False, "reportedSymptoms": [sp["fault"]] if sp.get("fault") else [],
               "checksReported": [], "facts": [], "declinedFacts": [], "_tokenMeaning": sp.get("token", "none"),
               "_applianceFamilyProvenance": sp.get("provenance", "customer_named" if sp.get("appliance") else "none"),
               "newEvidenceThisTurn": latest}
        dec = {"onTopic": True, "applianceFamily": sp.get("appliance") or "unknown", "symptomFamily": sp.get("symptomFamily", "none"),
               "candidateTokenMeaning": sp.get("token", "none"), "latestTurnEstablishes": sp.get("establishes", "symptom"),
               "userIntent": raw["userIntent"], "partReadiness": "diagnosis_only", "safetySignificance": sp.get("safety", "none"),
               "applianceFamilyProvenance": raw["_applianceFamilyProvenance"]}
        probs = {"candidateTokenMeaning": sp["tokenProbs"]} if sp.get("tokenProbs") else {}
        probs["applianceFamily"] = {sp["appliance"]: 0.95} if sp.get("appliance") else {"unknown": 0.9}
        return {"jev": {"decisions": dec, "probabilities": probs, "confidence": {"applianceFamily": 0.95 if sp.get("appliance") else 0.2}},
                "understand": raw}

    def diagnose(self, **kw):
        if self.fail_diagnose:
            raise RagUnavailable("down")
        return super().diagnose(**{k: v for k, v in kw.items() if k != "canonical"})


def transcript(turns):
    return "\n".join(f"Customer: {t}" for t in turns)


def play(o, turns, sid):
    resp = None
    for i in range(len(turns)):
        resp = o.handle_turn(TurnInput(message=transcript(turns[:i + 1]), sessionId=sid, latestMessage=turns[i]))
    return resp, o.last_state


# 1. volunteered facts: make, appliance and code in one message are all held by cs/1 and seed the next turn
T = ["hotpoint washing machine showing F06", "what does that mean"]
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({
    T[0]: {"appliance": "washing-machine", "make": "hotpoint", "code": "F06", "token": "error_code", "symptomFamily": "error_display"},
    T[1]: {"userIntent": "CLARIFICATION", "establishes": "question"}})))
play(o, T, "v1")
s = o.state("v1")
check("volunteered facts are all in cs/1", s["identity"]["make"]["value"] == "hotpoint" and s["identity"]["appliance"]["value"] == "washing-machine"
      and s["identity"]["displayedCodes"][-1]["value"] == "F06", s["identity"])
c = o.last_state.customer
check("...and seed the next turn (make, appliance, code)", (c.make, c.appliance, c.displayedCode) == ("hotpoint", "washing-machine", "F06"),
      (c.make, c.appliance, c.displayedCode))

# 2. not sure: a cannot-answer turn keeps identity and problem and invents nothing
T = ["my bosch dishwasher won't drain", "not sure"]
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({
    T[0]: {"appliance": "dishwasher", "make": "bosch", "fault": "not draining", "symptomFamily": "not_draining"},
    T[1]: {"userIntent": "CANNOT_ANSWER", "establishes": "cannot_answer"}})))
play(o, T, "n1")
c = o.last_state.customer
check("'not sure' keeps the identity from cs/1", (c.make, c.appliance) == ("bosch", "dishwasher"), (c.make, c.appliance))
check("...and the problem", c.symptomsText and "won't drain" in c.symptomsText, c.symptomsText)
check("...and invents no code or model", c.displayedCode is None and not c.observed, (c.displayedCode, c.observed))

# 3. corrections: an explicit correction replaces an established family; a token re-read as the model drops the code
T = ["my washing machine won't spin", "sorry, it's actually the dishwasher"]
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({
    T[0]: {"appliance": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning"},
    T[1]: {"appliance": "dishwasher", "userIntent": "CORRECTION", "establishes": "correction"}})))
play(o, T, "c1")
check("a correction replaces the established family", o.last_state.customer.appliance == "dishwasher"
      and o.state("c1")["identity"]["appliance"]["value"] == "dishwasher", o.last_state.customer.appliance)
o = Orchestrator(FakeErrorCodeService(CANNED), Scripted({"WAN28281GB is the model": {
    "appliance": "washing-machine", "model": "WAN28281GB", "token": "model", "establishes": "identity"}}))
st = o._load(TurnInput(message="WAN28281GB is the model", sessionId="c2",
                       canonical=block(cs1_state(appliance="washing-machine", establishment="established", codes=["WAN28281GB"]))))
check("a code token re-read as the model clears the code", st.customer.displayedCode is None
      and any(x.value == "WAN28281GB" for x in st.customer.observed), (st.customer.displayedCode, st.customer.observed))

# 4. code vs model: a weak model reading is not committed; the answer to our question keeps the token as the code
T = ["F06 hotpint washing machine"]
weak = {"model": 0.62, "uncertain": 0.27, "error_code": 0.08, "none": 0.03}
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({
    T[0]: {"appliance": "washing-machine", "model": "F06", "token": "model", "tokenProbs": weak}})))
r, st = play(o, T, "m1")
check("a weak model reading is not committed (to cs/1 or the turn)", not st.customer.observed
      and not o.state("m1")["identity"]["model"].get("value"), (st.customer.observed, o.state("m1")["identity"]["model"]))
check("...and the reply asks which it is, naming the token", r.message == routing.code_or_model_question("F06"), r.message)

# 4b. the real post-release shape: a code with a misspelt brand, then "still the error" (Phase 11 D2)
# (the fake merge stands in for mc/1, which now offers the near-miss brand; Jev accepts it as the make)
T = ["F06 Horpint Washing Machine", "thats ok still error"]
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({
    T[0]: {"appliance": "washing-machine", "model": "F06", "token": "model", "tokenProbs": weak, "make": "hotpoint"},
    T[1]: {"token": "error_code", "symptomFamily": "error_display", "establishes": "symptom",
           "tokenProbs": {"model": 0.05, "error_code": 0.47, "uncertain": 0.48}}})))
r1, _ = play(o, T[:1], "m2")
check("D2 turn 1: the held token gets the one code-or-model question", r1.message == routing.code_or_model_question("F06"), r1.message)
check("D2 turn 1: cs/1 holds the token and the make, and no model", o.state("m2")["identity"]["unconfirmedToken"]["value"] == "F06"
      and o.state("m2")["identity"]["make"]["value"] == "hotpoint" and not o.state("m2")["identity"]["model"]["value"], o.state("m2")["identity"])
r2, st = play(o, T, "m3")
c = st.customer
check("D2 turn 2: the answer commits the token as the displayed code", c.displayedCode == "F06", c.displayedCode)
check("D2 turn 2: the make comes from cs/1, so it is not asked again", c.make == "hotpoint" and "brand" not in (r2.message or "").lower()
      and "make" not in (r2.message or "").lower(), (c.make, r2.message))
check("D2 turn 2: the make from cs/1 is forwarded to the engine (it never asks for it again)", (st._understand or {}).get("make") == "hotpoint",
      (st._understand or {}).get("make"))
check("D2 turn 2: cs/1 records the code and clears the token", [f["value"] for f in o.state("m3")["identity"]["displayedCodes"] if f["status"] == "active"] == ["F06"]
      and not o.state("m3")["identity"]["unconfirmedToken"]["value"], o.state("m3")["identity"])

# 4c. obvious code and obvious model: no question
for name, spec, want in (("E15 bosch dishwasher", {"appliance": "dishwasher", "make": "bosch", "code": "E15", "token": "error_code",
                                                    "symptomFamily": "error_display"}, "code"),
                         ("bosch washing machine WAN28281GB", {"appliance": "washing-machine", "make": "bosch", "model": "WAN28281GB", "token": "model",
                                                               "tokenProbs": {"model": 1.0, "uncertain": 0.0}}, "model")):
    o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({name: spec})))
    r, st = play(o, [name], "o-" + want)
    ok = (st.customer.displayedCode == "E15") if want == "code" else any(x.value == "WAN28281GB" for x in st.customer.observed)
    check(f"an obvious {want} is committed with no code-or-model question", ok and r.message != routing.code_or_model_question(name.split()[0]),
          (st.customer.displayedCode, st.customer.observed, r.message))

# 5. identity progression across turns: appliance -> make -> model, read from cs/1 each turn
T = ["my washer is leaking", "it's a Beko", "the model is WTG841B2W"]
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), Scripted({
    T[0]: {"appliance": "washing-machine", "fault": "leaking", "symptomFamily": "leaking"},
    T[1]: {"make": "beko", "establishes": "identity", "userIntent": "ADDING_DETAIL"},
    T[2]: {"model": "WTG841B2W", "token": "model", "establishes": "identity", "userIntent": "ADDING_DETAIL"}})))
play(o, T, "i1")
c = o.last_state.customer
check("identity progresses: appliance and make from cs/1, model this turn",
      (c.appliance, c.make) == ("washing-machine", "beko") and any(x.value == "WTG841B2W" for x in c.observed), (c.appliance, c.make, c.observed))
check("cs/1 ends with the confirmed model", o.state("i1")["identity"]["modelStatus"] == "known", o.state("i1")["identity"]["modelStatus"])

# 6. a failed turn does not advance state: cs/1 stays at the previous version and the orchestrator kept nothing
T = ["my bosch dishwasher won't drain", "still the same"]
rag = Scripted({T[0]: {"appliance": "dishwasher", "make": "bosch", "fault": "not draining", "symptomFamily": "not_draining"},
                T[1]: {"appliance": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining", "userIntent": "EVIDENCE_UPDATE"}})
o = FakeBff(Orchestrator(FakeErrorCodeService(CANNED), rag))
play(o, T[:1], "d1")
before = copy.deepcopy(o.state("d1"))
rag.fail_diagnose = True
r = o.handle_turn(TurnInput(message=transcript(T), sessionId="d1", latestMessage=T[1]))
check("a failed diagnose is a service-unavailable turn", r.outcome == Outcome.SERVICE_UNAVAILABLE.value, r.outcome)
check("...and cs/1 is not advanced", o.state("d1") == before, (o.state("d1") or {}).get("version"))
check("...and the orchestrator holds no state of its own", not hasattr(o._o, "store"))

# 7. no container affinity: two instances given the same request and cs/1 decide identically
prior = cs1_state(appliance="dishwasher", establishment="established", make="bosch", problem=True, model_status="unavailable")
msg = "Customer: my bosch dishwasher won't drain\nCustomer: still the same"
sc = {"still the same": {"appliance": "dishwasher", "symptomFamily": "not_draining", "userIntent": "EVIDENCE_UPDATE"}}
a = Orchestrator(FakeErrorCodeService(CANNED), Scripted(sc)).handle_turn(TurnInput(message=msg, sessionId="x", canonical=block(prior)))
b_o = Orchestrator(FakeErrorCodeService(CANNED), Scripted(sc))
b_o.handle_turn(TurnInput(message="my oven smells of gas", sessionId="x"))   # unrelated earlier traffic on this instance
b = b_o.handle_turn(TurnInput(message=msg, sessionId="x", canonical=block(prior)))
check("two instances, same cs/1 -> same route, outcome and reply", (a.route, a.outcome, a.message) == (b.route, b.outcome, b.message),
      ((a.route, a.outcome), (b.route, b.outcome)))
st = Orchestrator(FakeErrorCodeService(CANNED), Scripted(sc))._load(TurnInput(message=msg, sessionId="x", canonical=block(prior)))
check("model status 'unavailable' is read from cs/1", st.customer.modelUnavailable is True)
check("a corrected hazard is not re-applied: the active safety level is cs/1's", st.safetyState == "NORMAL_DIAGNOSTIC", st.safetyState)

print(f"\nOne conversation state (ADR 0014): {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
