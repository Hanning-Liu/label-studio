import { TextEncoder } from "util";

global.TextEncoder = TextEncoder;
if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));

jest.mock("keymaster", () => {
  const keymaster = () => {};
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});
// This suite does not exercise occupancy clipping. Keep it isolated from the
// host checkout's optional polygon-clipping transitive dependency.
jest.mock("polygon-clipping", () => ({
  __esModule: true,
  default: {
    union: jest.fn(() => []),
    difference: jest.fn(() => []),
    intersection: jest.fn(() => []),
    xor: jest.fn(() => []),
  },
}));
jest.mock("../../../../components/Infomodal/Infomodal", () => ({
  __esModule: true,
  default: { warning: jest.fn() },
}));

import "../../../visual/View";
import "../Image";
import "../../../control/Label";
import "../../../control/RectangleLabels";
import "../../../control/PolygonLabels";
import "../../../control/VectorLabels";
import InfoModal from "../../../../components/Infomodal/Infomodal";
import AppStore from "../../../../stores/AppStore";

const CONFIG = `
  <View>
    <Image name="image" value="$image" roomWindowV1="true"
      roomV3Controls="room_rectangle,room_polygon" windowControls="window_vector"
      windowBoundaryMatchTolerancePx="2" windowMaximumTangentDeltaDeg="10"
      windowFlatteningTolerancePx="0.5" />
    <RectangleLabels name="room_rectangle" toName="image"><Label value="Bedroom" /></RectangleLabels>
    <PolygonLabels name="room_polygon" toName="image"><Label value="Bedroom" /></PolygonLabels>
    <VectorLabels name="window_vector" toName="image" closable="false" curves="true" minPoints="2">
      <Label value="Window" />
    </VectorLabels>
  </View>
`;

const environment = {
  events: { hasEvent: jest.fn(() => false), invoke: jest.fn(), invokeFirst: jest.fn() },
  messages: {},
  settings: {},
};

const room = (id = "room-a") => ({
  id,
  from_name: "room_rectangle",
  to_name: "image",
  type: "rectanglelabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  readonly: true,
  value: { x: 0, y: 0, width: 50, height: 50, rotation: 0, rectanglelabels: ["Bedroom"] },
  meta: { room_graph_node: { schema_version: 3, node_id: id, room_type: "Bedroom", geometry_type: "rectangle" } },
});

const windowResult = (vertices, context = null) => ({
  id: "window-a",
  from_name: "window_vector",
  to_name: "image",
  type: "vectorlabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  value: { closed: false, vectorlabels: ["Window"], vertices },
  ...(context ? { meta: { window_context: context } } : {}),
});

const line = (y = 0) => [
  { id: "a", x: 10, y, isBezier: false },
  { id: "b", prevPointId: "a", x: 40, y, isBezier: false },
];

function setup(results, config = CONFIG) {
  const store = AppStore.create(
    {
      config,
      task: { id: 1, data: JSON.stringify({ image: "https://example.com/plan.png" }) },
      interfaces: ["basic"],
    },
    environment,
  );
  store.initializeStore({ annotations: [{ result: structuredClone(results) }] });
  const annotation = store.annotationStore.selected;
  const image = annotation.names.get("image");
  image.naturalWidth = 100;
  image.naturalHeight = 100;
  annotation.reinitHistory(false);
  return { annotation, image };
}

test("Image beforeSend derives parent metadata without changing raw Bezier geometry", () => {
  const vertices = [
    {
      id: "a",
      x: 10,
      y: 0,
      isBezier: true,
      controlPoint1: { x: 9, y: 0 },
      controlPoint2: { x: 20, y: 0 },
    },
    {
      id: "b",
      prevPointId: "a",
      x: 40,
      y: 0,
      isBezier: true,
      controlPoint1: { x: 30, y: 0 },
      controlPoint2: { x: 41, y: 0 },
    },
  ];
  const { annotation, image } = setup([room(), windowResult(vertices)]);
  const before = annotation.serializeAnnotation({ fast: true }).find((result) => result.id === "window-a").value;
  image.beforeSend();
  const saved = annotation.serializeAnnotation({ fast: true }).find((result) => result.id === "window-a");
  expect(saved.value).toEqual(before);
  expect(saved.meta.window_context).toMatchObject({
    parent_room_id: "room-a",
    source_trace_id: "window-trace:window-a",
    derivation_status: "current",
    pairing_status: "pending",
  });
  expect(saved.meta.window_context).not.toHaveProperty("connection");
  expect(image.validate()).toBe(true);
});

test("Image validation blocks and selects the first unassigned window", () => {
  InfoModal.warning.mockClear();
  const { annotation, image } = setup([room(), windowResult(line(20))]);
  expect(image.validate()).toBe(false);
  expect(annotation.selectedRegions).toHaveLength(1);
  expect(annotation.selectedRegions[0].cleanId).toBe("window-a");
  expect(InfoModal.warning).toHaveBeenCalledWith(expect.stringContaining("窗线 window-a"));
});

test("edited window serialization uses refreshed result context instead of stale area metadata", () => {
  const stale = {
    schema_version: 1,
    parent_room_id: "room-a",
    source_trace_id: "window-trace:window-a",
    source_window_trace_fingerprint: "0".repeat(64),
    source_room_fingerprint: "1".repeat(64),
    parent_derivation: { room_fingerprint: "1".repeat(64) },
    pairing_status: "exterior",
    pairing_search: { status: "complete", candidate_count: 0 },
    connection: { connection_kind: "room_to_exterior" },
  };
  const { annotation, image } = setup([room(), windowResult(line(), stale)]);
  const region = image.windowRegions[0];
  region.updatePointsFromKonvaVector([
    { id: "a", x: 12, y: 0, isBezier: false },
    { id: "b", prevPointId: "a", x: 42, y: 0, isBezier: false },
  ]);
  const saved = annotation.serializeAnnotation({ fast: true }).find((result) => result.id === "window-a");
  expect(saved.meta.window_context.source_window_trace_fingerprint).not.toBe("0".repeat(64));
  expect(saved.meta.window_context.pairing_status).toBe("pending");
  expect(saved.meta.window_context).not.toHaveProperty("connection");
});

test("window derivation is inert unless roomWindowV1 is enabled", () => {
  const disabledConfig = CONFIG.replace(' roomWindowV1="true"', "");
  const { annotation, image } = setup([room(), windowResult(line())], disabledConfig);
  const before = annotation.serializeAnnotation({ fast: true });
  image.beforeSend();
  expect(image.windowEnabled).toBe(false);
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
});

test("Image validation rejects invalid window thresholds before server submission", () => {
  InfoModal.warning.mockClear();
  const invalidConfig = CONFIG.replace(
    'windowBoundaryMatchTolerancePx="2"',
    'windowBoundaryMatchTolerancePx="2" windowPairSearchLimitPx="-1"',
  );
  const { image } = setup([room(), windowResult(line())], invalidConfig);
  expect(image.validate()).toBe(false);
  expect(InfoModal.warning).toHaveBeenCalledWith(expect.stringContaining("windowPairSearchLimitPx 必须大于 0"));
  expect(InfoModal.warning).not.toHaveBeenCalledWith(expect.stringContaining("已选中第一个问题窗线"));
});

test("Image validation rejects a missing configured window control", () => {
  InfoModal.warning.mockClear();
  const invalidConfig = CONFIG.replace('name="window_vector"', 'name="other_window_vector"');
  const { image } = setup([room()], invalidConfig);
  expect(image.validate()).toBe(false);
  expect(InfoModal.warning).toHaveBeenCalledWith(expect.stringContaining("窗户控件 window_vector 缺失"));
});

test("server-owned projections serialize only on downstream geometry results", () => {
  const downstreamConfig = `
    <View>
      <Image name="image" value="$image" occupancyV1="true" />
      <Labels name="occupancy_type" toName="image"><Label value="furniture_group" /></Labels>
      <Rectangle name="occupancy_rectangle" toName="image" />
    </View>
  `;
  const projections = [{ kind: "window_projection", id: "projection-a", read_only: true }];
  const state = { schema_version: 1, status: "current", level: "L3" };
  const geometry = {
    id: "group-a",
    from_name: "occupancy_rectangle",
    to_name: "image",
    type: "rectangle",
    original_width: 100,
    original_height: 100,
    image_rotation: 0,
    value: { x: 10, y: 10, width: 20, height: 20, rotation: 0 },
    meta: {
      occupancy_context: { logical_id: "logical-a", group_id: "group-a", parent_room_id: "room-a" },
      window_projections: projections,
      window_projection_state: state,
    },
  };
  const label = {
    id: "group-a",
    from_name: "occupancy_type",
    to_name: "image",
    type: "labels",
    value: { labels: ["furniture_group"] },
  };
  const { annotation } = setup([geometry, label], downstreamConfig);
  const saved = annotation.serializeAnnotation({ fast: true });
  const savedGeometry = saved.find((result) => result.from_name === "occupancy_rectangle");
  const savedLabel = saved.find((result) => result.from_name === "occupancy_type");
  expect(savedGeometry.meta.window_projections).toEqual(projections);
  expect(savedGeometry.meta.window_projection_state).toEqual(state);
  expect(savedLabel.meta || {}).not.toHaveProperty("window_projections");
  expect(savedLabel.meta || {}).not.toHaveProperty("window_projection_state");
});
