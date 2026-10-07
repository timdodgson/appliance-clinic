#!/usr/bin/env python3
"""Journey Policy v2 — deterministic orchestration tests (fake services, no network, no LLM).

These exercise the DETERMINISTIC journey policy in orchestration/orchestrator.py by feeding it the
TYPED Jev decisions it consumes (latestTurnEstablishes / answeredPrevious / modelUnavailable / ...).
Jev's own semantic interpretation is tested in the part-finder suite; here we assert that, given the
typed meaning, the orchestrator advances the journey correctly and generally (no appliance/make
hard-coding, no prose parsing).

Run: python3 -m orchestration.tests.test_journey_policy_v2
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
    """Controllable stand-in for the Jev UNDERSTAND + RAG diagnose pair. Each turn is driven by an
    explicit (decisions, diagnose) pair so the orchestrator sees exactly the typed meaning under test.
    No keyword parsing — this is the typed contract the real Jev emits."""

    def __init__(self, script):
        self._script = list(script)
        self._i = 0

    def _current(self):
        idx = min(self._i, len(self._script) - 1)
        return self._script[idx]

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
                                                  else {"unknown": 0.9, "uncertain": 0.1})},
        }
        return {"jev": jev, "understand": raw}

    def diagnose(self, *, symptoms, appliance=None, make=None, trusted=None, image=None,
                 conversation=None, understand=None, established=None):
        _decisions, diag = self._current()
        self._i += 1  # advance after the turn's diagnose
        return dict(diag)


def orch(script):
    return Orchestrator(FakeErrorCodeService({}), JourneyRag(script), InMemoryStateStore())


# Reusable typed-decision fragments ------------------------------------------------
def opening_symptom(fam="washing-machine", fault="not draining", family_symptom="not_draining"):
    return {"applianceFamily": fam, "symptomFamily": family_symptom, "_fault": fault,
            "userIntent": "NEW_PROBLEM", "latestTurnEstablishes": "symptom",
            "answeredPrevious": "not_applicable", "safetySignificance": "none",
            "applianceFamilyProvenance": "customer_named", "_make": "hotpoint"}


def check_result(fam="washing-machine", family_symptom="not_draining", answered="yes",
                 establishes="check_result", **extra):
    d = {"applianceFamily": fam, "symptomFamily": family_symptom, "_fault": None,
         "userIntent": "EVIDENCE_UPDATE", "latestTurnEstablishes": establishes,
         "answeredPrevious": answered, "partReadiness": "diagnosis_only",
         "safetySignificance": "none", "applianceFamilyProvenance": "customer_named",
         "_make": "hotpoint", "_evidence": "filter checked and clear"}
    d.update(extra)
    return d


GROUNDED_DRAIN = {"grounded": True, "faultId": "not-draining", "faultLabel": "not draining",
                  "system": "drain", "confidence": 0.86, "componentMention": "none",
                  "candidateComponents": ["drain pump", "pump filter"], "parts": [],
                  "reply": ("Water left in the drum usually means it can't pump out. With the machine "
                            "off, check the pump filter at the bottom front — have a tray and towels "
                            "ready as some water will come out."),
                  "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False}, "safetyReason": None}


print("CANONICAL HOTPOINT — turn 1: safe generic first check, NO model ask")
o = orch([
    (opening_symptom(), GROUNDED_DRAIN),
    (check_result(), GROUNDED_DRAIN),
])
r1 = o.handle_turn(TurnInput(message="Hotpoint washing machine ends full of water", sessionId="hp"))
check("T1 stage is DIAGNOSING", r1.debug.get("journeyStage") == "DIAGNOSING", r1.debug.get("journeyStage"))
check("T1 does not require the model", r1.modelRequired is False, str(r1.modelRequired))
check("T1 gives the safe check (mentions filter)", "filter" in (r1.message or "").lower(), (r1.message or "")[:120])
check("T1 does not ask for the model yet", "model" not in (r1.message or "").lower(), (r1.message or "")[:160])
check("T1 pendingRequest is not MODEL", not (r1.pendingRequest and r1.pendingRequest.get("slot") == "MODEL"),
      str(r1.pendingRequest))

print("CANONICAL HOTPOINT — turn 2: 'filter is clear' -> ask for the model")
r2 = o.handle_turn(TurnInput(message="The filter is clear", sessionId="hp"))
check("T2 stage is MODEL_REQUIRED_AFTER_CHECK", r2.debug.get("journeyStage") == "MODEL_REQUIRED_AFTER_CHECK",
      r2.debug.get("journeyStage"))
check("T2 requires the model", r2.modelRequired is True, str(r2.modelRequired))
check("T2 asks for the model", "model" in (r2.message or "").lower(), (r2.message or "")[:160])
check("T2 accepts a rating-plate photo", "photo" in (r2.message or "").lower() and "plate" in (r2.message or "").lower(),
      (r2.message or ""))
check("T2 pendingRequest slot is MODEL", r2.pendingRequest and r2.pendingRequest.get("slot") == "MODEL",
      str(r2.pendingRequest))
check("T2 does NOT re-ask whether water is standing / what is wrong",
      "standing" not in (r2.message or "").lower()
      and "still full" not in (r2.message or "").lower()
      and "what is it doing" not in (r2.message or "").lower(), (r2.message or ""))
check("T2 offers no part / no catalogue mention", (r2.parts in (None, []) and r2.componentMention == "none"),
      f"parts={r2.parts} mention={r2.componentMention}")
check("T2 no internal rubric wording leaked", "do not confirm" not in (r2.message or "").lower()
      and "must not" not in (r2.message or "").lower(), (r2.message or ""))

print("PARAPHRASE — different wording, same journey")
o = orch([
    (opening_symptom(fault="water left in drum"), GROUNDED_DRAIN),
    (check_result(answered="yes"), GROUNDED_DRAIN),
])
o.handle_turn(TurnInput(message="my Hotpoint washer is left standing full of water at the end", sessionId="pp"))
rp = o.handle_turn(TurnInput(message="checked the trap, nothing in it", sessionId="pp"))
check("paraphrase T2 asks for model", rp.modelRequired is True and "model" in (rp.message or "").lower(),
      f"{rp.modelRequired}/{(rp.message or '')[:120]}")

print("FIRST CHECK RESOLVED THE FAULT — no model ask, journey ends")
o = orch([
    (opening_symptom(), GROUNDED_DRAIN),
    (check_result(answered="yes", establishes="recovery"),
     {"grounded": False, "normalBehaviour": True, "reply": "Great — clearing the filter sorted it; nothing to replace.",
      "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False}}),
])
o.handle_turn(TurnInput(message="Hotpoint washing machine ends full of water", sessionId="rec"))
rr = o.handle_turn(TurnInput(message="cleared the filter and now it drains fine", sessionId="rec"))
check("resolved -> not MODEL_REQUIRED", rr.debug.get("journeyStage") != "MODEL_REQUIRED_AFTER_CHECK",
      rr.debug.get("journeyStage"))
check("resolved -> no model ask", rr.modelRequired is False and "model" not in (rr.message or "").lower(),
      (rr.message or "")[:120])

print("MODEL SUPPLIED AFTER THE CHECK — no re-ask")
o = orch([
    (opening_symptom(), GROUNDED_DRAIN),
    (check_result(establishes="identity", answered="not_applicable"), GROUNDED_DRAIN),
])
o.handle_turn(TurnInput(message="Hotpoint washing machine ends full of water", sessionId="mdl"))
rm = o.handle_turn(TurnInput(message="model is WMUD962", sessionId="mdl",
                             observed=[ObservedIdentifier("MODEL", "WMUD962")]))
check("model known -> stage MODEL_KNOWN", rm.debug.get("journeyStage") == "MODEL_KNOWN", rm.debug.get("journeyStage"))
check("model known -> does not re-ask the model", not rm.modelRequired, str(rm.modelRequired))

print("MODEL UNAVAILABLE AFTER THE CHECK — graceful, no loop")
o = orch([
    (opening_symptom(), GROUNDED_DRAIN),
    (check_result(answered="cannot_answer", establishes="cannot_answer", modelUnavailable=True), GROUNDED_DRAIN),
])
o.handle_turn(TurnInput(message="Hotpoint washing machine ends full of water", sessionId="nomdl"))
rn = o.handle_turn(TurnInput(message="I can't find the model, the sticker's worn off", sessionId="nomdl"))
check("cannot-model -> stage MODEL_UNAVAILABLE", rn.debug.get("journeyStage") == "MODEL_UNAVAILABLE",
      rn.debug.get("journeyStage"))
check("cannot-model -> does not keep demanding the model", not rn.modelRequired, str(rn.modelRequired))

print("SAFETY OVERRIDES THE JOURNEY — hazard even after a check")
o = orch([
    (opening_symptom(), GROUNDED_DRAIN),
    (check_result(answered="yes", safetySignificance="burning"),
     {"grounded": False, "faultId": None, "faultLabel": None, "system": "safety", "confidence": 0.0,
      "candidateComponents": [], "safety": {"class": "STOP_USE", "stopUse": True}, "safetyReason": "burning"}),
])
o.handle_turn(TurnInput(message="Hotpoint washing machine ends full of water", sessionId="safe"))
rs = o.handle_turn(TurnInput(message="the filter's clear but now there's a burning smell", sessionId="safe"))
check("safety -> SAFETY_STOP outcome", rs.outcome == Outcome.SAFETY_STOP.value, rs.outcome)
check("safety -> does not ask for the model", not rs.modelRequired and "model" not in (rs.message or "").lower(),
      (rs.message or "")[:140])

print("VACUUM — same policy generalises (filter/blockage check first, then model)")
VAC = {"grounded": True, "faultId": "lost-suction", "faultLabel": "lost suction", "system": "airflow",
       "confidence": 0.85, "componentMention": "none", "candidateComponents": ["filter", "hose"],
       "parts": [], "reply": ("Lost suction is usually airflow — with it switched off, empty the bin and "
                              "check/clean the filter and the hose for a blockage."),
       "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False}}
o = orch([
    (opening_symptom(fam="vacuum", fault="lost suction", family_symptom="no_suction"), VAC),
    (check_result(fam="vacuum", family_symptom="no_suction", answered="yes"), VAC),
])
rv1 = o.handle_turn(TurnInput(message="my vacuum has lost suction", sessionId="vac"))
check("vac T1 DIAGNOSING, no model ask", rv1.debug.get("journeyStage") == "DIAGNOSING" and not rv1.modelRequired,
      f"{rv1.debug.get('journeyStage')}/{rv1.modelRequired}")
rv2 = o.handle_turn(TurnInput(message="filters are clean and the hose is clear", sessionId="vac"))
check("vac T2 asks for the model", rv2.debug.get("journeyStage") == "MODEL_REQUIRED_AFTER_CHECK" and rv2.modelRequired,
      f"{rv2.debug.get('journeyStage')}/{rv2.modelRequired}")

print("IMMEDIATE IDENTIFICATION — ambiguous family clarifies before any generic check")
o = orch([
    ({"applianceFamily": "unknown", "symptomFamily": "uncertain", "_fault": None,
      "userIntent": "NEW_PROBLEM", "latestTurnEstablishes": "none", "answeredPrevious": "not_applicable",
      "safetySignificance": "none", "applianceFamilyProvenance": "none"},
     {"grounded": False, "clarifyingQuestion": "Which appliance is it, and what is it doing?",
      "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False}}),
])
ri = o.handle_turn(TurnInput(message="it's not working", sessionId="amb"))
check("ambiguous -> clarify (not a model-after-check jump)",
      ri.outcome == Outcome.CLARIFICATION_REQUIRED.value
      and ri.debug.get("journeyStage") != "MODEL_REQUIRED_AFTER_CHECK", f"{ri.outcome}/{ri.debug.get('journeyStage')}")

print(f"\nJourney Policy v2 (fake services): {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
