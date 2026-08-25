import fs from "fs";
import path from "path";

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

describe("Room v3 project configs", () => {
  test("Room v3 exposes editable room/portal controls and disables only the v2 reference tool", () => {
    const image = createStore(loadConfig("room-v3.xml")).annotationStore.annotations[0].names.get("image");
    expect(image.roomv3validate).toBe(true);
    expect([...image.roomV3RoomControlNames]).toEqual(["room_rectangle", "room_polygon"]);
    expect([...image.roomV3PortalRectangleControlNames]).toEqual(["portal_rectangle"]);
    expect([...image.roomV3PortalVectorControlNames]).toEqual(["portal_vector"]);
    expect([...image.roomV3ReferenceControlNames]).toEqual(["portal_v2_reference"]);
  });

  test("FunctionZone v3 enables schema-v3 partition and connectivity-review validation", () => {
    const image = createStore(loadConfig("function-zone-v3.xml")).annotationStore.annotations[0].names.get("image");
    expect(image.functionzonev3validate).toBe(true);
    expect(image.partitioncontextschema).toBe("3");
    expect(image.geometryReviewControlFor("connection_vector")).toBe("connection_review");
    expect(image.geometryReviewControlFor("visual_connection_vector")).toBe("visual_connection_review");
  });
});
