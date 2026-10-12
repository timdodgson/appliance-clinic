#!/usr/bin/env python3
"""Build the two Lambda zips from this repository.

    python3 build/scripts/package_zips.py [--out-dir build/out]

  - applianceclinic-diagnosis-engine: services/diagnosis-engine (the canonical diagnosis engine, ADR 0019)
  - whichpart-api:                    services/whichpart-api, plus the engine files it ships (listed below)
It makes no AWS call.

The archives are deterministic: entries sorted, a fixed timestamp, mode 0644 and deflate. That makes
rebuilds byte-stable, but their CodeSha256 differs from the hand-built production zips. Equivalence is
proven entry by entry (build/scripts/compare_zip.py).
"""
import argparse
import glob
import json
import os
import subprocess
import sys
import zipfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
DE = os.path.join(ROOT, 'services', 'diagnosis-engine')
WP = os.path.join(ROOT, 'services', 'whichpart-api')
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def diagnosis_engine_entries():
    """The engine's runtime files: the handler and its modules, the canonical journeys, the catalogue and the media
    mappings. Runtime files added later are registered in docs/migration/runtime-changes.json."""
    top = ['handler.js', 'canonical-runtime.js', 'health.js', 'media.js', 'media-effective.js', 'engine-auth.js',
           'security.js', 'identity.js', 'admin-config.js', 'inference.js', 'jev-client.js', 'jev-understand.js',
           'jev-mc1.js', 'faults-catalogue.json']
    engine = sorted(f'engine/{os.path.basename(p)}' for p in glob.glob(os.path.join(DE, 'engine', '*.js')))
    canonical = sorted(f'canonical/{os.path.basename(p)}' for p in glob.glob(os.path.join(DE, 'canonical', '*.js'))) + ['canonical/journeys.json']
    entries = {name: os.path.join(DE, name) for name in top + engine + canonical}
    entries['knowledge/media-information.json'] = os.path.join(DE, 'knowledge', 'media-information.json')
    # ac2: the LLM-led turn and its guardrail kernel, and the knowledge the reasoner reads.
    for p in sorted(glob.glob(os.path.join(DE, 'ac2', '*.js'))):
        name = os.path.basename(p)
        if not name.startswith('build-'):
            entries[f'ac2/{name}'] = p
    for p in sorted(glob.glob(os.path.join(DE, 'ac2', 'data', '*.json'))):
        entries[f'ac2/data/{os.path.basename(p)}'] = p
    for n in ('knowledge-docs.json', 'journey-knowledge.json', 'normal-operation.json', 'safety-information.json'):
        entries[f'knowledge/{n}'] = os.path.join(DE, 'knowledge', n)
    return entries


# The knowledge index summary whichpart-api ships (index-meta.json), with json.dump defaults so the generated file is
# byte-identical across builds.
def index_meta(knowledge_dir):
    src = os.path.join(knowledge_dir, "knowledge-index.json")
    idx = json.load(open(src))
    meta = {
        "version": idx.get("version"),
        "embedModel": idx.get("embedModel"),
        "dims": idx.get("dims"),
        "builtAt": idx.get("builtAt"),
        "count": idx.get("count") or len(idx.get("docs") or []),
        "knowledgeIds": [d.get("knowledgeId") for d in (idx.get("docs") or []) if d.get("knowledgeId")],
    }
    return json.dumps(meta).encode()


def whichpart_api_entries(generated):
    """The whichpart-api zip: its own files, plus the files it copies in from the engine or generates."""
    # The packaging check that media-canonical-refs.json is current.
    subprocess.run(['node', os.path.join(WP, 'scripts', 'build-media-canonical-refs.cjs'), '--check'], check=True, cwd=ROOT)
    # Phase 8: fit-evidence.js (never required) and benchmark/acq-simulator.js (test-only) are no longer shipped.
    files = ['index.js', 'ai-config.js', 'settings-admin.js', 'config-readback.js', 'benchmark-auth.js',
             'package.json', 'transcripts.js', 'ddb.js', 'conversation-state.js', 'ac2-state.js', 'ac2-turn.js', 'canonical-audit.js', 'state-token.js',
             'live-test.js', 'media-catalogue.json', 'media-canonical-refs.json', 'knowledge-inspect.js',
             'media-inspect.js', 'media-admin.js', 'diagnostics-inspect.js', 'error-codes-admin.js',
             'benchmark/acq-scoring.js', 'benchmark/term-match.js', 'benchmark/acq-corpus.js',
             'benchmark/acq-grade.js', 'benchmark/acq-judge.js', 'benchmark/acq-store.js', 'benchmark/acq-library.js',
             'benchmark/acq-reviews.js', 'benchmark/routing-override.js', 'benchmark/acq-100.v1.json',
             'benchmark/gold-v2/version.js']
    # Phase 7 onwards: runtime files added after the import (docs/migration/runtime-changes.json).
    files += sorted(os.path.relpath(f['path'], 'services/whichpart-api') for f in json.load(open(os.path.join(ROOT, 'docs', 'migration', 'runtime-changes.json')))['added']
                    if f['role'] == 'runtime' and 'whichpart-api' in f['units'])
    entries = {name: os.path.join(WP, name) for name in files}
    for d in ('transcript-review', 'recalls'):  # zipped as whole directories
        for path in sorted(glob.glob(os.path.join(WP, d, '**', '*'), recursive=True)):
            if os.path.isfile(path) and '__pycache__' not in path:
                entries[os.path.relpath(path, WP)] = path
    # Copied in from the diagnosis engine: knowledge files for the admin inspectors and the shared canonical core.
    knowledge = os.path.join(DE, 'knowledge')
    for n in ('knowledge-docs.json', 'safety-information.json', 'media-information.json'):
        entries[f'knowledge-inspect/{n}'] = os.path.join(knowledge, n)
    entries['media-effective.js'] = os.path.join(DE, 'media-effective.js')
    for n in ('cs1.js', 'merge.js', 'requests.js', 'journey-registry.js', 'journeys.json'):
        entries[f'canonical/{n}'] = os.path.join(DE, 'canonical', n)
    generated['knowledge-inspect/index-meta.json'] = index_meta(knowledge)
    return entries


def write_zip(path, entries, generated):
    names = sorted(set(entries) | set(generated))
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        for name in names:
            data = generated[name] if name in generated else open(entries[name], 'rb').read()
            info = zipfile.ZipInfo(name, FIXED_TIME)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o100644 << 16
            z.writestr(info, data)
    return names


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out-dir', default=os.path.join(ROOT, 'build', 'out'))
    out = ap.parse_args().out_dir
    os.makedirs(out, exist_ok=True)
    de = write_zip(os.path.join(out, 'applianceclinic-diagnosis-engine.zip'), diagnosis_engine_entries(), {})
    gen = {}
    wp = write_zip(os.path.join(out, 'whichpart-api.zip'), whichpart_api_entries(gen), gen)
    print(f'applianceclinic-diagnosis-engine.zip: {len(de)} files')
    print(f'whichpart-api.zip: {len(wp)} files')


if __name__ == '__main__':
    sys.exit(main())
