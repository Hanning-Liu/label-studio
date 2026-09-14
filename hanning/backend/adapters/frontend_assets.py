import hashlib
from pathlib import Path


def asset_revision(root):
    digest = hashlib.sha256()
    try:
        for name in ('runtime.js', 'vendor.js', 'main.js', 'main.css'):
            digest.update((Path(root) / name).read_bytes())
    except OSError:
        return ''
    return digest.hexdigest()[:16]
