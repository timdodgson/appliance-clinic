"""STAGE C — canonical cs/1 transport through the orchestrator (SHADOW ONLY).

Proves, with no network and no real Jev:
  * the BFF's canonical block is forwarded verbatim to understand()
  * part-finder's canonical result is returned unchanged (same sessionId) in debug["canonical"]
  * a missing / mismatched result degrades the envelope, never the customer turn
  * diagnose() receives the merged result only when it is not degraded (trace only)
  * routing, outcome and customer message are IDENTICAL with and without canonical
  * the orchestrator never persists canonical state, and customer_view() never exposes it
  * services that predate Stage C (no `canonical` kwarg) still work when no block is sent
Run: PYTHONPATH=. python3 -m pytest orchestration/tests/test_canonical_passthrough.py -q
"""
import copy
import importlib
import json
import os
import sys

from orchestration.model import TurnInput
from orchestration.services import FakeErrorCodeService, FakeDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator
from orchestration.tests.fixtures import CANNED

CSID = "cs_" + "A" * 32
BLOCK = {"schema": "cs/1", "mode": "shadow", "sessionId": CSID, "version": 2,
         "state": {"schemaVersion": "cs/1", "sessionId": CSID, "version": 2, "facts": {"x": 1}},
         "degraded": None}


def merged_result(block):
    return {"schema": "cs/1", "mode": "shadow", "sessionId": block["sessionId"],
            "priorVersion": block["version"], "version": block["version"] + 1,
            "state": {"schemaVersion": "cs/1", "sessionId": block["sessionId"],
                      "version": block["version"] + 1, "facts": {"x": 2}},
            "classification": {"schema": "mc/1"}, "rulesFired": ["R1"], "degraded": None}


class StubRag(FakeDiagnosticService):
    """FakeDiagnosticService + recording of the canonical kwarg. `reply` controls what the
    understand() canonical result looks like: 'merge' | 'none' | 'mismatch' | 'unavailable'."""
    def __init__(self, reply="merge"):
        self.reply = reply
        self.understand_canonical = []
        self.diagnose_canonical = []

    def understand(self, *, symptoms, image=None, conversation=None, established=None, canonical=None):
        self.understand_canonical.append(copy.deepcopy(canonical))
        if self.reply == "unavailable":
            from orchestration.services import RagUnavailable
            raise RagUnavailable("down")
        out = super().understand(symptoms=symptoms, image=image, conversation=conversation,
                                 established=established)
        if canonical is not None and self.reply == "merge":
            out["canonical"] = merged_result(canonical)
        elif canonical is not None and self.reply == "mismatch":
            r = merged_result(canonical)
            r["sessionId"] = "cs_" + "B" * 32
            out["canonical"] = r
        return out

    def diagnose(self, *, canonical=None, **kw):
        self.diagnose_canonical.append(copy.deepcopy(canonical))
        return super().diagnose(**kw)


class LegacyRag(FakeDiagnosticService):
    """A pre-Stage-C service: rejects any `canonical` kwarg (TypeError)."""
    def understand(self, *, symptoms, image=None, conversation=None, established=None):
        return super().understand(symptoms=symptoms, image=image, conversation=conversation,
                                  established=established)

    def diagnose(self, *, symptoms, appliance=None, make=None, trusted=None, image=None,
                 conversation=None, understand=None, established=None):
        return super().diagnose(symptoms=symptoms, appliance=appliance, make=make, trusted=trusted,
                                image=image, conversation=conversation, understand=understand,
                                established=established)


MSG = "my washing machine won't drain, water sits in the drum"


def run(rag, canonical=None, session="s1", message=MSG):
    store = InMemoryStateStore()
    orch = Orchestrator(FakeErrorCodeService(CANNED), rag, store)
    resp = orch.handle_turn(TurnInput(message=message, sessionId=session, canonical=canonical))
    return resp, store


def test_block_forwarded_verbatim_to_understand():
    rag = StubRag()
    block = copy.deepcopy(BLOCK)
    run(rag, canonical=block)
    assert rag.understand_canonical == [BLOCK]
    assert block == BLOCK  # not mutated


def test_result_returned_unchanged_with_same_session():
    rag = StubRag()
    resp, _ = run(rag, canonical=copy.deepcopy(BLOCK))
    assert resp.debug["canonical"] == merged_result(BLOCK)
    assert resp.debug["canonical"]["sessionId"] == CSID


def test_diagnose_receives_merged_result_for_trace():
    rag = StubRag()
    run(rag, canonical=copy.deepcopy(BLOCK))
    assert rag.diagnose_canonical, "the symptom turn must reach diagnose"
    assert all(c == merged_result(BLOCK) for c in rag.diagnose_canonical)


def test_missing_result_degrades_envelope_only():
    rag = StubRag(reply="none")
    resp, _ = run(rag, canonical=copy.deepcopy(BLOCK))
    c = resp.debug["canonical"]
    assert c["degraded"] == "understand_no_canonical"
    assert c["sessionId"] == CSID and c["state"] is None
    assert all(x is None for x in rag.diagnose_canonical)  # degraded -> not forwarded


def test_session_mismatch_degrades():
    resp, _ = run(StubRag(reply="mismatch"), canonical=copy.deepcopy(BLOCK))
    assert resp.debug["canonical"]["degraded"] == "session_mismatch"


def test_understand_unavailable_degrades():
    resp, _ = run(StubRag(reply="unavailable"), canonical=copy.deepcopy(BLOCK))
    assert resp.debug["canonical"]["degraded"] == "understand_unavailable"


def test_no_block_means_no_kwarg_and_no_debug_key():
    rag = StubRag()
    resp, _ = run(rag, canonical=None)
    assert rag.understand_canonical == [None]
    assert all(c is None for c in rag.diagnose_canonical)
    assert "canonical" not in resp.debug


def test_legacy_service_unaffected_without_block():
    resp, _ = run(LegacyRag(), canonical=None)
    assert resp.outcome and resp.message


def test_routing_and_customer_output_identical_with_and_without_canonical():
    for message in (MSG, "Bosch dishwasher E15", "hello", "I can smell gas from my oven"):
        a, _ = run(StubRag(), canonical=None, message=message)
        b, _ = run(StubRag(), canonical=copy.deepcopy(BLOCK), message=message)
        assert a.route == b.route, message
        assert a.outcome == b.outcome, message
        assert a.customer_view() == b.customer_view(), message


def test_customer_view_never_exposes_canonical():
    resp, _ = run(StubRag(), canonical=copy.deepcopy(BLOCK))
    view = json.dumps(resp.customer_view())
    assert "canonical" not in view and CSID not in view


def test_orchestrator_store_does_not_persist_canonical():
    resp, store = run(StubRag(), canonical=copy.deepcopy(BLOCK))
    st = store.get("s1")
    # The orchestrator's own state object carries no canonical fields beyond the per-turn
    # transport slot, which _load() overwrites every turn.
    persisted = {k: v for k, v in vars(st).items() if "canonical" in k.lower()}
    assert set(persisted) <= {"_canonical"}
    rag = StubRag()
    orch = Orchestrator(FakeErrorCodeService(CANNED), rag, store)
    nxt = orch.handle_turn(TurnInput(message="still not draining", sessionId="s1"))
    assert "canonical" not in nxt.debug  # no carry-over from the previous turn's block
    assert rag.understand_canonical == [None]


def _load_handler():
    os.environ.setdefault("ORCH_BEARER_TOKEN", "test-token")
    os.environ.setdefault("RAG_URL", "http://localhost/")
    os.environ.setdefault("MCP_URL", "http://localhost/")
    os.environ.setdefault("MCP_BEARER_TOKEN", "test-mcp-token")
    sys.modules.pop("orchestration.deploy.lambda_handler", None)
    return importlib.import_module("orchestration.deploy.lambda_handler")


def test_lambda_canonical_in_envelope_check():
    h = _load_handler()
    assert h._canonical_in(copy.deepcopy(BLOCK)) == BLOCK
    assert h._canonical_in(None) is None
    assert h._canonical_in({"schema": "cs/2", "sessionId": CSID, "version": 0}) is None
    assert h._canonical_in({"schema": "cs/1", "sessionId": 5, "version": 0}) is None
    assert h._canonical_in({"schema": "cs/1", "sessionId": CSID, "version": "1"}) is None
    assert h._canonical_in("cs/1") is None


def test_lambda_returns_canonical_only_when_sent():
    h = _load_handler()
    h.ORCH = Orchestrator(FakeErrorCodeService(CANNED), StubRag(), InMemoryStateStore())
    hdr = {"authorization": "Bearer " + os.environ["ORCH_BEARER_TOKEN"]}

    def call(body):
        ev = {"rawPath": "/diagnose", "requestContext": {"http": {"method": "POST", "path": "/diagnose"}},
              "headers": hdr, "body": json.dumps(body)}
        return json.loads(h.handler(ev, None)["body"])

    with_c = call({"message": MSG, "sessionId": "s2", "canonical": copy.deepcopy(BLOCK)})
    without = call({"message": MSG, "sessionId": "s3"})
    assert with_c["_canonical"] == merged_result(BLOCK)
    assert "_canonical" not in without
    strip = lambda d: {k: v for k, v in d.items() if k not in ("_canonical", "_diagnosticTrace")}
    assert strip(with_c) == strip(without)
