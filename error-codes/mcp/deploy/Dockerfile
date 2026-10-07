# Error-Code MCP V1 — deployable container image.
# Runs the banked MCP Streamable HTTP server (uvicorn ASGI) on AWS Lambda via the
# AWS Lambda Web Adapter (unmodified web server; LWA bridges Function URL <-> HTTP).
#
# Build context MUST be the error-codes/ directory so the banked artifact tree is preserved:
#   docker build --platform linux/arm64 -f mcp/deploy/Dockerfile -t error-code-mcp .
#
# Serves ONLY generated/banked artifacts. No raw research files, caches, venv, or RAG.
FROM public.ecr.aws/docker/library/python:3.12-slim

# AWS Lambda Web Adapter (extension). arm64 image; matches --architectures arm64 Lambda.
COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4 /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 \
    PORT=8080 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# 1) Dependencies (pinned closure) — cached layer.
COPY mcp/deploy/requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt

# 2) Banked runtime artifacts + code, preserving the error-codes/ tree the loaders expect.
#    (frozen Dataset V1 runtime, Enrichment V1, resolver, identifier adapter + its data)
COPY runtime-model/compiler/resolve.py            /app/error-codes/runtime-model/compiler/resolve.py
COPY runtime-model/generated/runtime/             /app/error-codes/runtime-model/generated/runtime/
COPY enrichment/generated/                        /app/error-codes/enrichment/generated/
COPY tools/resolve-identifier.py                  /app/error-codes/tools/resolve-identifier.py
COPY identifier-map/                              /app/error-codes/identifier-map/
COPY mcp/tools.py mcp/mcp_http_server.py mcp/catalogue_effective.py mcp/catalogue_store.py mcp/catalogue_api.py mcp/catalogue_workflow.py /app/error-codes/mcp/
COPY mcp/schemas/                                 /app/error-codes/mcp/schemas/
COPY mcp/deploy/asgi.py mcp/deploy/integrity.py   /app/error-codes/mcp/deploy/

WORKDIR /app/error-codes/mcp/deploy
# MCP_BEARER_TOKEN is injected at deploy time (Lambda env from Secrets Manager). Never baked in.
CMD ["uvicorn", "asgi:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
