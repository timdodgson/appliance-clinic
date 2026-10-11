"""Test helpers for ADR 0014: the orchestrator keeps no conversation state, so a multi-turn test carries cs/1 between
turns the way whichpart-api does (it persists the merged state part-finder returns and sends it back as the next
turn's canonical block).

  FakeBff(orchestrator)  wraps an orchestrator: handle_turn() adds the session's canonical block and keeps the merged
                         state the (fake) engine returns. Every other attribute is the orchestrator's.
  cs1_state(...)         a cs/1 state with the given identity / safety / problem, for single-turn tests of a prior.
  fake_merge(...)        a small stand-in for part-finder's merge (canonical/merge.js): identity, displayed codes,
                         model status, problems and safety from the fake engine's typed output. Fakes only.
"""
from orchestration.tests.engine_token import token_decision, with_engine_token_decision
import copy, inspect
from orchestration import routing
from orchestration.model import TurnInput, Outcome

CSID = "cs_" + "f" * 32
# Jev's safetySignificance choices -> the cs/1 hazard and level the merge records (merge M14).
_SAFETY = {"gas_smell": ("gas_smell", "EMERGENCY_ACTION"), "gas_escape": ("gas_escape", "EMERGENCY_ACTION"),
           "electric_shock": ("electric_shock", "STOP_USE"), "electrical_water": ("electrical_water", "STOP_USE"),
           "burning": ("burning", "STOP_USE"), "supply_trip": ("supply_trip", "STOP_USE")}
# mc/1 types an unsafe request (safety.unsafeAction, merge M15); the fake reads the same request phrases the fake
# diagnose service treats as unsafe.
_UNSAFE = (("test the element live", "live_electrical_test"), ("test it live", "live_electrical_test"),
           ("live terminals", "live_electrical_test"), ("bypass the", "bypass_safety_device"),
           ("keep resetting the rcd", "repeated_reset_after_trip"), ("discharge the capacitor", "hv_microwave_work"),
           ("re-gas", "refrigerant_work"), ("regas", "refrigerant_work"),
           ("while it's plugged in", "open_while_powered"), ("while its plugged in", "open_while_powered"))
_REAL_SYMPTOM = lambda fam: bool(fam) and fam not in ("none", "uncertain", "error_display")


def _fact(value, basis, turn, **extra):
    return {"value": value, "basis": basis, "turn": turn, "status": "active", "history": [], **extra}


def cs1_state(appliance=None, establishment=None, make=None, model=None, model_confirmed=True, codes=(),
              model_status=None, safety_level=None, hazards=(), problem=False, version=1, token=None):
    empty = lambda **x: {"value": None, "basis": None, "turn": None, "status": "active", "history": [], **x}
    basis = {"established": "stated", "working": "inferred"}.get(establishment)
    return {
        "schemaVersion": "cs/1", "sessionId": CSID, "version": version,
        "identity": {
            "appliance": _fact(appliance, basis, 1) if appliance else empty(),
            "applianceEstablishment": establishment if appliance else "unknown",
            "make": _fact(make, "stated", 1) if make else empty(),
            "model": _fact(model, "stated" if model_confirmed else "read_from_image", 1, confirmed=model_confirmed) if model else empty(confirmed=False),
            "modelStatus": model_status or ("known" if model and model_confirmed else None),
            "fuel": empty(conflict=False),
            "displayedCodes": [_fact(c, "stated", 1) for c in codes],
            "unconfirmedToken": _fact(token, "stated", 1) if token else empty(),
        },
        "intent": {"active": "report_fault" if problem else None, "history": [{"intent": "report_fault", "turn": 1}] if problem else []},
        "problems": [{"id": "p1", "status": "active"}] if problem else [],
        "evidence": {"observations": {}, "checks": {}, "replacedParts": [], "customerTheories": []},
        "declined": [],
        "safety": {"hazards": [{"hazard": h, "turn": 1, "status": "active"} for h in hazards],
                   "activeLevel": safety_level or "NORMAL_DIAGNOSTIC", "peakLevel": safety_level or "NORMAL_DIAGNOSTIC",
                   "unsafeActions": []},
        "resolution": None, "requests": [], "pendingRequest": None, "inferred": {},
    }


def block(state, version=None, csid=CSID, mode="shadow"):
    return {"schema": "cs/1", "mode": mode, "sessionId": csid,
            "version": version if version is not None else ((state or {}).get("version") or 0),
            "state": state, "degraded": None}


def fake_merge(prior, res, turn, message):
    s = copy.deepcopy(prior) if isinstance(prior, dict) else cs1_state()
    s["version"] = turn
    raw = (res or {}).get("understand") or {}
    dec = ((res or {}).get("jev") or {}).get("decisions") or {}
    ident = s["identity"]
    fam = raw.get("applianceType")
    prov = dec.get("applianceFamilyProvenance") or raw.get("_applianceFamilyProvenance")
    if fam:
        cur = ident["appliance"]
        stated = prov == "customer_named"
        if not cur.get("value") or (stated and (cur.get("value") != fam or cur.get("basis") != "stated")):
            ident["appliance"] = _fact(fam, "stated" if stated else "inferred", turn)
        ident["applianceEstablishment"] = "established" if ident["appliance"]["basis"] == "stated" else "working"
    make = raw.get("make") or routing.detect_make(message or "", None)
    if make and not ident["make"].get("value"):
        ident["make"] = _fact(make, "stated", turn)
    # canonical/token-gate.js: a weak model reading is held, not committed; an answer commits the held token.
    meaning = raw.get("_tokenMeaning") or dec.get("candidateTokenMeaning")
    probs = (((res or {}).get("jev") or {}).get("probabilities") or {}).get("candidateTokenMeaning")
    held = (ident.get("unconfirmedToken") or {}).get("value")
    code_in = raw.get("errorCode")
    if raw.get("model") and meaning in (None, "model"):
        if token_decision("model", probs)["decision"] == "uncertain":
            ident["unconfirmedToken"] = _fact(raw["model"], "stated", turn)
        else:
            ident["model"] = _fact(raw["model"], "stated", turn, confirmed=True)
            ident["modelStatus"] = "known"
            ident["unconfirmedToken"] = _fact(None, None, None)
    elif held and (meaning == "error_code" or code_in or dec.get("symptomFamily") == "error_display"):
        code_in = code_in or held
        ident["unconfirmedToken"] = _fact(None, None, None)
    if code_in:
        code = routing._collapse_code(code_in)
        active = [f for f in ident["displayedCodes"] if f["status"] == "active"]
        if not active or active[-1]["value"] != code:
            for f in active:
                f["status"] = "superseded"
            ident["displayedCodes"].append(_fact(code, "stated", turn))
    # mc/1 types modelStatus from the customer's words (a cannot-answer to the model ask -> unavailable); merge M9.
    if (raw.get("modelUnavailable") or dec.get("_mc1ModelStatus") == "unavailable") and not ident["model"].get("confirmed"):
        ident["modelStatus"] = "unavailable"
    if (raw.get("fault") or _REAL_SYMPTOM(dec.get("symptomFamily"))) and not any(p["status"] == "active" for p in s["problems"]):
        s["problems"].append({"id": f"p{turn}", "status": "active"})
        s["intent"]["history"].append({"intent": "report_fault", "turn": turn})
    low = (message or "").lower()
    unsafe = next((a for cue, a in _UNSAFE if cue in low), None)
    if unsafe:
        s["safety"]["unsafeActions"].append({"action": unsafe, "turn": turn})
    if raw.get("_problemJourney") and not any(p["status"] == "active" for p in s["problems"]):
        s["problems"].append({"id": f"p{turn}", "status": "active"})
    for p in s["problems"]:
        if p["status"] == "active" and raw.get("_problemJourney"):
            p["journey"] = _fact(raw["_problemJourney"], "stated", turn)
    hz = _SAFETY.get(dec.get("safetySignificance"))
    if hz:
        s["safety"]["hazards"].append({"hazard": hz[0], "turn": turn, "status": "active"})
        s["safety"]["activeLevel"] = s["safety"]["peakLevel"] = hz[1]
    return s


def _accepts(fn, name):
    try:
        params = inspect.signature(fn).parameters
    except (TypeError, ValueError):
        return True
    return name in params or any(p.kind == p.VAR_KEYWORD for p in params.values())


class FakeBff:
    """whichpart-api's part in a multi-turn test: one cs/1 state per session, sent with each turn, replaced by the
    merged state the engine returns. A degraded or unavailable turn leaves it unchanged (ADR 0016)."""

    def __init__(self, orchestrator):
        self._o = orchestrator
        self.sessions = {}
        rag = orchestrator.rag
        inner_u, inner_d = rag.understand, rag.diagnose
        u_takes, d_takes = _accepts(inner_u, "canonical"), _accepts(inner_d, "canonical")

        def understand(**kw):
            canon = kw.pop("canonical", None)
            res = inner_u(canonical=canon, **kw) if (u_takes and canon is not None) else inner_u(**kw)
            res = with_engine_token_decision(res)   # the engine's own token decision, as part-finder adds it
            if isinstance(res, dict) and isinstance(canon, dict) and "canonical" not in res:
                nxt = (canon.get("version") or 0) + 1
                res = {**res, "canonical": {"schema": "cs/1", "mode": canon.get("mode", "shadow"),
                                            "sessionId": canon.get("sessionId"), "priorVersion": canon.get("version"),
                                            "version": nxt, "state": fake_merge(canon.get("state"), res, nxt, kw.get("symptoms")),
                                            "classification": None, "rulesFired": [], "degraded": None}}
            return res

        def diagnose(**kw):
            if not d_takes:
                kw.pop("canonical", None)
            return inner_d(**kw)
        rag.understand, rag.diagnose = understand, diagnose
        self.last_state = None
        inner_load = orchestrator._load

        def load(turn):
            self.last_state = inner_load(turn)
            return self.last_state
        orchestrator._load = load

    def __getattr__(self, name):
        return getattr(self._o, name)

    def state(self, session_id):
        return self.sessions.get(session_id)

    def handle_turn(self, turn: TurnInput):
        if getattr(turn, "canonical", None) is None:
            turn.canonical = block(self.sessions.get(turn.sessionId))
        resp = self._o.handle_turn(turn)
        out = (resp.debug or {}).get("canonical")
        if (isinstance(out, dict) and not out.get("degraded") and isinstance(out.get("state"), dict)
                and resp.outcome != Outcome.SERVICE_UNAVAILABLE.value):
            self.sessions[turn.sessionId] = out["state"]
        return resp
