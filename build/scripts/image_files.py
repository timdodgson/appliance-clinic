"""Shared helpers for the Phase 3 image checks (#29): read an image's layer tars in order and return the
final state of every regular file and symlink added after the base layers. Pure stdlib."""
import hashlib
import os
import tarfile


def added_files(layer_paths, base_count):
    """Apply layers in order (with OCI whiteouts); return {path: {...}} for entries written by layers
    at index >= base_count that are still present in the final filesystem."""
    state = {}
    for i, path in enumerate(layer_paths):
        with tarfile.open(path, 'r:*') as t:
            for m in t:
                name = m.name.lstrip('./').lstrip('/')
                d, b = os.path.split(name)
                if b == '.wh..wh..opq':
                    for k in [k for k in state if k.startswith(d + '/')]:
                        del state[k]
                    continue
                if b.startswith('.wh.'):
                    target = os.path.join(d, b[4:])
                    for k in [k for k in state if k == target or k.startswith(target + '/')]:
                        del state[k]
                    continue
                if m.isdir():
                    continue
                if m.issym() or m.islnk():
                    state[name] = {'layer': i, 'link': m.linkname}
                elif m.isfile():
                    data = t.extractfile(m).read()
                    entry = {'layer': i, 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'mode': oct(m.mode & 0o7777)}
                    if name.endswith('.pyc'):
                        # A .pyc is a 16-byte header (magic, flags, source mtime and size) then the
                        # marshalled code. The body is what runs; the header records install time.
                        entry['bodySha256'] = hashlib.sha256(data[16:]).hexdigest()
                    state[name] = entry
    return {k: {kk: vv for kk, vv in v.items() if kk != 'layer'} for k, v in sorted(state.items()) if v['layer'] >= base_count}
