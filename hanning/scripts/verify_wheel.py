"""Build/install the wheel independently of the source checkout (run in the build image)."""

import argparse
import json
import subprocess
import sys
import tempfile
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
    with tempfile.TemporaryDirectory() as installation:
        subprocess.run([sys.executable, '-m', 'pip', 'install', '--no-deps', '--target', installation, str(wheels[0])], check=True)
        code = (
            'import json,sys; from pathlib import Path; '
            'sys.path.insert(0,sys.argv[1]); import hanning; '
            'assert Path(hanning.__file__).is_relative_to(sys.argv[1]); '
            'from hanning.backend.catalog import CATALOG; '
            'print(json.dumps({"installed_package":hanning.__file__, "categories":len(CATALOG["categories"])}))'
        )
        result = subprocess.run([sys.executable, '-I', '-c', code, installation], cwd=installation,
                                check=True, text=True, capture_output=True)
    (args.output / 'installation-check.json').write_text(result.stdout, encoding='utf-8')
    print(json.dumps({'wheel': str(wheels[0]), 'installation': 'passed'}))


if __name__ == '__main__':
    main()
