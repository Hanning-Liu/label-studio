"""Read-only L1--L4 source snapshots and lossless window inheritance checks.

The document validator is also used by offline publication. Database access is
lazy so offline verification does not require Django settings or trust a saved
``ready`` flag. Draft writes never invoke the formal-publication gate.
"""

import copy
import hashlib
import json
import xml.etree.ElementTree as ET
from contextlib import contextmanager
from functools import wraps

PROFILES = {2: 'room_to_function_zone', 3: 'function_zone_to_occupancy', 4: 'occupancy_to_furniture_instances'}
WINDOW = 'window_vector'
WINDOW_KEYS = ('id', 'from_name', 'to_name', 'type', 'original_width', 'original_height', 'image_rotation', 'value')


class LineageSourceError(ValueError):
    def __init__(self, message, level, project_id, task_id):
        super().__init__(message)
        self.location = {'level': level, 'project_id': project_id, 'task_id': task_id}


@contextmanager
def read_snapshot():
    """One read snapshot without writes; PostgreSQL otherwise uses READ COMMITTED."""
    from django.db import connection, transaction
    outer = not connection.in_atomic_block
    with transaction.atomic():
        if outer and connection.vendor == 'postgresql':
            with connection.cursor() as cursor:
                cursor.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        yield


def consistent_read(fn):
    @wraps(fn)
    def wrapped(*args, **kwargs):
        with read_snapshot():
            return fn(*args, **kwargs)
    return wrapped


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'),
                                     allow_nan=False).encode('utf-8')).hexdigest()


def config_digest(config):
    return hashlib.sha256(config.encode('utf-8')).hexdigest()


def controls(config):
    root = ET.fromstring(config)
    found = {}
    for node in root.iter():
        name = node.get('name')
        if name:
            if name in found:
                raise ValueError(f'控件名称重复: {name}')
            found[name] = node
    return found


def configured_level(config):
    named = controls(config)
    if any(name.startswith('furniture_instance_') for name in named):
        return 4
    if {'occupancy_rectangle', 'occupancy_polygon', 'occupancy_type'} & named.keys():
        return 3
    if {'zone_rectangle', 'zone_polygon', 'function_zone'} & named.keys():
        return 2
    if {'room_rectangle', 'room_polygon'} & named.keys():
        return 1
    return None


def window_rows(results):
    if not isinstance(results, list) or any(not isinstance(row, dict) for row in results):
        raise ValueError('标注结果必须是对象列表')
    rows = [row for row in results if row.get('from_name') == WINDOW]
    # A renamed/corrupt window must not disappear into an apparently empty set.
    for row in results:
        labels = row.get('value', {}).get('vectorlabels', [])
        meta = row.get('meta') or {}
        if row.get('from_name') != WINDOW and (
            'window_context' in meta or any(str(label).strip().lower() == 'window' for label in labels)
        ):
            raise ValueError(f"窗结果 {row.get('id')} 未使用稳定控件 window_vector")
    ids = [row.get('id') for row in rows]
    if any(not isinstance(ident, str) or not ident for ident in ids) or len(set(ids)) != len(ids):
        raise ValueError('窗结果 ID 缺失或重复')
    return rows


def canonical_windows(results):
    from tasks.windows.geometry import parse_window

    output = {}
    for row in window_rows(results):
        parse_window(row)
        meta = row.get('meta') or {}
        context = meta.get('window_context')
        if not isinstance(context, dict):
            raise ValueError(f"窗 {row['id']} 缺少权威 window_context")
        output[row['id']] = {**{key: copy.deepcopy(row[key]) for key in WINDOW_KEYS if key in row},
                             'window_context': copy.deepcopy(context)}
    return output


def validate_window_config(config, windows):
    named = controls(config)
    if not windows:
        return
    control = named.get(WINDOW)
    if control is None:
        raise ValueError('来源 L1 有窗，目标缺少 window_vector 控件；请先预览并升级配置')
    labels = [child.get('alias') or child.get('value') for child in control if child.tag == 'Label']
    if len(set(labels)) != len(labels) or any(not label for label in labels):
        raise ValueError('window_vector 标签或别名重复/缺失')
    allowed = set(labels)
    for row in windows.values():
        if (control.tag != 'VectorLabels' or control.get('toName') != row.get('to_name')
                or not set(row.get('value', {}).get('vectorlabels', [])) <= allowed):
            raise ValueError('window_vector 的几何类型、图像目标或标签与 L1 来源不兼容')


def profile_reference_hash(results, target_level):
    if target_level == 2:
        from .results import reference_hash
    elif target_level == 3:
        from tasks.occupancy.reference import reference_hash
    else:
        from tasks.furniture_instances.reference import reference_hash
    return reference_hash(results)


def validate_formal(document):
    """Use existing domain validators; never repair or restamp saved results."""
    level, result, config = document['level'], document['result'], document['label_config']
    from .results import validate_source, validate_submission
    from tasks.windows.downstream import validate_persisted_projection_state

    validate_source(result, config)
    if level == 2:
        validate_submission(result)
        validate_persisted_projection_state(result, level='L2')
    elif level == 3:
        from tasks.occupancy.validation import validate
        issues = validate(result, document.get('binding', {}).get('applied_hash', 'formal-source'))
        if issues:
            raise ValueError('；'.join(str(issue.get('message') or issue.get('code')) for issue in issues[:6]))
        validate_persisted_projection_state(result, level='L3')
    elif level == 4:
        from tasks.furniture_instances.validation import validate
        from tasks.furniture_instances.reference import validate_provenance
        issues = validate(result, document.get('binding', {}).get('applied_hash', 'formal-source'))
        if issues:
            raise ValueError('；'.join(str(issue.get('message') or issue.get('code')) for issue in issues[:6]))
        validate_provenance(result, document['project_id'], document['task_id'], document['annotation_id'])


def validate_documents(documents, *, complete=False):
    """Check an ordered L1..Ln snapshot; candidate targets need no annotation PK.

    Applied references and the saved formal result are independently checked:
    an updated prediction never makes an old formal annotation current.
    """
    issues, levels, expected = [], [], None

    def error(doc, code, message, window_ids=None):
        issues.append({'code': code, 'level': doc.get('level'), 'project_id': doc.get('project_id'),
                       'task_id': doc.get('task_id'), 'annotation_id': doc.get('annotation_id'),
                       'message': message, 'window_ids': sorted(window_ids or [])})

    if not documents or documents[0].get('level') != 1:
        error(documents[0] if documents else {}, 'lineage_missing', '无法追溯到明确的 L1 正式标注')
    if complete and [doc.get('level') for doc in documents] != [1, 2, 3, 4]:
        error(documents[-1] if documents else {}, 'lineage_incomplete', '完整户型必须具有 L1—L4 四层正式标注')
    previous = None
    for index, doc in enumerate(documents):
        level = doc.get('level')
        summary = {key: doc.get(key) for key in ('level', 'project_id', 'task_id', 'annotation_id', 'updated_at')}
        summary['window_count'] = None
        levels.append(summary)
        if level != index + 1:
            error(doc, 'lineage_type', '来源层级不连续或绑定类型错误')
        formal = doc.get('formal', False)
        if (index < len(documents) - 1 or complete or level == 1) and not formal:
            error(doc, 'formal_missing', f'L{level} 缺少唯一有效正式标注，草稿不能替代')
        if formal and (not doc.get('annotation_id') or doc.get('was_cancelled')):
            error(doc, 'formal_missing', f'L{level} 正式标注缺失或已取消')
        try:
            controls(doc['label_config'])
            windows = canonical_windows(doc['result'])
            summary['window_count'] = len(windows)
            summary['window_fingerprint'] = digest(windows)
            if level == 1:
                expected = windows
                from tasks.windows.downstream import validate_authoritative_window_contexts
                validate_authoritative_window_contexts(doc['result'])
            validate_window_config(doc['label_config'], expected or windows)
            if expected is not None:
                missing, extra = expected.keys() - windows.keys(), windows.keys() - expected.keys()
                changed = {ident for ident in expected.keys() & windows.keys() if digest(expected[ident]) != digest(windows[ident])}
                if missing:
                    error(doc, 'window_missing', f'L{level} 缺少 L1 窗参考', missing)
                if extra:
                    error(doc, 'window_extra', f'L{level} 存在 L1 中没有的窗参考', extra)
                if changed:
                    error(doc, 'window_changed', f'L{level} 窗几何或权威上下文与 L1 不一致', changed)
            if formal:
                validate_formal(doc)
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            error(doc, 'lineage_invalid', f'L{level}: {exc}')
        if previous is not None:
            binding = doc.get('binding') or {}
            identity = (binding.get('source_project_id'), binding.get('source_task_id'), binding.get('source_annotation_id'))
            expected_identity = (previous.get('project_id'), previous.get('task_id'), previous.get('annotation_id'))
            if not binding.get('enabled') or binding.get('sync_type') != PROFILES.get(level) or identity != expected_identity:
                error(doc, 'lineage_binding', '缺少已启用且身份匹配的明确来源绑定')
            if doc.get('organization_id') != previous.get('organization_id'):
                error(doc, 'lineage_organization', '禁止跨组织引用')
            try:
                image_hash = digest(previous['data'])
                if digest(doc['data']) != image_hash or binding.get('source_data_hash') != image_hash:
                    error(doc, 'lineage_image', '来源图片数据已变化或未被明确绑定')
                wanted = profile_reference_hash(previous['result'], level)
                actual = profile_reference_hash(doc['result'], level)
                if binding.get('applied_hash') != wanted or actual != wanted:
                    error(doc, 'lineage_outdated', f'L{level} 尚未应用并保存最新 L{level - 1} 参考')
                prediction = doc.get('prediction')
                if prediction is None or profile_reference_hash(prediction['result'], level) != wanted:
                    error(doc, 'lineage_prediction', f'L{level} 已应用的权威参考缺失或过期')
            except (ValueError, TypeError, KeyError) as exc:
                error(doc, 'lineage_invalid', str(exc))
        previous = doc
    version = digest(documents)
    root = levels[0] if levels and levels[0]['level'] == 1 else None
    classification = 'complete' if complete and not issues else 'in_progress' if not issues else 'invalid_annotation'
    codes = {issue['code'] for issue in issues}
    if codes & {'lineage_missing', 'lineage_binding', 'lineage_type', 'lineage_image', 'lineage_outdated', 'lineage_prediction'}:
        classification = 'source_unconfirmed_or_outdated'
    if codes & {'window_missing', 'window_extra', 'window_changed'}:
        classification = 'window_inconsistent'
    if codes & {'formal_missing', 'lineage_incomplete'}:
        classification = 'formal_missing'
    return {'ready': not issues, 'complete': complete and not issues, 'version': version, 'classification': classification,
            'repair_order': sorted({issue['level'] for issue in issues if isinstance(issue['level'], int)}),
            'root': root, 'levels': levels, 'issues': issues,
            'window_count': root['window_count'] if root else None}


def _binding_document(binding):
    mapping = binding.mapping
    return {'id': binding.id, 'enabled': mapping.enabled, 'sync_type': mapping.sync_type,
            'source_project_id': mapping.source_project_id, 'source_task_id': binding.source_task_id,
            'source_annotation_id': binding.source_annotation_id, 'source_data_hash': binding.source_data_hash,
            'applied_hash': binding.applied_hash}


def document_for(task, level, annotation=None, result=None):
    return {'level': level, 'project_id': task.project_id, 'task_id': task.id,
            'organization_id': task.project.organization_id, 'data': copy.deepcopy(task.data),
            'label_config': task.project.label_config, 'annotation_id': annotation.id if annotation else None,
            'updated_at': annotation.updated_at.isoformat() if annotation else None,
            'formal': annotation is not None, 'was_cancelled': bool(annotation and annotation.was_cancelled),
            'result': copy.deepcopy(annotation.result if annotation else result if result is not None else [])}


def collect_documents(task, *, level=None, result=None, formal=False, lock=False):
    from projects.models import Project
    from tasks.models import Annotation, Prediction
    from .models import ReferenceSyncBinding
    from .service import source_for

    if lock:
        # Critical writes already run inside sync_atomic. Lock the source rows
        # until the entire save/apply completes; SQLite uses its writer lock.
        task = type(task).objects.select_for_update().get(pk=task.pk)
        task.project = Project.objects.select_for_update().get(pk=task.project_id)
    bindings = ReferenceSyncBinding.objects.filter(target_task=task).select_related('mapping', 'mapping__source_project')
    binding = (bindings.select_for_update() if lock else bindings).first()
    bound_level = next((n for n, profile in PROFILES.items() if binding and binding.mapping.sync_type == profile), None)
    level = level or bound_level or configured_level(task.project.label_config)
    if level not in (1, 2, 3, 4):
        raise ValueError('项目未声明可识别的 L1—L4 层级')
    if level > 1 and (not binding or not binding.mapping.enabled or binding.mapping.sync_type != PROFILES[level]):
        raise LineageSourceError(f'L{level} 任务 {task.id} 缺少已启用的正确来源绑定', level, task.project_id, task.id)
    if level == 1 and binding:
        raise ValueError('L1 根任务不能具有上级绑定')
    documents = []
    if binding:
        try:
            source_task, source = source_for(binding)
        except ValueError as exc:
            raise LineageSourceError(str(exc), level - 1, binding.mapping.source_project_id, binding.source_task_id) from exc
        documents = collect_documents(source_task, level=level - 1, formal=True, lock=lock)
        if documents[-1]['annotation_id'] != source.id:
            raise ValueError('来源正式标注身份不一致')
    annotation = None
    if formal or level == 1:
        query = Annotation.objects.filter(task=task, was_cancelled=False)
        candidates = list(query.select_for_update() if lock else query)
        if len(candidates) != 1:
            raise LineageSourceError(f'L{level} 任务 {task.id} 缺少唯一有效正式标注', level, task.project_id, task.id)
        annotation = candidates[0]
    prediction = Prediction.objects.filter(pk=binding.prediction_id, task=task).first() if binding else None
    if result is None and annotation is None:
        result = prediction.result if prediction else []
    doc = document_for(task, level, annotation=annotation, result=result)
    if binding:
        doc['binding'] = _binding_document(binding)
        doc['prediction'] = {'id': prediction.id, 'result': copy.deepcopy(prediction.result)} if prediction else None
    documents.append(doc)
    return documents


def report_for_task(task, *, result=None, complete=False, lock=False):
    try:
        return validate_documents(collect_documents(task, result=result, formal=complete, lock=lock), complete=complete)
    except (ValueError, TypeError, KeyError) as exc:
        location = getattr(exc, 'location', {'level': None, 'task_id': task.id, 'project_id': task.project_id})
        return {'ready': False, 'complete': False, 'classification': 'source_unconfirmed_or_missing', 'version': None,
                'root': None, 'levels': [], 'window_count': None,
                'issues': [{'code': 'lineage_missing', 'message': str(exc), **location, 'window_ids': []}]}


def require_report(report):
    if not report['ready']:
        from .service import SyncConflict
        messages = '；'.join(f"{issue['message']}" + (f" ({', '.join(issue['window_ids'])})" if issue.get('window_ids') else '')
                            for issue in report['issues'][:6])
        raise SyncConflict(messages, 'floorplan_lineage_invalid', 409,
                           display_context={'reason': 'FLOORPLAN_LINEAGE', 'issues': report['issues']})
    return report


def require_source(binding, *, lock=False, expected_version=None):
    """Before create/apply: validate upstream, not the old target being repaired."""
    from .service import source_for
    source_task, annotation = source_for(binding)
    level = next((level for level, name in PROFILES.items() if name == binding.mapping.sync_type), None)
    if level is None:
        raise ValueError('不支持的参考同步类型')
    documents = collect_documents(source_task, level=level - 1, formal=True, lock=lock)
    if expected_version is not None and profile_reference_hash(documents[-1]['result'], level) != expected_version:
        from .service import SyncConflict
        raise SyncConflict('读取来源链期间正式标注再次变化，本次创建或应用已中止', 'source_version_conflict')
    report = require_report(validate_documents(documents))
    validate_window_config(binding.mapping.target_project.label_config, canonical_windows(documents[0]['result']))
    return report
