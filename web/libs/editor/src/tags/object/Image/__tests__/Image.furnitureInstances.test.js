import { TextEncoder } from "util";
import { createElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import keymaster from "keymaster";
import { NodeViews } from "../../../../components/Node/Node";
import { cn } from "../../../../utils/bem";

import { confirmFurnitureInstances, orientationForInstance } from "../../../../furnitureInstances/constraints";
import { CONTROLS, context, controlName } from "../../../../furnitureInstances/domain";
import { groupCreationState } from "../../../../furnitureInstances/creation";
import {
  makeInstance,
  makeOccupancy,
  resetIds,
  SOURCE,
  square,
  stampProvenance,
} from "../../../../furnitureInstances/__tests__/helpers";
import {
  furnitureInstanceToolbarTools,
  partitionFurnitureReferenceRegions,
} from "../../../../furnitureInstances/referenceDisplay";

global.TextEncoder = TextEncoder;
if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

jest.mock("keymaster", () => {
  const keymaster = jest.fn();
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});

import "../../../visual/View";
import "../Image";
import "../../../control/Label";
import "../../../control/Labels/Labels";
import "../../../control/RectangleLabels";
import "../../../control/PolygonLabels";
import "../../../control/Rectangle";
import "../../../control/Polygon";
import "../../../control/VectorLabels";
import "../../../control/Choices";
import "../../../control/Choice";
import AppStore from "../../../../stores/AppStore";
import ToolsManager from "../../../../tools/Manager";

const CONFIG = `<View>
  <Image name="image" value="$image" furnitureInstancesV1="true" />
  <RectangleLabels name="room_rectangle" toName="image"><Label value="Study" /></RectangleLabels>
  <PolygonLabels name="room_polygon" toName="image"><Label value="Study" /></PolygonLabels>
  <Rectangle name="zone_rectangle" toName="image" />
  <Polygon name="zone_polygon" toName="image" />
  <Labels name="function_zone" toName="image"><Label value="Study/work" /></Labels>
  <Rectangle name="occupancy_rectangle" toName="image" />
  <Polygon name="occupancy_polygon" toName="image" />
  <Labels name="occupancy_type" toName="image"><Label value="furniture_group" /></Labels>
  <VectorLabels name="occupancy_barrier_vector" toName="image"><Label value="wall_barrier" /></VectorLabels>
  <Rectangle name="furniture_instance_rectangle" toName="image" canRotate="true" />
  <Polygon name="furniture_instance_polygon" toName="image" />
  <Choices name="furniture_instance_type" toName="image" perRegion="true" choice="single">
    <Choice value="书桌" alias="desk" />
    <Choice value="办公椅" alias="office_chair" />
  </Choices>
  <View style="display: none;">
    <VectorLabels name="furniture_front_direction" toName="image" closable="false" curves="false" minPoints="2" maxPoints="2" snap="none">
      <Label value="正面方向" alias="front_direction" />
    </VectorLabels>
    <VectorLabels name="furniture_front_edge" toName="image" closable="false" curves="false" minPoints="2" maxPoints="2" snap="none">
      <Label value="正面边" alias="front_edge" />
    </VectorLabels>
  </View>
</View>`;

const CATALOG_CONFIG = CONFIG.replace(
  "</Choices>",
  '<Choice value="梳妆台" alias="dressing_table" /><Choice value="吧台/餐吧台" alias="bar_counter" /></Choices>',
);

test("project choices constrain draft selection, import and category edits before mutation", () => {
  const refs = makeOccupancy();
  const { image, annotation } = setup(refs, makeInstance(refs));
  expect(image.furnitureInstanceAvailableTypes).toEqual(["desk", "office_chair"]);
  expect(image.furnitureInstanceDraftType).toBe("desk");
  const before = annotation.serializeAnnotation({ fast: true });
  expect(() => image.setFurnitureInstanceDraft("dressing_table")).toThrow("尚未启用");
  expect(() => image.setFurnitureInstanceCategory("instance-i", "dressing_table")).toThrow("尚未启用");
  expect(() => image.importFurnitureInstanceResults(makeInstance(refs, { instanceType: "bar_counter" }))).toThrow(
    "尚未启用",
  );
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  image.selectFurnitureInstance("instance-i");
  annotation.names.get(CONTROLS.type).findLabel("办公椅").onHotKey();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  expect(image.furnitureInstanceEditNotice).toContain("应用类别");
});

test.each(["dressing_table", "bar_counter"])(
  "reclassify a multipart reviewed instance to %s, retaining geometry, provenance and evidence",
  (type) => {
    const refs = makeOccupancy();
    const furniture = stampProvenance(
      makeInstance(refs, {
        geometry: [square(20, 20, 40, 40), square(50, 20, 65, 40)],
        orientation: {
          status: "front_direction",
          vertices: [
            { x: 25, y: 30 },
            { x: 35, y: 30 },
          ],
        },
      }),
    );
    const reviewed = confirmFurnitureInstances([...refs, ...furniture], [...refs, ...furniture], ["instance-i"]);
    const { image, annotation } = setup(
      refs,
      reviewed.filter((result) => result.from_name.startsWith("furniture_")),
      CATALOG_CONFIG,
    );
    const before = annotation.serializeAnnotation({ fast: true });
    image.setFurnitureInstanceDraft(type);
    expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
    expect(image.setFurnitureInstanceCategory("instance-i", type)).toBe(true);
    const after = annotation.serializeAnnotation({ fast: true });
    for (const result of after) {
      const original = before.find((value) => value.id === result.id && value.from_name === result.from_name);
      if (!context(result).instance_id) {
        expect(result).toEqual(original);
        continue;
      }
      expect(result.meta.furniture_instance_context).toEqual({
        ...context(original),
        instance_type: type,
        review_status: "pending",
        review_fingerprint: null,
      });
      expect(result.meta.furniture_instance_provenance).toEqual(original.meta.furniture_instance_provenance);
      expect(result.value).toEqual(
        result.from_name === CONTROLS.type ? { ...original.value, choices: [type] } : original.value,
      );
    }
    expect(image.setFurnitureInstanceCategory("instance-i", type)).toBe(false);
    expect(annotation.serializeAnnotation({ fast: true })).toEqual(after);
    const loaded = setup(
      after.filter((result) => !context(result).instance_id),
      after.filter((result) => context(result).instance_id),
      CATALOG_CONFIG,
    );
    expect(loaded.annotation.serializeAnnotation({ fast: true })).toEqual(after);
    expect(() => loaded.image.confirmFurnitureInstanceReviews(["instance-i"])).not.toThrow();
    expect(image.furnitureInstanceEditNotice).toContain("重新确认复核");
    image.confirmFurnitureInstanceReviews(["instance-i"]);
    expect(image.furnitureInstanceEditNotice).toBe("");
  },
);

const setup = (occupancy, furniture, config = CONFIG, markReferencesReadonly = true) => {
  ToolsManager.removeAllTools();
  const store = AppStore.create(
    {
      config,
      task: { id: 1, data: JSON.stringify({ image: "https://example.com/plan.png" }) },
      interfaces: ["basic"],
    },
    {
      events: { hasEvent: jest.fn(() => false), invoke: jest.fn(), invokeFirst: jest.fn() },
      messages: {},
      settings: {},
    },
  );
  const readonlyReferences = occupancy.map((result) => ({
    ...structuredClone(result),
    readonly: markReferencesReadonly,
  }));
  store.initializeStore({ annotations: [{ result: [...readonlyReferences, ...structuredClone(furniture)] }] });
  const annotation = store.annotationStore.selected;
  const image = annotation.names.get("image");
  image.naturalWidth = SOURCE.original_width;
  image.naturalHeight = SOURCE.original_height;
  image.currentImageEntity.setImageLoaded(true);
  image.currentImageEntity.setStageWidth(SOURCE.original_width);
  image.currentImageEntity.setStageHeight(SOURCE.original_height);
  annotation.setReferenceBaseline({ reference_version: "l3-snapshot", base_manual_hash: "baseline" }, true);
  annotation.reinitHistory(false);
  return { annotation, image, store };
};

test("hierarchy and display switches never change stored results and block out-of-scope selection", () => {
  const refs = makeOccupancy(),
    furniture = makeInstance(refs);
  const { image, annotation } = setup(refs, furniture);
  const before = annotation.serializeAnnotation({ fast: true });
  expect(image.furnitureInstanceDrawBlockReason(CONTROLS.rectangle)).toContain("房间");
  const region = image.regs.find((r) => r.results.some((v) => context(v).instance_id));
  annotation.selectArea(region);
  expect(annotation.selectedRegions).toHaveLength(0);
  image.setFurnitureInstanceSpace("room-r");
  expect(image.furnitureInstanceZoneId).toBe("");
  image.setFurnitureInstanceSpace("room-r", "zone-z");
  image.setFurnitureInstanceFocus("group-g");
  image.selectFurnitureInstance("instance-i");
  expect(image.furnitureInstanceEffectiveSelectedId).toBe("instance-i");
  image.setFurnitureInstanceReferenceDisplay("overview", true);
  image.setFurnitureInstanceReferenceDisplay("windows", false);
  image.setFurnitureInstanceSpace();
  expect(image.furnitureInstanceFocusId).toBe("");
  expect(annotation.selectedRegions).toHaveLength(0);
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  image.selectFurnitureInstance("instance-i");
  expect([image.furnitureInstanceRoomId, image.furnitureInstanceZoneId, image.furnitureInstanceFocusId]).toEqual([
    "room-r",
    "zone-z",
    "group-g",
  ]);
});

test("outline creation is one reversible history operation and preserves all existing results", () => {
  const refs = makeOccupancy(),
    furniture = makeInstance(refs);
  const { image, annotation } = setup(refs, furniture);
  const before = annotation.serializeAnnotation({ fast: true });
  image.setFurnitureInstanceFocus("group-g");
  const token = groupCreationState(image.furnitureInstanceData, "group-g", "desk").token;
  const id = image.createFurnitureInstanceFromGroup("group-g", "desk", token);
  expect(image.furnitureInstanceLogicals).toHaveLength(2);
  const after = annotation.serializeAnnotation({ fast: true });
  expect(after.filter((r) => context(r).instance_id !== id)).toEqual(before);
  expect(() => image.createFurnitureInstanceFromGroup("group-g", "desk", token)).toThrow("同轮廓");
  annotation.history.undo();
  expect(image.furnitureInstanceLogicals).toHaveLength(1);
  annotation.history.redo();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(after);
  const loaded = setup(
    after.filter((r) => !context(r).instance_id),
    after.filter((r) => context(r).instance_id),
  );
  expect(loaded.annotation.serializeAnnotation({ fast: true })).toEqual(after);
});

test("rotation preview is isolated, applies once with stable IDs and supports undo and reload", () => {
  const refs = makeOccupancy(),
    furniture = makeInstance(refs, { rectangle: { x: 25, y: 25, width: 20, height: 20, rotation: 0 } });
  const { image, annotation } = setup(refs, furniture);
  image.selectFurnitureInstance("instance-i");
  image.confirmFurnitureInstanceReviews(["instance-i"]);
  const before = annotation.serializeAnnotation({ fast: true });
  expect(image.previewFurnitureRectangle({ angle: 30 }).valid).toBe(true);
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  image.cancelFurnitureRectanglePreview();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  image.previewFurnitureRectangle({ angle: 30 });
  image.applyFurnitureRectanglePreview();
  const after = annotation.serializeAnnotation({ fast: true });
  const part = after.find((r) => r.from_name === CONTROLS.rectangle);
  expect(part.value.rotation).toBe(30);
  expect(context(part)).toMatchObject({ instance_id: "instance-i", group_id: "group-g", review_status: "pending" });
  expect(after.filter((r) => !context(r).instance_id)).toEqual(before.filter((r) => !context(r).instance_id));
  annotation.history.undo();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  annotation.history.redo();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(after);
  const loaded = setup(
    after.filter((r) => !context(r).instance_id),
    after.filter((r) => context(r).instance_id),
  );
  expect(loaded.annotation.serializeAnnotation({ fast: true })).toEqual(after);
});

const attachVectorRef = (region) => {
  const points = [];
  let pending = null;
  const ref = {
    startPoint: jest.fn((x, y) => {
      pending = { x, y };
      return true;
    }),
    commitPoint: jest.fn((x, y) => {
      const current = pending || { x, y };
      const previous = points.at(-1);
      points.push({
        id: `point-${points.length + 1}`,
        x: current.x,
        y: current.y,
        prevPointId: previous?.id || null,
        isBezier: false,
      });
      pending = null;
      region.updatePointsFromKonvaVector([...points]);
      return true;
    }),
    getShapeBoundingBox: jest.fn(() => ({
      left: Math.min(...points.map((point) => point.x)),
      top: Math.min(...points.map((point) => point.y)),
      right: Math.max(...points.map((point) => point.x)),
      bottom: Math.max(...points.map((point) => point.y)),
    })),
    clearSelection: jest.fn(),
    getSelectedPointIds: jest.fn(() => []),
  };
  region.setKonvaVectorRef(ref);
  return ref;
};

const beginOnePoint = (image, control, start) => {
  image.startFurnitureInstanceTool(control);
  const tool = image.getToolsManager().findSelectedTool();
  tool.startDrawing(start.x, start.y);
  const region = tool.getCurrentArea();
  const ref = attachVectorRef(region);
  jest.runOnlyPendingTimers();
  region.commitPoint((start.x * SOURCE.original_width) / 100, (start.y * SOURCE.original_height) / 100);
  return { region, ref, tool };
};

beforeEach(() => {
  resetIds();
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
  ToolsManager.removeAllTools();
});

const armGeometry = (image, name = CONTROLS.rectangle, threePoint = false, dynamic = false) => {
  image.setFurnitureInstanceDraft("desk");
  image.setFurnitureInstanceFocus("group-g");
  const tool =
    name === CONTROLS.rectangle
      ? image
          .getToolsManager()
          .allTools()
          .find(
            (candidate) =>
              candidate.control?.name === name &&
              candidate.toolName === (threePoint ? "Rectangle3PointTool" : "RectangleTool") &&
              candidate.dynamic === dynamic,
          )
      : null;
  image.startFurnitureInstanceTool(name, tool);
  return image.getToolsManager().findSelectedTool();
};

const drawRectangle = (tool, mode = "drag") => {
  const event = { offsetX: 200, offsetY: 100 };
  if (mode === "three-point") {
    tool.clickEv(event, [20, 20]);
    tool.mousemoveEv(event, [40, 20]);
    tool.clickEv(event, [40, 20]);
    tool.mousemoveEv(event, [40, 40]);
    tool.clickEv(event, [40, 40]);
  } else {
    tool.mousedownEv(event, [20, 20]);
    if (mode === "two-clicks") {
      tool.mouseupEv(event, [20, 20]);
      tool.clickEv(event, [20, 20]);
    }
    tool.mousemoveEv(event, [40, 40]);
    tool.mouseupEv(event, [40, 40]);
    if (mode === "two-clicks") {
      expect(tool.annotation.isDrawing).toBe(true);
      expect(tool.obj.getToolsManager().findSelectedTool()).toBe(tool);
      tool.clickEv(event, [40, 40]);
    }
  }
  jest.runOnlyPendingTimers();
};

const expectCompletedGeometry = (image, tool) => {
  expect(image.furnitureInstanceLogicals).toHaveLength(1);
  expect(image.getToolsManager().findSelectedTool().fullName).toBe("MoveTool");
  expect(tool.selected).toBe(false);
  expect(tool.currentArea).toBeNull();
  expect(image.annotation.isDrawing).toBe(false);
  expect(image.annotation.history.isFrozen).toBe(false);
  expect(image.furnitureInstanceDrawingControl).toBe("");
  const instance = image.furnitureInstanceLogicals[0];
  expect(image.furnitureInstanceSelectedId).toBe(instance.id);
  expect(image.furnitureInstanceFocusId).toBe("group-g");
  expect(image.furnitureInstanceType).toBe("desk");
  expect(image.annotation.selectedRegions.map((region) => region.cleanId)).toEqual(
    instance.parts.map((part) => part.id),
  );
  expect(instance.context).toMatchObject({ group_id: "group-g", instance_type: "desk", review_status: "pending" });
};

describe("L4 geometry toolbar entry points", () => {
  const activeClass = cn("tool").mod({ active: true }).toClassName();
  const disabledClass = cn("tool").mod({ disabled: true }).toClassName();
  beforeEach(() => {
    // This Jest configuration stubs the icon package without these named exports.
    for (const name of ["RectRegionModel", "Rect3PointRegionModel", "PolygonRegionModel"]) {
      jest.replaceProperty(NodeViews[name], "icon", () => null);
    }
  });

  const variants = [
    [CONTROLS.rectangle, "RectangleTool", "drag"],
    [CONTROLS.rectangle, "Rectangle3PointTool", "three-point"],
    [CONTROLS.polygon, "PolygonTool", "polygon"],
  ];

  test.each(variants.flatMap((variant) => ["click", "shortcut"].map((entry) => [entry, ...variant])))(
    "%s on %s / %s selects that tool, completes to Move and can be armed again",
    (entry, control, toolName, mode) => {
      const { image, annotation } = setup(makeOccupancy(), []);
      image.setFurnitureInstanceDraft("desk");
      image.setFurnitureInstanceFocus("group-g");
      const manager = image.getToolsManager();
      const tool = manager
        .allTools()
        .find((item) => item.control?.name === control && item.toolName === toolName && !item.dynamic);
      const before = annotation.serializeAnnotation({ fast: true });
      keymaster.mockClear();
      const view = render(createElement(tool.viewClass));
      const button = view.getByRole("button");
      if (entry === "click") {
        fireEvent.click(button);
      } else {
        // Run the keyboard handler actually registered by the rendered toolbar.
        const [key, , handler] = keymaster.mock.calls.at(-1) ?? [];
        expect(key).toBe(mode === "three-point" ? "shift+r" : mode === "polygon" ? "p" : "r");
        expect(handler).toEqual(expect.any(Function));
        act(() => handler({ preventDefault: jest.fn(), stopPropagation: jest.fn() }));
      }
      expect(manager.findSelectedTool()).toBe(tool);
      expect(button).toHaveClass(activeClass);
      expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
      expect(manager.allTools().some((item) => item.dynamic && item.selected)).toBe(false);
      act(() => {
        if (mode === "polygon") {
          tool.startDrawing(20, 20);
          tool.currentArea.addPoint(40, 20);
          tool.currentArea.addPoint(40, 40);
          tool.finishDrawing();
          jest.runOnlyPendingTimers();
        } else {
          drawRectangle(tool, mode);
        }
      });
      expectCompletedGeometry(image, tool);
      expect(button).not.toHaveClass(activeClass);
      fireEvent.click(button);
      expect(manager.findSelectedTool()).toBe(tool);
      expect(button).toHaveClass(activeClass);
      expect(image.furnitureInstanceLogicals).toHaveLength(1);
    },
  );

  test.each(variants)("%s / %s remains blocked without Focus", (control, toolName) => {
    const { image } = setup(makeOccupancy(), []);
    image.setFurnitureInstanceDraft("desk");
    const manager = image.getToolsManager();
    const tool = manager
      .allTools()
      .find((item) => item.control?.name === control && item.toolName === toolName && !item.dynamic);
    const selected = manager.findSelectedTool();
    const view = render(createElement(tool.viewClass));
    expect(view.getByRole("button")).toHaveClass(disabledClass);
    fireEvent.click(view.getByRole("button"));
    expect(manager.findSelectedTool()).toBe(selected);
    expect(image.furnitureInstanceLogicals).toHaveLength(0);
  });

  test.each([CONTROLS.rectangle, CONTROLS.polygon])("name-only %s selects a manual tool", (control) => {
    const { image } = setup(makeOccupancy(), []);
    image.setFurnitureInstanceDraft("desk");
    image.setFurnitureInstanceFocus("group-g");
    image.startFurnitureInstanceTool(control);
    const tool = image.getToolsManager().findSelectedTool();
    expect(tool.control.name).toBe(control);
    expect(tool.dynamic).toBe(false);
    if (control === CONTROLS.rectangle) expect(tool.toolName).toBe("RectangleTool");
  });

  test("rejects a tool belonging to another control before changing the current selection", () => {
    const refs = makeOccupancy();
    const { image, annotation } = setup(refs, makeInstance(refs));
    image.selectFurnitureInstance("instance-i");
    const selectedIds = annotation.selectedRegions.map((region) => region.id);
    const manager = image.getToolsManager();
    const selected = manager.findSelectedTool();
    const other = manager.allTools().find((tool) => tool.control?.name === CONTROLS.polygon);
    expect(() => image.startFurnitureInstanceTool(CONTROLS.rectangle, other)).toThrow("绘制工具尚未就绪");
    expect(manager.findSelectedTool()).toBe(selected);
    expect(annotation.selectedRegions.map((region) => region.id)).toEqual(selectedIds);
  });
});

test.each(["drag", "two-clicks", "three-point"])(
  "completed L4 %s rectangle returns to Move and selects the new instance",
  (mode) => {
    const { image } = setup(makeOccupancy(), []);
    const tool = armGeometry(image, CONTROLS.rectangle, mode === "three-point");
    drawRectangle(tool, mode);
    expectCompletedGeometry(image, tool);
  },
);

test("completed L4 polygon returns to Move only after a valid closure", () => {
  const { image, annotation } = setup(makeOccupancy(), []);
  const tool = armGeometry(image, CONTROLS.polygon);
  tool.startDrawing(20, 20);
  const region = tool.currentArea;
  region.addPoint(40, 20);
  expect(annotation.isDrawing).toBe(true);
  expect(image.getToolsManager().findSelectedTool()).toBe(tool);
  region.addPoint(40, 40);
  tool.finishDrawing();
  jest.runOnlyPendingTimers();
  expect(region.closed).toBe(true);
  expectCompletedGeometry(image, tool);
});

test.each(Array.from({ length: 8 }, (_, flags) => [Boolean(flags & 1), Boolean(flags & 2), Boolean(flags & 4)]))(
  "L4 completion overrides tool persistence without changing preferences (select=%s, continuous=%s, preserve=%s)",
  (selectAfterCreate, continuousLabeling, preserveSelectedTool) => {
    const { image, store } = setup(makeOccupancy(), []);
    if (store.settings.selectAfterCreate !== selectAfterCreate) store.settings.toggleSelectAfterCreate();
    if (store.settings.continuousLabeling !== continuousLabeling) store.settings.toggleContinuousLabeling();
    if (store.settings.preserveSelectedTool !== preserveSelectedTool) store.settings.togglepreserveSelectedTool();
    const tool = armGeometry(image);
    drawRectangle(tool);
    expectCompletedGeometry(image, tool);
    expect(store.settings).toMatchObject({ selectAfterCreate, continuousLabeling, preserveSelectedTool });
  },
);

test.each([false, true])(
  "L4 rectangle completion works for dynamic=%s and survives a late completion callback",
  (dynamic) => {
    const { image } = setup(makeOccupancy(), []);
    const tool = armGeometry(image, CONTROLS.rectangle, false, dynamic);
    drawRectangle(tool);
    tool._finishDrawing();
    expectCompletedGeometry(image, tool);
  },
);

test("completed geometry can be moved, resized, undone, redone and reloaded without changing parents", () => {
  const { image, annotation } = setup(makeOccupancy(), []);
  const refs = image.furnitureInstanceData.filter((result) => result.readonly);
  const tool = armGeometry(image);
  drawRectangle(tool);
  const instance = image.furnitureInstanceLogicals[0];
  const originalContext = structuredClone(instance.context);
  const saved = annotation.serializeAnnotation({ fast: true });
  annotation.history.undo();
  expect(image.furnitureInstanceLogicals).toHaveLength(0);
  annotation.history.redo();
  expect(image.furnitureInstanceLogicals[0].context).toEqual(originalContext);
  image.selectFurnitureInstance(instance.id);
  const region = annotation.selectedRegions[0];
  region.setPositionInternal(25, 25, 25, 25, 0);
  expect(image.furnitureInstanceLogicals[0].context).toEqual(originalContext);
  expect(region.x).toBe(25);
  expect(region.width).toBe(25);
  expect(image.furnitureInstanceData.filter((result) => result.readonly)).toEqual(refs);
  const secondTool = armGeometry(image);
  drawRectangle(secondTool);
  expect(image.furnitureInstanceLogicals).toHaveLength(2);
  expect(new Set(image.furnitureInstanceLogicals.map((item) => item.id)).size).toBe(2);
  const loaded = setup(
    refs,
    saved.filter((result) => !result.readonly),
  );
  expect(loaded.annotation.serializeAnnotation({ fast: true })).toEqual(saved);
});

test.each([CONTROLS.rectangle, CONTROLS.polygon])(
  "cancelled L4 %s never selects a transient instance or removes existing furniture",
  (name) => {
    const refs = makeOccupancy();
    const furniture = makeInstance(refs);
    const { image, annotation } = setup(refs, furniture);
    const before = annotation.serializeAnnotation({ fast: true });
    const tool = armGeometry(image, name);
    tool.startDrawing(50, 50);
    image.cancelFurnitureInstanceGeometryDrawing(name);
    jest.runOnlyPendingTimers();
    expect(tool.currentArea).toBeNull();
    expect(annotation.isDrawing).toBe(false);
    expect(annotation.history.isFrozen).toBe(false);
    expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  },
);

test("a zero-size rectangle does not trigger successful L4 completion", () => {
  const { image } = setup(makeOccupancy(), []);
  const tool = armGeometry(image);
  tool.startDrawing(20, 20);
  tool.finishDrawing(20, 20);
  expect(image.furnitureInstanceLogicals).toHaveLength(0);
  expect(image.annotation.selectedRegions).toHaveLength(0);
  expect(image.getToolsManager().findSelectedTool()).toBe(tool);
  expect(image.annotation.isDrawing).toBe(false);
});

test.each(["drag", "two-clicks", "three-point"])("cancelled %s rectangle can immediately be drawn again", (mode) => {
  const { image } = setup(makeOccupancy(), []);
  const tool = armGeometry(image, CONTROLS.rectangle, mode === "three-point");
  const event = { offsetX: 200, offsetY: 100 };
  if (mode === "three-point") {
    tool.clickEv(event, [20, 20]);
    tool.clickEv(event, [40, 20]);
  } else {
    tool.mousedownEv(event, [20, 20]);
    if (mode === "two-clicks") tool.clickEv(event, [20, 20]);
    tool.mousemoveEv(event, [40, 40]);
  }
  image.cancelFurnitureInstanceGeometryDrawing();
  expect(image.furnitureInstanceLogicals).toHaveLength(0);
  const next = armGeometry(image, CONTROLS.rectangle, mode === "three-point");
  drawRectangle(next, mode);
  expectCompletedGeometry(image, next);
});

test("reset removes only the selected orientation, preserves geometry/parents/other instances, and is idempotent", () => {
  const occupancy = makeOccupancy();
  const first = makeInstance(occupancy, {
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 25, y: 30 },
        { x: 35, y: 30 },
      ],
    },
  });
  const other = makeInstance(occupancy, {
    instanceId: "instance-other",
    instanceType: "office_chair",
    geometry: [square(50, 20, 60, 30)],
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 52, y: 25 },
        { x: 58, y: 25 },
      ],
    },
  });
  const reviewed = confirmFurnitureInstances([...first, ...other], occupancy, ["instance-i", "instance-other"]);
  const { annotation, image } = setup(occupancy, reviewed);
  image.selectFurnitureInstance("instance-i");
  const savedParent = { ...image.furnitureInstanceLogicals.find(({ id }) => id === "instance-i").context };
  const firstGeometryIds = image.furnitureInstanceLogicals
    .find(({ id }) => id === "instance-i")
    .parts.map(({ id }) => id);

  expect(image.clearFurnitureInstanceOrientation("instance-i")).toBe(true);
  const current = image.furnitureInstanceLogicals.find(({ id }) => id === "instance-i");
  const untouched = image.furnitureInstanceLogicals.find(({ id }) => id === "instance-other");
  expect(orientationForInstance(current)).toEqual({ status: "unknown" });
  expect(current.parts.map(({ id }) => id)).toEqual(firstGeometryIds);
  expect(current.context).toMatchObject({
    room_id: savedParent.room_id,
    zone_id: savedParent.zone_id,
    group_id: savedParent.group_id,
    parent_fingerprint: savedParent.parent_fingerprint,
    review_status: "pending",
    review_fingerprint: null,
  });
  expect(orientationForInstance(untouched).status).toBe("front_direction");
  expect(untouched.context.review_status).toBe("reviewed");
  const afterFirstReset = annotation.serializeAnnotation({ fast: true });

  expect(image.clearFurnitureInstanceOrientation("instance-i")).toBe(false);
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(afterFirstReset);
});

test("switching orientation modes and Esc cancel one-point drafts without serializing invalid evidence", () => {
  const occupancy = makeOccupancy();
  const reviewed = confirmFurnitureInstances(makeInstance(occupancy), occupancy, ["instance-i"]);
  const { annotation, image } = setup(occupancy, reviewed);
  image.selectFurnitureInstance("instance-i");

  const { region, tool: directionTool } = beginOnePoint(image, CONTROLS.frontDirection, { x: 25, y: 30 });
  expect(region.incomplete).toBe(true);
  expect(
    annotation.serializeAnnotation({ fast: true }).some((result) => controlName(result) === CONTROLS.frontDirection),
  ).toBe(false);

  image.startFurnitureInstanceTool(CONTROLS.frontEdge);
  expect(directionTool.currentArea).toBeNull();
  expect(image.furnitureInstanceDrawingControl).toBe(CONTROLS.frontEdge);
  expect(image.getToolsManager().findSelectedTool().control.name).toBe(CONTROLS.frontEdge);
  expect(image.furnitureInstanceLogicals[0].orientationResults).toEqual([]);

  image.getToolsManager().findSelectedTool().complete();
  expect(image.furnitureInstanceDrawingControl).toBe("");
  expect(image.getToolsManager().findSelectedTool().fullName).toBe("MoveTool");
  expect(annotation.isDrawing).toBe(false);
  expect(annotation.history.isFrozen).toBe(false);
  expect(image.furnitureInstanceLogicals[0].context.review_status).toBe("reviewed");
});

test("finishing a one-point orientation draft cancels it without committing null serialization", () => {
  const occupancy = makeOccupancy();
  const reviewed = confirmFurnitureInstances(makeInstance(occupancy), occupancy, ["instance-i"]);
  const { annotation, image } = setup(occupancy, reviewed);
  image.selectFurnitureInstance("instance-i");
  const { region, tool } = beginOnePoint(image, CONTROLS.frontDirection, { x: 25, y: 30 });

  expect(() => region.handleFinish()).not.toThrow();

  expect(tool.currentArea).toBeNull();
  expect(annotation.isDrawing).toBe(false);
  expect(annotation.history.isFrozen).toBe(false);
  expect(image.furnitureInstanceLogicals[0].orientationResults).toEqual([]);
  expect(image.furnitureInstanceLogicals[0].context.review_status).toBe("reviewed");
});

test.each([CONTROLS.frontDirection, CONTROLS.frontEdge])(
  "active %s accepts Konva points while reference regions remain protected",
  (control) => {
    const occupancy = makeOccupancy();
    const { image } = setup(occupancy, makeInstance(occupancy));
    image.selectFurnitureInstance("instance-i");
    const { region, tool } = beginOnePoint(image, control, { x: 25, y: 30 });
    expect(image.getSkipInteractions()).toBe(true);
    expect(image.getSkipInteractions(region)).toBe(false);
    expect(image.getSkipInteractions(image.regs.find((candidate) => candidate !== region))).toBe(true);
    expect(region.isReadOnly()).toBeFalsy();
    const reference = image.regs.find((candidate) => candidate.isReadOnly());
    expect(reference).toBeDefined();
    expect(image.getSkipInteractions(reference)).toBe(true);
    tool.complete();
    expect(tool.currentArea).toBeNull();
    expect(image.furnitureInstanceLogicals).toHaveLength(1);
  },
);

test("a persisted malformed orientation remains visible to validation instead of being silently dropped", () => {
  const occupancy = makeOccupancy();
  const malformed = makeInstance(occupancy, {
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 25, y: 30 },
        { x: 35, y: 30 },
      ],
    },
  });
  malformed.at(-1).value.vertices = malformed.at(-1).value.vertices.slice(0, 1);
  const { annotation } = setup(occupancy, malformed);

  expect(
    annotation.serializeAnnotation({ fast: true }).some((result) => controlName(result) === CONTROLS.frontDirection),
  ).toBe(true);
});

test("Esc on an armed orientation tool never adopts or deletes a highlighted persisted vector", () => {
  const occupancy = makeOccupancy();
  const current = makeInstance(occupancy);
  const malformed = makeInstance(occupancy, {
    instanceId: "instance-other",
    instanceType: "office_chair",
    geometry: [square(50, 20, 60, 30)],
    orientation: {
      status: "front_direction",
      vertices: [
        { x: 25, y: 30 },
        { x: 35, y: 30 },
      ],
    },
  });
  malformed.at(-1).value.vertices = malformed.at(-1).value.vertices.slice(0, 1);
  const { annotation, image } = setup(occupancy, [...current, ...malformed]);
  const persisted = image.regs.find((region) =>
    region.results.some(
      (result) => controlName(result) === CONTROLS.frontDirection && context(result).instance_id === "instance-other",
    ),
  );
  image.selectFurnitureInstance("instance-i");
  image.startFurnitureInstanceTool(CONTROLS.frontDirection);
  const tool = image.getToolsManager().findSelectedTool();
  annotation.selectArea(persisted);
  const before = annotation.serializeAnnotation({ fast: true });

  expect(tool.currentArea).toBeNull();
  expect(tool.getCurrentArea()).toBe(persisted);
  tool.complete();

  expect(image.regs.includes(persisted)).toBe(true);
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  expect(image.furnitureInstanceDrawingControl).toBe("");
  expect(image.getToolsManager().findSelectedTool().fullName).toBe("MoveTool");
});

test("reset during a one-point draft cancels it and explicitly reopens a reviewed instance", () => {
  const occupancy = makeOccupancy();
  const reviewed = confirmFurnitureInstances(makeInstance(occupancy), occupancy, ["instance-i"]);
  const { annotation, image } = setup(occupancy, reviewed);
  image.selectFurnitureInstance("instance-i");
  const geometryIds = image.furnitureInstanceLogicals[0].parts.map(({ id }) => id);

  const { region } = beginOnePoint(image, CONTROLS.frontDirection, { x: 25, y: 30 });
  expect(region.incomplete).toBe(true);
  expect(image.clearFurnitureInstanceOrientation("instance-i")).toBe(true);

  const instance = image.furnitureInstanceLogicals[0];
  expect(instance.parts.map(({ id }) => id)).toEqual(geometryIds);
  expect(instance.orientationResults).toEqual([]);
  expect(instance.context).toMatchObject({ review_status: "pending", review_fingerprint: null });
  expect(annotation.isDrawing).toBe(false);
  expect(annotation.history.isFrozen).toBe(false);
  expect(image.furnitureInstanceDrawingControl).toBe("");
  expect(image.furnitureInstanceErrors.filter(({ code }) => code === "orientation")).toEqual([]);
});

test("two distinct front_direction points create one bound result and reopen reviewed content as pending", () => {
  const occupancy = makeOccupancy();
  const reviewed = confirmFurnitureInstances(makeInstance(occupancy), occupancy, ["instance-i"]);
  const { image } = setup(occupancy, reviewed);
  image.selectFurnitureInstance("instance-i");

  const { region, tool } = beginOnePoint(image, CONTROLS.frontDirection, { x: 25, y: 30 });
  region.addPoint(35, 30);
  if (tool.currentArea) tool.complete();

  const instance = image.furnitureInstanceLogicals.find(({ id }) => id === "instance-i");
  expect(instance.orientationResults).toHaveLength(1);
  const evidence = instance.orientationResults[0];
  expect(controlName(evidence)).toBe(CONTROLS.frontDirection);
  expect(evidence.value).toMatchObject({ closed: false });
  expect(evidence.value.vertices).toHaveLength(2);
  expect(evidence.value.vertices.every((vertex) => vertex.isBezier !== true)).toBe(true);
  expect(context(evidence)).toMatchObject({
    instance_id: "instance-i",
    room_id: instance.context.room_id,
    zone_id: instance.context.zone_id,
    group_id: "group-g",
    parent_fingerprint: instance.context.parent_fingerprint,
    review_status: "pending",
    review_fingerprint: null,
  });
  expect(orientationForInstance(instance).status).toBe("front_direction");
  expect(image.furnitureInstanceErrors.filter(({ code }) => code === "orientation")).toEqual([]);
  expect(() => image.startFurnitureInstanceTool(CONTROLS.frontEdge)).toThrow("已有朝向证据");
});

test("front_edge points snap to the real boundary in source pixels at different canvas zooms", () => {
  const occupancy = makeOccupancy();
  const reviewed = confirmFurnitureInstances(makeInstance(occupancy), occupancy, ["instance-i"]);
  const { image } = setup(occupancy, reviewed);
  image.selectFurnitureInstance("instance-i");

  const first = image.furnitureInstanceDrawingPoint({ x: 25.31, y: 20.17 }, null, true, CONTROLS.frontEdge);
  image.currentImageEntity.setStageWidth(SOURCE.original_width * 2);
  image.currentImageEntity.setStageHeight(SOURCE.original_height * 2);
  const second = image.furnitureInstanceDrawingPoint({ x: 34.72, y: 20.08 }, null, false, CONTROLS.frontEdge);

  expect(first.y).toBe(20);
  expect(second.y).toBe(20);
  expect(first.x * 10).toBe(Math.round(first.x * 10));
  expect(second.x * 10).toBe(Math.round(second.x * 10));
  expect(
    image.furnitureInstanceDrawingPoint(
      { x: 40, y: 30 },
      { vertices: [{ x: 200, y: 100 }] },
      false,
      CONTROLS.frontEdge,
    ),
  ).toBeNull();
  expect(image.furnitureInstanceEditNotice).toContain("真实边界");

  const { region, tool } = beginOnePoint(image, CONTROLS.frontEdge, { x: 20, y: 20 });
  region.addPoint(40, 20);
  if (tool.currentArea) tool.complete();
  const instance = image.furnitureInstanceLogicals[0];
  expect(instance.orientationResults).toHaveLength(1);
  expect(orientationForInstance(instance)).toMatchObject({
    status: "front_edge",
    start: { x: 20, y: 20 },
    end: { x: 40, y: 20 },
  });
  expect(image.furnitureInstanceErrors.filter(({ code }) => code === "orientation")).toEqual([]);
});

const inheritedWindow = () => ({
  ...SOURCE,
  id: "inherited-window",
  from_name: "window_vector",
  type: "vectorlabels",
  value: {
    closed: false,
    vectorlabels: ["Window"],
    vertices: [
      { id: "wa", x: 10, y: 0, isBezier: false },
      { id: "wb", prevPointId: "wa", x: 40, y: 0, isBezier: false },
    ],
  },
  meta: { window_context: { schema_version: 1, parent_room_id: "room-r", pairing_status: "exterior" } },
});

test.each(["L3", "L4"])(
  "%s recognizes inherited windows as readonly without relying on the imported readonly flag",
  (level) => {
    let config = CONFIG.replace(
      "</View>",
      '<VectorLabels name="window_vector" toName="image"><Label value="Window" /></VectorLabels></View>',
    );
    if (level === "L3") config = config.replace('furnitureInstancesV1="true"', 'occupancyV1="true"');
    const refs = [...makeOccupancy(), inheritedWindow()];
    const { annotation, image } = setup(refs, [], config, false);
    const window = [...annotation.areas.values()].find((region) => region.cleanId === "inherited-window");
    expect(window.readonly).toBe(false);
    expect(window.isReadOnly()).toBe(true);
    expect(image.windowEnabled).toBe(false);
    expect(
      level === "L4"
        ? image.furnitureInstanceIsReference("window_vector")
        : image.occupancyIsReference("window_vector"),
    ).toBe(true);
    image.updateRoomConstraintTools();
    const tools = image.getToolsManager().allTools();
    const windowTool = tools.find((tool) => tool.control?.name === "window_vector");
    expect(windowTool).toBeDefined();
    expect(windowTool.disabled).toBe(true);
    if (level === "L4") {
      expect(partitionFurnitureReferenceRegions([window], image)).toEqual({ references: [window], interactive: [] });
      expect(furnitureInstanceToolbarTools(tools, true)).not.toContain(windowTool);
      expect(image.furnitureInstanceLogicals).toEqual([]);
    }
    const before = annotation.serializeAnnotation({ fast: true }).find((result) => result.id === window.cleanId);
    image.beforeSend();
    const after = annotation.serializeAnnotation({ fast: true }).find((result) => result.id === window.cleanId);
    expect(after).toEqual(before);
    const reloaded = setup(refs.filter((result) => result.id !== window.cleanId).concat(after), [], config, false);
    expect(
      reloaded.annotation.serializeAnnotation({ fast: true }).find((result) => result.id === window.cleanId),
    ).toEqual(after);
  },
);

test("L4 geometry, category and direction keep their own metadata through save and reload alongside window references", () => {
  const refs = [...makeOccupancy(), inheritedWindow()];
  const furniture = stampProvenance(
    makeInstance(refs, {
      orientation: {
        status: "front_direction",
        vertices: [
          { x: 25, y: 30 },
          { x: 35, y: 30 },
        ],
      },
    }),
  );
  const config = CONFIG.replace(
    "</View>",
    '<VectorLabels name="window_vector" toName="image"><Label value="Window" /></VectorLabels></View>',
  );
  const { annotation, image } = setup(refs, furniture, config);
  image.beforeSend();
  const saved = annotation.serializeAnnotation({ fast: true });
  for (const original of furniture) {
    const result = saved.find((item) => item.id === original.id && item.from_name === original.from_name);
    expect(result.meta.furniture_instance_context).toEqual(original.meta.furniture_instance_context);
    expect(result.meta.furniture_instance_provenance).toEqual(original.meta.furniture_instance_provenance);
    expect(result.meta).not.toHaveProperty("window_context");
    expect(result.meta).not.toHaveProperty("window_projections");
  }
  const sourceWindow = saved.find((result) => result.id === "inherited-window");
  expect(sourceWindow.meta.window_context).toEqual(inheritedWindow().meta.window_context);
  expect(sourceWindow.meta).not.toHaveProperty("furniture_instance_context");
  const loaded = setup(
    saved.filter((result) => !result.from_name.startsWith("furniture_")),
    saved.filter((result) => result.from_name.startsWith("furniture_")),
    config,
  );
  expect(loaded.annotation.serializeAnnotation({ fast: true })).toEqual(saved);
});

test("batch review synchronizes all parts and evidence, and an application exception restores every target", () => {
  const refs = makeOccupancy();
  const furniture = [
    ...makeInstance(refs, {
      instanceId: "a",
      geometry: [square(20, 20, 30, 30), square(40, 40, 50, 50)],
      orientation: {
        status: "front_direction",
        vertices: [
          { x: 22, y: 25 },
          { x: 28, y: 25 },
        ],
      },
    }),
    ...makeInstance(refs, { instanceId: "b" }),
    ...makeInstance(refs, { instanceId: "c" }),
  ];
  const { image, annotation } = setup(refs, furniture);
  const before = annotation.serializeAnnotation({ fast: true });
  const targeted = image.regs
    .flatMap((region) => [...region.results])
    .filter((r) => r.meta?.furniture_instance_context?.instance_id === "b");
  const originalAction = targeted[0].setMetaValue;
  targeted[0].setMetaValue = () => {
    throw new Error("injected mutation failure");
  };
  expect(() => image.confirmFurnitureInstanceReviews(["a", "b"])).toThrow("injected mutation failure");
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  targeted[0].setMetaValue = originalAction;
  image.confirmFurnitureInstanceReviews(["a", "b"]);
  const after = annotation.serializeAnnotation({ fast: true });
  expect(after.filter((r) => !["a", "b"].includes(context(r).instance_id))).toEqual(
    before.filter((r) => !["a", "b"].includes(context(r).instance_id)),
  );
  for (const id of ["a", "b"]) {
    const contexts = after.filter((r) => context(r).instance_id === id).map(context);
    expect(contexts.every((c) => c.review_status === "reviewed")).toBe(true);
    expect(new Set(contexts.map((c) => c.review_fingerprint)).size).toBe(1);
  }
});

test("invalid batch target prevents any model review write", () => {
  const refs = makeOccupancy();
  const { image, annotation } = setup(refs, [
    ...makeInstance(refs, { instanceId: "a" }),
    ...makeInstance(refs, { instanceId: "b", geometry: [square(85, 85, 98, 98)] }),
  ]);
  const before = annotation.serializeAnnotation({ fast: true });
  expect(() => image.confirmFurnitureInstanceReviews(["a", "b"])).toThrow();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
});

test("parent acceptance is atomic, survives reload and preserves unrelated reviewed instances", () => {
  const original = makeOccupancy();
  const updated = original.map((r) =>
    r.meta?.occupancy_context?.group_id
      ? { ...r, meta: { ...r.meta, occupancy_context: { ...r.meta.occupancy_context, group_note: "updated" } } }
      : r,
  );
  const stale = stampProvenance(
    makeInstance(original, {
      geometry: [square(20, 20, 30, 30), square(40, 40, 50, 50)],
      orientation: {
        status: "front_direction",
        vertices: [
          { x: 22, y: 25 },
          { x: 28, y: 25 },
        ],
      },
    }),
  );
  const other = confirmFurnitureInstances(makeInstance(updated, { instanceId: "untouched" }), updated, ["untouched"]);
  const { image, annotation } = setup(updated, [...stale, ...other]);
  const before = annotation.serializeAnnotation({ fast: true });
  const targets = image.regs.flatMap((r) => [...r.results]).filter((r) => context(r).instance_id === "instance-i");
  const action = targets[1].setMetaValue;
  targets[1].setMetaValue = () => {
    throw new Error("injected parent acceptance failure");
  };
  expect(() => image.acceptFurnitureInstanceParentUpdate("instance-i")).toThrow("injected parent acceptance failure");
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
  targets[1].setMetaValue = action;
  image.acceptFurnitureInstanceParentUpdate("instance-i");
  const after = annotation.serializeAnnotation({ fast: true });
  expect(after.filter((r) => context(r).instance_id !== "instance-i")).toEqual(
    before.filter((r) => context(r).instance_id !== "instance-i"),
  );
  for (const r of after.filter((r) => context(r).instance_id === "instance-i")) {
    const old = before.find((b) => b.id === r.id && b.from_name === r.from_name);
    expect(r.value).toEqual(old.value);
    expect(r.meta.furniture_instance_provenance).toEqual(old.meta.furniture_instance_provenance);
    expect(context(r)).toEqual({
      ...context(old),
      parent_fingerprint: image.furnitureInstanceParents[0].fingerprint,
      review_status: "pending",
      review_fingerprint: null,
    });
  }
  const loaded = setup(
    after.filter((r) => !r.from_name.startsWith("furniture_")),
    after.filter((r) => r.from_name.startsWith("furniture_")),
  );
  expect(loaded.annotation.serializeAnnotation({ fast: true })).toEqual(after);
  expect(loaded.image.furnitureInstanceErrors.filter((e) => e.instanceId === "instance-i").map((e) => e.code)).toEqual([
    "review",
  ]);
  loaded.image.confirmFurnitureInstanceReviews(["instance-i"]);
  expect(loaded.image.furnitureInstanceErrors).toEqual([]);
});
