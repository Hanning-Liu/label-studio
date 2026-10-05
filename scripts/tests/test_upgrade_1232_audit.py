import importlib.util
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

spec = importlib.util.spec_from_file_location('upgrade_audit', Path(__file__).parents[1] / 'upgrade_1232_audit.py')
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class UpgradeAuditTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'data.sqlite3'
        with closing(sqlite3.connect(self.path)) as db, db:
            db.executescript('''
                CREATE TABLE task (id INTEGER PRIMARY KEY, data TEXT);
                CREATE TABLE draft (id INTEGER PRIMARY KEY, task_id INTEGER REFERENCES task(id), result TEXT);
                CREATE TABLE tasks_referencesyncmapping (id INTEGER PRIMARY KEY, enabled BOOLEAN, worker_heartbeat TEXT);
                INSERT INTO task VALUES (1, '{"image":"a.png","room":1}');
                INSERT INTO draft VALUES (1, 1, '[{"id":"region-1"}]');
                INSERT INTO tasks_referencesyncmapping VALUES (1, 1, 'old');
            ''')

    def update(self, sql):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute(sql)

    def test_heartbeat_is_separate_but_mapping_changes_fail(self):
        before = audit.fingerprint(self.path)
        self.update("UPDATE tasks_referencesyncmapping SET worker_heartbeat='new'")
        result = audit.compare(before, audit.fingerprint(self.path))
        self.assertTrue(result['passed'])
        self.assertTrue(result['operational_changed'])
        self.update('UPDATE tasks_referencesyncmapping SET enabled=0')
        self.assertFalse(audit.compare(before, audit.fingerprint(self.path))['passed'])

    def test_lost_draft_is_detected(self):
        before = audit.fingerprint(self.path)
        self.update('DELETE FROM draft')
        self.assertEqual(audit.compare(before, audit.fingerprint(self.path))['changed_business_tables'], ['draft'])

    def test_json_key_order_does_not_change_fingerprint(self):
        before = audit.fingerprint(self.path)
        self.update('UPDATE task SET data=\'{"room":1, "image":"a.png"}\'')
        self.assertTrue(audit.compare(before, audit.fingerprint(self.path))['passed'])

    def test_snapshot_includes_committed_wal_and_refuses_overwrite(self):
        destination = self.path.with_name('snapshot.sqlite3')
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('PRAGMA journal_mode=WAL')
            db.execute("INSERT INTO task VALUES (2, '{}')")
            db.commit()
            result = audit.snapshot(self.path, destination)
        self.assertEqual(result['business']['task']['rows'], 2)
        with self.assertRaises(FileExistsError):
            audit.snapshot(self.path, destination)

    def test_existing_foreign_key_violation_fails_comparison(self):
        self.update('UPDATE draft SET task_id=999')
        report = audit.fingerprint(self.path)
        self.assertFalse(audit.compare(report, report)['passed'])


if __name__ == '__main__':
    unittest.main()
