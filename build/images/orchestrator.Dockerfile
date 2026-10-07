# Phase 3 (#29) rebuild of the orchestrator image. Derived from orchestration/deploy/Dockerfile
# (imported, unchanged), with two build-only differences and no change to any file in the image:
#   1. The base is pinned by digest: the arm64 image of public.ecr.aws/lambda/python:3.12.2026.10.03.13,
#      whose 6 layers are the production image's first 6 (#29). Override BASE for a local copy.
#   2. pip installs with the production versions as constraints, bind-mounted for that step only.
# Build context: the repository root.
#   docker buildx build --platform linux/arm64 -f build/images/orchestrator.Dockerfile .
ARG BASE=public.ecr.aws/lambda/python@sha256:7c61e7c7a5094a17be45b65b28a36e44503ca431015df4ab8c0f8dc24dd904be
FROM ${BASE}

COPY orchestration/deploy/requirements.txt /tmp/requirements.txt
# Build-only: an optional CA bundle for a TLS-intercepting proxy (pass --secret id=ca,src=<bundle> and
# --build-arg PIP_CERT=/run/secrets/ca). Unset in CI. Neither leaves anything in the image.
ARG PIP_CERT
RUN --mount=type=secret,id=ca,required=false --mount=type=bind,source=build/python/orchestrator.constraints.txt,target=/run/pip-constraints.txt \
    pip install --no-cache-dir -r /tmp/requirements.txt -c /run/pip-constraints.txt

COPY orchestration/__init__.py            ${LAMBDA_TASK_ROOT}/orchestration/__init__.py
COPY orchestration/model.py               ${LAMBDA_TASK_ROOT}/orchestration/model.py
COPY orchestration/routing.py             ${LAMBDA_TASK_ROOT}/orchestration/routing.py
COPY orchestration/services.py            ${LAMBDA_TASK_ROOT}/orchestration/services.py
COPY orchestration/orchestrator.py        ${LAMBDA_TASK_ROOT}/orchestration/orchestrator.py
COPY services/part-finder/canonical/journeys.json ${LAMBDA_TASK_ROOT}/orchestration/canonical_journeys.json
COPY orchestration/deploy/lambda_handler.py ${LAMBDA_TASK_ROOT}/lambda_handler.py

CMD ["lambda_handler.handler"]
