"""ADR 0017 / 0019: every orchestrator call to the diagnosis engine carries the HMAC engine signature, and is SigV4-signed
for the engine's AWS_IAM Function URL when role credentials exist. No network.
Run: PYTHONPATH=. python3 -m pytest orchestration/tests/test_engine_request_signing.py -q
"""
import sys
import types

from orchestration import services
from orchestration.services import RealDiagnosticService, ENGINE_SIGNATURE_HEADER


class _Resp:
    status_code = 200
    text = '{"type":"understand","understand":{},"jev":{}}\n'

    def raise_for_status(self):
        return None


class _Httpx:
    def __init__(self):
        self.calls = []

    def post(self, url, content=None, timeout=None, headers=None):
        self.calls.append({"url": url, "content": content, "headers": dict(headers or {})})
        return _Resp()


def test_engine_url_comes_from_diagnosis_engine_url(monkeypatch):
    monkeypatch.setenv("DIAGNOSIS_ENGINE_URL", "https://engine.example")
    monkeypatch.delenv("RAG_URL", raising=False)
    assert RealDiagnosticService().url == "https://engine.example/"


def test_post_carries_hmac_and_iam_signature(monkeypatch):
    monkeypatch.setenv("ENGINE_SIGNING_TOKEN", "k" * 40)
    seen = {}

    def fake_iam(url, body, headers):
        seen["hmac_present"] = ENGINE_SIGNATURE_HEADER in headers   # SigV4 is applied after the HMAC header
        return {**headers, "Authorization": "AWS4-HMAC-SHA256 test"}

    monkeypatch.setattr(services, "aws_iam_headers", fake_iam)
    h = _Httpx()
    RealDiagnosticService(url="https://engine.example")._post(h, {"messages": []})
    sent = h.calls[0]["headers"]
    assert seen["hmac_present"] is True
    assert sent[ENGINE_SIGNATURE_HEADER].startswith("t=")
    assert sent["Authorization"] == "AWS4-HMAC-SHA256 test"


def test_without_credentials_headers_are_unchanged(monkeypatch):
    # A botocore stand-in whose session has no credentials.
    session = types.SimpleNamespace(get_session=lambda: types.SimpleNamespace(get_credentials=lambda: None))
    auth = types.SimpleNamespace(SigV4Auth=object)
    req = types.SimpleNamespace(AWSRequest=object)
    monkeypatch.setitem(sys.modules, "botocore", types.SimpleNamespace(session=session))
    monkeypatch.setitem(sys.modules, "botocore.session", session)
    monkeypatch.setitem(sys.modules, "botocore.auth", auth)
    monkeypatch.setitem(sys.modules, "botocore.awsrequest", req)
    assert services.aws_iam_headers("https://engine.example/", b"{}", {"a": "1"}) == {"a": "1"}
