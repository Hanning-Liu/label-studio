"""Fast catalog regression entry: run in the existing development environments."""
import argparse
import subprocess
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--frontend-only', action='store_true')
    parser.add_argument('--backend-only', action='store_true')
    parser.add_argument('--node', default='node')
    args = parser.parse_args()
    if args.frontend_only and args.backend_only:
        parser.error('Choose at most one environment restriction')
    root = Path(__file__).resolve().parents[2]
    if not args.backend_only:
        subprocess.run([args.node, 'node_modules/jest/bin/jest.js', '--config', 'libs/editor/jest.config.js',
                        '--testPathPatterns', 'catalog.test|furnitureInstances|Image.furnitureInstances',
                        '--maxWorkers=2'], cwd=root / 'web', check=True)
    if not args.frontend_only:
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'hanning/tests/backend', '-v'],
                       cwd=root, check=True)
        subprocess.run([sys.executable, '-m', 'pytest', '--import-mode=importlib', '--pyargs',
                        'tasks.furniture_instances', '-q'], cwd=root / 'label_studio', check=True)
        subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'scripts/tests',
                        '-p', 'test_furniture_instances_to_unified.py', '-v'], cwd=root, check=True)


if __name__ == '__main__':
    main()
