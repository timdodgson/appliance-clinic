"""ADR 0017: the orchestrator signs every engine request (understand and diagnose) over the exact bytes it sends."""
import hashlib, hmac, os, sys
from orchestration.services import RealDiagnosticService, engine_signature, ENGINE_SIGNATURE_HEADER

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

KEY = "k" * 48
class R:
    def __init__(self, code): self.status_code, self.text = code, '{"type":"understand","jev":{},"understand":{}}'
    def raise_for_status(self):
        if self.status_code >= 400: raise RuntimeError(f"HTTP {self.status_code}")
class FakeHttpx:
    def __init__(self, codes): self.codes, self.calls = list(codes), []
    def post(self, url, **k):
        self.calls.append(k); return R(self.codes.pop(0))

def verify(header, body, key=KEY):
    parts = dict(p.split("=", 1) for p in header.split(","))
    mac = hmac.new(key.encode(), f"{parts['t']}.".encode() + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(mac, parts["v1"])

os.environ["ENGINE_SIGNING_TOKEN"] = KEY
svc = RealDiagnosticService.__new__(RealDiagnosticService); svc.url, svc.timeout, svc.seed = "http://x/", 1, 42
svc.THROTTLE_RETRY_S = 0
fx = FakeHttpx([200])
svc._post(fx, {"messages": [{"role": "user", "content": "x"}], "mode": "understand", "canonical": {"schema": "cs/1"}})
call = fx.calls[0]
check("the request carries the signature header", ENGINE_SIGNATURE_HEADER in call["headers"], call["headers"])
check("the signature covers the exact bytes sent", verify(call["headers"][ENGINE_SIGNATURE_HEADER], call["content"]))
check("the body is sent as those bytes (not re-serialised by the client)", isinstance(call["content"], bytes) and "json" not in call)
check("a tampered body would not verify", not verify(call["headers"][ENGINE_SIGNATURE_HEADER], call["content"].replace(b"understand", b"understane")))

fx = FakeHttpx([429, 200]); svc._post(fx, {"messages": []})
check("a throttled request is re-signed on retry", len(fx.calls) == 2 and all(verify(c["headers"][ENGINE_SIGNATURE_HEADER], c["content"]) for c in fx.calls))

check("the same signer the engine verifies (fixed vector)",
      engine_signature(b'{"messages":[{"role":"user","content":"x"}],"mode":"understand"}', key="k0123456789abcdef0123456789abcdef0123456789abcdef", now=1760000000)
      == "t=1760000000,v1=80dcc066b6ae45059ddfceef809cdc8475691b38ed215bddc136a83e6acbba18")

del os.environ["ENGINE_SIGNING_TOKEN"]
fx = FakeHttpx([200]); svc._post(fx, {"messages": []})
check("without a key the request is unsigned (the engine then refuses it, 401)", ENGINE_SIGNATURE_HEADER not in fx.calls[0]["headers"])
check("the secret never appears in the request", KEY.encode() not in fx.calls[0]["content"])

print(f"\nEngine signing: {passed} passed / {failed} failed  (total {passed + failed})")
sys.exit(0 if failed == 0 else 1)
