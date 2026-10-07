# Phase 3 (#29) rebuild of the error-code MCP image. Derived from error-codes/mcp/deploy/Dockerfile
# (imported, unchanged), with build-only differences and no change to any file in the image:
#   1. The base is pinned by content. python:3.12-slim of 2026-10-01 is no longer tagged, so
#      build/scripts/assemble_base.py assembles it from its 4 layer digests and passes it in as BASE.
#   2. The Lambda Web Adapter is pinned by digest: public.ecr.aws/awsguru/aws-lambda-adapter:0.8.4.
#   3. pip installs with the production versions as constraints, bind-mounted from the
#      `constraints` named context for that step only.
# Build context: error-codes/ (as the original deploy script staged it).
#   docker buildx build --platform linux/arm64 -f build/images/error-code-mcp.Dockerfile \
#     --build-arg BASE=<assembled base> --build-context constraints=build/python error-codes
ARG BASE
ARG ADAPTER=public.ecr.aws/awsguru/aws-lambda-adapter@sha256:e2653f741cd15851ba4f13f3cc47d29f2d14377c7d11737bfa272baa1b569007
FROM ${ADAPTER} AS adapter

FROM ${BASE}
COPY --from=adapter /lambda-adapter /opt/extensions/lambda-adapter
ENV AWS_LWA_PORT=8080 \
    PORT=8080 \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY mcp/deploy/requirements.txt /app/requirements.txt
# Build-only: an optional CA bundle for a TLS-intercepting proxy (pass --secret id=ca,src=<bundle> and
# --build-arg PIP_CERT=/run/secrets/ca). Unset in CI. Neither leaves anything in the image.
ARG PIP_CERT
RUN --mount=type=secret,id=ca,required=false --mount=type=bind,from=constraints,source=error-code-mcp.constraints.txt,target=/run/pip-constraints.txt \
    pip install --no-cache-dir -r /app/requirements.txt -c /run/pip-constraints.txt

COPY runtime-model/compiler/resolve.py            /app/error-codes/runtime-model/compiler/resolve.py
COPY runtime-model/generated/runtime/             /app/error-codes/runtime-model/generated/runtime/
COPY enrichment/generated/                        /app/error-codes/enrichment/generated/
COPY tools/resolve-identifier.py                  /app/error-codes/tools/resolve-identifier.py
COPY identifier-map/                              /app/error-codes/identifier-map/
COPY mcp/tools.py mcp/mcp_http_server.py mcp/catalogue_effective.py mcp/catalogue_store.py mcp/catalogue_api.py mcp/catalogue_workflow.py /app/error-codes/mcp/
COPY mcp/schemas/                                 /app/error-codes/mcp/schemas/
COPY mcp/deploy/asgi.py mcp/deploy/integrity.py   /app/error-codes/mcp/deploy/

WORKDIR /app/error-codes/mcp/deploy
CMD ["uvicorn", "asgi:app", "--host", "0.0.0.0", "--port", "8080", "--log-level", "info"]
