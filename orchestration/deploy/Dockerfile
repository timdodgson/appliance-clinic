# Customer Diagnostic Orchestrator V1 — Lambda container image (plain handler, BUFFERED Function URL).
# Uses the AWS Lambda Python base image (Runtime Interface Client); the handler runs the async MCP
# client via asyncio.run (no outer event loop). Build context = repo root (to copy orchestration/).
#   docker build --platform linux/arm64 -f orchestration/deploy/Dockerfile -t diag-orchestrator .
FROM public.ecr.aws/lambda/python:3.12

# deps (pinned closure: mcp SDK + httpx + transitive)
COPY orchestration/deploy/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# orchestration package (business logic) + handler at the task root
COPY orchestration/__init__.py            ${LAMBDA_TASK_ROOT}/orchestration/__init__.py
COPY orchestration/model.py               ${LAMBDA_TASK_ROOT}/orchestration/model.py
COPY orchestration/routing.py             ${LAMBDA_TASK_ROOT}/orchestration/routing.py
COPY orchestration/services.py            ${LAMBDA_TASK_ROOT}/orchestration/services.py
COPY orchestration/orchestrator.py        ${LAMBDA_TASK_ROOT}/orchestration/orchestrator.py
# the shared canonical journey registry (key -> likely area; the orchestrator's control gate)
COPY services/part-finder/canonical/journeys.json ${LAMBDA_TASK_ROOT}/orchestration/canonical_journeys.json
COPY orchestration/deploy/lambda_handler.py ${LAMBDA_TASK_ROOT}/lambda_handler.py

# MCP_URL / MCP_BEARER_TOKEN / RAG_URL / ORCH_BEARER_TOKEN injected at deploy time (never baked in).
CMD ["lambda_handler.handler"]
