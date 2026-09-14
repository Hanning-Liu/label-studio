"""Migration-only equivalence check against Git, not a second maintained catalog."""
import argparse
import ast
import json
import re
import subprocess
from pathlib import Path

from hanning.backend.catalog import ADDITIONS, CATALOG, FURNITURE_TYPE_CHOICES


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', default='c015e56a23b090f16f12a559c9be78b94b62a673')
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[2]

    def read(path):
        return subprocess.check_output(['git', 'show', f'{args.baseline}:{path}'], cwd=root).decode('utf-8')

    def assigned(path, name):
        for node in ast.parse(read(path)).body:
            if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == name for t in node.targets):
                return ast.literal_eval(node.value)
        raise AssertionError(f'Missing baseline assignment: {name}')

    assert FURNITURE_TYPE_CHOICES == assigned('label_studio/tasks/furniture_instances/__init__.py', 'FURNITURE_TYPE_CHOICES')
    assert ADDITIONS == assigned('label_studio/tasks/furniture_instances/catalog_upgrade.py', 'ADDITIONS')
    expected = json.loads(read('web/libs/editor/src/furnitureInstances/catalogDetails.json'))
    assert expected == {row['id']: {key: row[key] for key in ('definition', 'aliases', 'confusable')}
                        for row in CATALOG['categories']}
    palette = read('web/libs/editor/src/furnitureInstances/presentation.js')
    match = re.search(r'export const FURNITURE_TYPE_GROUPS = Object.freeze\((\[.*?\])\);', palette, re.S)
    assert match
    literal = re.sub(r'([,{]\s*)([A-Za-z_][A-Za-z_0-9]*)(\s*:)', r'\1"\2"\3', match[1])
    expected = json.loads(re.sub(r',\s*([}\]])', r'\1', literal))
    actual = [{'name': group['name'], 'color': group['color'], 'types': [row['id'] for row in sorted(
        [row for row in CATALOG['categories'] if row['group'] == group['id']], key=lambda row: row['display_order'])]}
              for group in sorted(CATALOG['groups'], key=lambda group: group['order'])]
    assert actual == expected
    print(json.dumps({'baseline': args.baseline, 'categories': len(FURNITURE_TYPE_CHOICES), 'groups': len(actual),
                      'historical_additions': len(ADDITIONS), 'labels_orders_colors_descriptions': 'identical'}))


if __name__ == '__main__':
    main()
