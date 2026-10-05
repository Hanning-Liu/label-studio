import copy
from pathlib import Path
from unittest.mock import patch

from django.test import TransactionTestCase
from rest_framework.test import APIClient
from projects.models import Project
from tasks.furniture_instances.tests import FurnitureInstanceWindowSyncTests
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from tasks.reference_sync.models import ReferenceSyncBinding, ReferenceSyncMapping
from hanning.backend.project_creation.service import source_choice, template
from hanning.backend.reference_sync.lineage import collect_documents

URL = '/api/projects/hierarchy/'


class HierarchyCreationTests(TransactionTestCase):
    def setUp(self):
        fixture = FurnitureInstanceWindowSyncTests()
        fixture.setUp()
        self.user = fixture.user
        self.client = fixture.client
        self.sources = {doc['level']: Task.objects.get(pk=doc['task_id'])
                        for doc in collect_documents(fixture.source_task, formal=True)}

    def payload(self, level=2, title='new downstream'):
        choice = source_choice(self.sources[level - 1])
        self.assertTrue(choice['ready'], choice)
        return {'level': level, 'title': title, 'source_task': choice['id'],
                'source_annotation': choice['annotation_id'], 'source_version': choice['version']}

    def counts(self):
        return [model.objects.count() for model in (Project, Task, Annotation, Prediction, ReferenceSyncMapping, ReferenceSyncBinding)]

    def test_create_each_level_preserves_image_source_and_ids(self):
        for level in (2, 3, 4):
            with self.subTest(level=level):
                source = self.sources[level - 1]
                before = copy.deepcopy(list(source.annotations.values('id', 'result', 'updated_at')))
                response = self.client.post(URL, self.payload(level, f'New L{level}'), format='json')
                self.assertEqual(response.status_code, 201, response.data)
                task = Task.objects.get(pk=response.data['task_id'])
                self.assertEqual(task.data, source.data)
                self.assertEqual(task.annotations.count(), 0)
                self.assertEqual(task.drafts.count(), 0)
                self.assertEqual(before, list(source.annotations.values('id', 'result', 'updated_at')))
                binding = ReferenceSyncBinding.objects.get(target_task=task)
                self.assertFalse(binding.mapping.auto_create)
                self.assertEqual(binding.status, 'synced')
                prediction = Prediction.objects.get(pk=binding.prediction_id)
                source_ids = {row.get('id') for row in before[0]['result']}
                self.assertTrue({row.get('id') for row in prediction.result} <= source_ids)
                self.assertTrue(prediction.result)

    def test_l1_has_ready_template_no_placeholder_task(self):
        response = self.client.post(URL, {'level': 1, 'title': 'fresh L1'}, format='json')
        self.assertEqual(response.status_code, 201, response.data)
        project = Project.objects.get(pk=response.data['id'])
        self.assertIn('roomWindowV1="true"', project.label_config)
        self.assertIn('roomV3Validate="true"', project.label_config)
        self.assertFalse(project.is_draft)
        self.assertEqual(project.tasks.count(), 0)

    def test_duplicate_post_is_rejected_without_extra_rows(self):
        payload = self.payload()
        self.assertEqual(self.client.post(URL, payload, format='json').status_code, 201)
        before = self.counts()
        self.assertEqual(self.client.post(URL, payload, format='json').status_code, 409)
        self.assertEqual(before, self.counts())

    def test_changed_upstream_rejected_without_partial_project(self):
        payload = self.payload()
        annotation = Annotation.objects.get(pk=payload['source_annotation'])
        annotation.save()
        before = self.counts()
        response = self.client.post(URL, payload, format='json')
        self.assertEqual(response.status_code, 409, response.data)
        self.assertEqual(before, self.counts())

    def test_failure_after_project_creation_rolls_back_everything(self):
        payload = self.payload()
        before = self.counts()
        with patch('hanning.backend.project_creation.service.process_binding', side_effect=ValueError('invalid geometry')):
            response = self.client.post(URL, payload, format='json')
        self.assertEqual(response.status_code, 400)
        self.assertEqual(before, self.counts())

    def test_wrong_level_and_mismatched_annotation_are_rejected(self):
        payload = self.payload()
        before = self.counts()
        self.assertEqual(self.client.post(URL, {**payload, 'level': 3}, format='json').status_code, 400)
        self.assertEqual(self.client.post(URL, {**payload, 'source_annotation': 987654}, format='json').status_code, 409)
        self.assertEqual(before, self.counts())

    def test_draft_only_and_multiple_formal_sources_explain_blocker(self):
        source = self.sources[1]
        empty = Task.objects.create(project=source.project, data=source.data)
        AnnotationDraft.objects.create(task=empty, user=self.user, result=[])
        choice = source_choice(empty)
        self.assertFalse(choice['ready'])
        self.assertIn('正式标注', choice['reason'])
        Annotation.objects.create(task=source, project=source.project, result=[])
        self.assertFalse(source_choice(source)['ready'])

    def test_choices_are_read_only_paginated_and_level_filtered(self):
        project = self.sources[1].project
        for _ in range(21):
            Task.objects.create(project=project, data={'image': 'extra.png'})
        before = self.counts()
        first = self.client.get(URL, {'level': 2, 'project_id': project.id}).data
        second = self.client.get(URL, {'level': 2, 'project_id': project.id, 'page': 2}).data
        self.assertEqual((first['count'], len(first['tasks']), len(second['tasks'])), (22, 20, 2))
        self.assertEqual([project.id], [item['id'] for item in first['projects']])
        self.assertTrue(first['tasks'][0]['ready'])
        self.assertFalse(first['tasks'][1]['ready'])
        self.assertEqual(before, self.counts())

    def test_other_organization_cannot_read_or_create_from_source(self):
        from organizations.models import Organization
        from users.models import User
        payload = self.payload()
        other = User.objects.create(email='other-hierarchy@example.invalid')
        org = Organization.create_organization(created_by=other, title='Other')
        other.active_organization = org
        other.save()
        self.client.force_authenticate(other)
        self.assertEqual(self.client.get(URL, {'level': 2}).data['projects'], [])
        before = self.counts()
        self.assertEqual(self.client.post(URL, payload, format='json').status_code, 404)
        self.assertEqual(before, self.counts())

    def test_anonymous_rejected_and_missing_source_validation(self):
        self.assertIn(APIClient().get(URL, {'level': 2}).status_code, (401, 403))
        self.assertEqual(self.client.post(URL, {'level': 2, 'title': 'bad'}, format='json').status_code, 400)
        self.assertEqual(self.client.post(URL, {'level': 5, 'title': 'bad'}, format='json').status_code, 400)

    def test_l2_template_preserves_custom_image_and_labels(self):
        source = template(1).replace('name="image"', 'name="plan"').replace('toName="image"', 'toName="plan"')
        source = source.replace('$image', '$plan').replace('Bedroom', 'Custom bedroom')
        target = template(2, source)
        self.assertIn('Custom bedroom', target)
        self.assertIn('name="plan"', target)
        self.assertIn('value="$plan"', target)
        self.assertNotIn('toName="image"', target)

    def test_packaged_templates_match_documented_examples(self):
        root = Path(__file__).resolve().parents[2]
        for level, path in ((1, 'room-window-annotation/room-window-v1.xml'), (2, 'room-v3/function-zone-v3.xml')):
            example = root / 'examples' / path
            if not example.exists():
                self.skipTest('Examples are not shipped in the runtime image')
            resource = root / 'hanning/backend/project_creation/templates' / f'l{level}.xml'
            self.assertEqual(example.read_text(), resource.read_text())
