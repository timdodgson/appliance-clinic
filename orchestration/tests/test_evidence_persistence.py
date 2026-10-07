"""CONVERSATION-STATE PERSISTENCE — deterministic typed-evidence reconciliation in the orchestrator.

Proves (no network, no real Jev) that the established typed problem / checks / facts the customer has
given are kept across turns and re-injected onto the forwarded intent (st._understand) so COMPOSE
always sees the whole picture:

  * Preserve — a sparse follow-up (identity answer / "I don't know" / check result where Jev returns
    an empty typed set) never drops what was established.
  * Add — new evidence unions into the established set.
  * Correct — an explicit customer correction (Jev userIntent == CORRECTION / latestTurnEstablishes
    == correction) replaces the set with the corrected one.
  * declinedFacts are monotonic (never re-asked).
  * symptomsText / the forwarded latest text are the CUSTOMER's words, never the advisor transcript.

Jev owns the semantic reading of the latest turn; the orchestrator owns the deterministic state
precedence. No customer-language regex / phrase scoring here.

Run: PYTHONPATH=. python3 orchestration/tests/test_evidence_persistence.py
"""
import sys
from orchestration.model import TurnInput
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator
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
    return Orchestrator(FakeErrorCodeService(CANNED), ScriptedRag(script), InMemoryStateStore())


def run(o, msgs, sid, latests=None):
    """Replay turns; `msgs` is what the boundary sends as `message` (may be a labelled transcript),
    `latests` the matching per-turn latestMessage. Returns final (customer, forwarded_understand)."""
    st = None
    for i, m in enumerate(msgs):
        latest = latests[i] if latests else m
        o.handle_turn(TurnInput(message=m, sessionId=sid, latestMessage=latest))
        st = o.store.get(sid)
    return st.customer, getattr(st, "_understand", {})


# --- PRESERVE: a cannot-answer turn keeps the established symptom + checks -----------------------
T1 = "my washing machine won't spin and water is left in the drum"
T2 = "I'm not sure"
o = build({
    T1: {"applianceType": "washing-machine", "fault": "not spinning",
         "symptomFamily": "not_spinning", "checksReported": [], "establishes": "symptom"},
    T2: {"applianceType": None, "fault": None, "symptomFamily": "none",
         "userIntent": "CANNOT_ANSWER", "establishes": "cannot_answer",
         "reportedSymptoms": [], "checksReported": []},
})
c, u = run(o, [T1, T2], "p1")
check("preserve: established fault survives a cannot-answer turn", c.fault == "not spinning", c.fault)
check("preserve: reportedSymptoms survive", c.reportedSymptoms == ["not spinning"], c.reportedSymptoms)
check("preserve: forwarded intent carries the established fault", u.get("fault") == "not spinning", u.get("fault"))
check("preserve: forwarded intent carries the established symptom",
      u.get("reportedSymptoms") == ["not spinning"], u.get("reportedSymptoms"))

# --- ADD: checks accumulate across follow-up turns ----------------------------------------------
T1 = "dishwasher not draining"
T2 = "the filter is clear"
T3 = "the pump spins freely"
o = build({
    T1: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining"},
    T2: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining",
         "userIntent": "EVIDENCE_UPDATE", "establishes": "check_result",
         "checksReported": ["filter clear"]},
    T3: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining",
         "userIntent": "EVIDENCE_UPDATE", "establishes": "check_result",
         # Jev happens to only report the latest check this turn; Add must keep the earlier one.
         "checksReported": ["pump spins freely"]},
})
c, u = run(o, [T1, T2, T3], "a1")
check("add: both checks accumulate (variance can't drop the earlier one)",
      c.checksReported == ["filter clear", "pump spins freely"], c.checksReported)
check("add: forwarded intent carries both checks",
      u.get("checksReported") == ["filter clear", "pump spins freely"], u.get("checksReported"))

# --- ADD does not duplicate when Jev reports the cumulative set ---------------------------------
o = build({
    T1: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining"},
    T2: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining",
         "userIntent": "EVIDENCE_UPDATE", "checksReported": ["filter clear"]},
    T3: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining",
         "userIntent": "EVIDENCE_UPDATE", "checksReported": ["filter clear", "pump spins freely"]},
})
c, _ = run(o, [T1, T2, T3], "a2")
check("add: cumulative Jev report does not duplicate",
      c.checksReported == ["filter clear", "pump spins freely"], c.checksReported)

# --- CORRECT: an explicit correction replaces the set ------------------------------------------
T1 = "washing machine won't spin"
T2 = "the filter is clear"
T3 = "actually I never checked the filter, I was wrong"
o = build({
    T1: {"applianceType": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning"},
    T2: {"applianceType": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning",
         "userIntent": "EVIDENCE_UPDATE", "checksReported": ["filter clear"]},
    T3: {"applianceType": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning",
         "userIntent": "CORRECTION", "establishes": "correction",
         # Jev, re-reading the thread, now reports no completed checks.
         "checksReported": ["filter not yet checked"]},
})
c, u = run(o, [T1, T2, T3], "c1")
check("correct: correction replaces the checks set",
      c.checksReported == ["filter not yet checked"], c.checksReported)
check("correct: forwarded intent carries the corrected set",
      u.get("checksReported") == ["filter not yet checked"], u.get("checksReported"))

# --- declinedFacts are monotonic and never dropped ----------------------------------------------
T1 = "oven not heating"
T2 = "I can't tell if the light comes on"
T3 = "I'm not sure about the fan either"
o = build({
    T1: {"applianceType": "oven", "fault": "not heating", "symptomFamily": "not_heating"},
    T2: {"applianceType": "oven", "fault": "not heating", "symptomFamily": "not_heating",
         "userIntent": "CANNOT_ANSWER", "declinedFacts": ["oven light state"]},
    T3: {"applianceType": "oven", "fault": "not heating", "symptomFamily": "not_heating",
         "userIntent": "CANNOT_ANSWER",
         # a later turn reports only the new declined fact; the earlier one must persist
         "declinedFacts": ["fan running"]},
})
c, u = run(o, [T1, T2, T3], "d1")
check("declinedFacts union is monotonic across turns",
      c.declinedFacts == ["oven light state", "fan running"], c.declinedFacts)
check("forwarded intent carries all declined facts",
      u.get("declinedFacts") == ["oven light state", "fan running"], u.get("declinedFacts"))

# --- symptomsText / forwarded latest text are the customer's words, not the advisor transcript --
T1 = "my washing machine won't spin and water is left in the drum"
LABELLED_T2 = ("Customer: my washing machine won't spin and water is left in the drum\n"
               "Advisor asked: Have you checked the pump filter at the bottom front?\n"
               "Customer: the filter is clear")
o = build({
    T1: {"applianceType": "washing-machine", "fault": "not spinning", "symptomFamily": "not_spinning"},
    LABELLED_T2: {"applianceType": "washing-machine", "fault": "not spinning",
                  "symptomFamily": "not_spinning", "userIntent": "EVIDENCE_UPDATE",
                  "checksReported": ["filter clear"]},
})
c, _ = run(o, [T1, LABELLED_T2], "s1", latests=[T1, "the filter is clear"])
check("symptomsText contains the customer's words",
      c.symptomsText and "filter is clear" in c.symptomsText, c.symptomsText)
check("symptomsText never captures the advisor transcript line",
      c.symptomsText and "Advisor asked:" not in c.symptomsText, c.symptomsText)

# --- ESTABLISHED PROBLEM FALLBACK (Defect B): a symptom Jev typed with no mapped fault label
# (symptomFamily 'other', e.g. "not drying") is still carried as the established problem, and
# survives a later sparse identity/model-only turn so COMPOSE never re-asks for the problem. ------
T1 = "my dishwasher isn't drying the dishes"
T2 = "it's a Bosch"
T3 = "the model is SMS46IW01G"
o = build({
    T1: {"applianceType": "dishwasher", "fault": None, "symptomFamily": "other",
         "establishes": "symptom", "userIntent": "NEW_PROBLEM"},
    T2: {"applianceType": "dishwasher", "fault": None, "symptomFamily": "none",
         "establishes": "identity", "userIntent": "ADDING_DETAIL"},
    T3: {"applianceType": "dishwasher", "fault": None, "symptomFamily": "none",
         "establishes": "identity", "userIntent": "ADDING_DETAIL"},
})
# T1 only
c1, u1 = run(o, [T1], "b-other-1")
check("B: unmapped 'other' symptom becomes an established reportedSymptoms",
      c1.reportedSymptoms and "drying" in c1.reportedSymptoms[0], c1.reportedSymptoms)
check("B: forwarded intent carries the established problem on turn 1",
      bool(u1.get("reportedSymptoms")), u1.get("reportedSymptoms"))
# full progression incl. the sparse model turn
c, u = run(o, [T1, T2, T3], "b-other-2")
check("B: established problem retained after make-only + model-only turns",
      c.reportedSymptoms and "drying" in c.reportedSymptoms[0], c.reportedSymptoms)
check("B: forwarded intent still carries the problem on the model-only turn",
      bool(u.get("reportedSymptoms")) and "drying" in u.get("reportedSymptoms")[0], u.get("reportedSymptoms"))

# A mapped symptom is unaffected: reportedSymptoms stays the short typed label (fallback not applied).
Tm = "my dishwasher won't drain"
om = build({Tm: {"applianceType": "dishwasher", "fault": "not draining", "symptomFamily": "not_draining"}})
cm, _ = run(om, [Tm], "b-mapped")
check("B: mapped symptom keeps its short typed label (fallback does not override)",
      cm.reportedSymptoms == ["not draining"], cm.reportedSymptoms)

print(f"\nevidence-persistence (orchestrator): {passed} passed / {failed} failed")
sys.exit(1 if failed else 0)
