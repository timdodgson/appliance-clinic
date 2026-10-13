#!/usr/bin/env bash
# Install the error-code MCP's Python dependencies for the arm64 python3.12 Zip Lambda (applianceclinic-error-code-mcp,
# ADR 0022) into a directory, from the hashed lock. Wheels only, for linux aarch64, never compiled, no dependency
# resolution: exactly the versions of build/python/error-code-mcp.constraints.txt. Makes no AWS call.
#
#   bash build/scripts/fetch_error_code_mcp_site.sh [<dir>]      # default build/out/error-code-mcp-site
#   python3 build/scripts/package_zips.py --mcp-site build/out/error-code-mcp-site
#
# Behind a TLS-intercepting proxy, set PIP_CERT=/path/to/ca-bundle.pem. PYTHON defaults to python3.12.
set -euo pipefail
cd "$(dirname "$0")/../.."
PY=${PYTHON:-python3.12}
DIR=${1:-build/out/error-code-mcp-site}
rm -rf "$DIR"
mkdir -p "$DIR"
"$PY" -m pip install --disable-pip-version-check -q ${PIP_CERT:+--cert "$PIP_CERT"} \
  --target "$DIR" --no-compile --no-deps --require-hashes \
  --platform manylinux2014_aarch64 --platform manylinux_2_17_aarch64 \
  --implementation cp --python-version 3.12 --abi cp312 --only-binary=:all: \
  -r build/python/error-code-mcp.lambda-arm64.lock
# Console scripts are not part of the Lambda (the image's /usr/local/bin is not mirrored); run.sh starts uvicorn as a module.
rm -rf "$DIR/bin"
echo "error-code MCP site-packages ready: $DIR"
