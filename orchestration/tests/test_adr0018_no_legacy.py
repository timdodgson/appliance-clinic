"""ADR 0018: an AC turn is canonical, an explicit non-diagnostic outcome, or an explicit error. Never the legacy diagnosis.

Proves, with no network:
  * every canonical degradation is an explicit SERVICE_UNAVAILABLE whose canonical result is marked degraded (so the BFF
    persists nothing), and diagnose() is never called: a missing block, a missing / mismatched / degraded / malformed
    canonical result, an unavailable understand, a degraded Jev pass;
  * a canonically controlled turn whose diagnose reply cannot prove it is the canonical one (no canonicalControl, e.g. a
    dropped signature) or whose diagnose call fails is an explicit error, never shown as the journey's answer;
  * the orchestrator never accepts a looser canonical result than the engine's controls() gate;
  * with no journey owning the turn: a cs/1 hazard is the safety stop, an unsafe request is the fixed decline, a typed
    problem no journey owns is UNSUPPORTED, anything else is intake; none of them calls diagnose().
Run: PYTHONPATH=. python3 -m pytest orchestration/tests/test_adr0018_no_legacy.py -q
"""
import copy

from orchestration.model import TurnInput
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, RagUnavailable
from orchestration.orchestrator import Orchestrator
from orchestration.tests.cs1_bff import cs1_state
from orchestration.tests.fixtures import CANNED

CSID = "cs_" + "A" * 32
BLOCK = {"schema": "cs/1", "mode": "control", "sessionId": CSID, "version": 1, "state": None, "degraded": None}
MSG = "my washing machine won't drain, water sits in the drum"


def action():
    return {"kind": "ask_check", "target": "drain-filter", "reason": "x", "requires": [], "expects": [], "pending": None,
            "conclusion": None, "journey": "wm-not-draining", "rule": "R7", "requestKind": "ask"}


_DEFAULT = object()


def merged(state=_DEFAULT, **over):
    st = cs1_state(appliance="washing-machine", establishment="established", version=2) if state is _DEFAULT else state
    out = {"schema": "cs/1", "mode": "control", "sessionId": CSID, "priorVersion": 1, "version": 2, "state": st,
           "classification": {"schema": "mc/1"}, "rulesFired": [], "degraded": None}
    out.update(over)
    return out


class Rag(FakeDiagnosticService):
    """The fake understanding with a scripted canonical result; records every diagnose call."""
    def __init__(self, canonical=None, raw=None, decisions=None, understand_error=False, diagnose=None, diagnose_error=False):
        self.canonical, self.raw, self.decisions = canonical, raw or {}, decisions
        self.understand_error, self.diagnose_reply, self.diagnose_error = understand_error, diagnose, diagnose_error
        self.diagnose_calls = []

    def understand(self, *, symptoms, image=None, conversation=None, established=None, canonical=None):
        if self.understand_error:
            raise RagUnavailable("down")
        out = super().understand(symptoms=symptoms, image=image, conversation=conversation, established=established)
        out["understand"].update(self.raw)
        if self.decisions is not None:
            out["jev"]["decisions"] = self.decisions
        if canonical is not None and self.canonical is not None:
            out["canonical"] = copy.deepcopy(self.canonical)
        return out

    def diagnose(self, **kw):
        self.diagnose_calls.append(kw)
        if self.diagnose_error:
            raise RagUnavailable("down")
        return copy.deepcopy(self.diagnose_reply) if self.diagnose_reply is not None else super().diagnose(
            **{k: v for k, v in kw.items() if k != "canonical"})


def run(rag, canonical=BLOCK, message=MSG):
    orch = Orchestrator(FakeErrorCodeService(CANNED), rag)
    return orch.handle_turn(TurnInput(message=message, sessionId="s1", canonical=copy.deepcopy(canonical) if canonical else None))


def assert_explicit_error(resp, rag, reason):
    assert resp.outcome == "SERVICE_UNAVAILABLE"
    assert resp.debug["canonicalUnavailable"] == reason
    assert rag.diagnose_calls == []                                   # never answered another way
    assert not resp.parts and resp.diagnosis is None
    c = resp.debug.get("canonical")
    assert c is None or c.get("degraded")                             # the BFF persists nothing from this turn


# ---- every canonical degradation is an explicit error ------------------------------------------------------------
def test_missing_block():
    rag = Rag(canonical=merged())
    assert_explicit_error(run(rag, canonical=None), rag, "canonical_block_missing")


def test_understand_returned_no_canonical_result():
    rag = Rag(canonical=None)
    assert_explicit_error(run(rag), rag, "understand_no_canonical")


def test_session_mismatch():
    rag = Rag(canonical=merged(sessionId="cs_" + "B" * 32))
    assert_explicit_error(run(rag), rag, "session_mismatch")


def test_understand_unavailable():
    rag = Rag(understand_error=True)
    assert_explicit_error(run(rag), rag, "understand_unavailable")


def test_engine_reported_degradations():
    for reason in ("classification_degraded", "classification_timeout", "invalid_prior_state", "merge_failed"):
        rag = Rag(canonical=merged(degraded=reason, state=None))
        assert_explicit_error(run(rag), rag, reason)


def test_malformed_result_the_engine_gate_would_refuse():
    """The orchestrator never applies a looser gate than the engine's controls() (isTransportResult)."""
    for bad in (merged(priorVersion=None), merged(version="2"), merged(schema="cs/2"),
                merged(state={"schemaVersion": 1}), merged(state=None)):
        rag = Rag(canonical=bad)
        resp = run(rag)
        assert resp.outcome == "SERVICE_UNAVAILABLE", bad
        assert rag.diagnose_calls == []


def test_gate_mismatch_on_a_controlled_journey():
    """A controlled journey on a result the engine would refuse to control is an error, not a diagnosis."""
    j = {"key": "wm-not-draining", "applies": True, "control": True, "nextAction": action()}
    rag = Rag(canonical=merged(priorVersion=None, journey=j))
    assert_explicit_error(run(rag), rag, "canonical_result_invalid")


def test_degraded_jev_understanding():
    rag = Rag(canonical=merged(), raw={"_degraded": "jev_timeout"})
    assert_explicit_error(run(rag), rag, "understand_degraded")
    rag = Rag(canonical=merged(), decisions={})
    assert_explicit_error(run(rag), rag, "understand_degraded")


# ---- a controlled journey's reply must be the canonical one ----------------------------------------------------
def controlled():
    return merged(journey={"key": "wm-not-draining", "applies": True, "control": True, "nextAction": action()})


def reply(**over):
    out = {"grounded": True, "reply": "Have a look at the drain filter. What did you find?", "safety": {"class": "NORMAL_DIAGNOSTIC", "stopUse": False},
           "parts": [], "media": [], "candidateComponents": [], "componentMention": "none",
           "canonicalControl": {"journey": "wm-not-draining", "nextAction": action(), "control": True}}
    out.update(over)
    return out


def test_controlled_turn_answers_from_the_canonical_reply():
    rag = Rag(canonical=controlled(), diagnose=reply())
    resp = run(rag)
    assert resp.outcome == "ANSWER" and resp.debug["canonicalControl"] == "wm-not-draining"
    assert len(rag.diagnose_calls) == 1


def test_diagnose_reply_without_canonical_proof_is_an_error():
    """e.g. the engine dropped the signature and answered on its legacy path: never shown as the journey's answer."""
    for bad in (reply(canonicalControl=None), reply(canonicalControl={"journey": "wm-not-draining"})):
        rag = Rag(canonical=controlled(), diagnose=bad)
        resp = run(rag)
        assert resp.outcome == "SERVICE_UNAVAILABLE"
        assert resp.debug["canonicalUnavailable"] == "diagnose_not_canonical"
        assert resp.debug["canonical"]["degraded"]
        assert "drain filter" not in (resp.message or "")


def test_diagnose_unavailable_on_a_controlled_turn():
    rag = Rag(canonical=controlled(), diagnose_error=True)
    resp = run(rag)
    assert resp.outcome == "SERVICE_UNAVAILABLE"
    assert resp.debug["canonicalUnavailable"] == "diagnose_unavailable"
    assert resp.debug["canonical"]["degraded"] == "diagnose_unavailable"


# ---- no journey owns the turn: explicit non-diagnostic outcomes, never diagnose() --------------------------------
def test_cs1_hazard_is_the_safety_stop():
    st = cs1_state(appliance="hob", establishment="established", safety_level="EMERGENCY_ACTION", hazards=("gas_smell",), version=2)
    rag = Rag(canonical=merged(state=st))
    resp = run(rag, message="I can smell gas near my hob")
    assert resp.outcome == "SAFETY_STOP" and resp.safety["stopUse"] is True
    assert "0800 111 999" in resp.message
    assert rag.diagnose_calls == []


def test_unsafe_request_this_turn_is_the_fixed_decline():
    st = cs1_state(appliance="washing-machine", establishment="established", version=2)
    st["safety"]["unsafeActions"] = [{"action": "live_electrical_test", "turn": 2}]
    rag = Rag(canonical=merged(state=st))
    resp = run(rag, message="can I test the heater live?")
    assert resp.message.startswith("Please don't do that")
    assert rag.diagnose_calls == []
    # an unsafe request from an earlier turn does not repeat the decline
    st["safety"]["unsafeActions"] = [{"action": "live_electrical_test", "turn": 1}]
    resp2 = run(Rag(canonical=merged(state=st)), message="ok what next")
    assert not (resp2.message or "").startswith("Please don't do that")


def test_typed_problem_no_journey_owns_is_unsupported():
    st = cs1_state(appliance="washing-machine", establishment="established", problem=True, version=2)
    st["problems"][0]["journey"] = {"value": "wm-noisy", "basis": "stated", "turn": 2, "status": "active", "history": []}
    rag = Rag(canonical=merged(state=st))
    resp = run(rag, message="my washing machine is really noisy on spin")
    assert resp.outcome == "UNSUPPORTED" and resp.route == "UNSUPPORTED"
    assert "won't guess" in resp.message and "washing machine" in resp.message
    assert not resp.parts and resp.diagnosis is None
    assert rag.diagnose_calls == []
    assert resp.debug["unsupported"] == "wm-noisy"


def test_untyped_symptom_is_intake():
    rag = Rag(canonical=merged())
    resp = run(rag, message="my washing machine is acting up")
    assert resp.outcome == "CLARIFICATION_REQUIRED" and resp.route == "CLARIFY"
    assert rag.diagnose_calls == []
