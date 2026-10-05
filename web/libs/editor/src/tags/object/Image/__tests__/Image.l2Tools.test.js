import React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import fs from "fs";
import path from "path";
import { L2Controls } from "@hanning/frontend/components/rooms/L2Controls";
import { L2RegionCategory } from "@hanning/frontend/components/rooms/L2RegionCategory";
import { l2ToolbarTools, l2HiddenControl, l2HiddenHeader } from "@hanning/frontend/domain/rooms/l2Tools";
if (typeof globalThis.structuredClone === "undefined") {
  globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
}

jest.mock("keymaster", () => {
  const keymaster = () => {};
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});

import "../../../visual/View";
import "../../../visual/Header";
import "../Image";
import "../../../control/Label";
import "../../../control/Labels/Labels";
import "../../../control/RectangleLabels";
import "../../../control/PolygonLabels";
import "../../../control/VectorLabels";
import "../../../control/Rectangle";
import "../../../control/Polygon";
import "../../../control/Choices";
import AppStore from "../../../../stores/AppStore";

const environment = {
  events: {
    hasEvent: jest.fn(() => false),
    invoke: jest.fn(),
    invokeFirst: jest.fn(),
  },
  messages: {},
  settings: {},
};

const loadConfig = (name) =>
  fs.readFileSync(path.resolve(process.cwd(), "../examples/room-v3", name), { encoding: "utf-8" });

const createStore = (config) => {
  const store = AppStore.create(
    {
      config,
      task: { id: 1, data: JSON.stringify({ image: "https://example.com/floor-plan.png" }) },
      interfaces: ["basic"],
    },
    environment,
  );
  store.initializeStore({ annotations: [{ id: 1, result: [] }], predictions: [] });
  return store;
};

const config = () => loadConfig("function-zone-v3.xml");
const setup = (xml = config(), focused = true) => {
  const store = createStore(xml);
  const annotation = store.annotationStore.annotations[0];
  const image = annotation.names.get("image");
  image.currentImageEntity.setNaturalWidth(1000);
  image.currentImageEntity.setNaturalHeight(1000);
  annotation.deserializeAnnotation([
    {
      id: "room-a",
      from_name: "room_rectangle",
      to_name: "image",
      type: "rectanglelabels",
      readonly: true,
      original_width: 1000,
      original_height: 1000,
      value: { x: 0, y: 0, width: 90, height: 90, rotation: 0, rectanglelabels: ["Bedroom"] },
      meta: {
        room_graph_node: { schema_version: 3, node_id: "room-a", room_type: "Bedroom", geometry_type: "rectangle" },
      },
    },
  ]);
  if (focused) image.setFocusedRoom("room-a");
  const tools = image.getToolsManager().allTools();
  const tool = (name, type) =>
    tools.find((t) => t.control?.name === name && !t.dynamic && (!type || t.toolName === type));
  return { store, annotation, image, tools, tool };
};
afterEach(cleanup);

test("canonical L2 takes over labels and headings while retaining review and custom controls", () => {
  const { image, annotation, store } = setup();
  expect(image.l2ToolbarEnabled).toBe(true);
  expect(image.l1ToolbarEnabled).toBe(false);
  expect(store.config).toBe(config());
  for (const name of [
    "function_zone",
    "connection_vector",
    "visual_connection_vector",
    "portal_rectangle",
    "window_vector",
  ]) {
    expect(l2HiddenControl(annotation.names.get(name))).toBe(true);
  }
  expect(l2HiddenControl(annotation.names.get("connection_review"))).toBe(false);
  const headers = annotation.root.children.filter((c) => c.type === "header");
  expect(headers.length).toBe(4);
  expect(headers.every(l2HiddenHeader)).toBe(true);
});

test("zone category survives Rectangle/Polygon and family switches, without leaking into vectors", () => {
  const { image, annotation, tool, tools } = setup();
  image.selectL2Category("Sleeping");
  image.getToolsManager().selectTool(tool("zone_polygon", "PolygonTool"), true);
  expect(image.l2Selection).toEqual({ category: "Sleeping", shape: "polygon" });
  expect(annotation.names.get("function_zone").selectedValues()).toEqual(["Sleeping"]);
  image.selectL2Family("connection");
  image.selectL2Category("Door");
  expect(annotation.names.get("function_zone").selectedValues()).toEqual([]);
  expect(annotation.names.get("connection_vector").selectedValues()).toEqual(["Door"]);
  expect(
    l2ToolbarTools(tools, image)
      .filter((t) => t.isDrawingTool)
      .map((t) => t.control.name),
  ).toEqual(["connection_vector"]);
  image.selectL2Family("visual");
  image.selectL2Category("Visual only");
  expect(annotation.names.get("connection_vector").selectedValues()).toEqual([]);
  image.selectL2Family("zone");
  expect(image.l2Selection).toEqual({ category: "Sleeping", shape: "polygon" });
  expect(
    l2ToolbarTools(tools, image)
      .filter((t) => t.isDrawingTool)
      .map((t) => t.toolName)
      .sort(),
  ).toEqual(["PolygonTool", "RectangleTool"]);
});

test("requires category and focused room, rejects invalid shapes and all reference shortcuts", () => {
  const { image, annotation, tool } = setup(config(), false);
  expect(tool("zone_rectangle", "RectangleTool").canStartDrawing()).toBe(false);
  image.selectL2Category("Sleeping");
  expect(image.l2ToolBlockReason(tool("zone_rectangle", "RectangleTool"), true)).toContain("Focus room");
  expect(image.selectL2Category("Door")).toBe(false);
  expect(image.prepareL2Tool(tool("connection_vector"))).toBe(false);
  for (const name of image.l2Config.references) {
    annotation.names.get(name).children[0].onHotKey();
    expect(annotation.names.get(name).selectedValues()).toEqual([]);
  }
  image.setFocusedRoom("room-a");
  expect(image.l2ToolBlockReason(tool("zone_rectangle", "RectangleTool"), true)).toBe("");
  annotation.names.get("connection_vector").children[1].onHotKey();
  expect(image.l2Family).toBe("connection");
  expect(image.l2Selection.category).toBe("Door");
});

test("drawing, saving and read-only lock the dock, tools and focused room", () => {
  const { image, annotation, tool } = setup();
  render(<L2Controls item={image} />);
  fireEvent.change(screen.getByRole("combobox", { name: "L2 标注类型" }), { target: { value: "Sleeping" } });
  act(() => annotation.setIsDrawing(true));
  expect(screen.getByRole("combobox")).toBeDisabled();
  expect(screen.getByRole("button", { name: "视觉连通" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Esc");
  expect(image.selectL2Family("connection")).toBe(false);
  expect(image.prepareL2Tool(tool("zone_polygon", "PolygonTool"))).toBe(false);
  image.setFocusedRoom("");
  expect(image.focusedRoom.cleanId).toBe("room-a");
  act(() => annotation.setIsDrawing(false));
  act(() => annotation.submissionInProgress());
  expect(image.selectL2Category("Dining")).toBe(false);
  act(() => {
    annotation.submissionFinished();
    annotation.setReadonly(true);
  });
  expect(image.selectL2Category("Dining")).toBe(false);
  expect(tool("zone_rectangle", "RectangleTool").canStartDrawing()).toBe(false);
});

test("top selection leaves existing regions intact; properties can change the saved category", () => {
  const { image, annotation } = setup();
  annotation.deserializeAnnotation([
    {
      id: "zone-a",
      from_name: "zone_rectangle",
      to_name: "image",
      type: "rectangle",
      value: { x: 10, y: 10, width: 20, height: 20, rotation: 0 },
      meta: { custom: "keep" },
    },
    { id: "zone-a", from_name: "function_zone", to_name: "image", type: "labels", value: { labels: ["Sleeping"] } },
  ]);
  const region = image.regs.find((r) => r.cleanId === "zone-a");
  annotation.selectAreas([region]);
  const before = annotation.serializeAnnotation({ fast: true });
  image.selectL2Category("Dining");
  image.selectL2Family("connection");
  image.selectL2Category("Door");
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  render(<L2RegionCategory region={region} />);
  fireEvent.change(screen.getByRole("combobox", { name: "L2 当前区域类型" }), { target: { value: "Dining" } });
  const after = annotation.serializeAnnotation({ fast: true });
  expect(after.find((r) => r.from_name === "function_zone").value.labels).toEqual(["Dining"]);
  expect(after.find((r) => r.from_name === "zone_rectangle").value).toEqual(
    before.find((r) => r.from_name === "zone_rectangle").value,
  );
  expect(after.find((r) => r.from_name === "zone_rectangle").meta.custom).toBe("keep");
});

test("drawn zone serializes separate geometry and category results, and reloads unchanged", () => {
  const { image, annotation, tool } = setup();
  image.selectL2Category("Sleeping");
  const rectangle = tool("zone_rectangle", "RectangleTool");
  const draft = rectangle.createDrawingRegion({ x: 10, y: 10, width: 20, height: 20, rotation: 0 });
  const result = draft.results.map((r) => ({ name: r.from_name.name, value: r.mainValue }));
  expect(result).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "zone_rectangle" }),
      { name: "function_zone", value: ["Sleeping"] },
    ]),
  );
  expect(result).toHaveLength(2);
  rectangle.commitDrawingRegion();
  annotation.setIsDrawing(false);
  const serialized = annotation.serializeAnnotation();
  expect(serialized.filter((r) => r.from_name === "function_zone")).toHaveLength(1);
  const reloaded = createStore(config()).annotationStore.annotations[0];
  reloaded.names.get("image").currentImageEntity.setNaturalWidth(1000);
  reloaded.names.get("image").currentImageEntity.setNaturalHeight(1000);
  reloaded.deserializeAnnotation(serialized);
  expect(reloaded.serializeAnnotation()).toEqual(serialized);
});

test("V selects Move without changing type and preserves choices across submit but resets on task change", () => {
  const { image, store } = setup();
  render(<L2Controls item={image} />);
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "Sleeping" } });
  fireEvent.keyDown(document.body, { key: "v" });
  fireEvent.keyDown(document.body, { key: "v", repeat: true });
  expect(image.getToolsManager().findSelectedTool().toolName).toBe("MoveTool");
  expect(image.l2Selection.category).toBe("Sleeping");
  cleanup();
  store.initializeStore({ annotations: [{ id: 2, result: [] }], predictions: [] });
  const replacement = store.annotationStore.annotations[0].names.get("image");
  replacement.initializeL2Tools();
  expect(replacement.l2Selection.category).toBe("Sleeping");
  expect(replacement.annotation.names.get("function_zone").selectedValues()).toEqual(["Sleeping"]);
  store.assignTask({ id: 2, data: { image: "https://example.com/next.png" } });
  replacement.initializeL2Tools();
  expect(replacement.l2Selection.category).toBe("");
});

test.each([
  config().replace('<Labels name="function_zone"', '<Labels choice="multiple" name="function_zone"'),
  config().replace("</View>", '<Labels name="extra" toName="image"><Label value="custom" /></Labels></View>'),
  fs.readFileSync(path.resolve(process.cwd(), "../examples/room-window-annotation/room-window-v1.xml"), "utf8"),
])("unsupported configurations retain original controls", (xml) => {
  const { image, annotation, tools } = setup(xml, false);
  expect(image.l2ToolbarEnabled).toBe(false);
  expect(l2ToolbarTools(tools, image)).toBe(tools);
  expect(l2HiddenControl(annotation.names.get("function_zone") || {})).toBe(false);
});

test("Escape cancels a zone polygon without removing its readonly parent", () => {
  const { image, annotation, tool } = setup();
  render(<L2Controls item={image} />);
  act(() => image.selectL2Category("Sleeping"));
  const before = annotation.serializeAnnotation();
  act(() => {
    const polygon = tool("zone_polygon", "PolygonTool");
    image.getToolsManager().selectTool(polygon, true);
    polygon.startDrawing(10, 10);
    polygon.listenForClose();
  });
  expect(annotation.isDrawing).toBe(true);
  fireEvent.keyDown(document, { key: "Escape" });
  expect(annotation.isDrawing).toBe(false);
  expect(annotation.serializeAnnotation()).toEqual(before);
  expect(image.l2Selection).toEqual({ category: "Sleeping", shape: "polygon" });
  expect(screen.getByRole("combobox")).not.toBeDisabled();
});

test.each([["connection", "Door", "connection_vector"], ["visual", "Visual only", "visual_connection_vector"]])(
  "%s Vector keeps only its own label and Enter finishes the drawing",
  (family, category, name) => {
    const { image, annotation, tool } = setup();
    render(<L2Controls item={image} />);
    act(() => {
      image.selectL2Category("Sleeping");
      image.selectL2Family(family);
      image.selectL2Category(category);
      const vector = tool(name);
      vector.startDrawing(10, 10);
      vector.currentArea.updatePointsFromKonvaVector([{ x: 100, y: 100 }, { x: 200, y: 200 }]);
    });
    expect(annotation.isDrawing).toBe(true);
    fireEvent.keyDown(document, { key: "Enter" });
    expect(annotation.isDrawing).toBe(false);
    const results = annotation.serializeAnnotation().filter((r) => !r.readonly);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ from_name: name, type: "vectorlabels", value: { vectorlabels: [category] } });
    expect(screen.getByRole("combobox")).not.toBeDisabled();
  },
);

test("measures the enclosing sticky dock and follows wrapping and review-panel changes", () => {
  const { image } = setup();
  const originalObserver = global.ResizeObserver;
  const disconnect = jest.fn();
  let resized;
  global.ResizeObserver = jest.fn((callback) => {
    resized = callback;
    return { observe: jest.fn(), disconnect };
  });
  const bounds = jest.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ height: 215.5 });
  const onDockResize = jest.fn();
  try {
    const view = render(<div><L2Controls item={image} onDockResize={onDockResize} /></div>);
    expect(onDockResize).toHaveBeenLastCalledWith(216);
    bounds.mockReturnValue({ height: 320 });
    act(() => resized());
    expect(onDockResize).toHaveBeenLastCalledWith(320);
    view.unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
  } finally {
    bounds.mockRestore();
    global.ResizeObserver = originalObserver;
  }
});
