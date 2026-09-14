"""Build/install the wheel independently of the source checkout (run in the build image)."""

import argparse
import json
import subprocess
import sys
import tempfile
import tarfile
import zipfile
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]
    args.output.mkdir(parents=True, exist_ok=True)
    subprocess.run(['/opt/poetry/bin/poetry', 'build', '--output', str(args.output)], cwd=root, check=True)
    wheels = list(args.output.glob('label_studio-*.whl'))
    if len(wheels) != 1:
        raise RuntimeError('Expected exactly one Label Studio wheel in the output directory')
    expected = {str(path.relative_to(root)).replace('\\', '/') for path in (root / 'hanning').rglob('*')
                if path.is_file() and '__pycache__' not in path.parts and
                (path.suffix == '.py' or (path.suffix == '.json' and
                 path.relative_to(root / 'hanning').parts[0] in {'catalog', 'backend', 'scripts'}))}
    with zipfile.ZipFile(wheels[0]) as archive:
        missing = expected - set(archive.namelist())
        assert not missing, f'Wheel missing package files: {sorted(missing)}'
    sdists = list(args.output.glob('label_studio-*.tar.gz'))
    assert len(sdists) == 1, 'Expected exactly one sdist'
    with tarfile.open(sdists[0]) as archive:
        names = {name.split('/', 1)[-1] for name in archive.getnames()}
        assert expected <= names, f'Sdist missing package files: {sorted(expected - names)}'
    with tempfile.TemporaryDirectory() as installation:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', '--target', installation, str(wheels[0])], check=True)
        code = '''
import importlib, json, sys
from pathlib import Path
sys.path[:0] = [sys.argv[1], str(Path(sys.argv[1]) / 'label_studio')]
import hanning
assert Path(hanning.__file__).is_relative_to(sys.argv[1])
from hanning.backend.catalog import CATALOG
from hanning.scripts import furniture_instances_to_unified, cytoscape_apply_groups
assert cytoscape_apply_groups.DEFAULT_VISUAL_STYLE.is_file()
json.loads(cytoscape_apply_groups.DEFAULT_VISUAL_STYLE.read_text())
pairs = [
    ('tasks.furniture_instances.geometry', 'hanning.backend.validation.furniture_instances.geometry'),
    ('tasks.occupancy.geometry', 'hanning.backend.validation.occupancy.geometry'),
    ('tasks.windows.geometry', 'hanning.backend.validation.windows.geometry'),
    ('tasks.reference_sync.lineage_bundle', 'hanning.backend.reference_sync.lineage_bundle'),
]
for old, new in pairs:
    assert importlib.import_module(old) is importlib.import_module(new), old
print(json.dumps({'installed_package': hanning.__file__, 'categories': len(CATALOG['categories']),
                  'module_identity_pairs': len(pairs), 'exporter_and_style_resource': 'passed'}))
'''
        result = subprocess.run([sys.executable, '-I', '-c', code, installation], cwd=installation,
                                check=True, text=True, capture_output=True)
    (args.output / 'installation-check.json').write_text(result.stdout, encoding='utf-8')
    print(json.dumps({'wheel': str(wheels[0]), 'packaged_python_json_files': len(expected),
                      'installation': 'passed'}))


if __name__ == '__main__':
    main()
