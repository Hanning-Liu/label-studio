import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WholeRoomInheritanceControls } from "../WholeRoomInheritanceControls";
jest.mock("antd", () => ({
  Modal: ({ visible, title, children }) =>
    visible ? (
      <div role="dialog" aria-label={title}>
        {children}
      </div>
    ) : null,
}));

function setup() {
  URL.createObjectURL = jest.fn(() => "blob:recovery");
  URL.revokeObjectURL = jest.fn();
  jest.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const annotation = {
    editable: true,
    isReadOnly: () => false,
    serializeAnnotation: () => [],
    draftResultFingerprint: "[]",
    savedResultFingerprint: "[]",
    draftSaved: new Date().toISOString(),
    saveDraftImmediatelyWithResults: jest.fn().mockResolvedValue({ id: 1 }),
    store: { task: { id: 20, data: '{"image":"plan.png"}' }, config: "<View/>" },
  };
  const item = {
    annotation,
    wholeRoomInheritanceEnabled: true,
    wholeRoomZones: [],
    wholeRoomLabels: ["Sleeping"],
    wholeRoomSubdivisionReason: () => "请选择房间",
    assertWholeRoomEditable: jest.fn(),
    wholeRoomCandidates: [
      { id: "room-a", roomType: "Bedroom", suggestedLabel: "Sleeping", eligible: true, sourceFingerprint: "v1" },
    ],
    generateWholeRoomZones: jest.fn(() => ["zone-a"]),
    confirmWholeRoomZones: jest.fn(),
  };
  render(<WholeRoomInheritanceControls item={item} />);
  return { item, annotation };
}
afterEach(() => jest.restoreAllMocks());

test("canceling the preview neither saves nor changes results", () => {
  const { item, annotation } = setup();
  fireEvent.click(screen.getByText("为空房间生成整室分区", { selector: "button" }));
  fireEvent.click(screen.getByText("取消"));
  expect(annotation.saveDraftImmediatelyWithResults).not.toHaveBeenCalled();
  expect(item.generateWholeRoomZones).not.toHaveBeenCalled();
});
test("a failed preflight save or version conflict cannot mutate results", async () => {
  const { item, annotation } = setup();
  annotation.saveDraftImmediatelyWithResults.mockRejectedValue(new Error("草稿版本冲突"));
  fireEvent.click(screen.getByText("为空房间生成整室分区", { selector: "button" }));
  fireEvent.click(screen.getByText("保存备份并生成（1）"));
  await waitFor(() => expect(screen.getAllByText(/草稿版本冲突/).length).toBeGreaterThan(0));
  expect(item.generateWholeRoomZones).not.toHaveBeenCalled();
  expect(URL.createObjectURL).not.toHaveBeenCalled();
});
test("generation saves before and after, exports recovery first, and never confirms automatically", async () => {
  const { item, annotation } = setup();
  fireEvent.click(screen.getByText("为空房间生成整室分区", { selector: "button" }));
  fireEvent.click(screen.getByText("保存备份并生成（1）"));
  await waitFor(() => expect(annotation.saveDraftImmediatelyWithResults).toHaveBeenCalledTimes(2));
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(item.generateWholeRoomZones.mock.invocationCallOrder[0]).toBeGreaterThan(
    URL.createObjectURL.mock.invocationCallOrder[0],
  );
  expect(item.confirmWholeRoomZones).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).toBeNull();
});
