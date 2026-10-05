import { getParent, hasParent, isStateTreeNode } from "mobx-state-tree";
import { l1Entries, l1LabelKey, l1ToolShape } from "./l1Tools";

export const L2_FAMILIES = [
  ["zone", "功能分区"],
  ["connection", "交通连通"],
  ["visual", "视觉连通"],
];

// The separate Labels result on a zone is part of the existing L2 contract.
// Keep it registered and activate it together with Rectangle/Polygon.
export function l2Configuration(image) {
  if (
    !image.functionzonev3validate ||
    !image.wholeRoomInheritanceEnabled ||
    image.occupancyEnabled ||
    image.furnitureInstancesEnabled
  )
    return null;
  const byName = image.annotation?.names;
  if (!byName) return null;
  const zoneLabels = byName.get("function_zone");
  const validLabels = (control) =>
    control?.toname === image.name &&
    control.choice === "single" &&
    !control.allowempty &&
    !control.value &&
    control.children?.length &&
    control.children.every((label) => label.type === "label" && label.value) &&
    new Set(control.children.map(l1LabelKey)).size === control.children.length;
  if (zoneLabels?.type !== "labels" || !validLabels(zoneLabels)) return null;
  const controls = [];
  for (const name of image.functionZoneControlNames) {
    const control = byName.get(name);
    if (
      !control ||
      control.toname !== image.name ||
      !["rectangle", "polygon"].includes(control.type) ||
      !control.constrainto ||
      controls.some((entry) => entry.shape === control.type)
    )
      return null;
    controls.push({
      name,
      family: "zone",
      shape: control.type,
      control,
      labelControl: zoneLabels,
      labels: zoneLabels.children,
    });
  }
  if (!controls.length) return null;
  for (const name of image.connectionVectorControlNames) {
    const control = byName.get(name);
    if (control?.type !== "vectorlabels" || !validLabels(control)) return null;
    const family = control.children.every((label) => label.value === "Visual only") ? "visual" : "connection";
    if (
      family === "connection" &&
      control.children.some((label) => !["Open passage", "Door", "Sliding door"].includes(label.value))
    )
      return null;
    if (controls.some((entry) => entry.family === family)) return null;
    controls.push({ name, family, shape: "vector", control, labelControl: control, labels: control.children });
  }
  const references = [
    ...new Set([
      ...image.roomControlNames,
      ...image.openingControlNames,
      ...image.roomV3ReferenceControlNames,
      ...image.windowControlNames,
    ]),
  ].filter((name) => byName.has(name));
  const managed = new Set([zoneLabels.name, ...controls.map((entry) => entry.name), ...references]);
  for (const control of byName.values()) {
    if (
      control.toname === image.name &&
      /^(labels|(rectangle|polygon|vector|ellipse|brush|keypoint)(labels)?)$/.test(control.type) &&
      !managed.has(control.name)
    )
      return null;
  }
  return { controls, references, managed };
}

export function l2ToolbarTools(tools, image) {
  if (!image.l2ToolbarEnabled) return tools;
  const entries = l1Entries(image.l2Config, image.l2Family, image.l2Selection.category);
  return tools.filter(
    (tool) =>
      !tool.isDrawingTool ||
      entries.some((entry) => entry.name === tool.control?.name && entry.shape === l1ToolShape(tool)),
  );
}

export function l2HiddenControl(control) {
  return Boolean(control.annotation?.names?.get(control.toname)?.l2Config?.managed.has(control.name));
}

export function l2HiddenHeader(header) {
  if (!isStateTreeNode(header) || !hasParent(header)) return false;
  const siblings = getParent(header);
  return Array.isArray(siblings) && Boolean(l2HiddenControl(siblings[siblings.indexOf(header) + 1] || {}));
}
