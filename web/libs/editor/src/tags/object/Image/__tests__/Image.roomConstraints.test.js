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
import "../Image";
import "../../../control/Label";
import "../../../control/RectangleLabels";
import "../../../control/PolygonLabels";
import "../../../control/VectorLabels";
import AppStore from "../../../../stores/AppStore";

const CONFIG = `
  <View>
    <Image name="image" value="$image" />
    <RectangleLabels name="label" toName="image"><Label value="Bathroom" /></RectangleLabels>
    <PolygonLabels name="polygon_label" toName="image"><Label value="Bathroom" /></PolygonLabels>
    <VectorLabels name="opening_label" toName="image"><Label value="Door" /></VectorLabels>
    <RectangleLabels name="partition_rectangle" toName="image"
      constrainTo="label,polygon_label" openingFrom="opening_label"
      constraintSnapPx="10" openingSnapAngleDeg="5"><Label value="Zone" /></RectangleLabels>
  </View>
`;

const environment = {
  events: {
    hasEvent: jest.fn(() => false),
    invoke: jest.fn(),
    invokeFirst: jest.fn(),
  },
  messages: {},
  settings: {},
};

const roomResult = (index) => {
  const rectangle = index < 9;
  return {
    id: `room-${index}`,
    from_name: rectangle ? "label" : "polygon_label",
    to_name: "image",
    type: rectangle ? "rectanglelabels" : "polygonlabels",
    original_width: 100,
    original_height: 100,
    image_rotation: 0,
    readonly: true,
    meta: {
      room_graph_node: {
        schema_version: 1,
        node_id: `room-${index}`,
        room_type: index < 2 ? "Bathroom" : `Room ${index}`,
        geometry_type: rectangle ? "rectangle" : "polygon",
      },
    },
    value: rectangle
      ? { x: index, y: index, width: 20, height: 20, rotation: 0, rectanglelabels: ["Bathroom"] }
      : {
          points: [
            [index, index],
            [index + 20, index],
            [index + 20, index + 20],
            [index, index + 20],
          ],
          closed: true,
          polygonlabels: ["Bathroom"],
        },
  };
};

const openingResult = (index) => ({
  id: `opening-${index}`,
  from_name: "opening_label",
  to_name: "image",
  type: "vectorlabels",
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  readonly: true,
  meta: {
    room_graph_edge: {
      schema_version: 1,
      edge_id: `opening-${index}`,
      room_ids: [`room-${index % 17}`, `room-${(index + 1) % 17}`],
      opening_type: "Door",
    },
  },
  value: {
    vertices: [
      { x: 10, y: index + 1 },
      { x: 20, y: index + 1 },
    ],
    closed: false,
    vectorlabels: ["Door"],
  },
});

const REFERENCE_RESULTS = [
  ...Array.from({ length: 17 }, (_, index) => roomResult(index)),
  ...Array.from({ length: 19 }, (_, index) => openingResult(index)),
];

const createStore = (taskId = 1) => {
  const store = AppStore.create(
    {
      config: CONFIG,
      task: { id: taskId, data: JSON.stringify({ image: "https://example.com/floor-plan.png" }) },
      interfaces: ["basic"],
    },
    environment,
  );
  store.initializeStore({
    annotations: [],
    predictions: [{ id: taskId, model_version: "room-layout-reference-v1", result: REFERENCE_RESULTS }],
  });
  return store;
};

describe("Image room constraint prediction model", () => {
  test("recognizes 17 room candidates, 19 openings, and duplicate room names", () => {
    const store = createStore();
    const prediction = store.annotationStore.predictions[0];
    const image = prediction.names.get("image");

    expect(image.hasRoomConstraints).toBe(true);
    expect(image.roomReferenceRegions).toHaveLength(17);
    expect(image.openingReferenceRegions).toHaveLength(19);
    expect(image.focusRoomOptions).toHaveLength(17);
    expect(image.focusRoomOptions.filter((option) => option.label.startsWith("Bathroom ·"))).toHaveLength(2);
    expect(image.roomReferenceRegions.every((region) => region.isRoomLayoutReference)).toBe(true);
    expect(image.openingReferenceRegions.every((region) => region.isReadOnly())).toBe(true);
  });

  test("focus is local to a task model and is cleared by task reconstruction", () => {
    const first = createStore(1).annotationStore.predictions[0].names.get("image");
    first.setFocusedRoom("room-0");
    expect(first.focusedRoom.cleanId).toBe("room-0");

    const second = createStore(2).annotationStore.predictions[0].names.get("image");
    expect(second.focusedRoom).toBeNull();
  });
});
