#!/usr/bin/env python3
"""Build the Lambda zips from this repository.

    python3 build/scripts/package_zips.py [--out-dir build/out] [--mcp-site build/out/error-code-mcp-site]

  - applianceclinic-diagnosis-engine: services/diagnosis-engine (the ac2 diagnosis engine, ADR 0019, ADR 0020)
  - whichpart-api:                    services/whichpart-api, plus the engine files it ships (listed below)
  - applianceclinic-error-code-mcp:   only with --mcp-site (ADR 0022). The files build/images/error-code-mcp.Dockerfile
                                      copies into /app/error-codes, at error-codes/ in the zip; the Python dependencies
                                      (build/scripts/fetch_error_code_mcp_site.sh) at the zip root; and run.sh (0755),
                                      which the Lambda Web Adapter layer starts (AWS_LAMBDA_EXEC_WRAPPER=/opt/bootstrap).
It makes no AWS call.

The archives are deterministic: entries sorted, a fixed timestamp, mode 0644 (run.sh 0755) and deflate. That makes
rebuilds byte-stable, but their CodeSha256 differs from the hand-built production zips. Equivalence is
proven entry by entry (build/scripts/compare_zip.py).
"""
import argparse
import glob
import json
import os
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DE = os.path.join(ROOT, 'services', 'diagnosis-engine')
EC = os.path.join(ROOT, 'error-codes')
MCP_DOCKERFILE = os.path.join(ROOT, 'build', 'images', 'error-code-mcp.Dockerfile')
WP = os.path.join(ROOT, 'services', 'whichpart-api')
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def diagnosis_engine_entries():
    """The engine's runtime files: the handler and its modules, the ac2 turn and its guardrail kernel, the knowledge the
    advisor reads and the media mappings."""
    top = ['handler.js', 'health.js', 'media.js', 'media-effective.js', 'engine-auth.js', 'admin-config.js', 'inference.js']
    engine = sorted(f'engine/{os.path.basename(p)}' for p in glob.glob(os.path.join(DE, 'engine', '*.js')))
    entries = {name: os.path.join(DE, name) for name in top + engine}
    entries['knowledge/media-information.json'] = os.path.join(DE, 'knowledge', 'media-information.json')
    # ac2: the advisor turn and its guardrail kernel, and the knowledge the advisor reads.
    for p in sorted(glob.glob(os.path.join(DE, 'ac2', '*.js'))):
        entries[f'ac2/{os.path.basename(p)}'] = p
    for n in ('knowledge-docs.json', 'journey-knowledge.json', 'normal-operation.json', 'safety-information.json'):
        entries[f'knowledge/{n}'] = os.path.join(DE, 'knowledge', n)
    return entries


def whichpart_api_entries(generated):
    """The whichpart-api zip: its own files, plus the files it copies in from the engine or generates."""
    # Phase 8: fit-evidence.js (never required) is no longer shipped. 23.4: the Test area / ACQ-100 benchmark, the
    # transcript review and the Jev client were retired (ADR 0023).
    files = ['index.js', 'ai-config.js', 'settings-admin.js', 'config-readback.js',
             'package.json', 'transcripts.js', 'ddb.js', 'ac2-state.js', 'ac2-turn.js', 'state-token.js',
             'live-test.js', 'media-catalogue.json', 'media-canonical-refs.json', 'knowledge-inspect.js',
             'media-inspect.js', 'media-admin.js', 'diagnostics-inspect.js', 'error-codes-admin.js']
    # Phase 7 onwards: runtime files added after the import (docs/migration/runtime-changes.json).
    files += sorted(os.path.relpath(f['path'], 'services/whichpart-api') for f in json.load(open(os.path.join(ROOT, 'docs', 'migration', 'runtime-changes.json')))['added']
                    if f['role'] == 'runtime' and 'whichpart-api' in f['units'])
    entries = {name: os.path.join(WP, name) for name in files}
    for d in ('recalls',):  # zipped as whole directories
        for path in sorted(glob.glob(os.path.join(WP, d, '**', '*'), recursive=True)):
            if os.path.isfile(path) and '__pycache__' not in path:
                entries[os.path.relpath(path, WP)] = path
    # Copied in from the diagnosis engine: knowledge files for the admin inspectors and the effective media join.
    knowledge = os.path.join(DE, 'knowledge')
    for n in ('knowledge-docs.json', 'safety-information.json', 'media-information.json'):
        entries[f'knowledge-inspect/{n}'] = os.path.join(knowledge, n)
    entries['media-effective.js'] = os.path.join(DE, 'media-effective.js')
    return entries


# The error-code MCP Zip Lambda (ADR 0022). The Lambda Web Adapter (layer) runs this as the handler and proxies
# requests to port 8080, as the image's adapter extension did; the image ran the same uvicorn command in this directory.
MCP_RUN_SH = b"""#!/bin/bash
cd "$LAMBDA_TASK_ROOT/error-codes/mcp/deploy"
PYTHONPATH="$LAMBDA_TASK_ROOT" exec python3 -m uvicorn asgi:app --host 0.0.0.0 --port 8080 --log-level info
"""
EXECUTABLE = {'run.sh'}
# The image's .dockerignore: never copied from error-codes/.
SKIP_PARTS = {'__pycache__', '.venv', 'tests'}


def dockerfile_copies(dockerfile=MCP_DOCKERFILE):
    """The (sources, destination) of each build-context COPY in the Dockerfile (COPY --from=... is the adapter, which
    the Zip Lambda takes from a layer instead). Sources are relative to the build context, error-codes/."""
    copies = []
    for line in open(dockerfile):
        parts = line.split()
        if not parts or parts[0] != 'COPY' or any(p.startswith('--') for p in parts[1:]):
            continue
        copies.append((parts[1:-1], parts[-1]))
    return copies


def error_code_mcp_entries(site):
    """{zip path: source path}: what the Dockerfile copies under /app/error-codes (at error-codes/), and the installed
    dependencies in `site` at the root. /app/requirements.txt is only pip's input in the image and is not shipped."""
    entries = {}

    def add(src, name, skip=SKIP_PARTS):
        if skip & set(name.split('/')) or name.endswith('.pyc'):
            return
        entries[name] = src

    for sources, dest in dockerfile_copies():
        if not dest.startswith('/app/error-codes/'):
            continue
        dest = dest[len('/app/'):]
        for s in sources:
            src = os.path.join(EC, s)
            if not os.path.exists(src):
                raise SystemExit(f'{MCP_DOCKERFILE}: COPY source error-codes/{s} does not exist')
            if os.path.isdir(src):
                for p in sorted(glob.glob(os.path.join(src, '**', '*'), recursive=True)):
                    if os.path.isfile(p):
                        add(p, dest.rstrip('/') + '/' + os.path.relpath(p, src).replace(os.sep, '/'))
            elif dest.endswith('/'):
                add(src, dest + os.path.basename(s))
            else:
                add(src, dest)
    if not glob.glob(os.path.join(site, '*.dist-info')):
        raise SystemExit(f'{site} has no installed dependencies: run build/scripts/fetch_error_code_mcp_site.sh first')
    for p in sorted(glob.glob(os.path.join(site, '**', '*'), recursive=True)):
        rel = os.path.relpath(p, site).replace(os.sep, '/')
        if rel.split('/')[0] in ('error-codes', 'run.sh'):
            raise SystemExit(f'{site}: {rel} would overwrite the application')
        # As pip installed them in the image: packages keep their own tests; only bytecode and console scripts are left out.
        if os.path.isfile(p) and rel.split('/')[0] != 'bin':
            add(p, rel, skip={'__pycache__'})
    return entries


def write_zip(path, entries, generated):
    names = sorted(set(entries) | set(generated))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in names:
            data = generated[name] if name in generated else open(entries[name], 'rb').read()
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = (0o100755 if name in EXECUTABLE else 0o100644) << 16
            z.writestr(info, data)
    return names


def shipped_record(src):
    """A dist-info RECORD without the console scripts pip wrote outside the package (`../../bin/...`): they are not
    shipped, and their hashes carry the shebang of the Python that ran pip, so keeping them would make the zip depend
    on the build machine."""
    lines = open(src, 'rb').read().decode().splitlines(keepends=True)
    return ''.join(l for l in lines if not l.startswith('../')).encode()


def build_error_code_mcp(path, site):
    entries = error_code_mcp_entries(site)
    generated = {'run.sh': MCP_RUN_SH}
    for name in [n for n in entries if n.endswith('.dist-info/RECORD')]:
        generated[name] = shipped_record(entries.pop(name))
    return write_zip(path, entries, generated)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-dir', default=os.path.join(ROOT, 'build', 'out'))
    ap.add_argument('--mcp-site', help='installed dependencies of the error-code MCP (fetch_error_code_mcp_site.sh); '
                    'builds applianceclinic-error-code-mcp.zip')
    a = ap.parse_args()
    out = a.out_dir
    os.makedirs(out, exist_ok=True)
    de = write_zip(os.path.join(out, 'applianceclinic-diagnosis-engine.zip'), diagnosis_engine_entries(), {})
    gen = {}
    wp = write_zip(os.path.join(out, 'whichpart-api.zip'), whichpart_api_entries(gen), gen)
    print(f'applianceclinic-diagnosis-engine.zip: {len(de)} files')
    print(f'whichpart-api.zip: {len(wp)} files')
    if a.mcp_site:
        ec = build_error_code_mcp(os.path.join(out, 'applianceclinic-error-code-mcp.zip'), a.mcp_site)
        print(f'applianceclinic-error-code-mcp.zip: {len(ec)} files')


if __name__ == '__main__':
    sys.exit(main())
