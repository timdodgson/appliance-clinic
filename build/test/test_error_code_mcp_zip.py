"""Change 22.0 (ADR 0022): the error-code MCP as a Zip Lambda, applianceclinic-error-code-mcp.

Builds build/out/applianceclinic-error-code-mcp.zip's equivalent with build/scripts/package_zips.py and inspects it:
run.sh is the 0755 entry point, every file the image's Dockerfile copies is at error-codes/, nothing the image would not
ship (bytecode, error-codes tests, console scripts) is in it, and the installed distributions are exactly the production
versions (build/python/error-code-mcp.constraints.txt), as pinned with hashes in the arm64 lock.

The dependencies come from build/scripts/fetch_error_code_mcp_site.sh (ERROR_CODE_MCP_SITE, default
build/out/error-code-mcp-site). Tests run offline, so when that directory is absent the zip is built from a stand-in
site holding only the lock's dist-info metadata: the packaging is still checked, and the real installation is checked
whenever it has been fetched.
"""
import glob
import hashlib
import os
import re
import sys
import zipfile

import pytest

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'build', 'scripts'))
import package_zips  # noqa: E402

CONSTRAINTS = os.path.join(ROOT, 'build', 'python', 'error-code-mcp.constraints.txt')
LOCK = os.path.join(ROOT, 'build', 'python', 'error-code-mcp.lambda-arm64.lock')
REAL_SITE = os.environ.get('ERROR_CODE_MCP_SITE') or os.path.join(ROOT, 'build', 'out', 'error-code-mcp-site')
RUN_SH = (b'#!/bin/bash\n'
          b'cd "$LAMBDA_TASK_ROOT/error-codes/mcp/deploy"\n'
          b'PYTHONPATH="$LAMBDA_TASK_ROOT" exec python3 -m uvicorn asgi:app --host 0.0.0.0 --port 8080 --log-level info\n')


def canonical(name):
    return re.sub(r'[-_.]+', '-', name).lower()


def pins(path):
    out = {}
    for line in open(path):
        m = re.match(r'^([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)', line)
        if m:
            out[canonical(m.group(1))] = m.group(2)
    return out


def lock_entries():
    """[(name, version, [sha256, ...])] in lock order; continuation lines carry the hashes."""
    entries, text = [], open(LOCK).read().replace('\\\n', ' ')
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        m = re.match(r'^(\S+)==(\S+)((?:\s+--hash=sha256:[0-9a-f]{64})+)\s*$', line)
        assert m, f'lock line not pinned with hashes: {line}'
        entries.append((m.group(1), m.group(2), re.findall(r'sha256:([0-9a-f]{64})', m.group(3))))
    return entries


def stand_in_site(directory):
    for name, version, _ in lock_entries():
        d = os.path.join(directory, f'{name.replace("-", "_")}-{version}.dist-info')
        os.makedirs(d)
        with open(os.path.join(d, 'METADATA'), 'w') as f:
            f.write(f'Metadata-Version: 2.1\nName: {name}\nVersion: {version}\n')
    return directory


@pytest.fixture(scope='module')
def built(tmp_path_factory):
    work = tmp_path_factory.mktemp('ecz')
    real = bool(glob.glob(os.path.join(REAL_SITE, '*.dist-info')))
    site = REAL_SITE if real else stand_in_site(str(work / 'site'))
    path = str(work / 'applianceclinic-error-code-mcp.zip')
    package_zips.build_error_code_mcp(path, site)
    again = str(work / 'again.zip')
    package_zips.build_error_code_mcp(again, site)
    return {'path': path, 'again': again, 'zip': zipfile.ZipFile(path), 'real': real}


def test_lock_pins_exactly_the_constraints_with_one_hash_each():
    entries = lock_entries()
    assert {canonical(n): v for n, v, _ in entries} == pins(CONSTRAINTS)
    assert len(entries) == len(pins(CONSTRAINTS))
    for name, _, hashes in entries:
        assert len(hashes) == 1, name


def test_run_sh_is_the_executable_entry_point(built):
    info = built['zip'].getinfo('run.sh')
    assert (info.external_attr >> 16) & 0o777 == 0o755
    assert built['zip'].read('run.sh') == RUN_SH


def test_every_dockerfile_copy_source_is_under_error_codes(built):
    names = set(built['zip'].namelist())
    copies = package_zips.dockerfile_copies()
    assert len(copies) >= 8
    for sources, dest in copies:
        if not dest.startswith('/app/error-codes/'):
            assert dest == '/app/requirements.txt'  # pip's input in the image, not part of the service
            continue
        dest = dest[len('/app/'):]
        for s in sources:
            src = os.path.join(ROOT, 'error-codes', s)
            if os.path.isdir(src):
                files = [p for p in glob.glob(os.path.join(src, '**', '*'), recursive=True)
                         if os.path.isfile(p) and not {'__pycache__', 'tests', '.venv'} & set(os.path.relpath(p, src).split(os.sep))]
                assert files, s
                for p in files:
                    name = dest.rstrip('/') + '/' + os.path.relpath(p, src).replace(os.sep, '/')
                    assert name in names, name
                    assert built['zip'].read(name) == open(p, 'rb').read(), name
            else:
                name = dest + os.path.basename(s) if dest.endswith('/') else dest
                assert name in names, name
                assert built['zip'].read(name) == open(src, 'rb').read(), name
    shipped = {n for n in names if n.startswith('error-codes/')}
    assert 'error-codes/mcp/deploy/asgi.py' in shipped and 'error-codes/mcp/deploy/integrity.py' in shipped
    assert not any('/tests/' in n for n in shipped)


def test_no_bytecode_console_scripts_or_adapter(built):
    for n in built['zip'].namelist():
        assert not n.startswith('bin/'), n
        assert '__pycache__' not in n.split('/'), n
        assert not n.endswith('.pyc'), n
        assert not n.startswith(('opt/', 'extensions/')), n


def test_installed_distributions_are_the_production_versions(built):
    z = built['zip']
    found = {}
    for n in z.namelist():
        parts = n.split('/')
        if len(parts) == 2 and parts[0].endswith('.dist-info') and parts[1] == 'METADATA':
            meta = z.read(n).decode('utf-8', 'replace')
            name = re.search(r'^Name: (.+)$', meta, re.M).group(1).strip()
            version = re.search(r'^Version: (.+)$', meta, re.M).group(1).strip()
            found[canonical(name)] = version
    assert found == pins(CONSTRAINTS)


def test_deterministic(built):
    a, b = open(built['path'], 'rb').read(), open(built['again'], 'rb').read()
    assert hashlib.sha256(a).digest() == hashlib.sha256(b).digest()
    infos = built['zip'].infolist()
    assert [i.filename for i in infos] == sorted(i.filename for i in infos)
    assert all(i.date_time == package_zips.FIXED_TIME for i in infos)
