import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { roomMetadataActions } from "@hanning/frontend/models/roomActions";
import { focusOccupancy } from "@hanning/frontend/domain/occupancy/focus";
import { RoomValidationContent, roomValidationItems, locateRoomValidation } from "@hanning/frontend/components/rooms/submitValidation";

jest.mock("@hanning/frontend/domain/occupancy/focus", () => ({ focusOccupancy: jest.fn().mockResolvedValue() }));
afterEach(() => { cleanup(); jest.clearAllMocks(); });

const rectangle = (id, index, label, control, x, y, width, height) => ({
  cleanId: id, region_index: index, labelName: label, type: "rectangleregion", x, y, width, height,
  results: [{ from_name: { name: control }, setMetaValue: jest.fn() }],
});
const setup = () => {
  const room = rectangle("room", 1, "Bedroom", "rooms", 10, 20, 40, 30);
  const portal = rectangle("door", 15, "Door", "portals", 20, 19, 10, 2);
  const identity = (value) => value;
  const item = {
    roomv3validate: true, roomv3tolerance: 0.02,
    roomV3Regions: [room], roomV3PortalRegions: [portal], regs: [room, portal],
    roomV3RoomControlNames: new Set(["rooms"]),
    roomV3PortalRectangleControlNames: new Set(["portals"]), roomV3PortalVectorControlNames: new Set(["passages"]),
    internalToCanvasX: identity, internalToCanvasY: identity, canvasToInternalX: identity, canvasToInternalY: identity,
    internalToImageX: identity, internalToImageY: identity,
    l1ToolbarEnabled: true, selectL1MoveTool: jest.fn(() => true),
    annotation: { unselectAreas: jest.fn(), selectAreas: jest.fn() },
  };
  return { item, room, portal };
};

test("overlapping door identifies the exact room without changing legacy errors or result metadata", () => {
  const { item, room, portal } = setup();
  const actions = roomMetadataActions(item);
  const oldErrors = actions.refreshRoomV3Metadata();
  const originalMetadata = portal.results[0].setMetaValue.mock.calls[0];
  const issues = [];
  expect(actions.refreshRoomV3Metadata(issues)).toEqual(oldErrors);
  expect(portal.results[0].setMetaValue.mock.calls[1]).toEqual(originalMetadata);
  expect(issues.map((issue) => issue.message)).toEqual(oldErrors);
  const overlap = issues.find((issue) => issue.message.includes("净空间"));
  expect(overlap.regionIds).toEqual([portal.cleanId, room.cleanId]);
  const [display] = roomValidationItems(item, [overlap]);
  expect(display.message).toContain("#15 Door");
  expect(display.targets.map((target) => target.title)).toEqual(["#15 Door", "#1 Bedroom"]);
  expect(display.hint).toContain("缩小或移动");
});

test("room overlap exposes both regions; touching rooms remain valid", () => {
  const { item, room } = setup();
  item.roomV3PortalRegions = [];
  const second = rectangle("room2", 2, "Kitchen", "rooms", 49, 20, 30, 30);
  item.roomV3Regions.push(second);
  const issues = [];
  roomMetadataActions(item).refreshRoomV3Metadata(issues);
  expect(issues[0].regionIds).toEqual([room.cleanId, second.cleanId]);
  second.x = 50;
  expect(roomMetadataActions(item).refreshRoomV3Metadata([])).toEqual([]);
});

test("invalid polygon and unsupported vector have actionable targets", () => {
  const { item, room, portal } = setup();
  room.type = "polygonregion";
  room.points = [{ x: 10, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }, { x: 30, y: 10 }];
  portal.type = "vectorregion";
  portal.results[0].from_name.name = "passages";
  portal.vertices = [{ x: 60, y: 60 }, { x: 70, y: 60 }];
  const issues = [];
  roomMetadataActions(item).refreshRoomV3Metadata(issues);
  expect(issues.find((issue) => issue.message.includes("自交")).regionIds).toEqual(["room"]);
  expect(issues.find((issue) => issue.message.includes("共享边界")).regionIds).toEqual(["door"]);
});

test("locate selects only the requested region, switches to move and respects the sticky dock", async () => {
  const { item, portal } = setup();
  const original = JSON.stringify(portal);
  await expect(locateRoomValidation(item, "door")).resolves.toBe(portal);
  expect(item.selectL1MoveTool).toHaveBeenCalledTimes(1);
  expect(item.annotation.selectAreas).toHaveBeenCalledWith([portal]);
  expect(focusOccupancy).toHaveBeenCalledWith(item, [[[[20, 19], [30, 19], [30, 21], [20, 21]]]], '[data-testid="l1-tools"]');
  expect(JSON.stringify(portal)).toBe(original);
});

test.each(["isDrawing", "hasIncompletePolygons"])("locate never interrupts %s", async (flag) => {
  const { item } = setup();
  item.annotation[flag] = true;
  await expect(locateRoomValidation(item, "door")).rejects.toThrow("完成绘制");
  expect(item.annotation.unselectAreas).not.toHaveBeenCalled();
});

test("missing regions and blocked tool switching fail without changing selection", async () => {
  const { item } = setup();
  await expect(locateRoomValidation(item, "gone")).rejects.toThrow("已不存在");
  item.selectL1MoveTool.mockReturnValue(false);
  await expect(locateRoomValidation(item, "door")).rejects.toThrow("不能切换");
  expect(item.annotation.selectAreas).not.toHaveBeenCalled();
});

test("each displayed region can be located and failures remain visible", async () => {
  const { item } = setup();
  const onLocate = jest.fn().mockRejectedValue(new Error("画布未就绪"));
  render(<RoomValidationContent items={roomValidationItems(item, [{ message: "door 与 room 重叠", regionIds: ["door", "room"], hint: "调整边界" }])} onLocate={onLocate} />);
  fireEvent.click(screen.getByRole("button", { name: "定位相关房间 #1 Bedroom" }));
  await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("画布未就绪"));
  expect(onLocate).toHaveBeenCalledWith("room");
  expect(screen.getByRole("button", { name: "定位并选中 #15 Door" })).not.toBeDisabled();
});
