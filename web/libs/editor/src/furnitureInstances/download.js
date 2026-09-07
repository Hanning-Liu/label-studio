import { clone } from "../occupancy/geometry";
import { downloadJson } from "../occupancy/download";
import { context, controlName, furnitureInstances, geometryForExport, ROLE_BY_CONTROL } from "./domain";
import { invalidateFurnitureReviews, orientationForInstance, validateFurnitureInstances } from "./constraints";

const ROLE_ORDER = Object.freeze({ geometry: 0, category: 1, front_direction: 2, front_edge: 3 });

const PUBLIC_PROVENANCE_FIELDS = new Set(["project_id", "task_id", "annotation_id", "result_id"]);
const validProvenanceValues = (value, resultId) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  typeof resultId === "string" &&
  resultId.length > 0 &&
  value.result_id === resultId &&
  [value.project_id, value.task_id, value.annotation_id].every((id) => Number.isInteger(id) && id > 0);
const validInternalProvenance = (value, resultId) =>
  value?.schema_version === 1 && validProvenanceValues(value, resultId);
const validPublicProvenance = (value, resultId) =>
  validProvenanceValues(value, resultId) &&
  Object.keys(value).length === PUBLIC_PROVENANCE_FIELDS.size &&
  Object.keys(value).every((key) => PUBLIC_PROVENANCE_FIELDS.has(key));
const samePublicProvenance = (left, right) =>
  [...PUBLIC_PROVENANCE_FIELDS].every((field) => left?.[field] === right?.[field]);

const compareSourceResults = (left, right) => {
  const leftRole = ROLE_BY_CONTROL[controlName(left)];
  const rightRole = ROLE_BY_CONTROL[controlName(right)];
  return ROLE_ORDER[leftRole] - ROLE_ORDER[rightRole] || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
};

export function provenanceForResult(result) {
  const provenance = result?.meta?.furniture_instance_provenance;
  if (!validInternalProvenance(provenance, result?.id))
    throw new Error(`家具结果 ${result?.id || "(missing)"} 尚无完整的服务端 provenance`);
  return {
    project_id: provenance.project_id,
    task_id: provenance.task_id,
    annotation_id: provenance.annotation_id,
    result_id: provenance.result_id,
  };
}

function sourceResults(instance) {
  return [...instance.results].sort(compareSourceResults).map((result) => ({
    role: ROLE_BY_CONTROL[controlName(result)],
    provenance: provenanceForResult(result),
    raw: clone(result),
  }));
}

export function exportFurnitureInstances(results, occupancyResults = results, { requireReview = true } = {}) {
  const normalized = invalidateFurnitureReviews(results, occupancyResults);
  const errors = validateFurnitureInstances(normalized, occupancyResults, { review: requireReview });
  if (errors.length) {
    const error = new Error(errors.map((issue) => issue.message).join("；"));
    error.name = "FurnitureInstanceValidationError";
    error.code = "furniture_instance_validation_failed";
    error.issues = errors;
    throw error;
  }
  return furnitureInstances(normalized).map((instance) => {
    const furnitureContext = instance.context;
    const sources = sourceResults(instance);
    const primary = sources.find((source) => source.role === "geometry");
    return {
      kind: "furniture_instance",
      id: instance.id,
      instance_type: furnitureContext.instance_type,
      ...(furnitureContext.note ? { note: furnitureContext.note } : {}),
      parent: {
        room_id: furnitureContext.room_id,
        zone_id: furnitureContext.zone_id,
        group_id: furnitureContext.group_id,
      },
      source_version: furnitureContext.source_version,
      parent_fingerprint: furnitureContext.parent_fingerprint,
      geometry: geometryForExport(instance.geometry),
      orientation: orientationForInstance(instance),
      review_status: furnitureContext.review_status,
      review_fingerprint: furnitureContext.review_fingerprint ?? null,
      provenance: primary.provenance,
      source_results: sources,
    };
  });
}

export function reimportFurnitureInstances(value) {
  const instances = Array.isArray(value) ? value : value?.furniture_instances;
  if (!Array.isArray(instances)) throw new Error("重新导入内容缺少 furniture_instances 数组");
  return instances.flatMap((instance) => {
    if (instance?.kind !== "furniture_instance" || !Array.isArray(instance.source_results))
      throw new Error("重新导入内容包含无效家具实例");
    const restored = instance.source_results.map((source) => {
      const raw = clone(source.raw);
      const expectedRole = ROLE_BY_CONTROL[controlName(raw)];
      if (!expectedRole || source.role !== expectedRole) throw new Error(`家具源结果 ${raw.id} 的 role 与控件不一致`);
      if (!validPublicProvenance(source.provenance, raw.id))
        throw new Error(`家具源结果 ${raw.id} 的 provenance 不完整或不符合公共 Schema`);
      raw.meta = {
        ...raw.meta,
        furniture_instance_context: {
          schema_version: 1,
          instance_id: instance.id,
          instance_type: instance.instance_type,
          note: instance.note || "",
          room_id: instance.parent?.room_id,
          zone_id: instance.parent?.zone_id,
          group_id: instance.parent?.group_id,
          source_version: instance.source_version,
          parent_fingerprint: instance.parent_fingerprint,
          review_status: instance.review_status,
          review_fingerprint: instance.review_fingerprint ?? null,
          role: source.role,
        },
        furniture_instance_provenance: { schema_version: 1, ...clone(source.provenance) },
      };
      return raw;
    });
    const primary = instance.source_results
      .filter((source) => source.role === "geometry")
      .sort((left, right) => compareSourceResults(left.raw, right.raw))[0];
    if (
      !primary ||
      !validPublicProvenance(instance.provenance, primary.raw?.id) ||
      !samePublicProvenance(instance.provenance, primary.provenance)
    )
      throw new Error(`家具实例 ${instance.id || "(missing)"} 的 provenance 必须匹配 primary geometry source`);
    return restored;
  });
}

export function withFurnitureInstances(unified, instances) {
  if (unified?.schema !== "floorplan-unified/4")
    throw new Error("furniture_instances 只能写入 floorplan-unified/4 聚合数据");
  return { ...clone(unified), furniture_instances: clone(instances) };
}

export function aggregateFurnitureInstances(unified, results, occupancyResults = results, options) {
  return withFurnitureInstances(unified, exportFurnitureInstances(results, occupancyResults, options));
}

export function downloadFurnitureInstances(annotation, occupancyResults, options) {
  const results = annotation.serializeAnnotation({ fast: true });
  const instances = exportFurnitureInstances(results, occupancyResults || results, options);
  const taskId = annotation.store.task.id;
  downloadJson(
    { schema_version: 1, coordinate_system: "image_percent", furniture_instances: instances },
    `task-${taskId}-furniture-instances-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
  );
}

export const furnitureInstanceContext = context;
