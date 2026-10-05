#!/usr/bin/env python3
"""Read-only SQLite fingerprints and consistent snapshots for the 1.23.2 upgrade.

Reports contain hashes and counts, never annotation content or credentials.
Only explicitly listed runtime fields are excluded from business fingerprints.
"""
import argparse
import hashlib
import json
import os
import sqlite3
from contextlib import closing
from pathlib import Path

OPERATIONAL_TABLES = {'django_session', 'django_migrations', 'sqlite_sequence'}
OPERATIONAL_COLUMNS = {'tasks_referencesyncmapping': {'worker_heartbeat'}}


def readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)


def quote(name):
    return '"' + name.replace('"', '""') + '"'


def normalize(value):
    if isinstance(value, bytes):
        return {'bytes_sha256': hashlib.sha256(value).hexdigest()}
    if isinstance(value, str) and value.lstrip().startswith(('{', '[')):
        try:
            return json.loads(value)
        except ValueError:
            pass
    return value


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True,
                                    separators=(',', ':')).encode()).hexdigest()


def fingerprint(path):
    with closing(readonly(path)) as connection:
        connection.execute('BEGIN')
        integrity = [row[0] for row in connection.execute('PRAGMA integrity_check')]
        foreign_keys = [list(row) for row in connection.execute('PRAGMA foreign_key_check')]
        report = {'schema_version': 1, 'integrity': integrity,
                  'foreign_key_violations': foreign_keys, 'business': {}, 'operational': {}}
        tables = [r[0] for r in connection.execute(
            "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        for table in tables:
            info = list(connection.execute(f'PRAGMA table_info({quote(table)})'))
            columns = [row[1] for row in info]
            ignored = OPERATIONAL_COLUMNS.get(table, set())
            business_columns = [c for c in columns if c not in ignored]
            business_hashes, runtime_hashes = [], []
            for row in connection.execute(f'SELECT * FROM {quote(table)}'):
                values = {c: normalize(v) for c, v in zip(columns, row)}
                business_hashes.append(digest({c: values[c] for c in business_columns}))
                runtime_hashes.append(digest(values))
            entry = {'rows': len(business_hashes), 'columns': business_columns,
                     'rows_sha256': digest(sorted(business_hashes)),
                     'schema_sha256': digest([r for r in info if r[1] not in ignored])}
            if table in OPERATIONAL_TABLES:
                report['operational'][table] = entry
            else:
                report['business'][table] = entry
                if ignored:
                    report['operational'][table] = {'rows_sha256': digest(sorted(runtime_hashes)),
                                                    'excluded_columns': sorted(ignored)}
        return report


def compare(before, after):
    if before.get('schema_version') != 1 or after.get('schema_version') != 1:
        raise ValueError('Unsupported fingerprint schema')
    changed = [name for name in sorted(before['business'].keys() | after['business'].keys())
               if before['business'].get(name) != after['business'].get(name)]
    healthy = all(r['integrity'] == ['ok'] and not r['foreign_key_violations'] for r in (before, after))
    return {'passed': healthy and not changed, 'integrity_passed': healthy,
            'changed_business_tables': changed,
            'operational_changed': before['operational'] != after['operational']}


def snapshot(source, destination):
    destination = Path(destination)
    # Reserve the destination, so an existing database can never be overwritten.
    os.close(os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
    with closing(readonly(source)) as source_db, closing(sqlite3.connect(destination)) as target_db:
        source_db.backup(target_db)
    destination.chmod(0o600)
    return fingerprint(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    fp = sub.add_parser('fingerprint')
    fp.add_argument('database', type=Path)
    snap = sub.add_parser('snapshot')
    snap.add_argument('database', type=Path)
    snap.add_argument('destination', type=Path)
    diff = sub.add_parser('compare')
    diff.add_argument('before', type=Path)
    diff.add_argument('after', type=Path)
    args = parser.parse_args()
    if args.command == 'compare':
        result = compare(json.loads(args.before.read_text()), json.loads(args.after.read_text()))
        passed = result['passed']
    else:
        result = snapshot(args.database, args.destination) if args.command == 'snapshot' else fingerprint(args.database)
        passed = result['integrity'] == ['ok'] and not result['foreign_key_violations']
    print(json.dumps(result, sort_keys=True, indent=2))
    raise SystemExit(0 if passed else 1)


if __name__ == '__main__':
    main()
