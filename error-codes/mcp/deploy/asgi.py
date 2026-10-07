#!/usr/bin/env python3
"""Deployable ASGI app for Error-Code MCP V1 — bearer auth + integrity + enriched /health.

This is a thin DEPLOYMENT wrapper around the banked MCP server (mcp_http_server.py). It does NOT
change any tool behaviour, schema, or response contract. It adds, at the HTTP/middleware layer:
  - startup artifact integrity check (fail fast if banked data doesn't match frozen hashes)
  - bearer-token auth on the MCP endpoint (/health stays unauthenticated)
  - an enriched, non-sensitive /health payload
  - minimal structured access logging (never logs the token or identifier bodies)

Served in STATELESS + JSON mode so it is correct behind Lambda/Function URL (each request is
independent; no cross-instance session state). Run: `uvicorn asgi:app`.
"""
import os, sys, json, time, hmac, uuid, logging

HERE = os.path.dirname(os.path.abspath(__file__))
MCP = os.path.dirname(HERE)
sys.path.insert(0, MCP)

import integrity  # noqa: E402  (deploy/integrity.py — same dir)
from starlette.responses import JSONResponse  # noqa: E402

# ---- startup: integrity check BEFORE building/serving anything ----
_INTEGRITY = integrity.verify()  # raises RuntimeError -> process fails to start on mismatch

import mcp_http_server as mcpsrv  # noqa: E402  (registers tools + canonical schemas at import)

# ---- bearer token (required; never logged) ----
_TOKEN = os.environ.get("MCP_BEARER_TOKEN")
if not _TOKEN:
    raise RuntimeError("MCP_BEARER_TOKEN is not set; refusing to start an unauthenticated MCP server.")

SERVICE = "error-code-mcp"
VERSION = "1"
MCP_PATH = "/mcp"

logging.basicConfig(level=logging.INFO, format='%(message)s')
_log = logging.getLogger(SERVICE)


def _health_payload():
    snap = None
    try:
        snap = mcpsrv.TOOLS.catalogue_snapshot()
    except Exception:
        snap = None
    payload = {
        "status": "ok",
        "service": SERVICE,
        "version": VERSION,
        "datasetVersion": "1",
        "mappingCount": _INTEGRITY["mappingCount"],
        "baselineMappingCount": _INTEGRITY["mappingCount"],
        "uniqueLookupCount": (snap or {}).get("baselineCount"),
        "effectiveActiveCount": (snap or {}).get("effectiveActiveCount"),
        "datasetV1Hash": _INTEGRITY["datasetV1Hash"][:12],
        "enrichmentV1Hash": _INTEGRITY["enrichmentV1Hash"][:12],
    }
    if snap and snap.get("overlay"):
        payload["overlay"] = {
            "state": snap["overlay"].get("state"),
            "present": bool(snap["overlay"].get("present")),
            "records": snap["overlay"].get("records"),
            "retired": snap["overlay"].get("retired"),
            "adminActive": snap["overlay"].get("adminActive"),
            "updatedAt": snap["overlay"].get("updatedAt"),
        }
    return payload


def _bearer_ok(header_value: str) -> bool:
    if not header_value or not header_value.startswith("Bearer "):
        return False
    presented = header_value[len("Bearer "):].strip()
    if not presented:
        return False
    return hmac.compare_digest(presented, _TOKEN)  # constant-time


# Transport security (DNS-rebinding host/origin checks). Behind a bearer-gated Function URL the
# Host is the generated lambda-url domain; the rebinding defense (aimed at browsers on local
# networks) does not apply to this server-to-server endpoint. Configurable via MCP_ALLOWED_HOSTS
# (comma-separated); default/"*" disables the host check while bearer auth remains the real gate.
from mcp.server.transport_security import TransportSecuritySettings  # noqa: E402

_allowed = os.environ.get("MCP_ALLOWED_HOSTS", "*").strip()
if _allowed and _allowed != "*":
    hosts = [h.strip() for h in _allowed.split(",") if h.strip()]
    _transport_security = TransportSecuritySettings(
        enable_dns_rebinding_protection=True, allowed_hosts=hosts,
        allowed_origins=[f"https://{h}" for h in hosts] + [f"http://{h}" for h in hosts],
    )
else:
    _transport_security = TransportSecuritySettings(enable_dns_rebinding_protection=False)

# Build the banked MCP app in stateless + JSON mode (Lambda/Function-URL friendly).
_mcp_app = mcpsrv.server.streamable_http_app(
    streamable_http_path=MCP_PATH, json_response=True, stateless_http=True,
    transport_security=_transport_security,
)


async def app(scope, receive, send):
    """ASGI entry. Handles /health unauthenticated; enforces bearer on everything else;
    delegates authenticated traffic to the banked MCP Streamable HTTP app."""
    if scope["type"] == "lifespan":
        # forward lifespan so the MCP session manager starts/stops correctly
        await _mcp_app(scope, receive, send)
        return
    if scope["type"] != "http":
        await _mcp_app(scope, receive, send)
        return

    start = time.perf_counter()
    rid = uuid.uuid4().hex[:12]
    path = scope.get("path", "")
    method = scope.get("method", "")

    async def _send_json(status, payload):
        body = json.dumps(payload).encode()
        await send({"type": "http.response.start", "status": status,
                    "headers": [(b"content-type", b"application/json"),
                                (b"x-request-id", rid.encode())]})
        await send({"type": "http.response.body", "body": body})
        _log.info(json.dumps({"reqId": rid, "method": method, "path": path,
                              "status": status, "durationMs": round((time.perf_counter() - start) * 1000, 2)}))

    # unauthenticated health
    if path == "/health" and method == "GET":
        await _send_json(200, _health_payload())
        return

    # bearer auth for everything else
    headers = {k.decode().lower(): v.decode() for k, v in scope.get("headers", [])}
    if not _bearer_ok(headers.get("authorization", "")):
        await _send_json(401, {"error": "unauthorized", "message": "valid bearer token required"})
        return

    if path.startswith("/catalogue"):
        from catalogue_api import CatalogueApi
        api = CatalogueApi(mcpsrv.TOOLS)
        status, payload = await api.handle(scope, receive)
        await _send_json(status, payload)
        return

    # authenticated: delegate to the banked MCP app, logging status without leaking bodies/token
    status_holder = {"code": 0}

    async def _wrapped_send(message):
        if message["type"] == "http.response.start":
            status_holder["code"] = message["status"]
        await send(message)

    await _mcp_app(scope, receive, _wrapped_send)
    _log.info(json.dumps({"reqId": rid, "method": method, "path": path,
                          "status": status_holder["code"],
                          "durationMs": round((time.perf_counter() - start) * 1000, 2)}))
