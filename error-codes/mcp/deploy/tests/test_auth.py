#!/usr/bin/env python3
"""Local bearer-auth E2E for the deployable ASGI app (real uvicorn + real MCP client).

Spawns `uvicorn asgi:app` with a test token, then verifies over real HTTP:
  - /health is unauthenticated and enriched
  - missing / malformed / wrong bearer -> 401
  - correct bearer -> initialize, tools/list, tool call all succeed
  - the token never appears in server logs

Run: error-codes/mcp/.venv/bin/python error-codes/mcp/deploy/tests/test_auth.py
"""
import os, sys, time, json, subprocess, contextlib, asyncio

HERE = os.path.dirname(os.path.abspath(__file__))
DEPLOY = os.path.dirname(HERE)
MCP = os.path.dirname(DEPLOY)
PYBIN = os.path.join(MCP, ".venv", "bin", "python")
HOST, PORT = "127.0.0.1", 8815
BASE = f"http://{HOST}:{PORT}"
URL = f"{BASE}/mcp"
TOKEN = "test-secret-token-do-not-commit-1234567890"

import httpx
from mcp.client.streamable_http import streamable_http_client
from mcp.client.session import ClientSession

passed = 0; failed = 0
def check(n, cond, detail=""):
    global passed, failed
    ok = bool(cond); passed += ok; failed += (not ok)
    print(("  ok  " if ok else "  FAIL") + f" {n}" + ("" if ok else f"  :: {detail}"))

def _wait_health(timeout=40):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            r = httpx.get(f"{BASE}/health", timeout=2)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        time.sleep(0.3)
    raise RuntimeError("server did not become healthy")

async def _client_call(token):
    """initialize + tools/list + one tool call using a bearer token; returns (names, status)."""
    hc = httpx.AsyncClient(headers={"Authorization": f"Bearer {token}"})
    async with streamable_http_client(URL, http_client=hc) as (r, w):
        async with ClientSession(r, w) as s:
            await s.initialize()
            tl = await s.list_tools()
            names = sorted(t.name for t in tl.tools)
            res = await s.call_tool("resolve-error-code", {"make": "Bosch", "appliance": "dishwasher", "code": "E15"})
            sc = getattr(res, "structured_content", None) or {}
            if set(sc.keys()) == {"result"}:
                sc = sc["result"]
            return names, sc.get("status")

def main():
    env = dict(os.environ, MCP_BEARER_TOKEN=TOKEN)
    proc = subprocess.Popen(
        [PYBIN, "-m", "uvicorn", "asgi:app", "--host", HOST, "--port", str(PORT), "--log-level", "info"],
        cwd=DEPLOY, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        health = _wait_health()
        check("health unauthenticated + enriched",
              health.get("status") == "ok" and health.get("service") == "error-code-mcp"
              and health.get("mappingCount") == 847 and len(health.get("datasetV1Hash", "")) == 12,
              json.dumps(health))

        # 1 no Authorization header -> 401
        r = httpx.post(URL, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                       headers={"content-type": "application/json", "accept": "application/json, text/event-stream"}, timeout=5)
        check("1 no auth header -> 401", r.status_code == 401, str(r.status_code))
        # 2 malformed header -> 401
        r = httpx.post(URL, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                       headers={"authorization": "Token abc", "content-type": "application/json"}, timeout=5)
        check("2 malformed header -> 401", r.status_code == 401, str(r.status_code))
        # 3 wrong bearer -> 401
        r = httpx.post(URL, json={"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                       headers={"authorization": "Bearer wrong-token", "content-type": "application/json"}, timeout=5)
        check("3 wrong bearer -> 401", r.status_code == 401, str(r.status_code))
        # 4-6 correct bearer -> initialize + tools/list + tool call
        names, status = asyncio.run(_client_call(TOKEN))
        check("4 correct bearer -> initialize+tools/list", names == ["resolve-appliance-context", "resolve-error-code"], str(names))
        check("5 hidden evidence tool absent", "get-error-code-evidence" not in names)
        check("6 correct bearer -> tool call RESOLVED", status == "RESOLVED", str(status))
        # 8 /health still ok
        check("8 /health behaviour ok", httpx.get(f"{BASE}/health", timeout=3).status_code == 200)
    finally:
        proc.terminate()
        try:
            out = proc.communicate(timeout=6)[0]
        except Exception:
            out = ""
    # 7 token must not appear in logs
    check("7 token not in server logs", TOKEN not in (out or ""), "TOKEN LEAKED IN LOGS")

    print(f"\nError-Code MCP auth (local) : {passed} passed / {failed} failed  (total {passed+failed})")
    sys.exit(1 if failed else 0)

if __name__ == "__main__":
    main()
