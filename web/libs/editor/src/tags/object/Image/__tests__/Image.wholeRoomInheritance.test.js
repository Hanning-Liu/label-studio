if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
jest.mock("keymaster", () => {
  const keymaster = () => {};
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { autorun } from "mobx";
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
import { geometryValue } from "../../../../utils/wholeRoomInheritance";
import { ReferenceSyncController } from "../../../../../../datamanager/src/sdk/reference-sync";

const CONFIG = readFileSync(
  resolve(__dirname, "../../../../../../../../examples/room-v3/function-zone-v3.xml"),
  "utf8",
);
const room = (id, polygon = false, rotation = 0) => ({
  id,
  from_name: polygon ? "room_polygon" : "room_rectangle",
  to_name: "image",
  type: polygon ? "polygonlabels" : "rectanglelabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  readonly: true,
  meta: {
    room_graph_node: {
      schema_version: 3,
      node_id: id,
      room_type: "Bathroom",
      geometry_type: polygon ? "polygon" : "rectangle",
    },
  },
  value: polygon
    ? {
        points: [
          [40, 1],
          [60, 1],
          [60, 10],
          [50, 10],
          [50, 20],
          [40, 20],
        ],
        closed: true,
        polygonlabels: ["Bathroom"],
      }
    : {
        x: 10.1234567890123,
        y: 10.2345678901234,
        width: 15.0123456789012,
        height: 15.1234567890123,
        rotation,
        rectanglelabels: ["Bathroom"],
      },
});
const portal = {
  id: "door-a",
  from_name: "portal_vector",
  to_name: "image",
  type: "vectorlabels",
  readonly: true,
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  value: {
    vertices: [
      { x: 40, y: 2 },
      { x: 40, y: 8 },
    ],
    closed: false,
    vectorlabels: ["Open passage"],
  },
  meta: {
    room_graph_edge: {
      schema_version: 3,
      connected_room_ids: ["a", "b"],
      boundary_segments: {
        b: [
          [
            { x: 40, y: 2 },
            { x: 40, y: 8 },
          ],
        ],
      },
    },
  },
};
function setup(results = [room("a"), room("b", true), portal], enabled = true) {
  const store = AppStore.create(
    {
      config: enabled ? CONFIG : CONFIG.replace('wholeRoomZoneInheritance="true"', ""),
      task: { id: 1, data: JSON.stringify({ image: "https://example.com/plan.png" }) },
      interfaces: ["basic"],
    },
    {
      events: { hasEvent: jest.fn(() => false), invoke: jest.fn(), invokeFirst: jest.fn() },
      messages: {},
      settings: {},
    },
  );
  store.initializeStore({ annotations: [{ result: results }] });
  const annotation = store.annotationStore.selected;
  const image = annotation.names.get("image");
  image.naturalWidth = 100;
  image.naturalHeight = 100;
  annotation.reinitHistory(false);
  return { store, annotation, image };
}
const choices = (image) =>
  image.wholeRoomCandidates
    .filter((candidate) => candidate.eligible)
    .map((candidate) => ({
      roomId: candidate.id,
      label: candidate.suggestedLabel,
      sourceFingerprint: candidate.sourceFingerprint,
    }));

test("reference refresh preserves manual results, zoom and Focus room in the real editor store", () => {
  const { annotation, image } = setup();
  image.generateWholeRoomZones(choices(image));
  image.setFocusedRoom("a");
  image.setZoom(2);
  const before = annotation.serializeAnnotation({ fast: true });
  const changed = JSON.parse(JSON.stringify(before));
  changed.find((result) => result.id === "a").value.rectanglelabels = ["Hallway"];
  const controller = new ReferenceSyncController({ task: { id: 1 }, currentAnnotation: annotation });
  controller.replace(annotation, { id: 7, result: changed, updated_at: "2026-08-26T00:00:00Z", reference_version: "new", base_manual_hash: "m" }, true);
  expect(annotation.serializeAnnotation({ fast: true }).filter((result) => !result.readonly)).toEqual(before.filter((result) => !result.readonly));
  expect(image.focusedRoomId).toBe("a");
  expect(image.currentZoom).toBe(2);
  expect(annotation.referenceVersion).toBe("new");
  expect(annotation.draftId).toBe(7);
  expect(annotation.savedResultFingerprint).toBe(annotation.draftResultFingerprint);
});

test("reference review metadata stays on geometry rather than paired function labels", () => {
  const { annotation, image } = setup();
  image.generateWholeRoomZones(choices(image));
  const result = annotation.serializeAnnotation({ fast: true });
  const geometry = result.find((entry) => entry.from_name === "zone_rectangle");
  geometry.meta.reference_review = { status: "pending", revision: "r", reason: "room_or_portal_changed" };
  const loaded = setup(result).annotation.serializeAnnotation({ fast: true });
  expect(loaded.find((entry) => entry.id === geometry.id && entry.from_name === "zone_rectangle").meta.reference_review.status).toBe("pending");
  expect(loaded.find((entry) => entry.id === geometry.id && entry.from_name === "function_zone").meta?.reference_review).toBeUndefined();
});

test("generates paired editable results, preserves originals, assigns Portal context, and is idempotent", () => {
  const { annotation, image } = setup();
  expect(image.wholeRoomInheritanceEnabled).toBe(true);
  const before = annotation.serializeAnnotation();
  const selection = choices(image);
  expect(selection).toHaveLength(2);
  const ids = image.generateWholeRoomZones(selection);
  expect(new Set(ids).size).toBe(2);
  expect(ids.some((id) => ["a", "b"].includes(id))).toBe(false);
  const after = annotation.serializeAnnotation();
  expect(after.filter((result) => before.some((old) => old.id === result.id))).toEqual(before);
  for (const zone of image.wholeRoomZones) {
    expect(zone.region.isReadOnly()).toBeFalsy();
    expect(zone.region.results).toHaveLength(2);
    expect(geometryValue(zone.result)).toEqual(geometryValue(zone.source.result));
    expect(zone.review).toMatchObject({ reviewed: false, wholeRoom: true });
  }
  expect(
    image.wholeRoomZones.find((zone) => zone.parentRoomId === "b").result.meta.partition_context.opening_ids,
  ).toEqual(["door-a"]);
  expect(choices(image)).toHaveLength(0);
  expect(() => image.generateWholeRoomZones(selection)).toThrow("预览后");
  expect(annotation.serializeAnnotation()).toEqual(after);
});
test("generation and subdivision each undo in one step, keeping focus and references", () => {
  const { annotation, image } = setup();
  const before = annotation.serializeAnnotation();
  image.generateWholeRoomZones(choices(image));
  annotation.history.undo();
  expect(annotation.serializeAnnotation()).toEqual(before);
  annotation.history.redo();
  const zone = image.wholeRoomZones[0];
  const generated = annotation.serializeAnnotation();
  image.startWholeRoomSubdivision(zone.id);
  expect(image.focusedRoom.cleanId).toBe("a");
  expect(image.wholeRoomZones).toHaveLength(1);
  annotation.history.undo();
  expect(annotation.serializeAnnotation()).toEqual(expect.arrayContaining(generated));
  expect(annotation.serializeAnnotation()).toHaveLength(generated.length);
});
test("pending does not block drafts; batch confirmation persists and label edits invalidate it", async () => {
  const { annotation, image } = setup();
  const ids = image.generateWholeRoomZones(choices(image));
  expect(image.validateWholeRoomInheritance()[0]).toContain("2 个");
  await expect(annotation.saveDraftImmediatelyWithResults()).resolves.toBeUndefined();
  image.confirmWholeRoomZones(ids);
  expect(image.validateWholeRoomInheritance()).toEqual([]);
  const reload = setup(JSON.parse(JSON.stringify(annotation.serializeAnnotation())));
  expect(reload.image.wholeRoomZones.every((zone) => zone.review.reviewed)).toBe(true);
  image.setWholeRoomZoneLabel(ids[0], "Toilet");
  expect(image.wholeRoomZones[0].label).toBe("Toilet");
  expect(image.validateWholeRoomInheritance()[0]).toContain("1 个");
  expect(image.wholeRoomZones[0].result.meta.zone_inheritance.review_status).toBe("pending");
});
test("changed parent geometry is not silently copied and requires review", () => {
  const { annotation, image } = setup();
  image.confirmWholeRoomZones(image.generateWholeRoomZones(choices(image)));
  const exported = annotation.serializeAnnotation();
  exported.find((result) => result.id === "a").value.width += 2;
  const reloaded = setup(exported).image;
  const changed = reloaded.wholeRoomZones.find((zone) => zone.parentRoomId === "a");
  expect(changed.review).toMatchObject({ sourceChanged: true, wholeRoom: false, reviewed: false });
  expect(reloaded.wholeRoomSubdivisionReason(changed.id)).toContain("调整");
});
test("disabled projects do not opt old manual annotations into confirmation", () => {
  const { image } = setup(undefined, false);
  expect(image.wholeRoomInheritanceEnabled).toBe(false);
  expect(image.validateWholeRoomInheritance()).toEqual([]);
  expect(() => image.generateWholeRoomZones(choices(image))).toThrow("未启用");
});

test("rotated rectangles preserve exact serialized geometry and metadata stays only on geometry", () => {
  const { annotation, image } = setup([room("rotated", false, 21.1234567891234)]);
  image.generateWholeRoomZones(choices(image));
  expect(geometryValue(image.wholeRoomZones[0].result)).toEqual(geometryValue(image.wholeRoomSources[0].result));
  expect(
    annotation.serializeAnnotation().find((result) => result.from_name === "function_zone").meta?.zone_inheritance,
  ).toBeUndefined();
});

test("partial manual zones are skipped without review requirements; orphan zones block generation", () => {
  const { annotation, image } = setup();
  image.generateWholeRoomZones(choices(image).slice(0, 1));
  const exported = annotation.serializeAnnotation();
  const manual = exported.find((result) => result.from_name === "zone_rectangle");
  delete manual.meta.zone_inheritance;
  manual.value.width /= 2;
  const partial = setup(exported).image;
  expect(choices(partial)).toHaveLength(1);
  expect(partial.validateWholeRoomInheritance()).toEqual([]);
  const orphaned = JSON.parse(JSON.stringify(exported));
  orphaned.find((result) => result.from_name === "zone_rectangle").meta.partition_context.parent_room_id = "unknown";
  expect(choices(setup(orphaned).image)).toHaveLength(0);
});

test("relations prevent shortcut deletion without changing any results", () => {
  const { annotation, image } = setup();
  image.generateWholeRoomZones(choices(image));
  const [zone, other] = image.wholeRoomZones;
  annotation.relationStore.addRelation(zone.region.id, other.region.id);
  const before = annotation.serializeAnnotation();
  expect(image.wholeRoomSubdivisionReason(zone.id)).toContain("Relations");
  expect(() => image.startWholeRoomSubdivision(zone.id)).toThrow("Relations");
  expect(annotation.serializeAnnotation()).toEqual(before);
});

test("saving legacy paired category results does not introduce geometry metadata", () => {
  const { annotation, image } = setup();
  image.generateWholeRoomZones(choices(image).slice(0, 1));
  const existing = JSON.parse(JSON.stringify(annotation.serializeAnnotation()));
  const geometry = existing.find((result) => result.from_name === "zone_rectangle");
  delete geometry.meta.zone_inheritance;
  const category = existing.find((result) => result.from_name === "function_zone");
  delete category.meta;
  const reloaded = setup(existing);
  reloaded.image.generateWholeRoomZones(choices(reloaded.image));
  const saved = reloaded.annotation
    .serializeAnnotation()
    .find((result) => result.id === category.id && result.from_name === "function_zone");
  expect(saved).toEqual(category);
});

test("observed review and save-status views react to metadata and geometry edits", async () => {
  const { annotation, image } = setup();
  const ids = image.generateWholeRoomZones(choices(image));
  let observedZones;
  let observedFingerprint;
  const dispose = autorun(() => {
    observedZones = image.wholeRoomZones;
    observedFingerprint = annotation.draftResultFingerprint;
  });
  try {
    await annotation.saveDraftImmediatelyWithResults();
    expect(observedFingerprint).toBe(annotation.savedResultFingerprint);
    image.confirmWholeRoomZones(ids);
    expect(observedZones.every((zone) => zone.review.reviewed)).toBe(true);
    expect(observedFingerprint).not.toBe(annotation.savedResultFingerprint);
    await annotation.saveDraftImmediatelyWithResults();
    expect(observedFingerprint).toBe(annotation.savedResultFingerprint);
    const rectangle = observedZones.find((zone) => zone.result.type === "rectangle").region;
    rectangle.setPositionInternal(rectangle.x, rectangle.y, rectangle.width / 2, rectangle.height, rectangle.rotation);
    expect(observedZones.find((zone) => zone.id === rectangle.cleanId).review.reviewed).toBe(false);
    expect(observedFingerprint).not.toBe(annotation.savedResultFingerprint);
    await annotation.saveDraftImmediatelyWithResults();
    expect(observedFingerprint).toBe(annotation.savedResultFingerprint);
  } finally {
    dispose();
  }
});
