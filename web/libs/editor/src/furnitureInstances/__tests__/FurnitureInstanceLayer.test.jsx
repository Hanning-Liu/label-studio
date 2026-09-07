import { fireEvent, render, screen } from "@testing-library/react";

import { FurnitureInstanceLayer } from "../FurnitureInstanceLayer";

jest.mock("react-konva", () => ({
  Layer: ({ children, listening }) => (
    <div data-testid="logical-layer" data-listening={String(listening)}>
      {children}
    </div>
  ),
  Group: ({ children, name, onClick }) => (
    <button type="button" data-testid={name} onClick={onClick}>
      {children}
    </button>
  ),
  Path: ({ data, fillRule }) => <span data-testid="geometry-path" data-path={data} data-fill-rule={fillRule} />,
  Text: ({ text }) => <span>{text}</span>,
}));

const polygon = (left, top, right, bottom, hole = null) => [
  [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ],
  ...(hole ? [hole] : []),
];

const setup = ({ activePartId = "", tool = { fullName: "MoveTool" } } = {}) => {
  const item = {
    furnitureInstancesEnabled: true,
    furnitureInstanceBusy: false,
    furnitureInstanceFocusId: "group-a",
    furnitureInstanceEffectiveSelectedId: "instance-a",
    furnitureInstanceActivePartId: activePartId,
    furnitureInstanceParents: [
      {
        id: "group-a",
        groupType: "study_work",
        groupNote: "窗边",
        geometry: [polygon(0, 0, 90, 90, polygon(30, 30, 40, 40)[0])],
      },
    ],
    furnitureInstanceLogicals: [
      {
        id: "instance-a",
        instanceType: "desk",
        context: { instance_type: "desk" },
        parts: [
          { id: "part-a", original_width: 1000, original_height: 500, value: { x: 10, y: 10, width: 10, height: 10 } },
          { id: "part-b", original_width: 1000, original_height: 500, value: { x: 50, y: 50, width: 10, height: 10 } },
        ],
        geometry: [polygon(10, 10, 20, 20), polygon(50, 50, 60, 60)],
      },
    ],
    annotation: { isDrawing: false, hasIncompletePolygons: false },
    getToolsManager: () => ({ findSelectedTool: () => tool }),
    setFurnitureInstanceFocus: jest.fn(),
    selectFurnitureInstance: jest.fn(),
    stageWidth: 1000,
    stageHeight: 500,
    zoomScale: 1,
  };
  render(<FurnitureInstanceLayer item={item} />);
  return item;
};

test("renders parent below logical instances with even-odd multi-part paths", () => {
  setup();
  const groups = screen.getAllByRole("button");
  expect(groups.map((group) => group.dataset.testid)).toEqual([
    "furniture-parent:group-a",
    "furniture-instance:instance-a",
  ]);
  expect(screen.getByText("学习办公 · 窗边")).toBeInTheDocument();
  expect(screen.getAllByTestId("geometry-path").every((path) => path.dataset.fillRule === "evenodd")).toBe(true);
  expect(screen.getAllByTestId("geometry-path")[1].dataset.path.match(/M/g)).toHaveLength(2);
});

test("parent click changes Focus while instance click selects the logical instance", () => {
  const item = setup();
  fireEvent.click(screen.getByTestId("furniture-parent:group-a"));
  expect(item.setFurnitureInstanceFocus).toHaveBeenCalledWith("group-a");
  expect(item.selectFurnitureInstance).not.toHaveBeenCalled();

  fireEvent.click(screen.getByTestId("furniture-instance:instance-a"));
  expect(item.selectFurnitureInstance).toHaveBeenCalledWith("instance-a");
});

test("selected editable part removes its logical hit overlay and drawing tools disable all hits", () => {
  const item = setup({ activePartId: "part-a", tool: { toolName: "PolygonTool", isDrawingTool: true } });
  expect(screen.getByTestId("furniture-instance:instance-a")).toBeInTheDocument();
  expect(screen.getAllByTestId("geometry-path")[1].dataset.path.match(/M/g)).toHaveLength(1);
  expect(screen.getByTestId("logical-layer")).toHaveAttribute("data-listening", "false");
  expect(item.selectFurnitureInstance).not.toHaveBeenCalled();
});
