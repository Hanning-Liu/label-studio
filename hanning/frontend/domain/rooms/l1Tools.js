import { getParent, hasParent, isStateTreeNode } from "mobx-state-tree";

export const L1_SHAPES = { rectangle: "Rectangle", polygon: "Polygon", vector: "Vector" };
const TOOL_SHAPES = { RectangleTool: "rectangle", PolygonTool: "polygon", VectorTool: "vector" };
const CONTROL_SHAPES = { rectanglelabels: "rectangle", polygonlabels: "polygon", vectorlabels: "vector" };
const names = (value) =>
  String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
export const l1LabelKey = (label) => label.alias || label.value;
export const l1ToolShape = (tool) => !tool.dynamic && TOOL_SHAPES[tool.toolName];

// Only take over configurations whose drawing controls we can represent without
// dropping labels, multi-label semantics, or unrelated custom drawing controls.
export function l1Configuration(image) {
  if (
    !image.roomv3validate ||
    image.functionzonev3validate ||
    image.occupancyEnabled ||
    image.furnitureInstancesEnabled ||
    image.wholeRoomInheritanceEnabled
  )
    return null;
  const groups = [
    ["room", names(image.roomv3controls), ["rectangle", "polygon"]],
    [
      "opening",
      [...names(image.portalrectanglecontrols), ...names(image.portalvectorcontrols)],
      ["rectangle", "vector"],
    ],
    ["window", image.windowEnabled ? names(image.windowcontrols) : [], ["vector"]],
  ];
  const controls = [];
  for (const [family, configured, shapes] of groups) {
    for (const name of configured) {
      const control = image.annotation?.names?.get(name);
      const shape = CONTROL_SHAPES[control?.type];
      if (
        !control ||
        control.toname !== image.name ||
        !shapes.includes(shape) ||
        control.choice !== "single" ||
        control.allowempty ||
        control.value
      )
        return null;
      const labels = Array.from(control.children || []);
      if (!labels.length || labels.some((label) => label.type !== "label" || !label.value)) return null;
      if (
        family === "opening" &&
        labels.some(
          (label) =>
            !(shape === "vector" ? ["Open passage"] : ["Door", "Sliding door", "Open passage"]).includes(label.value),
        )
      )
        return null;
      if (family === "window" && labels.some((label) => label.value !== "Window")) return null;
      if (new Set(labels.map(l1LabelKey)).size !== labels.length) return null;
      if (controls.some((entry) => entry.family === family && entry.shape === shape)) return null;
      controls.push({ name, family, shape, control, labels });
    }
  }
  if (!controls.some((entry) => entry.family === "room")) return null;
  const references = names(image.roomv3referencecontrols).filter((name) => image.annotation.names.has(name));
  const managed = new Set([...controls.map((entry) => entry.name), ...references]);
  for (const control of image.annotation.names.values()) {
    if (
      control.toname === image.name &&
      /^(rectangle|polygon|vector|ellipse|brush|keypoint)(labels)?$/.test(control.type) &&
      !managed.has(control.name)
    )
      return null;
  }
  return { controls, references, managed };
}

export function l1Categories(config, family) {
  const unique = new Map();
  for (const entry of config?.controls || []) {
    if (entry.family !== family) continue;
    for (const label of entry.labels) {
      const key = l1LabelKey(label);
      if (!unique.has(key)) unique.set(key, { key, title: label.showalias && label.alias ? label.alias : label.value });
    }
  }
  return [...unique.values()];
}

export function l1Entries(config, family, category) {
  return (config?.controls || []).filter(
    (entry) => entry.family === family && (!category || entry.labels.some((label) => l1LabelKey(label) === category)),
  );
}

export function l1ToolbarTools(tools, image) {
  if (!image.l1ToolbarEnabled) return tools;
  const entries = l1Entries(image.l1Config, image.l1Family, image.l1Selection.category);
  return tools.filter(
    (tool) =>
      !tool.isDrawingTool ||
      entries.some((entry) => entry.name === tool.control?.name && entry.shape === l1ToolShape(tool)),
  );
}

export function l1HiddenControl(control) {
  const image = control.annotation?.names?.get(control.toname);
  return Boolean(image?.l1Config?.managed.has(control.name));
}

// Associate only an immediately preceding section heading with its managed
// control. Do not remove free text, unrelated headers, or enclosing Views.
export function l1HiddenHeader(header) {
  if (!isStateTreeNode(header) || !hasParent(header)) return false;
  const siblings = getParent(header);
  if (!Array.isArray(siblings)) return false;
  const next = siblings[siblings.indexOf(header) + 1];
  return Boolean(next && l1HiddenControl(next));
}
