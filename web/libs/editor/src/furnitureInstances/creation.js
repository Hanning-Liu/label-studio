import { baseContext, CONTROLS, furnitureGroups, furnitureInstances, resultsForGeometry } from "./domain";
import { equivalent, fingerprint } from "../occupancy/geometry";
import { validateFurnitureInstances } from "./constraints";
import { applyFurnitureInstanceOperation } from "./operations";

export function groupCreationState(results, groupId, type) {
  const group = furnitureGroups(results).find((g) => g.id === groupId);
  if (!group) throw new Error("请选择有效家具组团");
  const duplicate = furnitureInstances(results).find(
    (i) => i.context.group_id === groupId && i.context.instance_type === type && equivalent(i.geometry, group.geometry),
  );
  return {
    group,
    duplicate,
    token: fingerprint({
      group: group.fingerprint,
      type,
      source: group.parts.map((r) => ({ id: r.id, control: r.from_name, value: r.value, meta: r.meta })),
    }),
  };
}

export function groupInstanceResults(results, groupId, type, sourceVersion, note = "") {
  const { group, duplicate } = groupCreationState(results, groupId, type);
  if (duplicate) throw new Error(`本组已有同类别、同轮廓实例 ${duplicate.id}，请定位后编辑`);
  const value = baseContext(group, sourceVersion, type, note);
  const preserve = group.parts.map((part) => ({
    ...part,
    from_name: part.from_name === "occupancy_rectangle" ? CONTROLS.rectangle : CONTROLS.polygon,
  }));
  const created = resultsForGeometry(group.geometry, type, value, group.parts[0], undefined, preserve);
  const errors = validateFurnitureInstances([...results, ...created], results, { review: false }).filter(
    (e) => !e.instanceId || e.instanceId === value.instance_id,
  );
  if (errors.length) throw new Error(errors.map((e) => e.message).join("；"));
  return { results: created, id: value.instance_id };
}

export async function createGroupInstance(item, type, isCurrent = () => true) {
  const annotation = item.annotation,
    groupId = item.furnitureInstanceFocusId,
    version = annotation.referenceVersion;
  const request = groupCreationState(item.furnitureInstanceData, groupId, type);
  let createdId;
  await applyFurnitureInstanceOperation(item, () => {
    if (
      item.annotation !== annotation ||
      annotation.referenceVersion !== version ||
      item.furnitureInstanceFocusId !== groupId ||
      !isCurrent() ||
      groupCreationState(item.furnitureInstanceData, groupId, type).token !== request.token
    )
      throw new Error("组团、类别或来源已变化，本次未创建");
    createdId = item.createFurnitureInstanceFromGroup(groupId, type, request.token);
    return createdId;
  });
  return createdId;
}
