"""Offline source evidence. Saved success flags never replace revalidation."""

import copy
import hashlib
import json
from pathlib import Path

from .lineage import canonical_windows, digest, validate_documents

FORMAT = 'floorplan-lineage/1'


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2, allow_nan=False) + '\n').encode('utf-8')


def export_bundle(documents, directory):
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=False)
    entries = []
    raw_directory = directory / 'raw'
    raw_directory.mkdir()
    for document in documents:
        exported = copy.deepcopy(document)
        exported.update(id=document['annotation_id'], task=document['task_id'], project=document['project_id'])
        content = json_bytes(exported)
        name = f"L{document['level']}.json"
        (directory / name).write_bytes(content)
        entries.append({'level': document['level'], 'file': name, 'sha256': hashlib.sha256(content).hexdigest(),
                        **{key: document[key] for key in ('project_id', 'task_id', 'annotation_id')}})
        role = {1: 'rooms', 2: 'zones', 3: 'occupancy', 4: 'furniture_instances'}[document['level']]
        (raw_directory / f'{role}.json').write_bytes(json_bytes({
            'id': document['task_id'], 'project': document['project_id'], 'data': document['data'],
            'annotations': [{'id': document['annotation_id'], 'updated_at': document['updated_at'],
                             'was_cancelled': document['was_cancelled'], 'result': document['result']}],
        }))
        config_role = {1: 'room', 2: 'zone', 3: 'occupancy', 4: 'furniture_instance'}[document['level']]
        (raw_directory / f'{config_role}_config.json').write_bytes(json_bytes({
            'id': document['project_id'], 'label_config': document['label_config'],
        }))
    report = validate_documents(documents, complete=True)
    manifest = {'format': FORMAT, 'levels': entries, 'snapshot_version': report['version']}
    (directory / 'lineage-manifest.json').write_bytes(json_bytes(manifest))
    (directory / 'lineage-report.json').write_bytes(json_bytes(report))
    return manifest, report


def load_bundle(manifest_path):
    path = Path(manifest_path).resolve()
    manifest = json.loads(path.read_text(encoding='utf-8'))
    if manifest.get('format') != FORMAT or not isinstance(manifest.get('levels'), list):
        raise ValueError('需要有效的 floorplan-lineage/1 来源清单')
    if [entry.get('level') for entry in manifest['levels']] != [1, 2, 3, 4]:
        raise ValueError('来源清单必须按顺序包含 L1—L4，不能重复或缺层')
    documents = []
    for entry in manifest['levels']:
        filename = (path.parent / entry['file']).resolve()
        if not filename.is_relative_to(path.parent) or filename == path:
            raise ValueError('来源文件必须位于清单目录内')
        content = filename.read_bytes()
        if hashlib.sha256(content).hexdigest() != entry.get('sha256'):
            raise ValueError(f"L{entry['level']} 原始文件 SHA-256 不一致")
        document = json.loads(content)
        for key in ('level', 'project_id', 'task_id', 'annotation_id'):
            if document.get(key) != entry.get(key):
                raise ValueError(f"L{entry['level']} 来源身份 {key} 不一致")
        for alias, key in (('id', 'annotation_id'), ('task', 'task_id'), ('project', 'project_id')):
            if document.pop(alias, None) != document[key]:
                raise ValueError(f"L{entry['level']} 正式标注身份 {alias} 不一致")
        documents.append(document)
    if digest(documents) != manifest.get('snapshot_version'):
        raise ValueError('来源快照版本不一致')
    report = validate_documents(documents, complete=True)
    if not report['ready']:
        raise ValueError('来源链未通过完整验收：' + '；'.join(issue['message'] for issue in report['issues'][:6]))
    return documents, report


def validate_publication_sources(base, annotation, documents):
    """Match the full raw L4 and independently supplied L1--L3 base evidence."""
    from dataclasses import replace
    from datetime import datetime
    from tasks.windows.aggregate import augment_floorplan_aggregate
    from tasks.windows.downstream import authoritative_window_domain, _targets
    from tasks.windows.projections import derive_window_projections

    l4 = documents[-1]
    if annotation.get('id') != l4['annotation_id'] or digest(annotation.get('result')) != digest(l4['result']):
        raise ValueError('--annotation 与清单中的 L4 正式标注不一致')
    sources = base.get('sources', {})
    for document, name, role in zip(documents[:3], ('room', 'zone', 'occupancy'), ('rooms', 'zones', 'occupancy')):
        source = sources.get(name)
        if not isinstance(source, dict) or any(source.get(key) != document[key] for key in ('project_id', 'task_id', 'annotation_id')):
            raise ValueError(f'/4 基础数据缺少或不匹配 L{document["level"]} 来源身份 sources.{name}')
        raw = base.get('raw_inputs', {}).get(role, {})
        if not isinstance(raw.get('text'), str):
            raise ValueError(f'基础数据缺少 raw_inputs.{role} 原始导出证据')
        actual_sha = hashlib.sha256(raw['text'].encode('utf-8')).hexdigest()
        if raw.get('sha256') != actual_sha or source.get('input_sha256') != actual_sha:
            raise ValueError(f'/4 基础数据 L{document["level"]} 原始导出 SHA-256 不一致')
        payload = json.loads(raw['text'].lstrip('\ufeff'))
        tasks = payload if isinstance(payload, list) else [payload]
        matches = [task for task in tasks if task.get('id') == document['task_id']]
        if len(matches) != 1 or matches[0].get('project') != document['project_id']:
            raise ValueError(f'基础数据 {role} 来源任务身份不一致')
        matches = [row for row in matches[0].get('annotations', []) if row.get('id') == document['annotation_id']]
        if len(matches) != 1 or matches[0].get('was_cancelled') or digest(matches[0].get('result')) != digest(document['result']):
            raise ValueError(f'基础数据 {role} 正式标注内容与快照不一致')
        if any(datetime.fromisoformat(value.replace('Z', '+00:00')) != datetime.fromisoformat(document['updated_at'])
               for value in (source.get('updated_at', ''), matches[0].get('updated_at', ''))):
            raise ValueError(f'基础数据 {role} 正式标注版本与快照不一致')
    windows = canonical_windows(documents[0]['result'])
    if not windows:
        if any(base.get(name) for name in ('window_traces', 'window_connections', 'window_projections')):
            raise ValueError('L1 无窗，但基础数据残留窗或窗投影')
    else:
        traces, connections, config = authoritative_window_domain(documents[0]['result'])
        room_map = {}
        roots = {row['id']: row for row in documents[0]['result'] if row.get('from_name') in {'room_rectangle', 'room_polygon'}}
        for node in base.get('nodes', []):
            if node.get('kind') != 'room':
                continue
            ident = node.get('result_id')
            if ident in room_map or ident not in roots or digest(node.get('raw')) != digest(roots[ident]):
                raise ValueError('基础数据房间缺少唯一且匹配的原始结果证据')
            room_map[ident] = node['id']
        if any(trace.parent_room_id not in room_map for trace in traces):
            raise ValueError('基础数据缺少窗的来源房间')
        canonical_traces = [replace(trace, parent_room_id=room_map[trace.parent_room_id]) for trace in traces]
        canonical_connections = copy.deepcopy(connections)
        for connection in canonical_connections:
            connection['connected_room_ids'] = [room_map[ident] for ident in connection['connected_room_ids']]
        targets = []
        for document in documents[1:3]:
            level = f"L{document['level']}"
            for target in _targets(document['result'], level):
                rows = [document['result'][index] for index in target['result_indexes']]
                if level == 'L2':
                    candidates = [node for node in base.get('nodes', []) if node.get('kind') == 'zone'
                                  and node.get('result_id') == target['entity_id'] and node.get('raw') == rows[0]]
                else:
                    candidates = [region for region in base.get('occupancy_regions', [])
                                  if {part.get('result_id') for part in region.get('parts', [])} == {row['id'] for row in rows}
                                  and sorted((digest(part.get('raw')) for part in region.get('parts', []))) == sorted(map(digest, rows))]
                if len(candidates) != 1 or target['room_id'] not in room_map:
                    raise ValueError(f"基础数据 {level} 投影目标缺少唯一原始几何证据: {target['entity_id']}")
                targets.append({**target, 'entity_id': candidates[0]['id'], 'room_id': room_map[target['room_id']]})
        # Match the established /4 offline projection policy, while deriving
        # from the verified formal geometries rather than trusting saved arrays.
        tolerance = base.get('algorithm', {}).get('parameters', {}).get('l3_boundary_precision_px', 1e-6)
        import math
        if isinstance(tolerance, bool) or not isinstance(tolerance, (int, float)) or not math.isfinite(tolerance) or tolerance < 0:
            raise ValueError('基础数据窗投影边界容差无效')
        config = replace(config, projection_boundary_tolerance_px=tolerance)
        projections = derive_window_projections(canonical_traces, canonical_connections, targets, config)
        expected = augment_floorplan_aggregate({'schema': 'floorplan-unified/4'}, traces=canonical_traces,
                                              connections=canonical_connections, projections=projections, config=config,
                                              provenance={key: documents[0][key] for key in ('project_id', 'task_id', 'annotation_id')})
        for name in ('window_traces', 'window_connections', 'window_projections'):
            if digest(sorted(base.get(name, []), key=lambda row: row.get('id', ''))) != digest(expected[name]):
                raise ValueError(f'基础数据 {name} 与权威 L1 窗数据不一致')
        if base.get('window_matching_policy') != expected['window_matching_policy']:
            raise ValueError('基础数据窗匹配策略与 L1 来源不一致')
