"""Canonical CONTROL route through the orchestrator (every registry journey).
Proves, with no network:
  * a turn whose canonical result carries journey.control is answered from the RAG's NextAction wording
    only — no legacy overrides (model-acquisition stage, clarify, owner note, MCP code flow)
  * the reply/media/parts/model-ask/safety-stop shapes per NextAction kind
  * shadow (journey.control false), degraded, absent canonical or an unknown key -> the legacy path, unchanged
  * the orchestrator's journey -> likely-area map IS the shared registry (journeys.json)
Run: PYTHONPATH=. python3 -m pytest orchestration/tests/test_canonical_control.py -q
"""
import copy
import json
import pathlib
from orchestration.model import TurnInput
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator
from orchestration.tests.fixtures import CANNED

CSID = "cs_" + "A" * 32
BLOCK = {"schema": "cs/1", "mode": "control", "control": {"journeys": ["wm-not-draining"]},
         "sessionId": CSID, "version": 0, "state": None, "degraded": None}
MSG = "my Hotpoint washing machine won't drain, water sits in the drum, it shows F05"


def action(kind="ask_check", target="drain-filter", rule="R7", **kw):
    a = {"kind": kind, "target": target, "reason": "x", "requires": [], "expects": [], "pending": None,
         "conclusion": None, "journey": "wm-not-draining", "rule": rule, "requestKind": "ask"}
    a.update(kw)
    return a


class J1Rag(FakeDiagnosticService):
    def __init__(self, next_action, control=True, reply="Switch it off and unplug it first. What did you find in the filter?",
                 parts=None, safety_stop=None, degraded=None):
        self.a, self.control, self.reply, self.parts, self.safety_stop, self.degraded = next_action, control, reply, parts, safety_stop, degraded
        self.diagnose_calls = []

    def understand(self, *, symptoms, image=None, conversation=None, established=None, canonical=None):
        out = super().understand(symptoms=symptoms, image=image, conversation=conversation, established=established)
        if canonical is not None:
            out["canonical"] = {"schema": "cs/1", "mode": canonical["mode"], "sessionId": canonical["sessionId"],
                                "priorVersion": 0, "version": 1, "state": {"schemaVersion": "cs/1", "sessionId": CSID, "version": 1},
                                "classification": {"schema": "mc/1"}, "rulesFired": [], "degraded": self.degraded,
                                "journey": {"key": "wm-not-draining", "applies": True, "control": self.control, "nextAction": self.a}}
        return out

    def diagnose(self, *, canonical=None, **kw):
        self.diagnose_calls.append(copy.deepcopy(canonical))
        if not (canonical and (canonical.get("journey") or {}).get("control")):
            return super().diagnose(**kw)
        cls = {"electrical": "STOP_USE", "gas": "EMERGENCY_ACTION"}.get(self.safety_stop, "NORMAL_DIAGNOSTIC")
        return {"grounded": True, "faultId": "not-draining", "faultLabel": "not draining", "system": "not-draining",
                "confidence": 0.85, "candidateComponents": [], "componentMention": "none", "purchaseAppropriate": False,
                "clarifyingQuestion": None, "safety": {"class": cls, "stopUse": cls != "NORMAL_DIAGNOSTIC"},
                "safetyReason": self.safety_stop, "unsafeIntent": False, "normalBehaviour": False,
                "parts": self.parts or [], "resolvedModel": "WAN28281GB" if self.parts else None,
                "catalogueResolvedModel": None, "catalogueMatchType": "none", "extractedMake": None, "extractedAppliance": None,
                "reply": self.reply, "traceId": "t1", "checksReported": [], "userIntent": None, "safetyInformation": None,
                "media": [{"id": "wm-pump-filter", "type": "DIAGRAM"}] if self.a["target"] == "drain-filter" else [],
                "cards": 0, "diagnosticTrace": None,
                "canonicalControl": {"journey": "wm-not-draining", "nextAction": self.a, "compose": {"source": "compose", "violations": []}, "control": True}}


def run(rag, canonical=BLOCK, message=MSG):
    orch = Orchestrator(FakeErrorCodeService(CANNED), rag, InMemoryStateStore())
    return orch.handle_turn(TurnInput(message=message, sessionId="s1", canonical=canonical))


def test_control_ask_check_uses_nextaction_wording_only():
    rag = J1Rag(action())
    resp = run(rag)
    assert resp.message == rag.reply
    assert resp.outcome == "ANSWER"
    assert resp.media and resp.media[0]["id"] == "wm-pump-filter"
    assert resp.parts is None and resp.modelRequired is False
    assert resp.debug["canonicalControl"] == "wm-not-draining"
    assert resp.debug["canonicalAction"]["rule"] == "R7"
    assert resp.debug["canonicalAction"]["journey"] == "wm-not-draining"
    assert "journeyStage" not in resp.debug            # legacy model-acquisition stage never ran
    assert resp.route == "SYMPTOMS"
    assert rag.diagnose_calls and rag.diagnose_calls[0]["journey"]["control"] is True


def test_control_skips_the_owner_safety_note_and_mcp_code_flow():
    rag = J1Rag(action(), reply="Have a look at the filter. What did you find?")
    resp = run(rag)
    assert resp.message == "Have a look at the filter. What did you find?"   # owner note not prepended
    assert resp.codeResult is None                                           # F05 did not divert to the MCP flow


def test_control_model_ask_sets_model_required_and_pending():
    resp = run(J1Rag(action("ask_identity", "model", "R13"), reply="Could you send me the model number?"))
    assert resp.modelRequired is True
    assert resp.pendingRequest == {"slot": "MODEL", "purpose": "PART_FIT", "status": "PENDING"}


def test_control_conclusion_and_part():
    concl = {"cause": "drain-pump", "level": "component", "confidence": "likely", "handoff": "none", "component": "drain-pump"}
    resp = run(J1Rag(action("recommend_part", "drain-pump", "R14", conclusion=concl), reply="The drain pump is the likely fault.",
                     parts=[{"partNo": "P1", "title": "Drain Pump"}]))
    assert resp.parts == [{"partNo": "P1", "title": "Drain Pump"}]
    assert resp.componentMention == "purchase"
    assert resp.diagnosis.summary == "Drain pump"
    c2 = dict(concl, cause="household-waste-backflow", level="cause_family", handoff="plumbing")
    resp2 = run(J1Rag(action("conclude", "household-waste-backflow", "R6a", conclusion=c2), reply="It's the household waste plumbing."))
    assert resp2.parts is None and resp2.componentMention == "none"
    assert resp2.pendingRequest is None


def test_control_safety_stop_is_a_safety_stop():
    resp = run(J1Rag(action("safety_stop", "electrical_water", "R1"), reply="Water near the plug is dangerous.", safety_stop="electrical"))
    assert resp.outcome == "SAFETY_STOP"
    assert resp.safety["stopUse"] is True
    assert resp.message == "Water near the plug is dangerous."


def test_shadow_degraded_or_absent_canonical_is_legacy():
    for rag, canonical in ((J1Rag(action(), control=False), BLOCK), (J1Rag(action(), degraded="merge_failed"), BLOCK),
                           (J1Rag(action()), None)):
        resp = run(rag, canonical=canonical)
        assert "canonicalControl" not in resp.debug
        legacy = Orchestrator(FakeErrorCodeService(CANNED), FakeDiagnosticService(), InMemoryStateStore()).handle_turn(
            TurnInput(message=MSG, sessionId="s1"))
        assert resp.message == legacy.message
        assert resp.outcome == legacy.outcome


class J2Rag(J1Rag):
    """The same transport for another registry journey key."""
    def __init__(self, next_action, key="wm-not-spinning", **kw):
        super().__init__(next_action, **kw)
        self.key = key

    def understand(self, *, symptoms, image=None, conversation=None, established=None, canonical=None):
        out = super().understand(symptoms=symptoms, image=image, conversation=conversation, established=established, canonical=canonical)
        if "canonical" in out:
            out["canonical"]["journey"] = {**out["canonical"]["journey"], "key": self.key}
        return out


def test_journey2_control_uses_generic_journey_field():
    a = action("ask_check", "empty-spin-test", "S12")
    a["journey"] = "wm-not-spinning"
    resp = run(J2Rag(a, reply="Take the washing out and run a spin with the drum empty. Does it spin up properly?"),
               message="my washing machine drains but won't spin")
    assert resp.debug["canonicalControl"] == "wm-not-spinning"
    assert resp.message.startswith("Take the washing out")
    assert "journeyStage" not in resp.debug


def test_journey2_conclusion_area_and_label():
    concl = {"cause": "load-imbalance", "level": "cause_family", "confidence": "likely", "handoff": "none"}
    resp = run(J2Rag(action("conclude", "load-imbalance", "S9", conclusion=concl), reply="That points to an out-of-balance load."),
               message="it spins fine now with a mixed load")
    assert resp.diagnosis.summary == "Out-of-balance load"
    assert resp.diagnosis.likelyArea == "motor-drum"
    assert resp.parts is None


def test_unknown_journey_key_is_legacy():
    resp = run(J2Rag(action(), key="wm-something-else"))
    assert "canonicalControl" not in resp.debug


def test_missing_key_or_retired_journey1_field_is_legacy():
    class NoKey(J1Rag):
        def understand(self, **kw):
            out = super().understand(**kw)
            j = out["canonical"].pop("journey")
            if self.mode == "nokey":
                out["canonical"]["journey"] = {k: v for k, v in j.items() if k != "key"}
            else:
                out["canonical"]["journey1"] = j     # the retired migration field is not read any more
            return out
    for mode in ("nokey", "journey1"):
        rag = NoKey(action())
        rag.mode = mode
        assert "canonicalControl" not in run(rag).debug


def test_journey_map_is_the_shared_registry():
    reg = json.loads((pathlib.Path(__file__).resolve().parents[2] / "services/part-finder/canonical/journeys.json").read_text())
    want = {j["key"]: j["faultId"] for j in reg["journeys"]}
    assert len(want) == 63
    assert Orchestrator._CANONICAL_JOURNEYS == want


def test_dockerfile_ships_the_registry():
    df = (pathlib.Path(__file__).resolve().parents[1] / "deploy/Dockerfile").read_text()
    assert "COPY services/part-finder/canonical/journeys.json ${LAMBDA_TASK_ROOT}/orchestration/canonical_journeys.json" in df


def test_journey3_control_ask_uses_nextaction_wording_only():
    a = action("ask_check", "door-seal", "L8")
    a["journey"] = "wm-leaking"
    resp = run(J2Rag(a, key="wm-leaking", reply="Switch the machine off and unplug it first. Is the door seal intact, trapped, or torn?"),
               message="my washing machine is leaking from the front")
    assert resp.debug["canonicalControl"] == "wm-leaking"
    assert resp.message.startswith("Switch the machine off")


def test_journey3_backflow_conclusion_area_label_no_part():
    concl = {"cause": "household-backflow", "level": "cause_family", "confidence": "likely", "handoff": "plumbing", "noPart": True}
    resp = run(J2Rag(action("conclude", "household-backflow", "L5", conclusion=concl), key="wm-leaking",
                     reply="The blockage is in the household waste plumbing, not the machine."),
               message="the sink backs up when it drains")
    assert resp.diagnosis.summary == "Household waste plumbing"
    assert resp.diagnosis.likelyArea == "leak-drain"
    assert resp.parts is None


def test_batch2_journey_keys_control_with_area_and_label():
    cases = [("wm-not-filling", "household-supply", "F5", "inlet-valve", "Household water supply"),
             ("wm-overfilling", "level-sensing-or-control", "O22", "inlet-valve", "Level sensing / control"),
             ("wm-door", "normal-release-delay", "D5", "door-lock", "Normal door-lock delay"),
             ("wm-excessive-vibration", "transit-bolts", "V7", "excessive-vibration", "Transit bolts"),
             ("wm-noisy", "foreign-object", "N22", "motor-drum", "Object in the drum / tub"),
             ("wm-not-heating", "normal-low-temperature", "H22", "heater", "Normal low-temperature washing")]
    for key, cause, rule, area, label in cases:
        concl = {"cause": cause, "level": "cause_family", "confidence": "likely", "handoff": "none", "noPart": True}
        resp = run(J2Rag(action("conclude", cause, rule, conclusion=concl), key=key, reply="That explains it."), message="my washing machine has a problem")
        assert resp.debug["canonicalControl"] == key
        assert resp.diagnosis.summary == label
        assert resp.diagnosis.likelyArea == area
        assert resp.parts is None


def test_dishwasher_journey_keys_control_with_area_and_label():
    cases = [("dw-not-draining", "household-waste-or-spigot", "A5", "not-draining", "Household waste / sink spigot"),
             ("dw-not-filling", "household-supply", "B5", "fill", "Household water supply"),
             ("dw-leaking", "internal-leak", "K22", "leak-flood", "Internal leak (flood protection)"),
             ("dw-not-cleaning", "dirty-filter", "C7", "poor-clean-results", "Dirty filter"),
             ("dw-not-heating-drying", "normal-condensation-drying", "T22", "heating", "Normal condensation drying"),
             ("dw-door-not-starting", "start-control", "G22", "door", "Start control")]
    for key, cause, rule, area, label in cases:
        concl = {"cause": cause, "level": "cause_family", "confidence": "likely", "handoff": "none", "noPart": True}
        resp = run(J2Rag(action("conclude", cause, rule, conclusion=concl), key=key, reply="That explains it."), message="my dishwasher has a problem")
        assert resp.debug["canonicalControl"] == key
        assert resp.diagnosis.summary == label
        assert resp.diagnosis.likelyArea == area
        assert resp.parts is None


def test_fridge_and_tumble_dryer_journey_keys_control_with_area_and_label():
    cases = [("ff-not-cooling", "sealed-system-or-compressor", "FC22", "not-cooling", "Sealed cooling system"),
             ("ff-too-cold-freezing", "temperature-setting", "FX7", "over-cooling", "Temperature setting / mode"),
             ("ff-noisy", "normal-operating-noise", "FN5", "noisy", "Normal operating noise"),
             ("ff-leaking-water", "blocked-defrost-drain", "FL7", "drainage-blocked", "Blocked defrost drain"),
             ("ff-ice-frost-build-up", "defrost-system", "FI22", "defrost-system", "Defrost system"),
             ("ff-door-seal-door", "door-closes-fine", "FD22", "door-seal", "Door closes and seals"),
             ("ff-not-running-dead", "click-start-relay-or-compressor", "FP22", "compressor", "Compressor start device / compressor"),
             ("td-not-heating", "heat-pump-runs-cooler", "DH5", "not-heating", "Normal heat-pump drying"),
             ("td-not-drying", "condenser-blocked", "DD7", "poor-drying", "Clogged condenser"),
             ("td-drum-not-turning", "motor-or-control", "DT22", "motor", "Motor / control"),
             ("td-noisy", "foreign-object", "DN7", "noisy", "Object in the drum / tub"),
             ("td-stops-mid-cycle", "thermal-protection-or-thermostat", "DS22", "overheating", "Overheat protection / thermostat"),
             ("td-water-container-drain", "vented-no-container", "DW5", "not-emptying-condensate", "Vented dryer (no container)"),
             ("td-door-not-starting", "start-control", "DG22", "door", "Start control")]
    for key, cause, rule, area, label in cases:
        concl = {"cause": cause, "level": "cause_family", "confidence": "likely", "handoff": "none", "noPart": True}
        resp = run(J2Rag(action("conclude", cause, rule, conclusion=concl), key=key, reply="That explains it."), message="my appliance has a problem")
        assert resp.debug["canonicalControl"] == key
        assert resp.diagnosis.summary == label
        assert resp.diagnosis.likelyArea == area
        assert resp.parts is None


def test_final_pass_journey_keys_control_with_area_and_label():
    # one representative conclusion per new journey key (oven / hob / microwave / vacuum / washer-dryer)
    cases = [("oven-not-heating", "clock-or-auto-mode", "OH7", "element", "Clock / timer being in auto mode"),
             ("oven-overheating", "control-stuck-on", "OT5", "thermostat", "Control stuck on"),
             ("oven-grill-not-working", "grill-element", "OG22", "element", "Grill element"),
             ("oven-fan-not-working", "cooling-fan-run-on", "OF5", "fan-motor", "Cooling fan running on"),
             ("oven-dead-no-power", "supply-or-cooker-switch", "OD7", "control-panel", "Supply"),
             ("oven-door", "door-glass-cracked", "OR5", "door-hinge", "Cracked door glass"),
             ("oven-tripping", "wiring-terminal-or-control", "OP22", "tripping-electrics", "Wiring, terminal block or control"),
             ("cooker-ignition-gas", "flame-failure-device", "GC22", "ignition", "Flame-failure safety device"),
             ("hob-zone-not-heating", "pan-compatibility", "HZ7", "element", "Pan not suiting induction"),
             ("hob-no-power", "mains-connection-or-power-side", "HP22", "power-module", "Hob's mains connection or power side"),
             ("hob-overheating-control", "zone-stuck-on", "HO5", "overheating", "Zone stuck on"),
             ("hob-ignition-gas", "igniter-or-spark-unit", "GH22", "ignition", "Igniter / spark unit"),
             ("mw-not-heating", "high-voltage-heating-system", "MH22", "not-heating", "High-voltage heating system"),
             ("mw-not-starting", "control-or-child-lock", "MS7", "main-pcb", "Control / child lock"),
             ("mw-door", "door-hook-or-latch", "MD22", "door", "Broken door hook / latch"),
             ("mw-turntable", "turntable-motor", "MT22", "turntable", "Turntable motor"),
             ("mw-noisy-sparking", "metal-or-foil-inside", "MN7", "sparking-arcing", "Metal or foil inside"),
             ("mw-starts-when-door-closes", "door-interlock-or-control", "MC5", "door", "Door interlock or control"),
             ("vacuum-low-suction", "internal-seal-or-motor-area", "VS22", "lost-suction", "Internal seal or the motor area"),
             ("vacuum-pulsing-cutting-out", "bin-or-filters", "VP7", "cuts-out", "Full bin or clogged filters"),
             ("vacuum-not-running", "damaged-cable-stop-use", "VN5", "wont-run", "Damaged mains cable or plug"),
             ("vacuum-brush-not-turning", "floorhead-drive", "VB22", "brush-bar", "Floorhead's own drive or motor"),
             ("vacuum-battery-runtime", "boost-or-max-mode", "VR7", "cuts-out", "Boost / max mode"),
             ("vacuum-noisy", "motor-bearing-or-fan", "VY22", "motor", "Motor bearing or fan"),
             ("wd-not-drying", "drying-load-over-capacity", "WY7", "drying-poor", "Drying load bigger than the dry capacity"),
             ("wd-not-draining", "filter-blockage", "R7", "not-draining", "Blocked pump filter"),
             ("wd-not-spinning", "load-imbalance", "S7", "motor-drum", "Out-of-balance load"),
             ("wd-leaking", "door-seal", "L7", "leak-flood", "Door seal"),
             ("wd-not-filling", "tap-or-fill-hose", "F7", "inlet-valve", "Tap / fill hose"),
             ("wd-overfilling", "drain-hose-siphon", "O7", "inlet-valve", "Drain hose installation (siphon)"),
             ("wd-door", "child-lock", "D7", "door-lock", "Child lock"),
             ("wd-excessive-vibration", "transit-bolts", "V7", "excessive-vibration", "Transit bolts"),
             ("wd-noisy", "foreign-object", "N7", "motor-drum", "Object in the drum / tub"),
             ("wd-not-heating-wash", "heater-element", "H22", "heater", "Heater element")]
    for key, cause, rule, area, label in cases:
        concl = {"cause": cause, "level": "cause_family", "confidence": "likely", "handoff": "none", "noPart": True}
        resp = run(J2Rag(action("conclude", cause, rule, conclusion=concl), key=key, reply="That explains it."), message="my appliance has a problem")
        assert resp.debug["canonicalControl"] == key
        assert resp.diagnosis.summary == label
        assert resp.diagnosis.likelyArea == area
        assert resp.parts is None
