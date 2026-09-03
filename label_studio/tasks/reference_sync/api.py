import copy
from core.permissions import ViewClassPermission, all_permissions
from django.shortcuts import get_object_or_404
from django.utils.dateparse import parse_datetime
from rest_framework import generics
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from tasks.models import Annotation, Task, AnnotationDraft
from tasks.serializers import AnnotationDraftSerializer
from .models import ReferenceSyncAudit, ReferenceSyncBinding
from .results import ROOMS, ZONES, inside, pending_reviews, region_hash, result_polygon, reference_results, manual_hash, reference_hash
from .service import (SyncConflict,binding_status,current_reference,enqueue_source,lock_target,
                      prepare_source_annotation_result,prepare_write,snapshot,sync_atomic,target_binding)
from .room_metadata import geometry_digest


class ReferenceSyncStatusAPI(generics.GenericAPIView):
    permission_required=ViewClassPermission(GET=all_permissions.annotations_view,POST=all_permissions.annotations_change)
    queryset=Task.objects.all()

    def task(self):
        return get_object_or_404(Task.objects.for_user(self.request.user),pk=self.kwargs['pk'])

    def get(self,request,*args,**kwargs):
        task=self.task()
        binding=ReferenceSyncBinding.objects.filter(target_task=task).select_related('mapping').first()
        if binding:
            data=binding_status(binding,request.user)
            data['mode']='target'
            return Response(data)
        outgoing=list(ReferenceSyncBinding.objects.filter(source_task_id=task.id,mapping__source_project_id=task.project_id).select_related('mapping'))
        return Response({'enabled':any(b.mapping.enabled for b in outgoing),'mode':'source',
                         'bindings':[binding_status(b,request.user) for b in outgoing]})

    @sync_atomic
    def post(self,request,*args,**kwargs):
        task=self.task()
        binding=target_binding(task)
        if not binding:
            # Source-side retry is useful when first-time task creation failed.
            candidates=list(ReferenceSyncBinding.objects.filter(source_task_id=task.id,mapping__source_project_id=task.project_id,mapping__enabled=True))
            if len(candidates)!=1:
                raise SyncConflict('没有唯一的已启用同步绑定','binding_missing',400)
            binding=candidates[0]
        if request.data:
            raise SyncConflict('重试接口不接受来源或目标参数','invalid_retry',400)
        enqueue_source(binding.source_task_id,binding.mapping.source_project_id)
        binding.refresh_from_db()
        if binding.status=='blocked':
            # Worker revalidates; it cannot bypass an invalid/deleted source.
            binding.status='pending'
            binding.next_attempt_at=None
            binding.save(update_fields=['status','next_attempt_at'])
        elif binding.status=='retry':
            binding.next_attempt_at=None
            binding.save(update_fields=['next_attempt_at'])
        return Response(binding_status(binding,request.user),status=202)


class ReferenceSyncReviewAPI(ReferenceSyncStatusAPI):
    http_method_names=['post','options']

    @sync_atomic
    def post(self,request,*args,**kwargs):
        task=self.task()
        binding=target_binding(task)
        if not binding:
            raise SyncConflict('此任务未启用同步','binding_missing',400)
        if binding.mapping.sync_type == 'function_zone_to_occupancy':
            raise SyncConflict('L3 请使用父分区复核，不能调用 Room 复核接口', 'wrong_sync_profile', 400)
        if binding.mapping.sync_type == 'occupancy_to_furniture_instances':
            raise SyncConflict('L4 请使用家具实例复核，不能调用 Room 复核接口', 'wrong_sync_profile', 400)
        draft=get_object_or_404(AnnotationDraft,pk=request.data.get('draft_id'),task=task,user=request.user)
        refs=current_reference(binding)
        if request.data.get('reference_version')!=binding.applied_hash or request.data.get('expected_updated_at')!=draft.updated_at.isoformat().replace('+00:00','Z'):
            raise SyncConflict('复核期间参考或草稿已变化，请重新加载','draft_version_conflict')
        ids=request.data.get('region_ids')
        if not isinstance(ids,list) or not ids or not all(isinstance(i,str) for i in ids):
            raise SyncConflict('请选择需要复核的区域','invalid_review',400)
        requested=set(ids)
        if len(requested)!=len(ids):
            raise SyncConflict('待复核区域列表包含重复项，请重新加载','review_changed')
        lock_target(task)
        before=snapshot(task)
        rooms={r['id']:result_polygon(r) for r in refs if r['from_name'] in ROOMS}
        found=set()
        result=copy.deepcopy(draft.result)
        for r in result:
            review=r.get('meta',{}).get('reference_review',{})
            if r.get('id') not in requested or review.get('status')!='pending':
                continue
            if r.get('from_name') in ZONES:
                parent=r['meta'].get('partition_context',{}).get('parent_room_id')
                if parent not in rooms or not inside(result_polygon(r),rooms[parent]):
                    raise SyncConflict('请先修正来源房间缺失或超出房间的区域','invalid_geometry',400)
            r['meta']['reference_review'].update(status='reviewed',revision=binding.applied_hash,
                content_hash=region_hash(result,r['id']))
            found.add(r['id'])
        if found!=requested:
            raise SyncConflict('部分待复核区域已不存在，请重新加载','review_changed')
        draft.result=result
        draft.save(update_fields=['result','updated_at'])
        ReferenceSyncAudit.objects.create(binding=binding,source_hash=binding.applied_hash,operation='user_review',
            before=before,after=snapshot(task),summary={'region_ids':sorted(found),'user_id':request.user.id})
        return Response(AnnotationDraftSerializer(draft,context={'request':request}).data)


class ReferenceSyncRepairSourceAPI(ReferenceSyncStatusAPI):
    """Repair stale Room v3 derived metadata without changing user geometry."""

    http_method_names = ['post', 'options']

    @sync_atomic
    def post(self, request, *args, **kwargs):
        task = self.task()
        bindings = list(ReferenceSyncBinding.objects.select_for_update().select_related('mapping__target_project').filter(
            source_task_id=task.id,
            mapping__source_project_id=task.project_id,
            mapping__enabled=True,
            mapping__sync_type='room_to_function_zone',
        ))
        if not bindings:
            raise SyncConflict('此 Room 任务没有已启用的下游同步', 'binding_missing', 400)
        candidates = list(Annotation.objects.select_for_update().filter(task=task, was_cancelled=False))
        if len(candidates) != 1:
            raise SyncConflict('来源正式标注缺失、已取消或存在多个候选；需要人工处理', 'source_ambiguous', 400)
        annotation = candidates[0]
        if any(binding.source_annotation_id not in (None, annotation.id) for binding in bindings):
            raise SyncConflict('绑定的来源标注已删除或替换，不自动切换来源', 'source_replaced', 409)
        expected = parse_datetime(str(request.data.get('expected_annotation_updated_at') or ''))
        if expected is None:
            raise SyncConflict('缺少来源标注版本，请重新加载同步状态', 'source_version_required', 428)
        if expected != annotation.updated_at:
            raise SyncConflict('来源标注已被其他窗口更新；请重新加载后再修复', 'source_version_conflict', 409)

        before = snapshot(task)
        original_geometry = geometry_digest(annotation.result)
        refreshed, changes = prepare_source_annotation_result(task, annotation.result)
        if geometry_digest(refreshed) != original_geometry:
            raise RuntimeError('元数据修复不得修改房间或 Portal 几何')
        annotation.result = refreshed
        annotation.updated_by = request.user
        annotation.save(update_fields=['result', 'updated_by', 'updated_at'])
        enqueue_source(task.id, task.project_id)
        after = snapshot(task)
        summary = {
            'room_ids': changes['room_ids'],
            'portal_ids': changes['portal_ids'],
            'user_id': request.user.id,
            'annotation_id': annotation.id,
            'geometry_unchanged': True,
        }
        for binding in bindings:
            binding.refresh_from_db()
            ReferenceSyncAudit.objects.create(
                binding=binding,
                source_hash=reference_hash(refreshed),
                operation='repair_source_metadata',
                before=before,
                after=after,
                summary=summary,
            )
        return Response({
            'repaired': bool(changes['room_ids'] or changes['portal_ids']),
            'repaired_room_ids': changes['room_ids'],
            'repaired_portal_ids': changes['portal_ids'],
            'source_annotation_id': annotation.id,
            'source_annotation_updated_at': annotation.updated_at,
            'mode': 'source',
            'bindings': [binding_status(binding, request.user) for binding in bindings],
        })


class OccupancyReferenceApplyAPI(ReferenceSyncStatusAPI):
    http_method_names = ['post', 'options']

    @sync_atomic
    def post(self, request, *args, **kwargs):
        task = self.task()
        binding = ReferenceSyncBinding.objects.select_for_update().select_related('mapping__target_project').filter(
            target_task=task,
            mapping__enabled=True,
            mapping__sync_type__in=('function_zone_to_occupancy', 'occupancy_to_furniture_instances'),
            mapping__apply_policy='manual',
        ).first()
        if not binding:
            raise SyncConflict('未启用支持的手动参考更新', 'binding_missing', 400)
        if binding.mapping.sync_type == 'function_zone_to_occupancy':
            from tasks.occupancy.reference import apply_reference
        else:
            from tasks.furniture_instances.reference import apply_reference
        draft = get_object_or_404(AnnotationDraft.objects.select_for_update(), pk=request.data.get('draft_id'), task=task, user=request.user)
        try:
            draft = apply_reference(binding, draft, request.data, request.user)
        except ValueError as exc:
            raise SyncConflict(str(exc), 'invalid_source', 400) from exc
        return Response(AnnotationDraftSerializer(draft, context={'request': request}).data)
