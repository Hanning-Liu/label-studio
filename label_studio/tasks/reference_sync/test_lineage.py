import copy
import hashlib
import json
import sys
import tempfile
from io import StringIO
from pathlib import Path

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TransactionTestCase
from tasks.furniture_instances import tests as fixtures
from tasks.furniture_instances.reference import stamp_provenance
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from tasks.windows.aggregate import augment_floorplan_aggregate
from tasks.windows.downstream import authoritative_window_domain

from .lineage import canonical_windows, collect_documents, digest, report_for_task, validate_documents
from .lineage_bundle import export_bundle, load_bundle, validate_publication_sources
from .models import ReferenceSyncBinding


def publication_base(documents):
    """Small real /4 source envelope, matching the existing raw_inputs contract."""
    from tasks.furniture_instances.validation import furniture_groups
    root, zone, occupancy, _l4 = documents
    base = {'schema': 'floorplan-unified/4', 'created_at': root['updated_at'],
            'floorplan': {'id': 'lineage-fixture', 'image_id': 'fixture.png', 'width': 100, 'height': 100},
            'sources': {'format': 'label-studio-full-json'}, 'raw_inputs': {}, 'nodes': [], 'occupancy_regions': [],
            'connections': [], 'analysis_relations': [], 'occupancy_relations': [], 'occupancy_barriers': [],
            'identity_corrections': [], 'algorithm': {}, 'capabilities': {}, 'warnings': [], 'fingerprint': '0' * 64}
    for doc, name, role in zip(documents[:3], ('room', 'zone', 'occupancy'), ('rooms', 'zones', 'occupancy')):
        ann = {'id': doc['annotation_id'], 'updated_at': doc['updated_at'], 'was_cancelled': False, 'result': doc['result']}
        payload = {'id': doc['task_id'], 'project': doc['project_id'], 'data': doc['data'], 'annotations': [ann]}
        text = json.dumps(payload, ensure_ascii=False)
        sha = hashlib.sha256(text.encode()).hexdigest()
        base['raw_inputs'][role] = {'role': role, 'name': role + '.json', 'text': text, 'sha256': sha}
        base['sources'][name] = {**{key: doc[key] for key in ('project_id', 'task_id', 'annotation_id', 'updated_at')}, 'input_sha256': sha}
    for kind, doc, names in (('room', root, {'room_rectangle', 'room_polygon'}), ('zone', zone, {'zone_rectangle', 'zone_polygon'})):
        for row in doc['result']:
            if row.get('from_name') not in names:
                continue
            node = {'id': row['id'], 'kind': kind, 'result_id': row['id'], 'raw': copy.deepcopy(row),
                    'label': kind, 'code': kind, 'color': '#000000'}
            if kind == 'zone':
                node['parent_room_id'] = row['meta']['partition_context']['parent_room_id']
            base['nodes'].append(node)
    for ident, group in furniture_groups(occupancy['result']).items():
        rows = [r for r in occupancy['result'] if r.get('from_name') in {'occupancy_rectangle', 'occupancy_polygon'}
                and r.get('meta', {}).get('occupancy_context', {}).get('group_id') == ident]
        context = rows[0]['meta']['occupancy_context']
        base['nodes'].append({'id': ident, 'kind': 'furniture_group', 'parent_room_id': group['room_id'],
                              'parent_zone_id': group['zone_id'], 'label': ident, 'code': ident, 'color': '#000000'})
        base['occupancy_regions'].append({'id': ident, 'logical_id': ident, 'category': 'furniture_group',
                                          'group_id': ident, 'group_type': context['group_type'], 'group_note': '',
                                          'parent_room_id': group['room_id'], 'parent_zone_id': group['zone_id'],
                                          'parent_fingerprint': context['parent_fingerprint'], 'generation': 'manual',
                                          'review_status': 'confirmed', 'source_version': context['source_version'],
                                          'parts': [{'result_id': row['id'], 'raw': copy.deepcopy(row)} for row in rows]})
    if canonical_windows(root['result']):
        traces, connections, config = authoritative_window_domain(root['result'])
        from dataclasses import replace
        from tasks.windows.downstream import _targets
        from tasks.windows.projections import derive_window_projections
        config = replace(config, projection_boundary_tolerance_px=1e-6)
        targets = [{key: target[key] for key in ('level', 'entity_id', 'room_id', 'geometry')}
                   for target in _targets(zone['result'], 'L2') + _targets(occupancy['result'], 'L3')]
        projections = derive_window_projections(traces, connections, targets, config)
    else:
        from tasks.windows.config import WindowConfig
        traces, connections, config = [], [], WindowConfig()
        projections = []
    return augment_floorplan_aggregate(base, traces=traces, connections=connections, projections=projections, config=config,
                                      provenance={key: root[key] for key in ('project_id', 'task_id', 'annotation_id')})


class LineageTests(TransactionTestCase):
    def setUp(self):
        self.f = fixtures.FurnitureInstanceWindowSyncTests()
        self.f.setUp()

    def formal(self, fixture=None):
        f = fixture or self.f
        annotation = Annotation.objects.create(task=f.task, project=f.target_project, completed_by=f.user, result=f.complete_result())
        annotation.result = stamp_provenance(annotation.result, f.task.project_id, f.task.id, annotation.id)
        Annotation.objects.filter(pk=annotation.id).update(result=annotation.result)
        return annotation

    def documents(self):
        self.formal()
        return collect_documents(self.f.task, formal=True)

    def test_complete_windows_and_display_only_differences(self):
        docs = self.documents()
        original = copy.deepcopy(docs)
        report = validate_documents(docs, complete=True)
        self.assertTrue(report['complete'], report)
        self.assertEqual([row['window_count'] for row in report['levels']], [1, 1, 1, 1])
        for doc in docs[1:]:
            for row in doc['result']:
                row.update(readonly=True, opacity=0.15, hidden=True)
        self.assertTrue(validate_documents(docs, complete=True)['ready'])
        self.assertEqual(original[0], docs[0])

    def test_no_window_old_config_is_complete(self):
        docs = self.documents()
        # A genuinely windowless historical chain, including all applied snapshots.
        from .lineage import profile_reference_hash
        for index, doc in enumerate(docs):
            import xml.etree.ElementTree as ET
            root = ET.fromstring(doc['label_config'])
            for parent in root.iter():
                for child in list(parent):
                    if child.get('name') == 'window_vector':
                        parent.remove(child)
            doc['label_config'] = ET.tostring(root, encoding='unicode')
            doc['result'] = [r for r in doc['result'] if r.get('from_name') != 'window_vector']
            for row in doc['result']:
                row.get('meta', {}).pop('window_projections', None)
                row.get('meta', {}).pop('window_projection_state', None)
            if index:
                doc['prediction']['result'] = copy.deepcopy(docs[index - 1]['result'])
                doc['binding']['applied_hash'] = profile_reference_hash(docs[index - 1]['result'], index + 1)
        report = validate_documents(docs, complete=True)
        self.assertTrue(report['complete'], report)
        self.assertEqual(report['window_count'], 0)

    def test_root_replacement_missing_binding_and_image_change_have_explicit_locations(self):
        docs = collect_documents(self.f.task)
        binding = ReferenceSyncBinding.objects.get(target_task_id=docs[1]['task_id'])
        for field, value in (('source_annotation_id', 99999), ('source_data_hash', 'changed')):
            original = getattr(binding, field)
            setattr(binding, field, value)
            binding.save(update_fields=[field])
            report = report_for_task(self.f.task)
            self.assertFalse(report['ready'])
            self.assertEqual(report['issues'][0]['task_id'], docs[0]['task_id'])
            setattr(binding, field, original)
            binding.save(update_fields=[field])
        binding.delete()
        self.assertFalse(report_for_task(self.f.task)['ready'])

    def test_config_conflicts_and_concurrent_source_update_are_rejected(self):
        from .window_config_upgrade import upgrade_window_control
        docs = collect_documents(self.f.task)
        windows = canonical_windows(docs[0]['result'])
        for config in ('<View><Choices name="window_vector" toName="image"/></View>',
                       '<View><VectorLabels name="window_vector"/><VectorLabels name="window_vector"/></View>'):
            with self.assertRaises(ValueError):
                upgrade_window_control(config, docs[0]['label_config'], windows)
        out = StringIO()
        call_command('upgrade_window_reference_controls', project_id=self.f.target_project.id,
                     l1_task_id=docs[0]['task_id'], stdout=out)
        preview = json.loads(out.getvalue())
        Annotation.objects.filter(pk=docs[0]['annotation_id']).update(was_cancelled=True)
        with self.assertRaises(CommandError):
            call_command('upgrade_window_reference_controls', project_id=self.f.target_project.id,
                         l1_task_id=docs[0]['task_id'], apply=True, expected_title=self.f.target_project.title,
                         expected_config_sha256=preview['original_sha256'], expected_source_version=preview['source_version'],
                         stdout=StringIO())

    def test_source_change_between_direct_check_and_locked_snapshot_aborts_apply(self):
        from unittest.mock import patch
        from .lineage import require_source
        draft = self.f.draft()
        before = copy.deepcopy(draft.result)
        payload = {**self.f.payload(draft), 'source_version': self.f.binding.applied_hash}
        def racing_source(binding, **kwargs):
            self.f.change_source_group()
            return require_source(binding, **kwargs)
        with patch('tasks.reference_sync.lineage.require_source', side_effect=racing_source):
            response = self.f.client.post(f'/api/tasks/{self.f.task.id}/reference-sync/apply/', payload, format='json')
        self.assertEqual(response.status_code, 409)
        self.assertEqual(str(response.data['detail']), '读取来源链期间正式标注再次变化，本次创建或应用已中止')
        draft.refresh_from_db()
        self.assertEqual(draft.result, before)

    def test_valid_first_window_cannot_enter_old_downstream_config(self):
        docs = self.documents()
        import xml.etree.ElementTree as ET
        for doc in docs[1:]:
            root = ET.fromstring(doc['label_config'])
            for parent in root.iter():
                for child in list(parent):
                    if child.get('name') == 'window_vector':
                        parent.remove(child)
            doc['label_config'] = ET.tostring(root, encoding='unicode')
            doc['result'] = [r for r in doc['result'] if r.get('from_name') != 'window_vector']
        report = validate_documents(docs, complete=True)
        self.assertEqual(report['window_count'], 1)
        self.assertFalse(any(issue['level'] == 1 for issue in report['issues']))
        self.assertEqual({issue['level'] for issue in report['issues']}, {2, 3, 4})

    def test_new_task_ready_but_draft_is_not_complete(self):
        self.f.draft()
        self.assertTrue(report_for_task(self.f.task)['ready'])
        self.assertFalse(report_for_task(self.f.task, complete=True)['complete'])
        with self.assertRaises(CommandError):
            call_command('audit_floorplan_lineage', task_id=self.f.task.id, stdout=StringIO())

    def test_each_level_rejects_missing_duplicate_extra_and_changed_windows(self):
        docs = self.documents()
        for level in (2, 3, 4):
            for mode in ('missing', 'duplicate', 'extra', 'geometry', 'context'):
                with self.subTest(level=level, mode=mode):
                    changed = copy.deepcopy(docs)
                    rows = changed[level - 1]['result']
                    window = next(row for row in rows if row.get('from_name') == 'window_vector')
                    if mode == 'missing':
                        rows.remove(window)
                    elif mode in ('duplicate', 'extra'):
                        extra = copy.deepcopy(window)
                        if mode == 'extra':
                            extra['id'] = 'unexpected-window'
                        rows.append(extra)
                    elif mode == 'geometry':
                        window['value']['vertices'][-1]['x'] += 1
                    else:
                        window['meta']['window_context']['parent_room_id'] = 'wrong-room'
                    report = validate_documents(changed, complete=True)
                    self.assertFalse(report['ready'])
                    self.assertTrue(any(issue['level'] == level for issue in report['issues']))
        self.assertEqual(docs, collect_documents(self.f.task, formal=True))

    def test_same_count_different_id_is_not_equivalent(self):
        docs = self.documents()
        window = next(r for r in docs[-1]['result'] if r.get('from_name') == 'window_vector')
        window['id'] = 'different-id'
        report = validate_documents(docs, complete=True)
        self.assertFalse(report['ready'])
        self.assertEqual(report['levels'][-1]['window_count'], 1)

    def test_l1_deleted_last_window_blocks_even_when_direct_l3_hash_is_unchanged(self):
        before = report_for_task(self.f.task)
        docs = collect_documents(self.f.task)
        root = Annotation.objects.get(pk=docs[0]['annotation_id'])
        root.result = [r for r in root.result if r.get('from_name') != 'window_vector']
        root.save(update_fields=['result', 'updated_at'])
        protected = copy.deepcopy(self.f.source.result)
        response = self.f.client.get(f'/api/tasks/{self.f.task.id}/reference-sync/')
        self.assertEqual(response.status_code, 200)
        status = response.data
        self.assertEqual(status['source_version'], status['reference_version'])
        self.assertFalse(status['lineage']['ready'])
        self.assertNotEqual(status['lineage']['version'], before['version'])
        self.assertEqual(status['lineage']['window_count'], 0)
        self.assertTrue(any(issue['code'] == 'window_extra' for issue in status['lineage']['issues']))
        self.f.source.refresh_from_db()
        self.assertEqual(self.f.source.result, protected)

    def test_invalid_root_window_is_not_treated_as_zero(self):
        docs = self.documents()
        window = next(r for r in docs[0]['result'] if r.get('from_name') == 'window_vector')
        window['value']['vertices'] = []
        report = validate_documents(docs, complete=True)
        self.assertFalse(report['ready'])
        self.assertIsNone(report['window_count'])

    def test_binding_image_and_formal_identity_fail_closed(self):
        docs = self.documents()
        for level in (2, 3, 4):
            for key, value in (('enabled', False), ('sync_type', 'wrong'), ('source_annotation_id', 99999), ('source_data_hash', 'wrong')):
                with self.subTest(level=level, key=key):
                    changed = copy.deepcopy(docs)
                    changed[level - 1]['binding'][key] = value
                    self.assertFalse(validate_documents(changed, complete=True)['ready'])
        binding = ReferenceSyncBinding.objects.get(target_task_id=docs[1]['task_id'])
        binding.mapping.enabled = False
        binding.mapping.save(update_fields=['enabled'])
        self.assertFalse(report_for_task(self.f.task)['ready'])

    def test_cancelled_or_multiple_formal_sources_do_not_select_a_replacement(self):
        docs = collect_documents(self.f.task)
        root = Annotation.objects.get(pk=docs[0]['annotation_id'])
        root.was_cancelled = True
        root.save(update_fields=['was_cancelled'])
        self.assertFalse(report_for_task(self.f.task)['ready'])
        root.was_cancelled = False
        root.save(update_fields=['was_cancelled'])
        Annotation.objects.create(task=root.task, project=root.project, result=copy.deepcopy(root.result), completed_by=root.completed_by)
        self.assertFalse(report_for_task(self.f.task)['ready'])

    def test_bad_lineage_blocks_formal_but_keeps_draft(self):
        draft = self.f.draft()
        root_id = collect_documents(self.f.task)[0]['annotation_id']
        Annotation.objects.filter(pk=root_id).update(was_cancelled=True)
        response = self.f.client.patch(f'/api/drafts/{draft.id}/', self.f.payload(draft), format='json')
        self.assertEqual(response.status_code, 200)
        draft.refresh_from_db()
        before = copy.deepcopy(draft.result)
        response = self.f.client.post(f'/api/tasks/{self.f.task.id}/annotations/', self.f.payload(draft), format='json')
        self.assertEqual(response.status_code, 409)
        draft.refresh_from_db()
        self.assertEqual(draft.result, before)

    def test_failed_create_rolls_back_all_target_objects(self):
        binding = ReferenceSyncBinding.objects.get(target_task=self.f.source_task)
        binding.mapping.enabled = False
        binding.mapping.save(update_fields=['enabled'])
        before = (Task.objects.count(), ReferenceSyncBinding.objects.count())
        with self.assertRaisesRegex(ValueError, '来源绑定'):
            call_command('create_furniture_instance_project', source_task=self.f.source_task.id,
                         source_annotation=self.f.source.id, title='must rollback', confirm_create=True, stdout=StringIO())
        self.assertEqual(before, (Task.objects.count(), ReferenceSyncBinding.objects.count()))

    def test_configuration_preview_guards_and_idempotent_apply(self):
        docs = collect_documents(self.f.task)
        project = self.f.target_project
        import xml.etree.ElementTree as ET
        root = ET.fromstring(project.label_config)
        for parent in root.iter():
            for node in list(parent):
                if node.get('name') == 'window_vector':
                    parent.remove(node)
        project.label_config = ET.tostring(root, encoding='unicode')
        project.save(update_fields=['label_config'])
        original = project.label_config
        args = {'project_id': project.id, 'l1_task_id': docs[0]['task_id']}
        out = StringIO()
        call_command('upgrade_window_reference_controls', **args, stdout=out)
        preview = json.loads(out.getvalue())
        self.assertEqual(preview['additions'], ['window_vector'])
        project.refresh_from_db()
        self.assertEqual(project.label_config, original)
        guarded = {**args, 'apply': True, 'expected_title': project.title,
                   'expected_config_sha256': preview['original_sha256'], 'expected_source_version': preview['source_version']}
        with self.assertRaises(CommandError):
            call_command('upgrade_window_reference_controls', **{**guarded, 'expected_config_sha256': 'changed'}, stdout=StringIO())
        call_command('upgrade_window_reference_controls', **guarded, stdout=StringIO())
        project.refresh_from_db()
        self.assertIn('window_vector', project.label_config)
        out = StringIO()
        call_command('upgrade_window_reference_controls', **args, stdout=out)
        self.assertEqual(json.loads(out.getvalue())['additions'], [])

    def test_bundle_revalidates_files_and_cannot_trust_success_flags(self):
        docs = self.documents()
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / 'snapshot'
            export_bundle(docs, output)
            loaded, report = load_bundle(output / 'lineage-manifest.json')
            self.assertEqual(loaded, docs)
            self.assertTrue(report['complete'])
            path = output / 'L3.json'
            path.write_text(path.read_text().replace('inherited-window', 'forged-window'), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'SHA-256'):
                load_bundle(output / 'lineage-manifest.json')
        changed = copy.deepcopy(docs)
        changed[-1]['result'] = [r for r in changed[-1]['result'] if r.get('from_name') != 'window_vector']
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'bad'
            export_bundle(changed, path)
            (path / 'lineage-report.json').write_text('{"ready": true, "complete": true}')
            with self.assertRaisesRegex(ValueError, '完整验收'):
                load_bundle(path / 'lineage-manifest.json')

    def test_publication_matches_raw_inputs_and_window_geometry(self):
        docs = self.documents()
        base = publication_base(docs)
        annotation = {'id': docs[-1]['annotation_id'], 'result': docs[-1]['result']}
        validate_publication_sources(base, annotation, docs)
        for changed in ('identity', 'raw', 'trace', 'projection'):
            broken = copy.deepcopy(base)
            if changed == 'identity':
                broken['sources']['zone']['annotation_id'] += 1
            elif changed == 'raw':
                broken['raw_inputs']['rooms']['text'] += ' '
            elif changed == 'trace':
                broken['window_traces'][0]['path']['vertices'][0]['x'] += 1
            else:
                broken['window_projections'].append({'id': 'forged', 'target': {'level': 'L4'}})
            with self.assertRaises(ValueError):
                validate_publication_sources(broken, annotation, docs)

    def test_projection_roundoff_never_relaxes_identity_geometry_or_policy(self):
        from .lineage_bundle import projection_equivalent
        record = {'id': 'p1', 'fingerprint': 'exact', 'relation': {'overlap_length_px': 17.0, 'tolerance': 1e-6},
                  'path_intervals': [{'path_parameter_start': 0.0, 'path_parameter_end': 1.0}]}
        changed = copy.deepcopy(record)
        changed['relation']['overlap_length_px'] -= 1e-13
        self.assertTrue(projection_equivalent(record, changed))
        changed['relation']['overlap_length_px'] -= 1e-5
        self.assertFalse(projection_equivalent(record, changed))
        for key in ('id', 'fingerprint'):
            changed = {**record, key: 'wrong'}
            self.assertFalse(projection_equivalent(record, changed))
        changed = copy.deepcopy(record)
        changed['relation']['tolerance'] += 1e-13
        self.assertFalse(projection_equivalent(record, changed))

    def test_cli_writes_exact_atomic_output_with_complete_evidence(self):
        scripts = Path(__file__).resolve().parents[3] / 'scripts'
        sys.path.insert(0, str(scripts))
        from furniture_instances_to_unified import aggregate_furniture_instances, main
        docs = self.documents()
        base = publication_base(docs)
        l4 = docs[-1]
        envelope = {'id': l4['annotation_id'], 'task': l4['task_id'], 'project': l4['project_id'],
                    'updated_at': l4['updated_at'], 'result': l4['result']}
        expected = aggregate_furniture_instances(base, envelope, project_id=l4['project_id'], task_id=l4['task_id'], annotation_id=l4['annotation_id'])
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)
            export_bundle(docs, path / 'evidence')
            (path / 'base.json').write_text(json.dumps(base), encoding='utf-8')
            output = path / 'nested' / 'output.json'
            args = ['--base', str(path / 'base.json'), '--annotation', str(path / 'evidence' / 'L4.json'),
                    '--project-id', str(l4['project_id']), '--task-id', str(l4['task_id']), '--annotation-id', str(l4['annotation_id']),
                    '--lineage-manifest', str(path / 'evidence' / 'lineage-manifest.json'), '--output', str(output)]
            self.assertEqual(main(args), 0)
            self.assertEqual(json.loads(output.read_text()), expected)
