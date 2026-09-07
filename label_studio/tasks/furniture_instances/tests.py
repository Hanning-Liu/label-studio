import copy
import json
from io import StringIO

from django.core.management import call_command
from django.core.management.base import CommandError
from django.db.models.signals import post_save
from django.test import TransactionTestCase
from organizations.models import Organization
from projects.models import Project
from rest_framework.test import APIClient
from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from tasks.occupancy.validation import content_fingerprint
from tasks.reference_sync.models import ReferenceSyncBinding, ReferenceSyncMapping
from tasks.reference_sync.service import process_binding, process_pending, response_tokens, sync_atomic
from users.models import User

from .reference import (
    SYNC_TYPE,
    initialize_binding,
    manual_hash,
    pending_reviews,
    reference_hash,
    validate_provenance,
)
from .template import build_template
from .test_template import SOURCE_CONFIG
from .test_validation import instance_results, mark_reviewed, reference_results
from .validation import validate


class FurnitureInstanceSyncTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(email='furniture-l4-qa@example.invalid')
        self.org = Organization.create_organization(created_by=self.user, title='L4 isolated tests')
        self.user.active_organization = self.org
        self.user.save()
        self.source_project = Project.objects.create(
            title='source L3',
            label_config=SOURCE_CONFIG,
            organization=self.org,
            created_by=self.user,
        )
        self.target_project = Project.objects.create(
            title='target L4',
            label_config=build_template(SOURCE_CONFIG),
            organization=self.org,
            created_by=self.user,
            maximum_annotations=1,
        )
        self.source_task = Task.objects.create(
            project=self.source_project,
            data={'image': '/data/local-files/?d=qa/floorplan.png'},
            overlap=1,
        )
        self.source = Annotation.objects.create(
            task=self.source_task,
            project=self.source_project,
            completed_by=self.user,
            result=reference_results(),
        )
        self.mapping = ReferenceSyncMapping.objects.create(
            source_project=self.source_project,
            target_project=self.target_project,
            sync_type=SYNC_TYPE,
            apply_policy='manual',
            auto_create=False,
            enabled=True,
        )
        self.binding = ReferenceSyncBinding.objects.create(
            mapping=self.mapping,
            source_task_id=self.source_task.id,
            source_annotation_id=self.source.id,
        )
        self.task = sync_atomic(initialize_binding)(self.binding)
        self.client = APIClient()
        self.client.force_authenticate(self.user)

    def complete_result(self):
        refs = copy.deepcopy(Prediction.objects.get(pk=self.binding.prediction_id).result)
        manual = instance_results(refs)
        for result in manual:
            result['meta']['furniture_instance_context']['source_version'] = self.binding.applied_hash
        mark_reviewed(manual)
        return refs + manual

    def draft(self, *, result=None, annotation=None):
        return AnnotationDraft.objects.create(
            task=self.task,
            user=self.user,
            annotation=annotation,
            result=result or self.complete_result(),
        )

    def payload(self, draft):
        return {
            **response_tokens(draft),
            'draft_id': draft.id,
            'expected_updated_at': draft.updated_at.isoformat(),
            'result': copy.deepcopy(draft.result),
        }

    def change_source_group(self):
        source = copy.deepcopy(self.source.result)
        group = next(
            result
            for result in source
            if result.get('meta', {}).get('occupancy_context', {}).get('group_id') == 'group-a'
        )
        group['meta']['occupancy_context']['group_note'] = 'changed upstream'
        review = content_fingerprint(source, 'zone-z')
        for result in source:
            group_context = result.get('meta', {}).get('occupancy_context')
            if group_context:
                group_context['review_fingerprint'] = review
        self.source.result = source
        self.source.save(update_fields=['result', 'updated_at'])
        self.binding.refresh_from_db()

    def test_initialize_is_reference_only_and_creates_no_user_work(self):
        prediction = Prediction.objects.get(pk=self.binding.prediction_id)
        self.assertTrue(prediction.result)
        self.assertTrue(all(result.get('readonly') is True for result in prediction.result))
        self.assertFalse(self.task.annotations.exists())
        self.assertFalse(self.task.drafts.exists())
        self.assertEqual(self.task.meta['furniture_instances_reference']['source_annotation_id'], self.source.id)
        self.assertEqual(self.task.data, self.source_task.data)

    def test_worker_never_applies_l4_even_if_policy_is_misconfigured(self):
        self.mapping.apply_policy = 'automatic'
        self.mapping.save(update_fields=['apply_policy'])
        self.change_source_group()
        old_applied = self.binding.applied_hash
        self.assertFalse(process_binding(self.binding.id))
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.applied_hash, old_applied)

    def test_management_command_requires_confirmation_and_creates_isolated_target(self):
        options = {
            'source_task': self.source_task.id,
            'source_annotation': self.source.id,
            'title': 'command-created L4',
        }
        with self.assertRaises(CommandError):
            call_command('create_furniture_instance_project', **options)
        output = StringIO()
        call_command('create_furniture_instance_project', confirm_create=True, stdout=output, **options)
        project = Project.objects.get(title=options['title'], organization=self.org)
        target = Task.objects.get(project=project)
        self.assertFalse(target.annotations.exists())
        self.assertFalse(target.drafts.exists())
        self.assertIn('no L4 annotations or drafts created', output.getvalue())

    def test_save_refresh_submit_and_json_roundtrip_stamp_real_provenance(self):
        draft = self.draft()
        response = self.client.patch(f'/api/drafts/{draft.id}/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        post_save_calls = []

        def observe_save(sender, instance, **kwargs):
            post_save_calls.append(instance.pk)

        dispatch_uid = f'l4-provenance-single-save-{id(self)}'
        post_save.connect(observe_save, sender=Annotation, weak=False, dispatch_uid=dispatch_uid)
        try:
            response = self.client.post(
                f'/api/tasks/{self.task.id}/annotations/',
                self.payload(draft),
                format='json',
            )
        finally:
            post_save.disconnect(sender=Annotation, dispatch_uid=dispatch_uid)
        self.assertEqual(response.status_code, 201, response.data)
        saved = self.task.annotations.get()
        self.assertEqual(post_save_calls.count(saved.id), 1)
        self.assertTrue(validate_provenance(saved.result, self.target_project.id, self.task.id, saved.id))
        self.assertEqual(validate(saved.result, self.binding.applied_hash), [])
        exported = json.loads(json.dumps(saved.result, ensure_ascii=False))
        self.assertEqual(validate(exported, self.binding.applied_hash), [])
        self.assertFalse(AnnotationDraft.objects.filter(pk=draft.id).exists())

    def test_incomplete_instance_is_saved_as_draft_but_formal_submit_is_blocked(self):
        draft = self.draft()
        payload = self.payload(draft)
        payload['result'] = [
            result for result in payload['result'] if result.get('from_name') != 'furniture_instance_type'
        ]
        response = self.client.patch(f'/api/drafts/{draft.id}/', payload, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        response = self.client.post(
            f'/api/tasks/{self.task.id}/annotations/',
            self.payload(draft),
            format='json',
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertEqual(
            response.data.get('display_context', {}).get('reason'),
            'FURNITURE_INSTANCE_VALIDATION',
        )
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())

    def test_l4_config_without_enabled_binding_saves_draft_but_blocks_formal_submit(self):
        draft = self.draft()
        self.mapping.enabled = False
        self.mapping.save(update_fields=['enabled'])

        response = self.client.patch(f'/api/drafts/{draft.id}/', self.payload(draft), format='json')
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        response = self.client.post(
            f'/api/tasks/{self.task.id}/annotations/',
            self.payload(draft),
            format='json',
        )
        self.assertEqual(response.status_code, 409, response.data)
        self.assertIn('缺少已启用的权威 L3 参考绑定', str(response.data.get('detail')))
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())
        self.assertFalse(self.task.annotations.exists())

        copied_project = Project.objects.create(
            title='copied L4 config without binding',
            label_config=self.target_project.label_config,
            organization=self.org,
            created_by=self.user,
        )
        copied_task = Task.objects.create(project=copied_project, data=copy.deepcopy(self.task.data), overlap=1)
        response = self.client.post(
            f'/api/tasks/{copied_task.id}/annotations/',
            {'result': self.complete_result()},
            format='json',
        )
        self.assertEqual(response.status_code, 409, response.data)
        self.assertIn('缺少已启用的权威 L3 参考绑定', str(response.data.get('detail')))
        self.assertFalse(copied_task.annotations.exists())

        self.mapping.enabled = True
        self.mapping.sync_type = 'room_to_function_zone'
        self.mapping.save(update_fields=['enabled', 'sync_type'])
        response = self.client.post(
            f'/api/tasks/{self.task.id}/annotations/',
            {
                'draft_id': draft.id,
                'expected_updated_at': draft.updated_at.isoformat(),
                'result': copy.deepcopy(draft.result),
            },
            format='json',
        )
        self.assertEqual(response.status_code, 409, response.data)
        self.assertIn('绑定了错误的参考同步类型', str(response.data.get('detail')))
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())
        self.assertFalse(self.task.annotations.exists())

    def test_l4_binding_without_explicit_config_marker_blocks_formal_submit(self):
        draft = self.draft()
        self.target_project.label_config = SOURCE_CONFIG
        self.target_project.save(update_fields=['label_config'])
        response = self.client.post(
            f'/api/tasks/{self.task.id}/annotations/',
            self.payload(draft),
            format='json',
        )
        self.assertEqual(response.status_code, 409, response.data)
        self.assertIn('未启用 furnitureInstancesV1', str(response.data.get('detail')))
        self.assertTrue(AnnotationDraft.objects.filter(pk=draft.id).exists())
        self.assertFalse(self.task.annotations.exists())

    def test_manual_source_apply_preserves_formal_and_marks_draft_stale(self):
        original_result = self.complete_result()
        submitted = Annotation.objects.create(
            task=self.task,
            project=self.target_project,
            completed_by=self.user,
            result=copy.deepcopy(original_result),
        )
        draft = self.draft(result=copy.deepcopy(original_result), annotation=submitted)
        protected = manual_hash(draft.result)
        original_formal = copy.deepcopy(submitted.result)
        old_applied = self.binding.applied_hash
        self.change_source_group()
        self.assertEqual(process_pending(), 0)
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.applied_hash, old_applied)
        payload = {
            **self.payload(draft),
            'source_version': reference_hash(self.source.result),
        }
        response = self.client.post(
            f'/api/tasks/{self.task.id}/reference-sync/apply/',
            payload,
            format='json',
        )
        self.assertEqual(response.status_code, 200, response.data)
        draft.refresh_from_db()
        submitted.refresh_from_db()
        self.binding.refresh_from_db()
        self.assertEqual(manual_hash(draft.result), protected)
        self.assertEqual(submitted.result, original_formal)
        self.assertEqual(pending_reviews(draft.result)[0]['review_status'], 'stale')
        response = self.client.patch(
            f'/api/annotations/{submitted.id}/',
            self.payload(draft),
            format='json',
        )
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn(
            'parent_stale',
            {
                issue['code']
                for issue in response.data.get('display_context', {}).get('issues', [])
            },
        )
        submitted.refresh_from_db()
        self.assertEqual(submitted.result, original_formal)


__all__ = ['FurnitureInstanceSyncTests']
