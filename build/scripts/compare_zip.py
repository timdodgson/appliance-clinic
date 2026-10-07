#!/usr/bin/env python3
"""Compare a rebuilt Lambda zip with its production reference, entry by entry (Phase 3, #29).

    python3 build/scripts/compare_zip.py build/reference/<unit>.zip.json build/out/<unit>.zip [--out report.json]

Equivalent means the same set of file paths with byte-identical contents. Archive metadata
(timestamps, entry order, compression, directory entries) is reported separately; it changes the
CodeSha256 but not what runs.
"""
import argparse
import base64
import hashlib
import json
import sys
import zipfile


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('zip')
    ap.add_argument('--out')
    a = ap.parse_args()
    ref = json.load(open(a.reference))
    z = zipfile.ZipFile(a.zip)
    built = {i.filename: hashlib.sha256(z.read(i.filename)).hexdigest() for i in z.infolist() if not i.is_dir()}
    want = {p: f['sha256'] for p, f in ref['files'].items()}
    report = {
        'unit': ref['unit'],
        'equivalent': None,
        'files': len(want),
        'identical': sorted(p for p in want if built.get(p) == want[p]),
        'differing': sorted(p for p in want if p in built and built[p] != want[p]),
        'missing': sorted(p for p in want if p not in built),
        'extra': sorted(p for p in built if p not in want),
        'metadata': {
            'productionCodeSha256': ref['codeSha256'],
            'rebuiltCodeSha256': base64.b64encode(hashlib.sha256(open(a.zip, 'rb').read()).digest()).decode(),
            'note': 'Expected to differ: the rebuild uses fixed timestamps, sorted entries and no directory entries.',
        },
    }
    report['equivalent'] = not (report['differing'] or report['missing'] or report['extra'])
    summary = {k: (len(v) if isinstance(v, list) else v) for k, v in report.items() if k != 'metadata'}
    print(json.dumps(summary))
    for k in ('differing', 'missing', 'extra'):
        for p in report[k]:
            print(f'  {k}: {p}')
    if a.out:
        json.dump(report, open(a.out, 'w'), indent=1)
    return 0 if report['equivalent'] else 1


if __name__ == '__main__':
    sys.exit(main())
