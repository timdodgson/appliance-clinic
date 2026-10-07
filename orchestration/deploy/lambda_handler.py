#!/usr/bin/env python3
"""AWS Lambda handler for the Customer Diagnostic Orchestrator V1 (Function URL, BUFFERED).

Thin transport around the deterministic orchestrator. Routes:
  GET  /health   -> unauthenticated status (no secrets/paths)
  POST /diagnose -> bearer-authenticated; body {message, sessionId?, make?, appliance?,
                    displayedCode?, region?, observed?[], includeEnrichment?}

Downstream: real Error-Code MCP (Streamable HTTP + bearer) and real Diagnostic RAG (Function URL).
Config via env only (never hard-coded): MCP_URL, MCP_BEARER_TOKEN, RAG_URL, ORCH_BEARER_TOKEN.
The orchestrator is STATELESS per request (the client carries accumulated conversation context in
the structured fields); an in-memory store gives best-effort warm-container continuity only.
Downstream bearer tokens are never returned to the client. Structured logs never include tokens.
"""
import os, json, time, hmac, logging

# package import (image copies the repo's orchestration/ package to /var/task/orchestration)
from orchestration.model import TurnInput, ObservedIdentifier, Outcome
from orchestration.services import McpErrorCodeService, RealDiagnosticService, InMemoryStateStore
from orchestration.orchestrator import Orchestrator

log = logging.getLogger("diag-orchestrator"); log.setLevel(logging.INFO)

_TOKEN = os.environ.get("ORCH_BEARER_TOKEN")
if not _TOKEN:
    raise RuntimeError("ORCH_BEARER_TOKEN not set; refusing to start an unauthenticated orchestrator.")

# built once per warm container
ORCH = Orchestrator(McpErrorCodeService(), RealDiagnosticService(), InMemoryStateStore())
SERVICE, VERSION = "customer-diagnostic-orchestrator", "1"


def _resp(status, obj):
    return {"statusCode": status, "headers": {"content-type": "application/json"}, "body": json.dumps(obj)}


def _canonical_in(block):
    """Accept the BFF's canonical cs/1 block as opaque transport data.
    Only the envelope shape is checked; the orchestrator never interprets the state."""
    if not isinstance(block, dict) or block.get("schema") != "cs/1":
        return None
    if not isinstance(block.get("sessionId"), str) or not isinstance(block.get("version"), int):
        return None
    return block


def _bearer_ok(headers: dict) -> bool:
    auth = (headers or {}).get("authorization") or (headers or {}).get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return False
    return hmac.compare_digest(auth[len("Bearer "):].strip(), _TOKEN)


def _diagnostic_trace(resp, debug):
    """Bounded runtime evidence for the trusted BFF. No prompts, headers, tokens, or reasoning."""
    stages = []
    rag = debug.get("ragTrace") if isinstance(debug.get("ragTrace"), dict) else None
    if rag:
        stages.extend(rag.get("stages") or [])
    else:
        stages.append({"id": "rag", "label": "Diagnostic RAG", "evidence": "NOT_CAPTURED",
                       "summary": "No RAG evidence captured", "detail": None})
    route = resp.route
    stages.insert(0, {"id": "routing", "label": "Routing", "evidence": "OBSERVED",
                      "summary": route, "detail": {
                          "route": route,
                          "mcpInvoked": route in ("ERROR_CODE", "ERROR_CODE_AND_SYMPTOMS"),
                          "ragInvoked": bool(debug.get("ragInvoked") or rag),
                      }})
    mcp = debug.get("mcpEvidence")
    stages.insert(1, {"id": "error-code-mcp", "label": "Error Code MCP",
                      "evidence": "OBSERVED" if mcp else ("DERIVED" if route not in ("ERROR_CODE", "ERROR_CODE_AND_SYMPTOMS") else "NOT_CAPTURED"),
                      "summary": ("MCP " + str(mcp.get("status"))) if mcp else ("Skipped by route" if route not in ("ERROR_CODE", "ERROR_CODE_AND_SYMPTOMS") else "MCP evidence not captured"),
                      "detail": mcp})
    stages.append({"id": "orchestrator-state", "label": "Diagnostic state", "evidence": "OBSERVED",
                   "summary": "Structured conversation state after this turn", "detail": debug.get("state")})
    stages.append({"id": "customer-response", "label": "Customer response", "evidence": "OBSERVED",
                   "summary": resp.outcome, "detail": {
                       "outcome": resp.outcome, "messageChars": len(resp.message or ""),
                       "partsCount": len(resp.parts or []), "mediaCount": len(resp.media or []),
                       "pendingRequest": resp.pendingRequest,
                   }})
    return {"schemaVersion": "1.0", "stages": stages,
            "latenciesMs": debug.get("latencies") or {}}


def handler(event, context):
    rc = (event or {}).get("requestContext", {}).get("http", {})
    method = rc.get("method", "GET")
    path = event.get("rawPath") or rc.get("path", "/")
    rid = getattr(context, "aws_request_id", "local")[:12]

    if method == "GET" and path.rstrip("/").endswith("/health") or path == "/health":
        return _resp(200, {"status": "ok", "service": SERVICE, "version": VERSION,
                           "errorCodeMcp": "configured" if os.environ.get("MCP_URL") else "unconfigured",
                           "diagnosticRag": "configured" if os.environ.get("RAG_URL") else "unconfigured"})

    if not _bearer_ok(event.get("headers") or {}):
        return _resp(401, {"error": "unauthorized", "message": "valid bearer token required"})

    if method != "POST":
        return _resp(405, {"error": "method_not_allowed"})

    t0 = time.perf_counter()
    try:
        body = event.get("body") or "{}"
        if event.get("isBase64Encoded"):
            import base64
            body = base64.b64decode(body).decode()
        data = json.loads(body or "{}")
        if not isinstance(data, dict) or not isinstance(data.get("message", ""), str):
            return _resp(200, {"outcome": Outcome.CLARIFICATION_REQUIRED.value,
                               "message": "Please send a JSON body with a 'message' string."})
        observed = [ObservedIdentifier(type=o.get("type"), value=o.get("value"), revision=o.get("revision"))
                    for o in (data.get("observed") or []) if isinstance(o, dict)]
        _img = data.get("image")
        _pending = data.get("pendingRequest")
        _latest = data.get("latestMessage")
        _intent = data.get("intent")
        _conversation = data.get("conversation")
        turn = TurnInput(
            message=data.get("message", ""), sessionId=data.get("sessionId", "default"),
            make=data.get("make"), appliance=data.get("appliance"),
            identitySource=data.get("identitySource"),
            fuel=data.get("fuel"),
            displayedCode=data.get("displayedCode"), region=data.get("region"),
            observed=observed, includeEnrichment=bool(data.get("includeEnrichment", True)),
            image=_img if isinstance(_img, str) and _img else None,
            pendingRequest=_pending if isinstance(_pending, dict) else None,
            latestMessage=_latest if isinstance(_latest, str) else None,
            turnIndex=int(data.get("turnIndex") or 0) if isinstance(data.get("turnIndex"), (int, float)) else 0,
            intent=_intent if isinstance(_intent, dict) else None,
            conversation=_conversation if isinstance(_conversation, list) else None,
            canonical=_canonical_in(data.get("canonical")))
        resp = ORCH.handle_turn(turn)
        dbg = resp.debug or {}
        log.info(json.dumps({"reqId": rid, "route": resp.route, "outcome": resp.outcome,
                             "mcpStatus": dbg.get("mcpStatus"), "ragInvoked": dbg.get("ragInvoked"),
                             "trustedContextUsed": dbg.get("trustedContextUsed"),
                             "conflict": dbg.get("conflict"), "safetyState": dbg.get("safetyState"),
                             "familyDecision": dbg.get("familyDecision"),
                             # canonical: owning journey + the NextAction rule (no state, no csid)
                             "canonicalControl": dbg.get("canonicalControl"),
                             "canonicalRule": (dbg.get("canonicalAction") or {}).get("rule"),
                             "canonicalDegraded": (dbg.get("canonical") or {}).get("degraded") if isinstance(dbg.get("canonical"), dict) else None,
                             "latencies": dbg.get("latencies"),
                             "totalMs": round((time.perf_counter() - t0) * 1000, 1)}))
        public = resp.customer_view()   # strips debug + internal ids
        # Observability is strictly best-effort: a trace-assembly failure must NEVER turn a good
        # diagnosis into an error. Capture defensively and omit the trace if anything goes wrong.
        try:
            public["_diagnosticTrace"] = _diagnostic_trace(resp, dbg)
        except Exception:
            log.warning("diagnostic trace assembly failed reqId=%s (non-fatal)", rid)
        # Hand the merged canonical result back to the BFF, which persists it and strips `_canonical`
        # before anything reaches the browser. Only present when the BFF sent a canonical block this turn.
        if isinstance(dbg.get("canonical"), dict):
            public["_canonical"] = dbg["canonical"]
        return _resp(200, public)        # trusted bearer-authenticated BFF boundary only
    except Exception as e:
        log.exception("orchestrator failed reqId=%s error=%s", rid, type(e).__name__)
        return _resp(200, {"outcome": Outcome.SERVICE_UNAVAILABLE.value,
                           "message": "The diagnostic service hit an unexpected error. Please try again shortly."})
