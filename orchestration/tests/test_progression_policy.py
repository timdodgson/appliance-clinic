#!/usr/bin/env python3
"""Progression policy regression tests — the shared conversation mechanics added to stop the GOLD v2
loop/re-ask/continue-after-solved failures. Deterministic (fake services, no network, no LLM): we
feed the orchestrator the TYPED Jev decisions it consumes and assert it advances correctly. No prose
parsing, no regex behavioural oracle — assertions are on typed outcome/stage/pendingRequest.

Run: python3 -m orchestration.tests.test_progression_policy
"""
import sys
from orchestration.model import TurnInput, ObservedIdentifier, Outcome
from orchestration.services import FakeErrorCodeService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator

passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    ok = bool(cond)
    passed += ok
    failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {name}" + ("" if ok else f"  :: {detail}"))


class JourneyRag:
    """Same controllable typed stand-in used by test_journey_policy_v2: each turn is an explicit
    (decisions, diagnose) pair, so the orchestrator sees exactly the typed Jev meaning under test."""

    def __init__(self, script):
        self._script = list(script)
        self._i = 0

    def _current(self):
        return self._script[min(self._i, len(self._script) - 1)]

    def understand(self, *, symptoms, image=None, conversation=None, established=None):
        decisions, _diag = self._current()
        fam = decisions.get("applianceFamily") or "unknown"
        raw = {
            "onTopic": True,
            "userIntent": decisions.get("userIntent") or "NEW_PROBLEM",
            "make": decisions.get("_make"),
            "model": None,
            "applianceType": fam if fam != "unknown" else None,
            "fault": decisions.get("_fault"),
            "errorCode": None,
            "reportedSymptoms": [decisions["_fault"]] if decisions.get("_fault") else [],
            "checksReported": list(decisions.get("_checksReported") or []),
            "facts": [],
            "declinedFacts": [],
            "modelUnavailable": bool(decisions.get("modelUnavailable")),
            "newEvidenceThisTurn": decisions.get("_evidence") or "",
        }
        jev = {
            "decisions": decisions,
            "confidence": {"applianceFamily": 0.95 if fam != "unknown" else 0.2},
            "probabilities": {"applianceFamily": ({fam: 0.95, "unknown": 0.05} if fam != "unknown"
                                                  else {"unknown": 0.9})},
        }
        return {"jev": jev, "understand": raw}

    def diagnose(self, *, symptoms, appliance=None, make=None, trusted=None, image=None,
                 conversation=None, understand=None, established=None):
        _decisions, diag = self._current()
        self._i += 1
        return dict(diag)


def orch(script):
    return Orchestrator(FakeErrorCodeService({}), JourneyRag(script), InMemoryStateStore())


def opening_symptom(fam="tumble-dryer", fault="not drying", family_symptom="not_heating"):
    return {"applianceFamily": fam, "symptomFamily": family_symptom, "_fault": fault,
            "userIntent": "NEW_PROBLEM", "latestTurnEstablishes": "symptom",
            "answeredPrevious": "not_applicable", "safetySignificance": "none",
            "applianceFamilyProvenance": "customer_named", "_make": "bosch"}


def check_turn(fam="tumble-dryer", family_symptom="not_heating", answered="yes",
               establishes="check_result", **extra):
    d = {"applianceFamily": fam, "symptomFamily": family_symptom, "_fault": None,
         "userIntent": "EVIDENCE_UPDATE", "latestTurnEstablishes": establishes,
         "answeredPrevious": answered, "partReadiness": "diagnosis_only", "safetySignificance": "none",
         "applianceFamilyProvenance": "customer_named", "_make": "bosch", "_evidence": "checked"}
    d.update(extra)
    return d


GROUNDED = {"grounded": True, "faultId": "not-heating", "faultLabel": "not heating",
            "system": "heating", "confidence": 0.82, "componentMention": "none",
            "candidateComponents": ["thermostat", "element"], "parts": [],
            "reply": "With the dryer off, check the lint filter and that the vent/condenser airflow path is clear.",
            "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False}, "safetyReason": None}


# 1) RECOVERY / SOLVED CLOSURE -----------------------------------------------------
print("RECOVERY CLOSURE — a check fixed it: close, no model, no part, no probe")
o = orch([
    (opening_symptom(), GROUNDED),
    (check_turn(establishes="recovery", answered="yes"), GROUNDED),
])
o.handle_turn(TurnInput(message="vented tumble dryer not drying", sessionId="rec"))
rr = o.handle_turn(TurnInput(message="the vent hose was kinked, I straightened it and it's drying fine now",
                             sessionId="rec"))
check("recovery -> ANSWER outcome (not clarification/model)", rr.outcome == Outcome.ANSWER.value, rr.outcome)
check("recovery -> no model required", rr.modelRequired is False, str(rr.modelRequired))
check("recovery -> does not ask for the model", "model" not in (rr.message or "").lower(), (rr.message or "")[:140])
check("recovery -> no part / no catalogue mention", rr.parts in (None, []) and rr.componentMention == "none",
      f"parts={rr.parts} mention={rr.componentMention}")
check("recovery -> no pending question outstanding", rr.pendingRequest is None, str(rr.pendingRequest))
check("recovery -> not stuck in MODEL_REQUIRED stage", rr.debug.get("journeyStage") != "MODEL_REQUIRED_AFTER_CHECK",
      rr.debug.get("journeyStage"))

# 2) MODEL CANNOT-ANSWER LATCH (not the narrower typed modelUnavailable) -----------
print("MODEL CANNOT-ANSWER — 'don't know the model offhand' must not re-ask the model")
o = orch([
    (opening_symptom(fam="oven-cooker", fault="one side burns", family_symptom="other"), GROUNDED),
    (check_turn(fam="oven-cooker", family_symptom="other", answered="yes"), GROUNDED),
    # cannot-answer to the MODEL ask: answeredPrevious cannot_answer, modelUnavailable NOT typed
    (check_turn(fam="oven-cooker", family_symptom="other", answered="cannot_answer",
                establishes="cannot_answer", modelUnavailable=False), GROUNDED),
    (check_turn(fam="oven-cooker", family_symptom="other", answered="cannot_answer",
                establishes="cannot_answer", modelUnavailable=False), GROUNDED),
])
o.handle_turn(TurnInput(message="my oven isn't cooking evenly, one side burns", sessionId="loop"))
r2 = o.handle_turn(TurnInput(message="checked, no debris around the fan", sessionId="loop"))
check("asked for the model after the check", r2.modelRequired is True and r2.pendingRequest
      and r2.pendingRequest.get("slot") == "MODEL", f"{r2.modelRequired}/{r2.pendingRequest}")
# feed the MODEL pending back (as the boundary does) + a cannot-answer to it
r3 = o.handle_turn(TurnInput(message="don't know the model offhand", sessionId="loop",
                             pendingRequest=r2.pendingRequest))
check("cannot-answer to model -> stage MODEL_UNAVAILABLE", r3.debug.get("journeyStage") == "MODEL_UNAVAILABLE",
      r3.debug.get("journeyStage"))
check("cannot-answer to model -> does NOT re-ask the model", r3.modelRequired is False
      and "model" not in (r3.message or "").lower(), f"{r3.modelRequired}/{(r3.message or '')[:140]}")
# 3) LATCH PERSISTS across a later turn
r4 = o.handle_turn(TurnInput(message="still the same, one side hotter", sessionId="loop",
                             pendingRequest=r3.pendingRequest))
check("latch persists -> still no model re-ask next turn", r4.modelRequired is False
      and r4.debug.get("journeyStage") == "MODEL_UNAVAILABLE", f"{r4.modelRequired}/{r4.debug.get('journeyStage')}")

# 4) A TRUSTED MODEL still wins (latch is moot once the model is actually supplied) -
print("MODEL SUPPLIED LATER — a real model overrides any prior unavailable latch")
o = orch([
    (opening_symptom(fam="oven-cooker", fault="one side burns", family_symptom="other"), GROUNDED),
    (check_turn(fam="oven-cooker", family_symptom="other", answered="cannot_answer",
                establishes="cannot_answer"), GROUNDED),
    (check_turn(fam="oven-cooker", family_symptom="other", establishes="identity",
                answered="not_applicable"), GROUNDED),
])
o.handle_turn(TurnInput(message="oven one side burns", sessionId="found"))
rc = o.handle_turn(TurnInput(message="not sure of the model", sessionId="found",
                             pendingRequest={"slot": "MODEL", "purpose": "DIAGNOSIS", "status": "PENDING"}))
check("after cannot-answer -> MODEL_UNAVAILABLE", rc.debug.get("journeyStage") == "MODEL_UNAVAILABLE",
      rc.debug.get("journeyStage"))
rf = o.handle_turn(TurnInput(message="found it, it's a Zanussi ZOB35301XK", sessionId="found",
                             observed=[ObservedIdentifier("MODEL", "ZOB35301XK")]))
check("model supplied -> stage MODEL_KNOWN", rf.debug.get("journeyStage") == "MODEL_KNOWN",
      rf.debug.get("journeyStage"))

print(f"\nProgression policy (fake services): {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
