#!/usr/bin/env python3
"""ERROR-CODE MCP V1 — Streamable HTTP server (thin transport around the tested tool layer).

This file contains ONLY MCP/SDK wiring. All diagnostic logic lives in tools.py (frozen V1
Resolver + identifier adapters + Enrichment V1). Immutable runtime artifacts are loaded ONCE at
startup and shared read-only across concurrent requests; nothing here mutates shared state.

Run (isolated env):
  error-codes/mcp/.venv/bin/python error-codes/mcp/mcp_http_server.py --host 127.0.0.1 --port 8765

Requires the official MCP Python SDK (mcp 2.x). Transport: Streamable HTTP at /mcp. A non-MCP
GET /health is also exposed. No auth (out of scope for this task). No deployment.
"""
import os, sys, json, argparse

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from typing import Any  # noqa: E402
from tools import ErrorCodeTools  # noqa: E402  (tested, transport-free business layer)

from mcp.server.mcpserver import MCPServer  # noqa: E402
from starlette.responses import JSONResponse  # noqa: E402
from starlette.requests import Request  # noqa: E402

# ---- startup: load immutable artifacts ONCE, reuse across requests ----
TOOLS = ErrorCodeTools()
_EC = os.path.dirname(HERE)
_V1_MANIFEST = json.load(open(os.path.join(_EC, "runtime-model", "generated", "runtime", "manifest.json")))
DATASET_VERSION = "V1"
MAPPING_COUNT = _V1_MANIFEST.get("counts", {}).get("sourceCodeRecords") \
    or len(json.load(open(os.path.join(_EC, "runtime-model", "generated", "runtime", "mappings.json"))))

RESOLVE_ERROR_CODE_DESC = (
    "Resolves an error, fault, warning, maintenance or status code displayed by a domestic "
    "appliance. Requires make, appliance type and the displayed code. May return RESOLVED, "
    "NEEDS_CONTEXT, AMBIGUOUS, NOT_FOUND or INVALID_INPUT. Additional rating-plate identifiers "
    "(model, E-Nr, PNC, 12NC, serial, ...) can be supplied via 'observed' when different product "
    "generations/platforms use the same displayed code differently. The result is deterministic "
    "and based on curated error-code data."
)
RESOLVE_APPLIANCE_CONTEXT_DESC = (
    "Resolves appliance rating-plate/product identifiers into ProductContext (scheme, generation, "
    "platform lineage, architecture) that can disambiguate error-code schemes. Use when "
    "resolve-error-code reports NEEDS_CONTEXT and suitable model/rating-plate information is "
    "available."
)

server = MCPServer(
    name="error-code-mcp",
    version="1.0.0",
    instructions="Deterministic domestic-appliance error-code resolution over curated Error-Code "
                 "Dataset V1 + Enrichment V1. Call resolve-error-code first; if it returns "
                 "NEEDS_CONTEXT, supply observed rating-plate identifiers (directly to "
                 "resolve-error-code, or via resolve-appliance-context).",
)


@server.tool(name="resolve-error-code", description=RESOLVE_ERROR_CODE_DESC, structured_output=True)
def resolve_error_code(make: str, appliance: str, code: str,
                       observed: list | None = None, region: str | None = None,
                       includeEnrichment: bool = True) -> dict[str, Any]:
    args = {"make": make, "appliance": appliance, "code": code, "includeEnrichment": includeEnrichment}
    if observed is not None:
        args["observed"] = observed
    if region is not None:
        args["region"] = region
    return TOOLS.resolve_error_code(args)


@server.tool(name="resolve-appliance-context", description=RESOLVE_APPLIANCE_CONTEXT_DESC, structured_output=True)
def resolve_appliance_context(make: str, appliance: str, observed: list) -> dict[str, Any]:
    return TOOLS.resolve_appliance_context({"make": make, "appliance": appliance, "observed": observed})


# NOTE: get-error-code-evidence is intentionally NOT registered as a public MCP tool.
# It remains callable internally via TOOLS.get_error_code_evidence(...) for debug.


def _advertise_canonical_schema(tool_name: str) -> None:
    """Advertise the CANONICAL JSON Schema (schemas/<tool>.schema.json) as the tool's inputSchema.

    The SDK derives a schema from the Python signature that omits the identifier `type` enum and
    other constraints. `MCPServer.list_tools` advertises `Tool.parameters`, so we set that field to
    the single canonical contract. Call-time argument parsing still uses the tool's `fn_metadata`
    (from the signature), so a caller that bypasses client-side schema validation and sends an
    invalid `observed.type` is NOT hard-rejected by the transport — it reaches tools.py, which
    returns a structured INVALID_INPUT. One contract (the JSON file) feeds both advertisement and
    (via tools.py._validate) enforcement.
    """
    canonical = TOOLS.schemas[tool_name]["inputSchema"]
    tool = server._tool_manager.get_tool(tool_name)
    tool.parameters = canonical


for _name in ("resolve-error-code", "resolve-appliance-context"):
    _advertise_canonical_schema(_name)


@server.custom_route("/health", methods=["GET"])
async def health(_request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "datasetVersion": DATASET_VERSION, "mappingCount": MAPPING_COUNT})


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=8765)
    a = ap.parse_args()
    import anyio
    anyio.run(lambda: server.run_streamable_http_async(host=a.host, port=a.port, streamable_http_path="/mcp"))
