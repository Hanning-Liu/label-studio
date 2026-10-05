import xml.etree.ElementTree as ET

from core.permissions import ViewClassPermission, all_permissions
from django.conf import settings
from django.core.paginator import Paginator
from django.shortcuts import get_object_or_404
from projects.models import Project
from rest_framework import generics, serializers
from rest_framework.response import Response
from tasks.models import Task
from hanning.backend.reference_sync.lineage import configured_level, consistent_read
from .service import create_project, source_choice


class SourceQuery(serializers.Serializer):
    level = serializers.IntegerField(min_value=2, max_value=4)
    project_id = serializers.IntegerField(min_value=1, required=False)
    page = serializers.IntegerField(min_value=1, default=1)


class CreateRequest(serializers.Serializer):
    level = serializers.IntegerField(min_value=1, max_value=4)
    title = serializers.CharField(min_length=settings.PROJECT_TITLE_MIN_LEN,
                                  max_length=Project._meta.get_field('title').max_length)
    source_task = serializers.IntegerField(min_value=1, required=False)
    source_annotation = serializers.IntegerField(min_value=1, required=False)
    source_version = serializers.RegexField(r'^[0-9a-f]{64}$', required=False)

    def validate(self, data):
        fields = {'source_task', 'source_annotation', 'source_version'}
        if data['level'] > 1 and not fields <= data.keys():
            raise serializers.ValidationError('请选择来源图片及其有效正式标注。')
        if data['level'] == 1 and fields & data.keys():
            raise serializers.ValidationError('L1 不接受上游来源。')
        return data


class HierarchyProjectAPI(generics.GenericAPIView):
    permission_required = ViewClassPermission(GET=all_permissions.projects_view, POST=all_permissions.projects_create)
    serializer_class = CreateRequest

    @consistent_read
    def get(self, request):
        query = SourceQuery(data=request.query_params)
        query.is_valid(raise_exception=True)
        data = query.validated_data
        projects = []
        for project in Project.objects.for_user(request.user).filter(is_draft=False).order_by('id'):
            try:
                level = configured_level(project.label_config)
            except (ValueError, ET.ParseError):
                continue
            if level == data['level'] - 1:
                projects.append({'id': project.id, 'title': project.title})
        response = {'projects': projects, 'tasks': [], 'page': data['page'], 'pages': 1, 'count': 0}
        if 'project_id' in data:
            if data['project_id'] not in {project['id'] for project in projects}:
                raise serializers.ValidationError('来源项目不存在、不可访问或层级不匹配。')
            project = get_object_or_404(Project.objects.for_user(request.user), pk=data['project_id'])
            pages = Paginator(Task.objects.for_user(request.user).filter(project=project).order_by('id'), 20)
            if data['page'] > pages.num_pages:
                raise serializers.ValidationError('页码已失效，请返回上一页。')
            response.update(tasks=[source_choice(task) for task in pages.page(data['page'])],
                            pages=pages.num_pages, count=pages.count)
        return Response(response)

    def post(self, request):
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        try:
            project, task = create_project(request.user, **serializer.validated_data)
        except ValueError as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return Response({'id': project.id, 'task_id': task.id if task else None}, status=201)
