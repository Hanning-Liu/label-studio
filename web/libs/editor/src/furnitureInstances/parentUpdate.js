import { fingerprint } from "../occupancy/geometry";
import { validateFurnitureInstances } from "./constraints";
import { ALL_CONTROLS, context, controlName, furnitureGroups, furnitureInstances } from "./domain";
import { applyFurnitureInstanceOperation } from "./operations";

// Accept only a new version of the saved parent, never the current Focus.
// Validate the original bytes first so inconsistent contexts cannot be repaired
// accidentally by replacing their fingerprints with a common value.
export function furnitureParentUpdate(results, occupancyResults, instanceId) {
  const instance = furnitureInstances(results).find((candidate) => candidate.id === instanceId);
  if (!instance) throw new Error("待处理家具实例不存在");
  const referenceKeys = new Set();
  for (const result of occupancyResults.filter((r) => !ALL_CONTROLS.has(controlName(r)))) {
    const key = `${result.id}\u0000${controlName(result)}`;
    if (referenceKeys.has(key)) throw new Error("上级参考包含重复结果，不能接受父组团更新");
    referenceKeys.add(key);
  }
  const relevant = (error) => !error.instanceId || error.instanceId === instanceId;
  const blocking = validateFurnitureInstances(results, occupancyResults, { review: false }).filter(
    (error) => relevant(error) && !["parent_stale", "stale_status"].includes(error.code),
  );
  if (blocking.length) throw new Error(blocking.map((error) => error.message).join("；"));
  const parent = furnitureGroups(occupancyResults).find((group) => group.id === instance.context.group_id);
  if (!parent) throw new Error("原家具组团已删除，不能接受父级更新");
  const token = fingerprint({ results: instance.results, parent: parent.fingerprint });
  if (instance.context.parent_fingerprint === parent.fingerprint && instance.context.review_status !== "stale")
    return { results, token };
  const next = results.map((result) =>
    context(result).instance_id === instanceId
      ? {
          ...result,
          meta: {
            ...result.meta,
            furniture_instance_context: {
              ...context(result),
              parent_fingerprint: parent.fingerprint,
              review_status: "pending",
              review_fingerprint: null,
            },
          },
        }
      : result,
  );
  const errors = validateFurnitureInstances(next, occupancyResults, { review: false }).filter(relevant);
  if (errors.length) throw new Error(errors.map((error) => error.message).join("；"));
  return { results: next, token };
}

export async function acceptFurnitureParentUpdate(item, instanceId) {
  const annotation = item.annotation;
  const reference = annotation.referenceVersion;
  const data = annotation.serializeAnnotation({ fast: true });
  const request = furnitureParentUpdate(data, data, instanceId);
  return applyFurnitureInstanceOperation(item, () => {
    const current = annotation.serializeAnnotation({ fast: true });
    if (
      item.annotation !== annotation ||
      annotation.referenceVersion !== reference ||
      item.furnitureInstanceEffectiveSelectedId !== instanceId ||
      furnitureParentUpdate(current, current, instanceId).token !== request.token
    )
      throw new Error("实例、选择或父级参考已变化，本次未接受更新；请重新检查");
    item.acceptFurnitureInstanceParentUpdate(instanceId, request.token);
    return "已接受原父组团更新并保存草稿；当前实例待复核，请检查后确认复核。";
  });
}
