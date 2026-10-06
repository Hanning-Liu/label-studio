from django.shortcuts import get_object_or_404
from lxml import etree
from organizations.models import Organization
from projects.models import Project
from rest_framework import generics, serializers
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response
from core.permissions import ViewClassPermission, all_permissions
from hanning.backend.reference_sync.service import sync_atomic
from hanning.backend.reference_sync.lineage import configured_level
from hanning.backend.validation.furniture_instances.catalog_upgrade import upgrade_choices
from . import CATALOG
from .custom import custom_entry, normalize_name


def extend_config(config, entries):
    config, _ = upgrade_choices(config, [(e['id'], e['label']) for e in entries])
    # Put portable display metadata on the Choice; no annotations are rewritten.
    for entry in entries:
        old = etree.tostring(etree.Element('Choice', value=entry['label'], alias=entry['id']), encoding='unicode')
        new = etree.tostring(etree.Element('Choice', value=entry['label'], alias=entry['id'],
                                          furnitureGroup=entry['group']), encoding='unicode')
        config = config.replace(old, new)
    root = etree.fromstring(config.encode('utf-8'), etree.XMLParser(resolve_entities=False, no_network=True))
    for entry in entries:
        matches = root.xpath('.//Choices[@name="furniture_instance_type"]/Choice[@alias=$alias]', alias=entry['id'])
        if len(matches) != 1 or matches[0].get('furnitureGroup') != entry['group']:
            raise ValueError('现有家具类别的大类配置冲突，请检查项目配置')
    return config

class CategoryRequest(serializers.Serializer):
    label = serializers.CharField(max_length=80)
    group = serializers.CharField(max_length=40)
    project_id = serializers.IntegerField(min_value=1)

class FurnitureCatalogAPI(generics.GenericAPIView):
    permission_required = ViewClassPermission(GET=all_permissions.projects_view, POST=all_permissions.projects_change)
    serializer_class = CategoryRequest

    def get(self, request):
        org = get_object_or_404(Organization, pk=request.user.active_organization_id)
        return Response({'categories': org.furniture_catalog, 'groups': CATALOG['groups'],
                         'can_create': org.created_by_id == request.user.id})

    @sync_atomic
    def post(self, request):
        data = self.get_serializer(data=request.data)
        data.is_valid(raise_exception=True)
        data = data.validated_data
        org = Organization.objects.select_for_update().get(pk=request.user.active_organization_id)
        if org.created_by_id != request.user.id:
            raise PermissionDenied('只有工作区管理员可以创建共用家具类别')
        project = get_object_or_404(Project.objects.for_user(request.user), pk=data['project_id'], organization=org)
        try:
            if configured_level(project.label_config) != 4:
                raise ValueError('只能从 L4 家具实例项目创建类别')
            entry = custom_entry(data['label'], data['group'])
            name = entry['label'].casefold()
            for base in CATALOG['categories']:
                if name in {normalize_name(v).casefold() for v in [base['id'], base['label'], *base['aliases']]}:
                    raise ValueError('该名称或别称已存在，请直接选择已有类别')
            for existing in org.furniture_catalog:
                if normalize_name(existing['label']).casefold() == name:
                    if existing['group'] != entry['group']:
                        raise ValueError('同名类别已存在于另一个大类')
                    return Response({'category': existing, 'created': False})
            # Organization lock serializes category/project creation, including double clicks.
            projects = list(Project.objects.filter(organization=org).select_for_update())
            updates = []
            for target in projects:
                if 'furnitureinstancesv1' not in (target.label_config or '').lower():
                    continue
                if configured_level(target.label_config) == 4:
                    updates.append((target, extend_config(target.label_config, [entry])))
            for target, config in updates:
                target.label_config = config
                target.save(update_fields=['label_config'])
            org.furniture_catalog = [*org.furniture_catalog, entry]
            org.save(update_fields=['furniture_catalog'])
        except (ValueError, etree.XMLSyntaxError) as exc:
            raise serializers.ValidationError(str(exc)) from exc
        return Response({'category': entry, 'created': True}, status=201)
