from django.db.models.signals import post_save, post_delete
from django.dispatch import receiver
from tasks.models import Annotation, Task
from .models import ReferenceSyncBinding
from .service import enqueue_source


@receiver(post_save,sender=Annotation,dispatch_uid='reference_sync_annotation_saved')
@receiver(post_delete,sender=Annotation,dispatch_uid='reference_sync_annotation_deleted')
def annotation_changed(sender,instance,**kwargs):
    enqueue_source(instance.task_id,instance.project_id)


@receiver(post_delete,sender=Task,dispatch_uid='reference_sync_task_deleted')
def source_deleted(sender,instance,**kwargs):
    ReferenceSyncBinding.objects.filter(source_task_id=instance.id).update(status='blocked',error='来源任务已删除，保留现有 L2')
