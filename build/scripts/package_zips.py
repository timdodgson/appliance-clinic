#!/usr/bin/env python3
"""Rebuild the two Lambda zips from this repository (Phase 3, #29).

    python3 build/scripts/package_zips.py [--out-dir build/out]

Reproduces only the packaging steps of the imported deploy scripts:
  - spares4repairs-part-finder: services/part-finder/deploy.sh, lines 29-48
  - whichpart-api:              services/whichpart-api/deploy.sh, lines 192-231
It makes no AWS call. Never run the deploy scripts themselves; they also change AWS.

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
PF = os.path.join(ROOT, 'services', 'part-finder')
WP = os.path.join(ROOT, 'services', 'whichpart-api')
FIXED_TIME = (1980, 1, 1, 0, 0, 0)


def part_finder_entries():
    """services/part-finder/deploy.sh lines 29, 39, 44 and 46: the files the zip contains."""
    top = ['part-finder-lambda.js', 'inference.js', 'admin-config.js', 'jev-client.js', 'jev-understand.js',
           'faults-catalogue.json', 'retrieval.js', 'security.js', 'identity.js', 'media-effective.js', 'health.js',
           'canonical-runtime.js', 'jev-mc1.js']
    knowledge = ['knowledge-index.json', 'safety-information.json', 'media-information.json', 'normal-behaviour.json']
    canonical = sorted(os.path.basename(p) for p in glob.glob(os.path.join(PF, 'canonical', '*.js'))) + ['journeys.json']
    entries = {name: os.path.join(PF, name) for name in top}
    entries.update({f'knowledge/{n}': os.path.join(PF, 'knowledge', n) for n in knowledge})
    entries.update({f'canonical/{n}': os.path.join(PF, 'canonical', n) for n in canonical})
    return entries


# Verbatim logic of the Python heredoc in services/whichpart-api/deploy.sh (lines 198-211), including
# json.dump defaults, so the generated file is byte-identical.
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
    """services/whichpart-api/deploy.sh lines 192-231: the zip list, plus the files it copies in or generates."""
    # deploy.sh line 214: the packaging check that media-canonical-refs.json is current.
    subprocess.run(['node', os.path.join(WP, 'scripts', 'build-media-canonical-refs.cjs'), '--check'], check=True, cwd=ROOT)
    files = ['index.js', 'ai-config.js', 'settings-admin.js', 'config-readback.js', 'benchmark-auth.js', 'fit-evidence.js',
             'package.json', 'transcripts.js', 'ddb.js', 'conversation-state.js', 'canonical-audit.js', 'state-token.js',
             'live-test.js', 'media-catalogue.json', 'media-canonical-refs.json', 'knowledge-inspect.js', 'knowledge-admin.js',
             'media-inspect.js', 'media-admin.js', 'diagnostics-inspect.js', 'error-codes-admin.js',
             'benchmark/acq-scoring.js', 'benchmark/term-match.js', 'benchmark/acq-corpus.js', 'benchmark/acq-simulator.js',
             'benchmark/acq-grade.js', 'benchmark/acq-judge.js', 'benchmark/acq-store.js', 'benchmark/acq-library.js',
             'benchmark/acq-reviews.js', 'benchmark/routing-override.js', 'benchmark/acq-100.v1.json',
             'benchmark/gold-v2/version.js']
    entries = {name: os.path.join(WP, name) for name in files}
    for d in ('transcript-review', 'recalls'):  # zipped as whole directories
        for path in sorted(glob.glob(os.path.join(WP, d, '**', '*'), recursive=True)):
            if os.path.isfile(path) and '__pycache__' not in path:
                entries[os.path.relpath(path, WP)] = path
    # Copied in from part-finder (deploy.sh lines 195-197, 213, 215-217).
    knowledge = os.path.join(PF, 'knowledge')
    for n in ('knowledge-docs.json', 'safety-information.json', 'media-information.json'):
        entries[f'knowledge-inspect/{n}'] = os.path.join(knowledge, n)
    entries['media-effective.js'] = os.path.join(PF, 'media-effective.js')
    for n in ('cs1.js', 'merge.js', 'requests.js', 'journey-registry.js', 'journeys.json'):
        entries[f'canonical/{n}'] = os.path.join(PF, 'canonical', n)
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
    pf = write_zip(os.path.join(out, 'spares4repairs-part-finder.zip'), part_finder_entries(), {})
    gen = {}
    wp = write_zip(os.path.join(out, 'whichpart-api.zip'), whichpart_api_entries(gen), gen)
    print(f'spares4repairs-part-finder.zip: {len(pf)} files')
    print(f'whichpart-api.zip: {len(wp)} files')


if __name__ == '__main__':
    sys.exit(main())
