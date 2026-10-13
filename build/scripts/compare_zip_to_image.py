#!/usr/bin/env python3
"""Compare a Zip Lambda built from this repository with the image it replaces, file by file (ADR 0022).

    python3 build/scripts/compare_zip_to_image.py build/reference/spares4repairs-error-code-mcp.image.json \\
        build/out/applianceclinic-error-code-mcp.zip [--out report.json]

The reference lists every file the image's Dockerfile added on top of its base (build/reference/*.image.json). Paths
are mapped from the image to the zip:
    app/error-codes/...                          -> error-codes/...
    usr/local/lib/python3.12/site-packages/...   -> ... (the zip root, which is on sys.path in a Lambda)
Not compared:
    .pyc files (pip compiled bytecode in the image; the zip ships none, Python compiles on import)
    dist-info RECORD, INSTALLER and REQUESTED (they describe the installation, not the code)
    files outside those prefixes (the adapter extension, console scripts in usr/local/bin and app/requirements.txt),
    listed as `unmapped`; the Zip Lambda takes the adapter from a layer and starts uvicorn from run.sh.

Exit 0 only when every compared file is identical and nothing is missing or extra; a deliberate difference (a repaired
data file, run.sh) is reported, never hidden.
"""
import argparse
import hashlib
import json
import sys
import zipfile

MAPPING = [('app/error-codes/', 'error-codes/'), ('usr/local/lib/python3.12/site-packages/', '')]
IGNORED_DIST_INFO = {'RECORD', 'INSTALLER', 'REQUESTED'}


def ignored(path):
    if path.endswith('.pyc') or '/__pycache__/' in f'/{path}':
        return True
    parts = path.split('/')
    return len(parts) >= 2 and parts[-2].endswith('.dist-info') and parts[-1] in IGNORED_DIST_INFO


def mapped(path):
    for src, dst in MAPPING:
        if path.startswith(src):
            return dst + path[len(src):]
    return None


def compare(ref, zip_path):
    z = zipfile.ZipFile(zip_path)
    built = {i.filename: hashlib.sha256(z.read(i.filename)).hexdigest() for i in z.infolist()
             if not i.is_dir() and not ignored(i.filename)}
    want, unmapped = {}, []
    for p, f in ref['files'].items():
        m = mapped(p)
        if m is None:
            unmapped.append(p)
        elif not ignored(m):
            want[m] = f.get('sha256')
    report = {
        'unit': ref['unit'],
        'zip': zip_path,
        'compared': len(want),
        'identical': sum(1 for p in want if built.get(p) == want[p]),
        'differing': sorted(p for p in want if p in built and built[p] != want[p]),
        'missing': sorted(p for p in want if p not in built),
        'extra': sorted(p for p in built if p not in want),
        'unmapped': sorted(unmapped),
    }
    report['equivalent'] = not (report['differing'] or report['missing'] or report['extra'])
    return report


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('zip')
    ap.add_argument('--out')
    a = ap.parse_args()
    report = compare(json.load(open(a.reference)), a.zip)
    print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in report.items()}))
    for k in ('differing', 'missing', 'extra', 'unmapped'):
        for p in report[k]:
            print(f'  {k}: {p}')
    if a.out:
        json.dump(report, open(a.out, 'w'), indent=1)
    return 0 if report['equivalent'] else 1


if __name__ == '__main__':
    sys.exit(main())
