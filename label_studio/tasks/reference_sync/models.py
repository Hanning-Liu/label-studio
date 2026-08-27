from django.db import models


class ReferenceSyncMapping(models.Model):
    source_project = models.ForeignKey('projects.Project', on_delete=models.PROTECT, related_name='+')
    target_project = models.ForeignKey('projects.Project', on_delete=models.PROTECT, related_name='+')
    enabled = models.BooleanField(default=False)
    auto_create = models.BooleanField(default=True)
    sync_type = models.CharField(max_length=48, default='room_to_function_zone')
    apply_policy = models.CharField(max_length=16, default='automatic')
    worker_heartbeat = models.DateTimeField(null=True)

    class Meta:
        app_label = 'tasks'
        constraints = [models.UniqueConstraint(fields=['source_project', 'target_project'], name='reference_sync_project_pair')]


class ReferenceSyncBinding(models.Model):
    mapping = models.ForeignKey(ReferenceSyncMapping, on_delete=models.CASCADE, related_name='bindings')
    # Keep source identifiers after deletion so a missing source never silently
    # switches annotation or removes a user's downstream work.
    source_task_id = models.BigIntegerField()
    source_annotation_id = models.BigIntegerField(null=True)
    target_task = models.OneToOneField('tasks.Task', null=True, on_delete=models.SET_NULL, related_name='reference_sync')
    prediction_id = models.BigIntegerField(null=True)
    source_data_hash = models.CharField(max_length=64, default='')
    desired_hash = models.CharField(max_length=64, default='')
    applied_hash = models.CharField(max_length=64, default='')
    generation = models.PositiveIntegerField(default=0)
    status = models.CharField(max_length=24, default='pending')
    error = models.TextField(default='')
    attempts = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True)
    last_synced_at = models.DateTimeField(null=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        app_label = 'tasks'
        constraints = [models.UniqueConstraint(fields=['mapping', 'source_task_id'], name='reference_sync_source_target')]


class ReferenceSyncAudit(models.Model):
    binding = models.ForeignKey(ReferenceSyncBinding, on_delete=models.CASCADE, related_name='audits')
    created_at = models.DateTimeField(auto_now_add=True)
    source_hash = models.CharField(max_length=64)
    operation = models.CharField(max_length=24, default='sync')
    summary = models.JSONField(default=dict)
    before = models.JSONField(default=dict)
    after = models.JSONField(default=dict)

    class Meta:
        app_label = 'tasks'
