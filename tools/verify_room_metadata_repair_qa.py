import json

from rest_framework.test import APIClient

from tasks.models import Annotation, AnnotationDraft, Prediction, Task
from tasks.reference_sync.models import ReferenceSyncAudit, ReferenceSyncBinding
from tasks.reference_sync.results import digest, manual_hash, reference_hash
from tasks.reference_sync.room_metadata import geometry_digest
from tasks.reference_sync.service import process_binding, source_metadata_repair_status


def profiles(model, task_id, fingerprint):
    return {
        str(instance.id): fingerprint(instance.result or [])
        for instance in model.objects.filter(task_id=task_id).order_by("id")
    }


source_task = Task.objects.get(pk=19, project_id=9)
target_task = Task.objects.get(pk=20, project_id=10)
source = Annotation.objects.get(pk=10, task=source_task, was_cancelled=False)
binding = ReferenceSyncBinding.objects.select_related("mapping__target_project").get(
    source_task_id=source_task.id,
    mapping__sync_type="room_to_function_zone",
)
user = source.completed_by or source.updated_by or source_task.project.created_by

before = {
    "source_geometry": geometry_digest(source.result),
    "source_result_count": len(source.result),
    "source_reference": reference_hash(source.result),
    "target_annotations_manual": profiles(Annotation, target_task.id, manual_hash),
    "target_drafts_manual": profiles(AnnotationDraft, target_task.id, manual_hash),
    "target_predictions_manual": profiles(Prediction, target_task.id, manual_hash),
    "l3_annotations": profiles(Annotation, 22, digest),
    "l3_drafts": profiles(AnnotationDraft, 22, digest),
    "repair_status": source_metadata_repair_status(binding),
}

client = APIClient()
client.force_authenticate(user=user)
response = client.post(
    f"/api/tasks/{source_task.id}/reference-sync/repair-source/",
    {"expected_annotation_updated_at": source.updated_at.isoformat()},
    format="json",
)
response_payload = response.json()
if response.status_code != 200:
    raise RuntimeError(f"repair endpoint failed: {response.status_code} {response_payload}")

process_binding(binding.id)
source.refresh_from_db()
binding.refresh_from_db()
after = {
    "source_geometry": geometry_digest(source.result),
    "source_result_count": len(source.result),
    "source_reference": reference_hash(source.result),
    "target_annotations_manual": profiles(Annotation, target_task.id, manual_hash),
    "target_drafts_manual": profiles(AnnotationDraft, target_task.id, manual_hash),
    "target_predictions_manual": profiles(Prediction, target_task.id, manual_hash),
    "l3_annotations": profiles(Annotation, 22, digest),
    "l3_drafts": profiles(AnnotationDraft, 22, digest),
    "repair_status": source_metadata_repair_status(binding),
    "binding_status": binding.status,
    "binding_error": binding.error,
    "audit_count": ReferenceSyncAudit.objects.filter(
        binding=binding,
        operation="repair_source_metadata",
    ).count(),
}

checks = {
    "endpoint_ok": response.status_code == 200,
    "repaired_expected_portals": set(response_payload["repaired_portal_ids"])
    == {"269EeJqBTa", "4VZMWehtcj", "mPiLH58utu"},
    "source_geometry_unchanged": before["source_geometry"] == after["source_geometry"],
    "source_result_count_unchanged": before["source_result_count"] == after["source_result_count"],
    "target_annotation_manual_unchanged": before["target_annotations_manual"]
    == after["target_annotations_manual"],
    "target_draft_manual_unchanged": before["target_drafts_manual"] == after["target_drafts_manual"],
    "target_prediction_manual_unchanged": before["target_predictions_manual"]
    == after["target_predictions_manual"],
    "l3_annotations_unchanged": before["l3_annotations"] == after["l3_annotations"],
    "l3_drafts_unchanged": before["l3_drafts"] == after["l3_drafts"],
    "repair_no_longer_needed": not after["repair_status"]["source_metadata_repair_available"],
    "sync_succeeded": after["binding_status"] == "synced" and not after["binding_error"],
    "audit_written": after["audit_count"] >= 1,
}

print(
    json.dumps(
        {
            "response": response_payload,
            "before": before,
            "after": after,
            "checks": checks,
            "all_checks_passed": all(checks.values()),
        },
        ensure_ascii=False,
        indent=2,
        default=str,
    )
)

if not all(checks.values()):
    raise SystemExit(1)
