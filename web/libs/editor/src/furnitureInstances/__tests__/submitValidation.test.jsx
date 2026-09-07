import { focusOccupancy } from "../../occupancy/focus";
import { furnitureInstanceValidationItems, locateFurnitureInstanceValidation } from "../submitValidation";

jest.mock("../../occupancy/focus", () => ({ focusOccupancy: jest.fn().mockResolvedValue() }));

const item = () => ({
  furnitureInstanceLogicals: [
    {
      id: "fi_cabinet_abcdefghijklmnopqrst",
      context: { instance_type: "cabinet", group_id: "group-storage" },
      geometry: [
        [
          [
            [10, 10],
            [20, 10],
            [20, 20],
            [10, 20],
            [10, 10],
          ],
        ],
      ],
    },
  ],
  furnitureInstanceParents: [{ id: "group-storage", groupType: "storage", groupNote: "玄关" }],
  selectFurnitureInstance: jest.fn(),
});

test("submission issues identify the actual category, short id, and owning group", () => {
  const items = furnitureInstanceValidationItems(item(), [
    { code: "review", instanceId: "fi_cabinet_abcdefghijklmnopqrst", message: "家具实例未复核" },
    { code: "review", instanceId: "fi_cabinet_abcdefghijklmnopqrst", message: "家具实例未复核" },
  ]);
  expect(items).toEqual([
    expect.objectContaining({
      category: "柜体",
      shortId: "fi_cabinet…nopqrst",
      parent: "收纳 · 玄关",
      messages: ["家具实例未复核"],
    }),
  ]);
});

test("locating a submission issue selects and focuses its exact logical instance", async () => {
  const target = item();
  await expect(locateFurnitureInstanceValidation(target, "fi_cabinet_abcdefghijklmnopqrst")).resolves.toMatchObject({
    context: { instance_type: "cabinet" },
  });
  expect(target.selectFurnitureInstance).toHaveBeenCalledWith("fi_cabinet_abcdefghijklmnopqrst");
  expect(focusOccupancy).toHaveBeenCalledWith(target, target.furnitureInstanceLogicals[0].geometry);
});
