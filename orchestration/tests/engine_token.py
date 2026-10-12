"""The engine's code-or-model token decision for offline tests, computed by the engine itself.

canonical/token-gate.js is the only implementation of the commit rule (Phase 12). Tests that stand in for the engine
ask it through Node instead of copying the thresholds into Python, so a test cannot drift from the engine.
"""
import functools
import json
import os
import subprocess

_GATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "services", "diagnosis-engine", "canonical", "token-gate.js")


@functools.lru_cache(maxsize=None)
def _decide(meaning, probs_json):
    script = ("const t = require(process.argv[1]);"
              "const [meaning, probs] = JSON.parse(process.argv[2]);"
              "process.stdout.write(JSON.stringify(t.tokenDecision({ meaning, probabilities: probs })));")
    out = subprocess.run(["node", "-e", script, os.path.abspath(_GATE), json.dumps([meaning, json.loads(probs_json)])],
                         check=True, capture_output=True, text=True).stdout
    return json.loads(out)


def token_decision(meaning, probabilities):
    """The engine's {meaning, decision, reason} for a token meaning and Jev's candidateTokenMeaning distribution."""
    return dict(_decide(meaning, json.dumps(probabilities or None, sort_keys=True)))


def with_engine_token_decision(res):
    """An understand result as the engine returns it: the intent carries the engine's tokenDecision
    (services/diagnosis-engine/handler.js, understand mode, sets it on the intent object). One that already carries it is left alone."""
    if not isinstance(res, dict) or not isinstance(res.get("understand"), dict) or "tokenDecision" in res["understand"]:
        return res
    raw, jev = res["understand"], res.get("jev") or {}
    meaning = raw.get("_tokenMeaning") or (jev.get("decisions") or {}).get("candidateTokenMeaning")
    probs = (jev.get("probabilities") or {}).get("candidateTokenMeaning")
    raw["tokenDecision"] = token_decision(meaning, probs)   # set on the intent itself, as the engine does
    return res
