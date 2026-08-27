import copy
from core.permissions import ViewClassPermission, all_permissions
from django.shortcuts import get_object_or_404
from rest_framework import generics
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from tasks.models import Task, AnnotationDraft
from tasks.serializers import AnnotationDraftSerializer
from .models import ReferenceSyncAudit, ReferenceSyncBinding
from .results import ROOMS, ZONES, inside, pending_reviews, region_hash, result_polygon, reference_results, manual_hash, reference_hash
from .service import (SyncConflict,binding_status,current_reference,enqueue_source,lock_target,
                      prepare_write,snapshot,sync_atomic,target_binding)


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
        draft=get_object_or_404(AnnotationDraft,pk=request.data.get('draft_id'),task=task,user=request.user)
        refs=current_reference(binding)
        if request.data.get('reference_version')!=binding.applied_hash or request.data.get('expected_updated_at')!=draft.updated_at.isoformat().replace('+00:00','Z'):
            raise SyncConflict('复核期间参考或草稿已变化，请重新加载','draft_version_conflict')
        ids=request.data.get('region_ids')
        if not isinstance(ids,list) or not ids or not all(isinstance(i,str) for i in ids):
            raise SyncConflict('请选择需要复核的区域','invalid_review',400)
        lock_target(task)
        before=snapshot(task)
        rooms={r['id']:result_polygon(r) for r in refs if r['from_name'] in ROOMS}
        found=set()
        result=copy.deepcopy(draft.result)
        for r in result:
            if r.get('id') not in ids or 'reference_review' not in r.get('meta',{}):
                continue
            if r.get('from_name') in ZONES:
                parent=r['meta'].get('partition_context',{}).get('parent_room_id')
                if parent not in rooms or not inside(result_polygon(r),rooms[parent]):
                    raise SyncConflict('请先修正来源房间缺失或超出房间的区域','invalid_geometry',400)
            r['meta']['reference_review'].update(status='reviewed',revision=binding.applied_hash,
                content_hash=region_hash(result,r['id']))
            found.add(r['id'])
        if found!=set(ids):
            raise SyncConflict('部分待复核区域已不存在，请重新加载','review_changed')
        draft.result=result
        draft.save(update_fields=['result','updated_at'])
        ReferenceSyncAudit.objects.create(binding=binding,source_hash=binding.applied_hash,operation='user_review',
            before=before,after=snapshot(task),summary={'region_ids':sorted(found),'user_id':request.user.id})
        return Response(AnnotationDraftSerializer(draft,context={'request':request}).data)


class OccupancyReferenceApplyAPI(ReferenceSyncStatusAPI):
    http_method_names = ['post', 'options']

    @sync_atomic
    def post(self, request, *args, **kwargs):
        from tasks.occupancy.reference import apply_reference
        task = self.task()
        binding = ReferenceSyncBinding.objects.select_for_update().select_related('mapping__target_project').filter(target_task=task, mapping__enabled=True, mapping__sync_type='function_zone_to_occupancy', mapping__apply_policy='manual').first()
        if not binding:
            raise SyncConflict('未启用 L2 到 L3 手动参考更新', 'binding_missing', 400)
        draft = get_object_or_404(AnnotationDraft.objects.select_for_update(), pk=request.data.get('draft_id'), task=task, user=request.user)
        try:
            draft = apply_reference(binding, draft, request.data, request.user)
        except ValueError as exc:
            raise SyncConflict(str(exc), 'invalid_source', 400) from exc
        return Response(AnnotationDraftSerializer(draft, context={'request': request}).data)
