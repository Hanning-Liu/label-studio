if (!globalThis.structuredClone) globalThis.structuredClone = (value) => JSON.parse(JSON.stringify(value));
jest.mock("keymaster", () => {
  const keymaster = () => {};
  keymaster.unbind = () => {};
  keymaster.setScope = () => {};
  return { __esModule: true, default: keymaster };
});
jest.mock("antd", () => ({ Modal: ({ visible, children }) => (visible ? <div role="dialog">{children}</div> : null) }));
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { Provider } from "mobx-react";
import "../../../tags/visual/View";
import "../../../tags/object/Image/Image";
import "../../../tags/control/Label";
import "../../../tags/control/Labels/Labels";
import "../../../tags/control/RectangleLabels";
import "../../../tags/control/PolygonLabels";
import "../../../tags/control/Rectangle";
import "../../../tags/control/Polygon";
import "../../../tags/control/VectorLabels";
import "../../../tags/visual/Header";
import { HtxChoices } from "../../../tags/control/Choices";
import AppStore from "../../../stores/AppStore";
import { VectorReviewButton, VectorReviewPanel } from "../VectorReviewControls";
import { vectorReviewRows } from "../../../utils/vectorReviewDock";

afterEach(() => jest.restoreAllMocks());

const CONFIG = readFileSync(resolve(__dirname, "../../../../../../../examples/room-v3/function-zone-v3.xml"), "utf8");
const vector = (id, from_name = "connection_vector", readonly = false) => ({
  id,
  from_name,
  to_name: "image",
  type: "vectorlabels",
  readonly,
  original_width: 100,
  original_height: 100,
  image_rotation: 0,
  value: {
    vertices: [
      { x: 20, y: 20 },
      { x: 40, y: 20 },
    ],
    closed: false,
    vectorlabels: [from_name === "visual_connection_vector" ? "Visual only" : "Open passage"],
  },
  meta: { geometry_review: { status: "pending" } },
});
const RESULTS = [
  {
    id: "room-a",
    from_name: "room_rectangle",
    to_name: "image",
    type: "rectanglelabels",
    readonly: true,
    original_width: 100,
    original_height: 100,
    image_rotation: 0,
    meta: { room_graph_node: { schema_version: 3, room_type: "Bedroom" } },
    value: { x: 10, y: 10, width: 80, height: 80, rotation: 0, rectanglelabels: ["Bedroom"] },
  },
  vector("traffic"),
  vector("visual", "visual_connection_vector"),
  vector("portal", "portal_vector", true),
];
function setup(enabled = true, results = RESULTS, configOverride) {
  const store = AppStore.create(
    {
      config: configOverride || (enabled ? CONFIG : CONFIG.replace('wholeRoomZoneInheritance="true"', "")),
      task: { id: 1, data: JSON.stringify({ image: "plan.png" }) },
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
  const resultsBefore = annotation.serializeAnnotation({ fast: true });
  render(
    <Provider store={store}>
      <VectorReviewButton item={image} />
      <VectorReviewPanel item={image} />
      <div data-testid="old-location">
        <HtxChoices item={annotation.names.get("connection_review")} />
        <HtxChoices item={annotation.names.get("visual_connection_review")} />
      </div>
    </Provider>,
  );
  const select = (id) =>
    act(() => {
      annotation.unselectAreas();
      annotation.selectAreas([image.connectionVectorRegions.find((region) => region.cleanId === id)]);
    });
  return { store, annotation, image, select, resultsBefore };
}

test("mounting and locating do not confirm or mutate results; readonly Portal is excluded", () => {
  const { annotation, image, resultsBefore } = setup();
  expect(vectorReviewRows(image)).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "连通 Vector 待复核（2）" }));
  expect(within(screen.getByRole("dialog")).queryByText("portal")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "定位 Vector visual" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(within(screen.getByTestId("vector-review-panel")).getByText("visual")).toBeTruthy();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(resultsBefore);
});

test("the original checkbox is rendered once in the top panel and writes the existing per-vector result", () => {
  const { annotation, image, select, resultsBefore } = setup();
  select("traffic");
  expect(within(screen.getByTestId("old-location")).queryByRole("checkbox")).toBeNull();
  const checkbox = within(screen.getByTestId("vector-review-panel")).getByRole("checkbox", { name: "Reviewed" });
  fireEvent.click(checkbox);
  const result = annotation.serializeAnnotation({ fast: true });
  expect(result.find((r) => r.id === "traffic" && r.from_name === "connection_review")?.value).toMatchObject({
    choices: ["Reviewed"],
  });
  expect(result.some((r) => r.from_name === "visual_connection_review")).toBe(false);
  for (const old of resultsBefore)
    expect(result.find((r) => r.id === old.id && r.from_name === old.from_name)).toEqual(old);
  expect(screen.getByRole("button", { name: "连通 Vector 待复核（1）" })).toBeTruthy();
  act(() => image.connectionVectorRegions.find((r) => r.cleanId === "traffic").invalidateGeometryReview());
  expect(screen.getByRole("button", { name: "连通 Vector 待复核（2）" })).toBeTruthy();
  expect(
    within(screen.getByTestId("vector-review-panel")).getByRole("checkbox", { name: "Reviewed" }),
  ).not.toBeChecked();
});

test("visual review uses its own Choices control and can be unchecked", () => {
  const { annotation, select } = setup();
  select("visual");
  const checkbox = within(screen.getByTestId("vector-review-panel")).getByRole("checkbox", { name: "Reviewed" });
  fireEvent.click(checkbox);
  const result = annotation.serializeAnnotation({ fast: true });
  expect(result.find((r) => r.id === "visual" && r.from_name === "visual_connection_review")?.value).toMatchObject({
    choices: ["Reviewed"],
  });
  expect(result.some((r) => r.from_name === "connection_review")).toBe(false);
  fireEvent.click(within(screen.getByTestId("vector-review-panel")).getByRole("checkbox", { name: "Reviewed" }));
  expect(screen.getByRole("button", { name: "连通 Vector 待复核（2）" })).toBeTruthy();
});

test("projects without the feature retain their original checkbox location", () => {
  const { select } = setup(false);
  select("traffic");
  expect(screen.queryByTestId("vector-review-panel")).toBeNull();
  // Jest does not load the stylesheet that hides the unselected vector's control.
  const visibleControl = screen.getByTestId("old-location").querySelector(".ls-choices:not(.ls-choices_hidden)");
  expect(within(visibleControl).getByRole("checkbox", { name: "Reviewed" })).toBeTruthy();
});

test("selecting multiple vectors never exposes an accidental bulk confirmation", () => {
  const { annotation, image } = setup();
  act(() => annotation.selectAreas(image.connectionVectorRegions));
  expect(within(screen.getByTestId("vector-review-panel")).queryByRole("checkbox")).toBeNull();
});

test("bulk review saves twice, only adds paired Choices, round-trips and undoes in one step", async () => {
  const { annotation, image, resultsBefore } = setup();
  const save = jest.spyOn(annotation, "saveDraftImmediatelyWithResults").mockResolvedValue({});
  const preview = image.captureVectorReview();
  await act(async () => expect(await image.confirmAllVectorsAndSave(preview)).toBe(2));
  expect(save).toHaveBeenCalledTimes(2);
  const result = annotation.serializeAnnotation({ fast: true });
  for (const old of resultsBefore)
    expect(result.find((r) => r.id === old.id && r.from_name === old.from_name)).toEqual(old);
  expect(result.filter((r) => r.type === "choices").map((r) => [r.id, r.from_name, r.value.choices])).toEqual([
    ["traffic", "connection_review", ["Reviewed"]],
    ["visual", "visual_connection_review", ["Reviewed"]],
  ]);
  act(() => image.setVectorReview(["traffic", "visual"], true));
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(result);
  act(() => annotation.history.undo());
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(resultsBefore);
  act(() => annotation.history.redo());
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(result);
  const reloaded = setup(true, JSON.parse(JSON.stringify(result)));
  expect(vectorReviewRows(reloaded.image).every((r) => r.reviewed)).toBe(true);
});

test.each(["Network failed", "409 草稿版本冲突"])("pre-save failure (%s) makes no review mutation", async (message) => {
  const { annotation, image, resultsBefore } = setup();
  jest.spyOn(annotation, "saveDraftImmediatelyWithResults").mockRejectedValue(new Error(message));
  await act(async () => expect(image.confirmAllVectorsAndSave(image.captureVectorReview())).rejects.toThrow(message));
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(resultsBefore);
  expect(image.vectorReviewBusy).toBe(false);
});

test("post-save failure retains local reviewed results, with an explicit unsaved error and retry", async () => {
  const { annotation, image } = setup();
  const save = jest
    .spyOn(annotation, "saveDraftImmediatelyWithResults")
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("Network failed"));
  await act(async () =>
    expect(image.confirmAllVectorsAndSave(image.captureVectorReview())).rejects.toThrow("复核已保留在本地"),
  );
  expect(vectorReviewRows(image).every((r) => r.reviewed)).toBe(true);
  expect(image.vectorReviewBusy).toBe(false);
  save.mockResolvedValue({});
  await annotation.saveDraftImmediatelyWithResults();
  expect(annotation.serializeAnnotation({ fast: true }).filter((r) => r.type === "choices")).toHaveLength(2);
});

test("changes during pre-save cancel the stale batch without confirming any vector", async () => {
  const { annotation, image } = setup();
  const preview = image.captureVectorReview();
  jest.spyOn(annotation, "saveDraftImmediatelyWithResults").mockImplementation(async () => {
    image.connectionVectorRegions[0].results[0].setValue(["Door"]);
  });
  await act(async () => expect(image.confirmAllVectorsAndSave(preview)).rejects.toThrow("已变化"));
  expect(vectorReviewRows(image).every((r) => !r.reviewed)).toBe(true);
});

test("reference version changes reject preview; unapplied references block review", async () => {
  const { annotation, image, store } = setup();
  const preview = image.captureVectorReview();
  act(() => annotation.setReferenceBaseline({ reference_version: "v2", base_manual_hash: "hash" }));
  expect(() => image.setVectorReview(["traffic", "visual"], true, preview.fingerprint)).toThrow("已变化");
  act(() =>
    store.setReferenceSyncController({
      state: { status: { enabled: true, reference_version: "v3", mode: "target" } },
      subscribe: () => () => {},
    }),
  );
  expect(() => image.setVectorReview(["traffic"], true)).toThrow("新参考");
});

test("an exception during the second result write rolls back the entire batch", () => {
  const { annotation, image, resultsBefore } = setup();
  jest.spyOn(image.connectionVectorRegions[1], "addResult").mockImplementation(() => {
    throw new Error("write failure");
  });
  expect(() => image.setVectorReview(["traffic", "visual"], true)).toThrow("write failure");
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(resultsBefore);
  expect(vectorReviewRows(image).every((r) => !r.reviewed)).toBe(true);
});

test("only pending rows are included; portal, missing ids and duplicates never get confirmed", () => {
  const { annotation, image } = setup();
  act(() => image.setVectorReview(["traffic"], true));
  expect(image.captureVectorReview().rows.map((r) => r.id)).toEqual(["visual"]);
  const before = annotation.serializeAnnotation({ fast: true });
  for (const ids of [["portal"], ["missing"], ["visual", "visual"]])
    expect(() => image.setVectorReview(ids, true)).toThrow();
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(before);
});

test("bulk button requires explicit confirmation; cancel and opening the list are non-mutating", async () => {
  const { annotation, image, resultsBefore } = setup();
  const save = jest.spyOn(annotation, "saveDraftImmediatelyWithResults").mockResolvedValue({});
  fireEvent.click(screen.getByRole("button", { name: "复核全部（2）", exact: true }));
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(resultsBefore);
  fireEvent.click(screen.getByRole("button", { name: "取消", exact: true }));
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "复核全部（2）", exact: true }));
  fireEvent.click(screen.getByRole("button", { name: "已检查，确认全部", exact: true }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByRole("button", { name: "复核全部（0）", exact: true })).toBeDisabled();
  expect(vectorReviewRows(image).every((r) => r.reviewed)).toBe(true);
});

test("concurrent double click cannot start a second save/mutation", async () => {
  const { annotation, image } = setup();
  let release;
  jest
    .spyOn(annotation, "saveDraftImmediatelyWithResults")
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({});
  const preview = image.captureVectorReview();
  let operation;
  act(() => {
    operation = image.confirmAllVectorsAndSave(preview);
  });
  await expect(image.confirmAllVectorsAndSave(preview)).rejects.toThrow("重复点击");
  await act(async () => {
    release({});
    await operation;
  });
  expect(annotation.serializeAnnotation({ fast: true }).filter((r) => r.type === "choices")).toHaveLength(2);
});

test("room reference hotkeys are inert in FunctionZone but the control definitions remain", () => {
  const { annotation, image } = setup();
  const label = annotation.names.get("room_rectangle").children[0];
  const interact = jest.spyOn(label, "onLabelInteract");
  const selectedTool = image.getToolsManager().findSelectedTool();
  act(() => label.onHotKey());
  expect(interact).not.toHaveBeenCalled();
  expect(image.roomReferenceRegions).toHaveLength(1);
  expect(image.getToolsManager().findSelectedTool()).toBe(selectedTool);
  expect(image.roomReferenceRegions[0].isReadOnly()).toBe(true);
});

test("L1 label shortcuts retain their original interaction", () => {
  const { annotation } = setup(
    false,
    RESULTS,
    CONFIG.replace('functionZoneV3Validate="true"', "").replace('wholeRoomZoneInheritance="true"', ""),
  );
  const label = annotation.names.get("room_rectangle").children[0];
  const interact = jest.spyOn(label, "onLabelInteract").mockImplementation(() => {});
  act(() => label.onHotKey());
  expect(interact).toHaveBeenCalledTimes(1);
});

test("review centering can pan an edge line without changing results or normal pan constraints", () => {
  const { annotation, image, resultsBefore } = setup();
  act(() => {
    image.setZoomPosition(50, 50, { reviewFocus: true });
  });
  expect(annotation.serializeAnnotation({ fast: true })).toEqual(resultsBefore);
  act(() => image.setZoomPosition(50, 50));
  expect(image.zoomingPositionX).toBeLessThanOrEqual(0);
  expect(image.zoomingPositionY).toBeLessThanOrEqual(0);
});
