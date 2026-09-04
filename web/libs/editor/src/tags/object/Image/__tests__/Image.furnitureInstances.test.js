import { TextEncoder } from "util";

import { confirmFurnitureInstances, orientationForInstance } from "../../../../furnitureInstances/constraints";
import { CONTROLS, context, controlName } from "../../../../furnitureInstances/domain";
import {
  makeInstance,
  makeOccupancy,
  resetIds,
  SOURCE,
  square,
} from "../../../../furnitureInstances/__tests__/helpers";

global.TextEncoder = TextEncoder;
if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

jest.mock("keymaster", () => {
  const keymaster = () => {};
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

const setup = (occupancy, furniture) => {
  ToolsManager.removeAllTools();
  const store = AppStore.create(
    {
      config: CONFIG,
      task: { id: 1, data: JSON.stringify({ image: "https://example.com/plan.png" }) },
      interfaces: ["basic"],
    },
    {
      events: { hasEvent: jest.fn(() => false), invoke: jest.fn(), invokeFirst: jest.fn() },
      messages: {},
      settings: {},
    },
  );
  const readonlyReferences = occupancy.map((result) => ({ ...structuredClone(result), readonly: true }));
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
  jest.useRealTimers();
  ToolsManager.removeAllTools();
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
