#!/usr/bin/env python3
"""Assemble a base image from its layer blobs, pinned by digest, and load it into Docker (Phase 3, #29).

    python3 build/scripts/assemble_base.py <reference.image.json> --tag <local-tag>
        [--blobs-dir DIR | --registry docker.io/library/python]

Used for bases that cannot be pulled by a tag or manifest digest:
  - The MCP base (python:3.12-slim, 2026-10-01) is no longer tagged. Its layer blobs are still served
    by digest, so they are fetched from the registry.
  - Environments that cannot reach a registry's blob CDN use local copies (--blobs-dir: the
    production image layers downloaded in #4, named by digest in layers.json).

Every blob is verified against its digest before use. The image config carries only the base's
runtime settings, recorded in the reference file as base.config. The layers are the pinned content.
"""
import argparse
import gzip
import hashlib
import io
import json
import os
import subprocess
import sys
import tarfile
import urllib.request


def fetch_registry(registry, digest):
    host, repo = registry.split('/', 1)
    if host == 'docker.io':
        token = json.load(urllib.request.urlopen(f'https://auth.docker.io/token?service=registry.docker.io&scope=repository:{repo}:pull'))['token']
        url = f'https://registry-1.docker.io/v2/{repo}/blobs/{digest}'
    else:
        token = json.load(urllib.request.urlopen(f'https://{host}/token/?scope=repository:{repo}:pull&service={host}'))['token']
        url = f'https://{host}/v2/{repo}/blobs/{digest}'
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}'})
    return urllib.request.urlopen(req).read()


def fetch_local(blobs_dir, digest):
    layers = json.load(open(os.path.join(blobs_dir, 'layers.json')))
    match = [l for l in layers if l['digest'] == digest]
    if not match:
        raise SystemExit(f'{digest} not in {blobs_dir}/layers.json')
    return open(match[0]['file'], 'rb').read()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('reference')
    ap.add_argument('--tag', required=True)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument('--blobs-dir')
    src.add_argument('--registry')
    a = ap.parse_args()
    ref = json.load(open(a.reference))
    base = ref['base']
    # docker load needs a name:tag in RepoTags; newer engines reject a bare name.
    tag = a.tag if ':' in a.tag.rsplit('/', 1)[-1] else a.tag + ':latest'
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode='w') as tar:
        def add(name, data):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
        layer_names = []
        for digest, diff_id in zip(base['layers'], base['diffIds']):
            blob = fetch_local(a.blobs_dir, digest) if a.blobs_dir else fetch_registry(a.registry, digest)
            if 'sha256:' + hashlib.sha256(blob).hexdigest() != digest:
                raise SystemExit(f'blob digest mismatch for {digest}')
            raw = gzip.decompress(blob)
            if 'sha256:' + hashlib.sha256(raw).hexdigest() != diff_id:
                raise SystemExit(f'diff_id mismatch for {digest}')
            name = f'{diff_id[7:]}.tar'
            add(name, raw)
            layer_names.append(name)
        config = {'architecture': ref['architecture'], 'os': 'linux', 'config': base['config'],
                  'rootfs': {'type': 'layers', 'diff_ids': base['diffIds']},
                  'history': [{'created_by': f'pinned base layer {d}'} for d in base['layers']]}
        if ref['architecture'] == 'arm64':
            config['variant'] = 'v8'
        cfg = json.dumps(config).encode()
        cfg_name = hashlib.sha256(cfg).hexdigest() + '.json'
        add(cfg_name, cfg)
        add('manifest.json', json.dumps([{'Config': cfg_name, 'RepoTags': [tag], 'Layers': layer_names}]).encode())
    subprocess.run(['docker', 'load'], input=out.getvalue(), check=True)
    print(f'{tag}: {len(layer_names)} layers verified and loaded')


if __name__ == '__main__':
    sys.exit(main())
