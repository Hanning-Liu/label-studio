import React from "react";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import { L1Controls } from "@hanning/frontend/components/rooms/L1Controls";
import fs from "fs";
import path from "path";
import { l1Categories, l1ToolbarTools, l1HiddenControl, l1HiddenHeader } from "@hanning/frontend/domain/rooms/l1Tools";

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

const config = () =>
  fs.readFileSync(path.resolve(process.cwd(), "../examples/room-window-annotation/room-window-v1.xml"), "utf8");
const setup = (xml = config()) => {
  const store = createStore(xml);
  const annotation = store.annotationStore.annotations[0];
  const image = annotation.names.get("image");
  return { store, annotation, image, tools: image.getToolsManager().allTools() };
};

describe("L1 tool dock", () => {
  afterEach(cleanup);
  test("recognizes current template without changing the stored configuration", () => {
    const { image, annotation, store } = setup();
    expect(image.l1ToolbarEnabled).toBe(true);
    expect(image.l1Selection).toEqual({ category: "", shape: "rectangle" });
    expect(l1Categories(image.l1Config, "room")).toHaveLength(18);
    expect(image.l1Config.references).toEqual(["portal_v2_reference"]);
    expect(l1HiddenControl(annotation.names.get("room_rectangle"))).toBe(true);
    expect(store.config).toBe(config());
  });

  test("category stays selected across rectangle/polygon and family switches", () => {
    const { image, tools } = setup();
    expect(image.selectL1Category("Bedroom")).toBe(true);
    const polygon = tools.find((t) => t.control?.name === "room_polygon" && t.toolName === "PolygonTool" && !t.dynamic);
    image.getToolsManager().selectTool(polygon, true);
    expect(image.l1Selection).toEqual({ category: "Bedroom", shape: "polygon" });
    expect(polygon.control.selectedValues()).toEqual(["Bedroom"]);
    image.selectL1Family("opening");
    image.selectL1Category("Door");
    expect(image.l1Selection.shape).toBe("rectangle");
    image.selectL1Family("room");
    expect(image.l1Selection).toEqual({ category: "Bedroom", shape: "polygon" });
    image.resetL1Tools();
    expect(image.l1Selection.category).toBe("");
  });

  test("submission rebuild retains task choices, and changing tasks clears them", () => {
    const { image, tools, store } = setup();
    image.initializeL1Tools();
    image.selectL1Category("Bedroom");
    image.getToolsManager().selectTool(
      tools.find((t) => t.control?.name === "room_polygon" && t.toolName === "PolygonTool" && !t.dynamic),
      true,
    );
    image.selectL1Family("window");
    image.selectL1Category("Window");
    store.initializeStore({ annotations: [{ id: 2, result: [] }], predictions: [] });
    const replacement = store.annotationStore.annotations[0].names.get("image");
    replacement.initializeL1Tools();
    expect(replacement.l1Family).toBe("window");
    expect(replacement.l1Selection).toEqual({ category: "Window", shape: "vector" });
    replacement.selectL1Family("room");
    expect(replacement.l1Selection).toEqual({ category: "Bedroom", shape: "polygon" });
    store.assignTask({ id: 2, data: { image: "https://example.com/next.png" } });
    replacement.initializeL1Tools();
    expect(replacement.l1Family).toBe("room");
    expect(replacement.l1Selection).toEqual({ category: "", shape: "rectangle" });
  });

  test("toolbar filters references and illegal shapes; empty category blocks drawing", () => {
    const { image, tools } = setup();
    const drawing = () => l1ToolbarTools(tools, image).filter((t) => t.isDrawingTool);
    expect(
      drawing()
        .map((t) => t.toolName)
        .sort(),
    ).toEqual(["PolygonTool", "RectangleTool"]);
    expect(drawing().every((t) => image.l1ToolBlockReason(t))).toBe(true);
    image.selectL1Family("opening");
    image.selectL1Category("Door");
    expect(drawing().map((t) => t.toolName)).toEqual(["RectangleTool"]);
    image.selectL1Category("Open passage");
    expect(
      drawing()
        .map((t) => t.toolName)
        .sort(),
    ).toEqual(["RectangleTool", "VectorTool"]);
    const vector = drawing().find((t) => t.toolName === "VectorTool");
    image.getToolsManager().selectTool(vector, true);
    image.selectL1Category("Door");
    expect(image.l1Selection.shape).toBe("rectangle");
    image.selectL1Family("window");
    image.selectL1Category("Window");
    expect(drawing().map((t) => t.control.name)).toEqual(["window_vector"]);
    expect(image.selectL1Category("unknown")).toBe(false);
  });

  test("drawing and read-only states protect selection", () => {
    const { image, annotation, tools } = setup();
    image.selectL1Category("Bedroom");
    annotation.setIsDrawing(true);
    expect(image.selectL1Family("window")).toBe(false);
    expect(image.selectL1Category("Kitchen")).toBe(false);
    expect(image.prepareL1Tool(tools.find((t) => t.toolName === "PolygonTool" && !t.dynamic))).toBe(false);
    annotation.setIsDrawing(false);
    const readonly = jest.spyOn(annotation, "isReadOnly").mockReturnValue(true);
    expect(image.selectL1Category("Kitchen")).toBe(false);
    readonly.mockRestore();
  });

  test("shortcuts use the same selection state and reference shortcuts stay disabled", () => {
    const { image, annotation } = setup();
    annotation.names.get("room_polygon").children[0].onHotKey();
    expect(image.l1Selection).toEqual({ category: "Bedroom", shape: "polygon" });
    annotation.names.get("portal_v2_reference").children[0].onHotKey();
    expect(image.l1Family).toBe("room");
    expect(annotation.names.get("portal_v2_reference").selectedValues()).toEqual([]);
  });

  test("V selects Move once after drawing, preserving the category and saved result", () => {
    const { image, annotation } = setup();
    const view = render(<L1Controls item={image} />);
    fireEvent.change(screen.getByRole("combobox", { name: "L1 标注类型" }), { target: { value: "Bedroom" } });
    act(() => annotation.deserializeAnnotation([{ id: "v-room", from_name: "room_rectangle", to_name: "image",
      type: "rectanglelabels", value: { x: 10, y: 10, width: 20, height: 20, rotation: 0, rectanglelabels: ["Bedroom"] } }]));
    const before = JSON.stringify(annotation.serializeAnnotation());
    const legacy = jest.fn();
    document.addEventListener("keydown", legacy);
    try {
      fireEvent.keyDown(document.body, { key: "v" });
      expect(image.getToolsManager().findSelectedTool().toolName).toBe("MoveTool");
      expect(screen.getByText(/当前工具：移动／选择/)).toBeTruthy();
      fireEvent.keyDown(document.body, { key: "v", repeat: true });
      expect(image.getToolsManager().findSelectedTool().toolName).toBe("MoveTool");
      expect(image.l1Selection).toEqual({ category: "Bedroom", shape: "rectangle" });
      expect(JSON.stringify(annotation.serializeAnnotation())).toBe(before);
      expect(legacy).not.toHaveBeenCalled();
      view.unmount();
      fireEvent.keyDown(document.body, { key: "v" });
      expect(legacy).toHaveBeenCalledTimes(1);
    } finally {
      document.removeEventListener("keydown", legacy);
    }
  });

  test("V does not interrupt a drawing or activate a read-only editor", () => {
    const { image, annotation } = setup();
    render(<L1Controls item={image} />);
    act(() => image.selectL1Category("Bedroom"));
    const selected = image.getToolsManager().findSelectedTool();
    act(() => annotation.setIsDrawing(true));
    fireEvent.keyDown(document.body, { key: "v" });
    expect(image.getToolsManager().findSelectedTool()).toBe(selected);
    act(() => annotation.setIsDrawing(false));
    act(() => annotation.setReadonly(true));
    fireEvent.keyDown(document.body, { key: "v" });
    expect(image.getToolsManager().findSelectedTool().toolName).toBe(selected.toolName);
  });

  test("V respects input focus, IME and modified shortcuts", () => {
    const { image } = setup();
    render(<><L1Controls item={image} /><input aria-label="notes" /><div role="dialog"><button>dialog action</button></div></>);
    act(() => image.selectL1Category("Bedroom"));
    const selected = image.getToolsManager().findSelectedTool();
    for (const target of [screen.getByRole("combobox"), screen.getByRole("textbox"), screen.getByRole("button", { name: "dialog action" })]) {
      fireEvent.keyDown(target, { key: "v" });
      expect(image.getToolsManager().findSelectedTool()).toBe(selected);
    }
    for (const modifier of ["metaKey", "ctrlKey", "altKey", "shiftKey", "isComposing"]) {
      fireEvent.keyDown(document.body, { key: "v", [modifier]: true });
      expect(image.getToolsManager().findSelectedTool()).toBe(selected);
    }
  });

  test("changing pending type preserves existing result geometry, metadata and label", () => {
    const { image, annotation } = setup();
    annotation.deserializeAnnotation([
      {
        id: "existing-room",
        from_name: "room_rectangle",
        to_name: "image",
        type: "rectanglelabels",
        original_width: 693,
        original_height: 1000,
        image_rotation: 0,
        value: { x: 10, y: 10, width: 20, height: 20, rotation: 0, rectanglelabels: ["Bedroom"] },
        meta: { room_graph_node: { schema_version: 3, node_id: "existing-room", room_type: "Bedroom" } },
      },
    ]);
    annotation.selectAreas(Array.from(annotation.areas.values()));
    expect(annotation.selectionSize).toBe(1);
    const before = annotation.serializeAnnotation({ fast: true });
    image.selectL1Category("Kitchen");
    image.selectL1Family("window");
    image.selectL1Category("Window");
    expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
    const region = Array.from(annotation.areas.values())[0];
    expect(image.setL1RegionCategory(region, "Kitchen")).toBe(true);
    const edited = annotation.serializeAnnotation({ fast: true });
    expect(edited[0].value.rectanglelabels).toEqual(["Kitchen"]);
    expect(edited[0].id).toBe(before[0].id);
    expect(edited[0].value.x).toBe(before[0].value.x);
    expect(image.l1Selection.category).toBe("Window");
  });

  test("only headers directly associated with managed controls disappear", () => {
    const { annotation } = setup();
    const managed = annotation.names.get("room_rectangle");
    const { getParent } = require("mobx-state-tree");
    const siblings = getParent(managed);
    expect(l1HiddenHeader(siblings[siblings.indexOf(managed) - 1])).toBe(true);
  });

  test.each([
    (xml) => xml.replace('roomV3Validate="true"', 'roomV3Validate="false"'),
    (xml) => xml.replace('<Label value="Window"', '<Label value="Custom window"'),
    (xml) => xml.replace('name="room_polygon"', 'name="unrecognized_polygon"'),
    (xml) => xml.replace('name="room_rectangle"', 'choice="multiple" name="room_rectangle"'),
  ])("unrecognized configurations keep their original panels and toolbar", (modify) => {
    const { image, annotation, tools } = setup(modify(config()));
    expect(image.l1ToolbarEnabled).toBe(false);
    expect(l1ToolbarTools(tools, image)).toBe(tools);
    expect(l1HiddenControl(annotation.names.get("room_rectangle"))).toBe(false);
  });

  test("compact dropdown, drawing lock, and task reset are rendered together", () => {
    const first = setup();
    const view = render(<L1Controls item={first.image} />);
    const select = screen.getByRole("combobox", { name: "L1 标注类型" });
    expect(select.value).toBe("");
    fireEvent.change(select, { target: { value: "Bedroom" } });
    expect(first.image.l1Selection.category).toBe("Bedroom");
    fireEvent.click(screen.getByRole("button", { name: "门与通道" }));
    fireEvent.change(select, { target: { value: "Open passage" } });
    expect(screen.getByRole("status").textContent).toContain("有墙体进深");
    act(() => first.annotation.setIsDrawing(true));
    expect(select.disabled).toBe(true);
    expect(screen.getByRole("button", { name: "窗" }).disabled).toBe(true);
    expect(screen.getByRole("status").textContent).toContain("Esc");
    act(() => first.annotation.setIsDrawing(false));
    const second = setup();
    view.rerender(<L1Controls item={second.image} />);
    expect(select.value).toBe("");
    expect(screen.getByRole("button", { name: "房间" }).getAttribute("aria-pressed")).toBe("true");
  });

  test("category present on only one shape falls back to the available tool", () => {
    const { image, tools } = setup(
      config().replace(
        '<Label value="Bedroom" background="#FFA39E" />',
        '<Label value="Custom room" background="#FFA39E" />',
      ),
    );
    image.selectL1Category("Kitchen");
    image.getToolsManager().selectTool(
      tools.find((t) => t.control?.name === "room_polygon" && t.toolName === "PolygonTool" && !t.dynamic),
      true,
    );
    image.selectL1Category("Custom room");
    expect(image.l1Selection).toEqual({ category: "Custom room", shape: "rectangle" });
    expect(
      l1ToolbarTools(tools, image)
        .filter((t) => t.isDrawingTool)
        .map((t) => t.toolName),
    ).toEqual(["RectangleTool"]);
  });

  test("unrelated headings and controls remain visible", () => {
    const { annotation } = setup(
      config().replace(
        "<View>",
        '<View><Header name="custom_instructions" value="Custom instructions"/><Choices name="custom_choice" toName="image"><Choice value="Yes"/></Choices>',
      ),
    );
    expect(l1HiddenHeader(annotation.names.get("custom_instructions"))).toBe(false);
    expect(l1HiddenControl(annotation.names.get("custom_choice"))).toBe(false);
  });

  test("Escape cancels only the in-progress polygon and restores the dock", () => {
    const { image, annotation, tools } = setup();
    render(<L1Controls item={image} />);
    act(() => image.selectL1Category("Bedroom"));
    const polygon = tools.find((t) => t.toolName === "PolygonTool" && t.control?.name === "room_polygon" && !t.dynamic);
    act(() => {
      image.getToolsManager().selectTool(polygon, true);
      polygon.startDrawing(10, 10);
      polygon.listenForClose();
    });
    expect(annotation.isDrawing).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(annotation.isDrawing).toBe(false);
    expect(annotation.areas.size).toBe(0);
    expect(image.l1Selection).toEqual({ category: "Bedroom", shape: "polygon" });
    expect(screen.getByRole("combobox").disabled).toBe(false);
  });

  test("active L1 drawing can start on a room boundary without selecting the room", () => {
    const { image, tools } = setup();
    const rectangle = tools.find(
      (t) => t.control?.name === "room_rectangle" && t.toolName === "RectangleTool" && !t.dynamic,
    );
    expect(rectangle.shouldSkipInteractions({ evt: {} })).toBe(false);
    image.selectL1Category("Bedroom");
    expect(rectangle.shouldSkipInteractions({ evt: {} })).toBe(true);
    image.selectL1Family("opening");
    image.selectL1Category("Open passage");
    const vector = tools.find((t) => t.control?.name === "portal_vector");
    image.getToolsManager().selectTool(vector, true);
    expect(vector.shouldSkipInteractions({ evt: {} })).toBe(true);
    const area = vector.createRegion(vector.createRegionOptions(), true);
    area.setDrawing(true);
    image.setSkipInteractions(true);
    expect(image.getSkipInteractions()).toBe(true);
    expect(image.getSkipInteractions(area)).toBe(false);
    expect(tools.find((t) => t.toolName === "MoveTool").shouldSkipInteractions({ evt: {} })).toBe(false);
  });

  test("L2 template keeps its existing UI", () => {
    expect(setup(loadConfig("function-zone-v3.xml")).image.l1ToolbarEnabled).toBe(false);
  });
});
