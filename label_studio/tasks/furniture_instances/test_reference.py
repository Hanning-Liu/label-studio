import copy
import unittest

from .reference import (
    manual_hash,
    merge_results,
    pending_reviews,
    reference_hash,
    stamp_provenance,
    strip_client_provenance,
    validate_provenance,
)
from .test_validation import SOURCE_VERSION, instance_results, reference_results
from .validation import validate


class FurnitureInstanceReferenceTests(unittest.TestCase):
    def test_reference_hash_ignores_display_only_fields(self):
        refs = reference_results()
        decorated = copy.deepcopy(refs)
        for result in decorated:
            result.update(readonly=True, selected=True, opacity=0.4)
        self.assertEqual(reference_hash(refs), reference_hash(decorated))

    def test_merge_replaces_only_references_and_source_change_makes_instances_stale(self):
        old_refs = reference_results()
        manual = instance_results(old_refs)
        combined = copy.deepcopy(old_refs + manual)
        new_refs = copy.deepcopy(old_refs)
        group = next(
            result
            for result in new_refs
            if result.get('meta', {}).get('occupancy_context', {}).get('group_id') == 'group-a'
        )
        group['meta']['occupancy_context']['group_note'] = 'source changed'
        merged = merge_results(combined, new_refs)
        self.assertEqual(manual_hash(merged), manual_hash(combined))
        self.assertEqual(
            [result for result in merged if result.get('from_name', '').startswith('furniture_')],
            manual,
        )
        state = pending_reviews(merged)
        self.assertEqual(state, [{'id': 'instance-a', 'group_id': 'group-a', 'review_status': 'stale'}])

    def test_server_provenance_is_not_part_of_manual_optimistic_lock(self):
        refs = reference_results()
        results = refs + instance_results(refs)
        before = manual_hash(results)
        forged = copy.deepcopy(results)
        for result in forged:
            if result.get('from_name', '').startswith('furniture_'):
                result.setdefault('meta', {})['furniture_instance_provenance'] = {
                    'schema_version': 1,
                    'project_id': 999,
                    'task_id': 999,
                    'annotation_id': 999,
                    'result_id': result['id'],
                }
        self.assertEqual(manual_hash(forged), before)
        self.assertEqual(strip_client_provenance(forged), results)
        stamped = stamp_provenance(forged, project_id=14, task_id=24, annotation_id=104)
        self.assertTrue(validate_provenance(stamped, 14, 24, 104))
        self.assertEqual(manual_hash(stamped), before)
        with self.assertRaisesRegex(ValueError, 'provenance'):
            validate_provenance(stamped, 14, 24, 105)

    def test_source_version_is_not_rewritten_during_reference_merge(self):
        refs = reference_results()
        manual = instance_results(refs)
        self.assertTrue(all(
            result['meta']['furniture_instance_context']['source_version'] == SOURCE_VERSION
            for result in manual
        ))
        changed = merge_results(refs + manual, copy.deepcopy(refs))
        self.assertTrue(all(
            result['meta']['furniture_instance_context']['source_version'] == SOURCE_VERSION
            for result in changed
            if result.get('from_name', '').startswith('furniture_')
        ))

    def test_unrelated_group_change_does_not_stale_the_owning_group(self):
        refs = reference_results()
        manual = instance_results(refs)
        changed = copy.deepcopy(refs)
        other = next(
            result
            for result in changed
            if result.get('meta', {}).get('occupancy_context', {}).get('group_id') == 'group-b'
        )
        other['meta']['occupancy_context']['group_note'] = 'unrelated change'
        merged = merge_results(refs + manual, changed)
        self.assertEqual(
            pending_reviews(merged),
            [{'id': 'instance-a', 'group_id': 'group-a', 'review_status': 'reviewed'}],
        )
        self.assertEqual(validate(merged, reference_hash(changed)), [])


if __name__ == '__main__':
    unittest.main()
