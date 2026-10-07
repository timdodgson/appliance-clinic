#!/usr/bin/env python3
"""Compare a rebuilt image with its production reference (Phase 3, #29).

    python3 build/scripts/compare_image.py build/reference/<unit>.image.json <docker image> [--out report.json]

Equivalent means all of:
  - base:   the rebuilt image's first layers have the reference base diff_ids (identical base content)
  - files:  every file the Dockerfile adds is present with identical contents, and no other files are
            added. Python bytecode (.pyc) is compared on its code body, after the 16-byte header
  - config: Entrypoint, Cmd, Env, WorkingDir, ExposedPorts and User are identical

Reported separately as non-semantic:
  - .pyc headers: pip compiles bytecode at install time, and the header records the source mtime. The
    code body after the header must be identical; files whose header alone differs are listed.
  - image metadata: digests, creation times and history text.
"""
import argparse
import json
import os
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, os.path.dirname(__file__))
from image_files import added_files  # noqa: E402


def saved_layers(image, workdir):
    tar_path = os.path.join(workdir, 'image.tar')
    subprocess.run(['docker', 'save', '-o', tar_path, image], check=True)
    with tarfile.open(tar_path) as t:
        t.extractall(workdir, filter='data')
    manifest = json.load(open(os.path.join(workdir, 'manifest.json')))[0]
    config = json.load(open(os.path.join(workdir, manifest['Config'])))
    return [os.path.join(workdir, p) for p in manifest['Layers']], config


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('image')
    ap.add_argument('--out')
    a = ap.parse_args()
    ref = json.load(open(a.reference))
    with tempfile.TemporaryDirectory() as work:
        layers, config = saved_layers(a.image, work)
        n = len(ref['base']['diffIds'])
        base_ok = config['rootfs']['diff_ids'][:n] == ref['base']['diffIds']
        built = added_files(layers, n)
    want = ref['files']
    is_pyc = lambda p: p.endswith('.pyc')
    # .pyc files are compared on their code body; their 16-byte header records install time.
    same = lambda p: (built[p].get('bodySha256') == want[p].get('bodySha256') and built[p]['mode'] == want[p]['mode']) if is_pyc(p) else built[p] == want[p]
    report = {
        'unit': ref['unit'],
        'base': {'identical': base_ok, 'layers': n},
        'files': {
            'reference': len(want),
            'identical': sum(1 for p in want if p in built and same(p)),
            'differing': sorted(p for p in want if p in built and not same(p)),
            'missing': sorted(p for p in want if p not in built),
            'extra': sorted(p for p in built if p not in want),
        },
        'config': {k: {'reference': ref['config'][k], 'rebuilt': config['config'].get(k)}
                   for k in ref['config'] if ref['config'][k] != config['config'].get(k)},
        'nonSemantic': {
            'pycHeaderOnly': sorted(p for p in want if is_pyc(p) and p in built and same(p) and built[p]['sha256'] != want[p]['sha256']),
            'architecture': config.get('architecture'),
        },
    }
    f = report['files']
    report['equivalent'] = base_ok and not (f['differing'] or f['missing'] or f['extra'] or report['config'])
    ns = report['nonSemantic']
    print(json.dumps({'unit': ref['unit'], 'equivalent': report['equivalent'], 'base': report['base'],
                      'files': {k: (len(v) if isinstance(v, list) else v) for k, v in f.items()},
                      'configDifferences': list(report['config']),
                      'pycHeaderOnlyDifferences': len(ns['pycHeaderOnly'])}))
    for k in ('differing', 'missing', 'extra'):
        for p in f[k][:50]:
            print(f'  {k}: {p}')
    if a.out:
        json.dump(report, open(a.out, 'w'), indent=1)
    return 0 if report['equivalent'] else 1


if __name__ == '__main__':
    sys.exit(main())
