#!/usr/bin/env bash
# Create the two Python test environments the runtime suite uses (npm run test:runtime), with the production package
# versions (constraints files). CI runs exactly this. Re-running it refreshes both environments.
#
#   npm run setup:python          # or: bash build/scripts/setup-python-envs.sh
#
# Behind a TLS-intercepting proxy, set PIP_CERT=/path/to/ca-bundle.pem.
set -euo pipefail
cd "$(dirname "$0")/../.."
PY=${PYTHON:-python3}
"$PY" -c 'import sys; sys.exit(0 if sys.version_info[:2] >= (3, 12) else "Python 3.12 or newer is needed (production runs 3.12)")'
pip_opts=(--disable-pip-version-check -q ${PIP_CERT:+--cert "$PIP_CERT"})
"$PY" -m venv .venv-orchestrator
.venv-orchestrator/bin/pip install "${pip_opts[@]}" \
  -r orchestration/deploy/requirements.txt -c build/python/orchestrator.constraints.txt \
  -r build/python/requirements-test.txt
"$PY" -m venv .venv-error-code-mcp
.venv-error-code-mcp/bin/pip install "${pip_opts[@]}" \
  -r error-codes/mcp/deploy/requirements.txt -c build/python/error-code-mcp.constraints.txt \
  -r build/python/requirements-test.txt
echo "Python test environments ready: .venv-orchestrator, .venv-error-code-mcp"
