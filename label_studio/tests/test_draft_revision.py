"""Optional optimistic locking stays compatible with legacy draft clients."""
import pytest
from projects.models import Project
from tasks.models import AnnotationDraft

from .utils import make_task, project_id  # noqa: F401


@pytest.mark.django_db
def test_draft_expected_updated_at(business_client, project_id):
    task = make_task({'data': {'text': 'Draft revision test'}}, Project.objects.get(pk=project_id))
    created = business_client.post(f'/api/tasks/{task.id}/drafts', {'result': []}, content_type='application/json')
    assert created.status_code == 201
    first = created.json()
    url = f'/api/drafts/{first["id"]}/'
    assert 'expected_updated_at' not in first
    result = [{'id': 'semantic-zone', 'from_name': 'test_batch_predictions', 'to_name': 'text',
               'type': 'choices', 'value': {'choices': ['class_A']},
               'meta': {'zone_inheritance': {'review_status': 'pending'}}}]
    updated = business_client.patch(url, {'result': result, 'expected_updated_at': first['updated_at']}, content_type='application/json')
    assert updated.status_code == 200
    latest = updated.json()
    assert latest['updated_at'] != first['updated_at']
    conflict = business_client.patch(url, {'result': [], 'expected_updated_at': first['updated_at']}, content_type='application/json')
    assert conflict.status_code == 409
    assert conflict.json()['code'] == 'draft_version_conflict'
    assert AnnotationDraft.objects.get(pk=first['id']).result == result
    assert business_client.get(url).json()['updated_at'] == latest['updated_at']
    assert business_client.patch(url, {'result': [], 'expected_updated_at': 'invalid'}, content_type='application/json').status_code == 400
    assert business_client.patch(url, {'result': []}, content_type='application/json').status_code == 200
