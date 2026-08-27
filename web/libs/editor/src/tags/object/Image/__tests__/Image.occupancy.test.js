import { TextEncoder } from "util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getSnapshot } from "mobx-state-tree";
import { autorun } from "mobx";
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
import "../../../visual/Header";
import AppStore from "../../../../stores/AppStore";
import ToolsManager from "../../../../tools/Manager";
import {
  classifyLogical,
  confirmParents,
  context,
  generateRemainder,
  invalidateReviews,
  logicalRegions,
  GEOMETRY,
  resultsForGeometry,
} from "../../../../occupancy/domain";

const CONFIG = readFileSync(
  resolve(__dirname, "../../../../../../../../examples/occupancy-v1/furniture-group-v1.xml"),
  "utf8",
);
const source = [
  {
    id: "parent",
    from_name: "zone_rectangle",
    to_name: "image",
    type: "rectangle",
    readonly: true,
    original_width: 100,
    original_height: 100,
    image_rotation: 0,
    value: { x: 0, y: 0, width: 100, height: 100, rotation: 0 },
    meta: { partition_context: { parent_room_id: "room" } },
  },
  {
    id: "parent",
    from_name: "function_zone",
    to_name: "image",
    type: "labels",
    readonly: true,
    value: { labels: ["Sanitary/general"] },
  },
];
const setup = (enabled = true) => {
  ToolsManager.removeAllTools();
  const store = AppStore.create(
    {
      config: enabled ? CONFIG : CONFIG.replace('occupancyV1="true"', ""),
      task: { id: 1, data: JSON.stringify({ image: "https://example.com/plan.png" }) },
      interfaces: ["basic"],
    },
    {
      events: { hasEvent: jest.fn(() => false), invoke: jest.fn(), invokeFirst: jest.fn() },
      messages: {},
      settings: {},
    },
  );
  store.initializeStore({ annotations: [{ result: structuredClone(source) }] });
  const annotation = store.annotationStore.selected,
    image = annotation.names.get("image");
  image.naturalWidth = 100;
  image.naturalHeight = 100;
  image.currentImageEntity.setImageLoaded(true);
  image.currentImageEntity.setStageWidth(1000);
  image.currentImageEntity.setStageHeight(1000);
  annotation.setReferenceBaseline({ reference_version: "v1", base_manual_hash: "baseline" }, true);
  annotation.reinitHistory(false);
  return { store, annotation, image };
};
test("observed toolbar views update after asynchronous load, edits and undo", () => {
  const { image, annotation } = setup();
  annotation.deleteAllRegions({ deleteReadOnly: true });
  let parentCount, logicalCount;
  const dispose = autorun(() => {
    parentCount = image.occupancyParents.length;
    logicalCount = image.occupancyLogicals.length;
  });
  expect(parentCount).toBe(0);
  annotation.deserializeResults(structuredClone(source));
  annotation.updateObjects();
  expect(parentCount).toBe(1);
  annotation.reinitHistory(false);
  image.applyOccupancyResults(
    generateRemainder(image.occupancyData, "parent", "v1").results,
    image.occupancyOperationFingerprint(),
  );
  expect(logicalCount).toBe(1);
  annotation.history.undo();
  expect(logicalCount).toBe(0);
  dispose();
});
test("feature flag, readonly L2 and Focus independence", () => {
  const { image } = setup();
  expect(image.occupancyEnabled).toBe(true);
  expect(image.occupancyParents).toHaveLength(1);
  expect(image.regs[0].isReadOnly()).toBe(true);
  image.setOccupancyFocus("parent");
  expect(image.focusedRoomId).toBeNull();
  image.createOccupancyGroup("storage", "");
  expect(image.occupancyDrawBlockReason()).toBe("");
  expect(setup(false).image.occupancyEnabled).toBe(false);
});
test("append paired remainder with exact IDs, classify/review, serialize/reload and single undo", () => {
  const { image, annotation } = setup();
  const before = image.occupancyData;
  const preview = generateRemainder(before, "parent", "v1", () => `n${Math.random().toString(36).slice(2)}`);
  image.applyOccupancyResults(preview.results, image.occupancyOperationFingerprint());
  expect(image.occupancyLogicals).toHaveLength(1);
  annotation.history.undo();
  expect(image.occupancyData).toEqual(before);
  annotation.history.redo();
  expect(image.occupancyLogicals).toHaveLength(1);
  expect(image.occupancyData.filter((r) => GEOMETRY.has(r.from_name)).map((r) => r.id)).toEqual(
    preview.results.filter((r) => GEOMETRY.has(r.from_name)).map((r) => r.id),
  );
  let next = classifyLogical(image.occupancyData, image.occupancyLogicals[0].id, "walkable");
  image.applyOccupancyResults(next, image.occupancyOperationFingerprint());
  next = confirmParents(image.occupancyData, ["parent"], "v1");
  image.applyOccupancyResults(next, image.occupancyOperationFingerprint());
  expect(image.occupancyErrors).toEqual([]);
  const serialized = annotation.serializeAnnotation({ fast: true });
  annotation.deleteAllRegions({ deleteReadOnly: true });
  annotation.deserializeResults(serialized);
  annotation.updateObjects();
  expect(image.occupancyErrors).toEqual([]);
});
test("stale preview and reference mutation fail without touching data", () => {
  const { image, annotation } = setup();
  const before = getSnapshot(annotation.areas);
  expect(() => image.applyOccupancyResults([], "stale")).toThrow("预览后");
  expect(getSnapshot(annotation.areas)).toEqual(before);
  expect(() => image.applyOccupancyResults([], image.occupancyOperationFingerprint())).toThrow("参考");
  expect(getSnapshot(annotation.areas)).toEqual(before);
});
test("drawing geometry is bound at creation and pending until explicitly applied", () => {
  const { image, annotation } = setup();
  image.setOccupancyFocus("parent");
  image.createOccupancyGroup("toilet", "");
  const region = annotation.createResult(
    { x: 10, y: 10, width: 20, height: 20, rotation: 0, coordstype: "perc" },
    {},
    annotation.names.get("occupancy_rectangle"),
    image,
  );
  image.initializeOccupancyRegion(region);
  expect(image.occupancyPending).toHaveLength(1);
  image.setOccupancyFocus("");
  const pending = image.occupancyPending[0];
  expect(pending.context.parent_zone_id).toBe("parent");
  const preview = image.previewOccupancyDrawing(pending.id);
  image.applyOccupancyResults(preview.results, preview.fingerprint);
  expect(image.occupancyPending).toHaveLength(0);
  expect(image.occupancyLogicals[0].context.group_type).toBe("toilet");
});
test("review metadata becomes pending after a manual geometry edit", () => {
  const { image, annotation } = setup();
  let next = generateRemainder(image.occupancyData, "parent", "v1").results;
  next = classifyLogical(next, logicalRegions(next)[0].id, "walkable");
  next = confirmParents(next, ["parent"], "v1");
  image.applyOccupancyResults(next, image.occupancyOperationFingerprint());
  expect(image.occupancyLogicals[0].context.review_status).toBe("reviewed");
  const region = image.regs.find((r) => r.results.some((x) => GEOMETRY.has(x.from_name?.name)));
  const beforeX = region.serialize().value.points[0][0];
  region.points[0]._setPos(region.points[0].x + 1, region.points[0].y);
  expect(region.serialize().value.points[0][0]).toBe(beforeX + 1);
  expect(
    logicalRegions(invalidateReviews(annotation.serializeAnnotation({ fast: true }), "v1"))[0].context.review_status,
  ).toBe("pending");
  image.refreshOccupancyReviews();
  expect(context(region.results.find((x) => GEOMETRY.has(x.from_name?.name))).review_status).toBe("pending");
  expect(logicalRegions(annotation.serializeAnnotation({ fast: true }))[0].context.review_status).toBe("pending");
  expect(image.occupancyLogicals[0].context.review_status).toBe("pending");
  expect(image.occupancyErrors.some((e) => e.code === "review")).toBe(true);
});

test("pending rectangle selection exposes native handles and application preserves rectangle", () => {
  const { image, annotation } = setup();
  image.setOccupancyFocus("parent");
  image.createOccupancyGroup("storage", "");
  const region = annotation.createResult(
    { x: 10, y: 10, width: 20, height: 20, rotation: 0, coordstype: "perc" },
    {},
    annotation.names.get("occupancy_rectangle"),
    image,
  );
  image.initializeOccupancyRegion(region);
  image.selectOccupancyLogical(image.occupancyPending[0].id);
  expect(image.occupancyActivePartId).toBe(region.cleanId);
  expect(image.getToolsManager().findSelectedTool().fullName).toBe("MoveTool");
  expect(region.useTransformer).toBe(true);
  const preview = image.previewOccupancyDrawing(image.occupancyPending[0].id);
  image.applyOccupancyResults(preview.results, preview.fingerprint);
  const logical = image.occupancyLogicals[0];
  expect(logical.parts[0].from_name).toBe("occupancy_rectangle");
  image.selectOccupancyLogical(logical.id);
  expect(image.occupancyActivePartId).toBe(logical.parts[0].id);
  const applied = annotation.selectedRegions[0];
  applied.setPositionInternal(12, 14, 24, 22, 0);
  expect(applied.x).toBe(12);
  expect(applied.width).toBe(24);
  applied.setPositionInternal(95, 95, 24, 22, 0);
  expect(applied.x + applied.width).toBeLessThanOrEqual(100.00000001);
  expect(applied.y + applied.height).toBeLessThanOrEqual(100.00000001);
  expect(applied.width).toBe(24);
  expect(image.occupancyEditNotice).toMatch("限制");
  annotation.unselectAreas();
  expect(image.occupancyActivePartId).toBe("");
});

test("multi-part group only edits explicitly selected component; readonly reference has no handles", () => {
  const { image, annotation } = setup();
  image.setOccupancyFocus("parent");
  image.createOccupancyGroup("storage", "");
  const region = annotation.createResult(
    { x: 10, y: 10, width: 10, height: 10, rotation: 0, coordstype: "perc" },
    {},
    annotation.names.get("occupancy_rectangle"),
    image,
  );
  image.initializeOccupancyRegion(region);
  const c = { ...image.occupancyPending[0].context, generation: "manual" };
  const shape = [
    [
      [
        [10, 10],
        [20, 10],
        [20, 20],
        [10, 20],
        [10, 10],
      ],
    ],
    [
      [
        [30, 30],
        [40, 30],
        [40, 40],
        [30, 40],
        [30, 30],
      ],
    ],
  ];
  const next = [
    ...image.occupancyData.filter((r) => !GEOMETRY.has(r.from_name) && r.from_name !== "occupancy_type"),
    ...resultsForGeometry(shape, "furniture_group", c, source[0]),
  ];
  image.applyOccupancyResults(next, image.occupancyOperationFingerprint());
  image.selectOccupancyLogical(c.logical_id);
  expect(image.occupancyActivePartId).toBe("");
  const part = image.occupancyLogicals[0].parts[1];
  image.editOccupancyPart(part.id);
  expect(image.occupancyActivePartId).toBe(part.id);
  const selected = annotation.selectedRegions[0];
  selected.setPoints([31, 31, 41, 31, 41, 41, 31, 41]);
  selected.setPoints([101, 101, 111, 101, 111, 111, 101, 111]);
  expect(Math.max(...selected.points.map((p) => p.x))).toBeCloseTo(100, 7);
  expect(Math.max(...selected.points.map((p) => p.y))).toBeCloseTo(100, 7);
  annotation.selectAreas([image.regs.find((r) => r.cleanId === "parent")]);
  expect(image.occupancyActivePartId).toBe("");
});

test("pending rectangles are constrained to stored parent after Focus changes, with undo and readonly preservation", () => {
  const { image, annotation } = setup();
  image.setOccupancyFocus("parent");
  image.createOccupancyGroup("storage", "");
  const region = annotation.createResult(
    { x: 10, y: 10, width: 20, height: 20, rotation: 0, coordstype: "perc" },
    {},
    annotation.names.get("occupancy_rectangle"),
    image,
  );
  image.initializeOccupancyRegion(region);
  image.setOccupancyFocus("");
  const references = image.occupancyData.filter((r) => r.readonly);
  annotation.reinitHistory(false);
  region.setPositionInternal(120, 10, 20, 20, 0);
  expect(region.x).toBeCloseTo(80, 7);
  expect(image.occupancyPending).toHaveLength(1);
  expect(image.occupancyPending[0].context.parent_zone_id).toBe("parent");
  expect(image.occupancyData.filter((r) => r.readonly)).toEqual(references);
  annotation.history.undo();
  expect(image.occupancyPending[0].parts[0].value.x).toBe(10);
});

test("native rectangle drawing clamps before commit and keeps pending metadata", () => {
  const { image } = setup();
  image.regs.find((r) => r.cleanId === "parent").setPositionInternal(10, 10, 60, 60, 0);
  image.setOccupancyFocus("parent");
  image.createOccupancyGroup("storage", "");
  image.startOccupancyTool("occupancy_rectangle");
  const tool = image.getToolsManager().findSelectedTool();
  expect({
    enabled: tool.obj.occupancyEnabled,
    sameImage: tool.obj === image,
    sameAnnotation: tool.annotation === image.annotation,
  }).toEqual({ enabled: true, sameImage: true, sameAnnotation: true });
  tool.startDrawing(20, 20);
  tool.draw(140, 130);
  const current = tool.getCurrentArea();
  expect(current.width).toBeGreaterThan(10);
  expect(tool.beforeCommitDrawing()).toBe(true);
  expect(current.x + current.width).toBeLessThanOrEqual(70.00000001);
  expect(current.y + current.height).toBeLessThanOrEqual(70.00000001);
  tool.finishDrawing(140, 130);
  expect(image.occupancyData.filter((r) => GEOMETRY.has(r.from_name))).toEqual([
    expect.objectContaining({ meta: expect.objectContaining({ occupancy_context: expect.any(Object) }) }),
  ]);
  expect(image.occupancyPending).toHaveLength(1);
  expect(image.occupancyPending[0].context.parent_zone_id).toBe("parent");
  expect(image.occupancyData.filter((r) => r.from_name === "occupancy_type")).toHaveLength(1);
});

test("native polygon drawing rejects external vertices and edit keeps original parent", () => {
  const { image, annotation } = setup();
  image.setOccupancyFocus("parent");
  image.createOccupancyGroup("storage", "");
  image.startOccupancyTool("occupancy_polygon");
  const tool = image.getToolsManager().findSelectedTool();
  tool.startDrawing(20, 20);
  const region = tool.getCurrentArea();
  region.addPoint(40, 20);
  region.addPoint(140, 30);
  expect(region.points).toHaveLength(2);
  region.addPoint(40, 40);
  region.closePoly();
  expect(region.closed).toBe(true);
  region.moveVertex(region.points[1], { x: 140, y: 20 });
  expect(region.points[1].x).toBeCloseTo(100, 7);
  expect(annotation.isDrawing).toBe(true);
});
