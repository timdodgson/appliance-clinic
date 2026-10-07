"""STAGE A — deterministic cross-turn appliance-identity persistence in the orchestrator.

Proves (no network, no real Jev) that once a family is genuinely ESTABLISHED (Jev provenance
customer_named) it is preserved across weak / null / uncertain / inferred later turns, and is
replaced ONLY by an explicit customer correction. Jev owns the semantic provenance; the orchestrator
owns the deterministic state precedence. No customer-language regex / keyword scoring here.

Run: PYTHONPATH=. python3 orchestration/tests/test_identity_persistence.py
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


class ScriptedTurnsRag(FakeDiagnosticService):
    """A RAG double whose Jev UNDERSTAND output is scripted PER TURN (keyed by the exact message),
    so we can hand the orchestrator a specific typed family + applianceFamilyProvenance each turn and
    assert the deterministic state precedence. diagnose() reuses the FakeDiagnosticService."""

    def __init__(self, script):
        # script: {message: {"applianceType": fam|None, "provenance": str, "confidence": float,
        #                     "symptomFamily": str, "fault": str|None}}
        self._script = script

    def understand(self, *, symptoms, image=None, conversation=None, established=None):
        spec = self._script.get(symptoms, {})
        fam = spec.get("applianceType")
        fault = spec.get("fault")
        symptom_family = spec.get("symptomFamily", "none")
        raw = {
            "onTopic": True, "needMoreInfo": bool(not fam and not fault),
            "userIntent": "NEW_PROBLEM", "make": None, "model": None, "applianceType": fam,
            "fault": fault, "faultId": None, "errorCode": None, "modelUnavailable": False,
            "confidence": 0.8, "alternatives": [], "candidateComponents": [], "provenGood": [],
            "alreadyReplaced": [], "nextBestCheck": None, "clarifyingQuestion": None,
            "primaryFindingKind": "unknown", "customerTheories": [], "declinedFacts": [],
            "checksReported": [], "reportedSymptoms": [fault] if fault else [], "facts": [],
            "_tokenMeaning": "none", "_cannotAnswer": False,
            "_applianceFamilyProvenance": spec.get("provenance", "none"),
            "_jevEvidence": {"source": "jev", "facts": [], "intervention": None},
        }
        jev = {"decisions": {"onTopic": True, "applianceFamily": fam or "unknown",
                             "symptomFamily": symptom_family, "candidateTokenMeaning": "none",
                             "latestTurnEstablishes": "identity" if spec.get("provenance") == "customer_named" else "symptom",
                             "cannotAnswer": False, "safetySignificance": "none",
                             "applianceFamilyProvenance": spec.get("provenance", "none"),
                             "userIntent": "NEW_PROBLEM", "partReadiness": "diagnosis_only",
                             "identitySufficiency": "sufficient" if fam else "need_appliance"},
              "confidence": {"applianceFamily": spec.get("confidence", 0.8)},
              "customerEvidence": {"source": "jev", "facts": [], "intervention": None}}
        return {"jev": jev, "understand": raw}


def build(script):
    return Orchestrator(FakeErrorCodeService(CANNED), ScriptedTurnsRag(script), InMemoryStateStore())


def state_after(o, msgs, sid):
    st = None
    for m in msgs:
        o.handle_turn(TurnInput(message=m, sessionId=sid))
        st = o.store.get(sid)
    return st.customer


# --- Explicit identity persists across a weak follow-up that names no appliance -----------------
T1 = "my Bosch washing machine won't spin"
T2 = "it makes a humming noise"
o = build({
    T1: {"applianceType": "washing-machine", "provenance": "customer_named", "confidence": 1.0,
         "symptomFamily": "not_spinning", "fault": "not spinning"},
    T2: {"applianceType": None, "provenance": "none", "confidence": 0.3,
         "symptomFamily": "noisy", "fault": "humming"},
})
c = state_after(o, [T1, T2], "s1")
check("explicit identity persists across weak follow-up (washing-machine)",
      c.appliance == "washing-machine" and c.applianceState == "established",
      (c.appliance, c.applianceState))

# --- Null / 'not sure' follow-up does not erase an established identity -------------------------
T1 = "my dishwasher leaves everything wet"
T2 = "I'm not sure"
o = build({
    T1: {"applianceType": "dishwasher", "provenance": "customer_named", "confidence": 0.95,
         "symptomFamily": "not_heating", "fault": "not drying"},
    T2: {"applianceType": None, "provenance": "uncertain", "confidence": 0.2,
         "symptomFamily": "none", "fault": None},
})
c = state_after(o, [T1, T2], "s2")
check("null/uncertain follow-up does not erase dishwasher",
      c.appliance == "dishwasher" and c.applianceState == "established",
      (c.appliance, c.applianceState))

# --- Generic follow-up (no family) does not change an established family ------------------------
T1 = "my Dyson is pulsing"
T2 = "it does it after about a minute"
o = build({
    T1: {"applianceType": "vacuum", "provenance": "customer_named", "confidence": 0.9,
         "symptomFamily": "pulsing", "fault": "pulsing"},
    T2: {"applianceType": None, "provenance": "none", "confidence": 0.1,
         "symptomFamily": "pulsing", "fault": "pulsing"},
})
c = state_after(o, [T1, T2], "s3")
check("generic follow-up does not change vacuum",
      c.appliance == "vacuum" and c.applianceState == "established",
      (c.appliance, c.applianceState))

# --- A later WEAK INFERRED different family does NOT overwrite an established family -------------
T1 = "my washing machine won't drain"
T2 = "the dishes come out dirty"   # inferred dishwasher, but identity already established
o = build({
    T1: {"applianceType": "washing-machine", "provenance": "customer_named", "confidence": 0.95,
         "symptomFamily": "not_draining", "fault": "not draining"},
    T2: {"applianceType": "dishwasher", "provenance": "inferred", "confidence": 0.72,
         "symptomFamily": "not_cleaning", "fault": "not cleaning"},
})
c = state_after(o, [T1, T2], "s4")
check("weak inferred different family does not overwrite established washing-machine",
      c.appliance == "washing-machine" and c.applianceState == "established",
      (c.appliance, c.applianceState))

# --- Explicit correction to a different family deterministically replaces the identity ----------
T1 = "my washing machine won't drain"
T2 = "sorry, it's actually the dishwasher"
o = build({
    T1: {"applianceType": "washing-machine", "provenance": "customer_named", "confidence": 0.95,
         "symptomFamily": "not_draining", "fault": "not draining"},
    T2: {"applianceType": "dishwasher", "provenance": "customer_named", "confidence": 0.97,
         "symptomFamily": "not_draining", "fault": "not draining"},
})
c = state_after(o, [T1, T2], "s5")
check("explicit correction replaces washing-machine with dishwasher",
      c.appliance == "dishwasher" and c.applianceState == "established",
      (c.appliance, c.applianceState))

# --- Weak initial inference stays WORKING (not promoted to ESTABLISHED) -------------------------
T1 = "dishes hot but not dry"
o = build({
    T1: {"applianceType": "dishwasher", "provenance": "inferred", "confidence": 0.8,
         "symptomFamily": "not_heating", "fault": "not drying"},
})
c = state_after(o, [T1], "s6")
check("weak inferred opener stays WORKING (not established)",
      c.appliance == "dishwasher" and c.applianceState == "working",
      (c.appliance, c.applianceState))

# --- A WORKING family upgraded by later explicit customer naming becomes ESTABLISHED ------------
T1 = "dishes hot but not dry"
T2 = "yes it's my dishwasher"
o = build({
    T1: {"applianceType": "dishwasher", "provenance": "inferred", "confidence": 0.8,
         "symptomFamily": "not_heating", "fault": "not drying"},
    T2: {"applianceType": "dishwasher", "provenance": "customer_named", "confidence": 0.98,
         "symptomFamily": "not_heating", "fault": "not drying"},
})
c = state_after(o, [T1, T2], "s7")
check("WORKING upgraded by explicit naming becomes ESTABLISHED",
      c.appliance == "dishwasher" and c.applianceState == "established",
      (c.appliance, c.applianceState))

print(f"\nidentity-persistence (orchestrator): {passed} passed / {failed} failed")
sys.exit(1 if failed else 0)
