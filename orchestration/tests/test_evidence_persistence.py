"""ADR 0014 — evidence across turns without a second conversation state.

The orchestrator used to union Jev's typed problem / checks / facts / declined facts across turns in process memory
(per warm container) and re-inject them. That was a second answered-question memory beside cs/1. Now:

  * Each turn's forwarded intent carries THIS turn's Jev reading only. Jev reads the whole (windowed) conversation;
    durable typed evidence is cs/1's (evidence.observations / checks, declined), merged by the engine.
  * A problem cs/1 already holds is still the established problem on a sparse later turn (identity / model answer):
    symptomsText is the customer's own words from the transcript the BFF sends, never advisor text.
  * An unmapped symptom (Jev symptomFamily 'other') is carried as reportedSymptoms so COMPOSE never re-asks for it.

Turns are sent the way whichpart-api sends them: `message` is the labelled transcript, `latestMessage` the new turn.

Run: PYTHONPATH=. python3 orchestration/tests/test_evidence_persistence.py
"""
import sys
from orchestration.model import TurnInput
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService
from orchestration.orchestrator import Orchestrator
from orchestration.tests.cs1_bff import FakeBff
from orchestration.tests.fixtures import CANNED

passed = 0
failed = 0


def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond)
    passed += ok
    failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))


class ScriptedRag(FakeDiagnosticService):
    """Jev UNDERSTAND scripted per turn (keyed by the exact message). Each spec may set
    applianceType / fault / symptomFamily / userIntent / latestTurnEstablishes and the typed lists
    reportedSymptoms / checksReported / facts / declinedFacts. diagnose() reuses the fake."""

    def __init__(self, script):
        self._script = script

    def understand(self, *, symptoms, image=None, conversation=None, established=None):
        spec = self._script.get(symptoms, {})
        fam = spec.get("applianceType")
        fault = spec.get("fault")
        raw = {
            "onTopic": True, "needMoreInfo": False,
            "userIntent": spec.get("userIntent", "NEW_PROBLEM"), "make": None, "model": None,
            "applianceType": fam, "fault": fault, "faultId": None, "errorCode": None,
            "modelUnavailable": False, "confidence": 0.8, "alternatives": [],
            "candidateComponents": [], "provenGood": [], "alreadyReplaced": [],
            "nextBestCheck": None, "clarifyingQuestion": None, "primaryFindingKind": "unknown",
            "customerTheories": [], "declinedFacts": spec.get("declinedFacts", []),
            "checksReported": spec.get("checksReported", []),
            "reportedSymptoms": spec.get("reportedSymptoms", ([fault] if fault else [])),
            "facts": spec.get("facts", []),
            "_tokenMeaning": "none", "_cannotAnswer": False,
            "_applianceFamilyProvenance": spec.get("provenance", "customer_named" if fam else "none"),
            "_jevEvidence": {"source": "jev", "facts": [], "intervention": None},
        }
        jev = {"decisions": {"onTopic": True, "applianceFamily": fam or "unknown",
                             "symptomFamily": spec.get("symptomFamily", "none"),
                             "candidateTokenMeaning": "none",
                             "latestTurnEstablishes": spec.get("establishes", "symptom"),
                             "cannotAnswer": False, "safetySignificance": "none",
                             "applianceFamilyProvenance": raw["_applianceFamilyProvenance"],
                             "userIntent": raw["userIntent"], "partReadiness": "diagnosis_only",
                             "identitySufficiency": "sufficient" if fam else "need_appliance"},
              "confidence": {"applianceFamily": spec.get("confidence", 0.9)},
              "customerEvidence": {"source": "jev", "facts": [], "intervention": None}}
        return {"jev": jev, "understand": raw}


def build(script):
    return FakeBff(Orchestrator(FakeErrorCodeService(CANNED), ScriptedRag(script)))


def transcript(turns):
    return "\n".join(f"Customer: {t}" for t in turns) if len(turns) > 1 else turns[0]


def run(o, turns, sid):
    """Replay `turns` through the fake BFF (cs/1 carried between turns). Returns the last turn's
    (customer, forwarded_understand)."""
    for i in range(len(turns)):
        o.handle_turn(TurnInput(message=transcript(turns[:i + 1]), sessionId=sid, latestMessage=turns[i]))
    st = o.last_state
    return st.customer, getattr(st, "_understand", {})


def script_for(turns, specs):
    """Key each turn's Jev spec by the transcript that turn sends."""
    return {transcript(turns[:i + 1]): spec for i, spec in enumerate(specs)}


# --- a cannot-answer turn: the problem stays established (cs/1), the forwarded intent is this turn's reading ----
T = ["my washing machine won't spin and water is left in the drum", "I'm not sure"]
o = build(script_for(T, [
    {"applianceType": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning"},
    {"applianceType": None, "fault": None, "symptomFamily": "none", "userIntent": "CANNOT_ANSWER",
     "establishes": "cannot_answer", "reportedSymptoms": [], "checksReported": []},
]))
c, u = run(o, T, "p1")
check("the problem cs/1 holds is still established on the cannot-answer turn",
      c.symptomsText and "won't spin" in c.symptomsText, c.symptomsText)
check("...and is carried to COMPOSE as the reported symptom", u.get("reportedSymptoms") and "won't spin" in u["reportedSymptoms"][0],
      u.get("reportedSymptoms"))
check("no process-memory union: the forwarded fault is this turn's Jev reading", not u.get("fault"), u.get("fault"))

# --- checks: the forwarded set is exactly Jev's reading this turn (no union from earlier turns) -----------------
T = ["dishwasher not draining", "the filter is clear", "the pump spins freely"]
o = build(script_for(T, [
    {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining"},
    {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining",
     "userIntent": "EVIDENCE_UPDATE", "establishes": "check_result", "checksReported": ["filter clear"]},
    {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining",
     "userIntent": "EVIDENCE_UPDATE", "establishes": "check_result", "checksReported": ["filter clear", "pump spins freely"]},
]))
c, u = run(o, T, "a1")
check("checks forwarded are Jev's whole-conversation reading this turn", u.get("checksReported") == ["filter clear", "pump spins freely"],
      u.get("checksReported"))
o2 = build(script_for(T, [
    {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining"},
    {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining", "checksReported": ["filter clear"]},
    {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining", "checksReported": ["filter not yet checked"],
     "userIntent": "CORRECTION", "establishes": "correction"},
]))
c, u = run(o2, T, "c1")
check("a correction is simply this turn's reading (nothing stale re-injected)", u.get("checksReported") == ["filter not yet checked"],
      u.get("checksReported"))

# --- the customer's words, never the advisor transcript ----------------------------------------------------------
LABELLED = ("Customer: my washing machine won't spin and water is left in the drum\n"
            "Advisor asked: Have you checked the pump filter at the bottom front?\n"
            "Customer: the filter is clear")
o = build({LABELLED: {"applianceType": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning",
                      "userIntent": "EVIDENCE_UPDATE", "checksReported": ["filter clear"]}})
o.handle_turn(TurnInput(message=LABELLED, sessionId="s1", latestMessage="the filter is clear"))
c = o.last_state.customer
check("symptomsText contains the customer's words", c.symptomsText and "filter is clear" in c.symptomsText, c.symptomsText)
check("symptomsText never captures the advisor transcript line", c.symptomsText and "Advisor asked:" not in c.symptomsText, c.symptomsText)

# --- an unmapped symptom survives make-only and model-only turns (problem held by cs/1) -------------------------
T = ["my dishwasher isn't drying the dishes", "it's a Bosch", "the model is SMS46IW01G"]
o = build(script_for(T, [
    {"applianceType": "dishwasher", "fault": None, "symptomFamily": "other", "establishes": "symptom"},
    {"applianceType": "dishwasher", "fault": None, "symptomFamily": "none", "establishes": "identity", "userIntent": "ADDING_DETAIL"},
    {"applianceType": "dishwasher", "fault": None, "symptomFamily": "none", "establishes": "identity", "userIntent": "ADDING_DETAIL"},
]))
c1, u1 = run(o, T[:1], "b-other-1")
check("an unmapped 'other' symptom becomes the reported symptom", c1.reportedSymptoms and "drying" in c1.reportedSymptoms[0], c1.reportedSymptoms)
c, u = run(o, T, "b-other-2")
check("the problem is retained after make-only and model-only turns", c.reportedSymptoms and "drying" in c.reportedSymptoms[0], c.reportedSymptoms)
check("...and forwarded on the model-only turn", bool(u.get("reportedSymptoms")) and "drying" in u["reportedSymptoms"][0], u.get("reportedSymptoms"))

Tm = ["my dishwasher won't drain"]
om = build(script_for(Tm, [{"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining"}]))
cm, _ = run(om, Tm, "b-mapped")
check("a mapped symptom keeps its short typed label", cm.reportedSymptoms == ["not draining"], cm.reportedSymptoms)

# --- no second state: a turn without the cs/1 block starts empty -------------------------------------------------
o = build({T[0]: {"applianceType": "dishwasher", "fault": None, "symptomFamily": "other", "establishes": "symptom"},
           T[1]: {"applianceType": "dishwasher", "fault": None, "symptomFamily": "none", "establishes": "identity",
                  "userIntent": "ADDING_DETAIL"}})
o.handle_turn(TurnInput(message=T[0], sessionId="n1"))
o._o.handle_turn(TurnInput(message=T[1], sessionId="n1"))  # straight to the orchestrator: no canonical block
check("without cs/1 nothing carries over from the previous turn", not o.last_state.customer.symptomsText, o.last_state.customer.symptomsText)

print(f"\nevidence across turns (ADR 0014): {passed} passed / {failed} failed")
sys.exit(1 if failed else 0)
