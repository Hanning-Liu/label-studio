import { useState } from "react";
import { Modal } from "antd";

import { GROUP_TYPES } from "../occupancy/domain";
import { focusOccupancy } from "../occupancy/focus";
import { FURNITURE_TYPES } from "./domain";
import { shortFurnitureId } from "./presentation";

export function furnitureInstanceValidationItems(item, errors) {
  const instances = new Map(item.furnitureInstanceLogicals.map((instance) => [instance.id, instance]));
  const parents = new Map(item.furnitureInstanceParents.map((parent) => [parent.id, parent]));
  const grouped = new Map();

  for (const error of errors) {
    const id = error.instanceId || "";
    const key = id || `global:${error.code}:${error.objectId || ""}`;
    if (!grouped.has(key)) grouped.set(key, { instanceId: id, messages: [] });
    const group = grouped.get(key);
    if (!group.messages.includes(error.message)) group.messages.push(error.message);
  }

  return [...grouped.values()].map((group) => {
    const instance = instances.get(group.instanceId);
    const parent = parents.get(instance?.context.group_id);
    return {
      ...group,
      instance,
      category: instance
        ? FURNITURE_TYPES[instance.context.instance_type] || instance.context.instance_type
        : "任务级问题",
      shortId: instance ? shortFurnitureId(instance.id) : "—",
      parent: parent
        ? `${GROUP_TYPES[parent.groupType] || parent.groupType || "家具组团"}${parent.groupNote ? ` · ${parent.groupNote}` : ""}`
        : instance
          ? `原组团 ${shortFurnitureId(instance.context.group_id)} 不可用`
          : "不适用",
    };
  });
}

export async function locateFurnitureInstanceValidation(item, instanceId) {
  const instance = item.furnitureInstanceLogicals.find((candidate) => candidate.id === instanceId);
  if (!instance) throw new Error("待定位的家具实例已不存在；请关闭提示后重新检查任务。");
  item.selectFurnitureInstance(instance.id);
  await focusOccupancy(item, instance.geometry);
  return instance;
}

const ValidationContent = ({ items, onLocate }) => {
  const [error, setError] = useState("");
  return (
    <section aria-label="L4 家具实例提交问题">
      <p>提交前需要处理下列实例；未复核实例可能位于当前 Focus 以外的家具组团。</p>
      <ul>
        {items.map((item) => (
          <li key={item.instanceId || item.messages.join("\u0000")}>
            <strong>
              {item.category} · {item.shortId} · {item.parent}
            </strong>
            <ul>
              {item.messages.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            {item.instanceId && (
              <button
                type="button"
                onClick={async () => {
                  try {
                    await onLocate(item.instanceId);
                    setError("");
                  } catch (cause) {
                    setError(cause.message || "无法定位该家具实例");
                  }
                }}
              >
                定位并选择该实例
              </button>
            )}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
    </section>
  );
};

export function showFurnitureInstanceValidationWarning(item, errors) {
  const items = furnitureInstanceValidationItems(item, errors);
  let modal;
  const locate = async (instanceId) => {
    await locateFurnitureInstanceValidation(item, instanceId);
    modal?.destroy();
  };
  modal = Modal.warning({
    title: `L4 家具实例校验未通过（${errors.length} 项）`,
    content: <ValidationContent items={items} onLocate={locate} />,
    okText: "关闭",
    width: 680,
  });
  return modal;
}
