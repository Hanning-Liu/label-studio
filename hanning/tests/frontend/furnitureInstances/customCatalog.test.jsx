import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TextEncoder } from "util";
import {
  customFurnitureEntry,
  registerFurnitureConfig,
  FURNITURE_TYPES,
  FURNITURE_TYPE_GROUPS,
  customFurnitureEntries,
  furnitureNameExists,
  validCustomFurnitureEntry,
} from "@hanning/frontend/domain/catalog";
import {
  CreateFurnitureCategory,
  createFurnitureCategory,
} from "@hanning/frontend/components/furnitureInstances/CreateFurnitureCategory";
import { makeOccupancy, makeInstance, stampProvenance } from "./helpers";
import { validateFurnitureInstances } from "@hanning/frontend/domain/furnitureInstances/constraints";
import {
  exportFurnitureInstances,
  reimportFurnitureInstances,
} from "@hanning/frontend/domain/furnitureInstances/download";
import { context } from "@hanning/frontend/domain/furnitureInstances/domain";
import { duplicateFurnitureInstance } from "@hanning/frontend/domain/furnitureInstances/duplicate";
global.TextEncoder = TextEncoder;

test("config restores portable category label, group and alias with no duplicate palette entries", () => {
  const e = customFurnitureEntry("换鞋凳", "storage_display");
  const xml = `<View><Choices name="furniture_instance_type"><Choice value="${e.label}" alias="${e.id}" furnitureGroup="${e.group}" /></Choices></View>`;
  registerFurnitureConfig(xml);
  registerFurnitureConfig(xml);
  expect(FURNITURE_TYPES[e.id]).toBe("换鞋凳");
  expect(FURNITURE_TYPE_GROUPS.find((g) => g.id === e.group).types.filter((id) => id === e.id)).toHaveLength(1);
  expect(furnitureNameExists(" 换鞋凳 ")).toBe(true);
  expect(furnitureNameExists("SOFA")).toBe(true);
  expect(validCustomFurnitureEntry({ ...e, label: "forged" }, e.id)).toBe(false);
  const refs = makeOccupancy();
  const manual = makeInstance(refs, { instanceType: e.id });
  expect(context(manual[0]).catalog_entry).toEqual(e);
  expect(validateFurnitureInstances(manual, refs, { review: false })).toEqual([]);
  const copy = duplicateFurnitureInstance([...refs, ...manual], context(manual[0]).instance_id);
  expect(context(copy.results[0]).catalog_entry).toEqual(e);
  const exported = exportFurnitureInstances(stampProvenance(manual), refs, { requireReview: false });
  const restored = reimportFurnitureInstances(exported);
  expect(context(restored[0]).catalog_entry).toEqual(e);
  expect(validateFurnitureInstances(restored, refs, { review: false })).toEqual([]);
});

test("new category modal requires a group and saves draft before request; server failure stays visible", async () => {
  const order = [];
  const item = {
    annotation: {
      store: { project: { id: 9 } },
      saveDraftImmediatelyWithResults: jest.fn(async () => order.push("save")),
    },
  };
  global.fetch = jest.fn(async () => {
    order.push("post");
    return { ok: false, json: async () => ({ detail: "同名类别已存在" }) };
  });
  render(<CreateFurnitureCategory item={item} name="测试凳" onClose={jest.fn()} onCreated={jest.fn()} />);
  expect(screen.getByRole("button", { name: "创建并刷新类别" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("新家具类别所属大类"), { target: { value: "storage_display" } });
  fireEvent.click(screen.getByRole("button", { name: "创建并刷新类别" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("同名类别已存在");
  expect(order).toEqual(["save", "post"]);
  expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({ project_id: 9, label: "测试凳", group: "storage_display" });
});

test("draft failure or read-only blocks creation before any request", async () => {
  global.fetch = jest.fn();
  const item = { annotation: { saveDraftImmediatelyWithResults: jest.fn().mockRejectedValue(new Error("草稿冲突")) } };
  await expect(createFurnitureCategory(item, "换鞋凳", "storage_display")).rejects.toThrow("草稿冲突");
  expect(fetch).not.toHaveBeenCalled();
  await expect(
    createFurnitureCategory(
      { ...item, furnitureInstanceOperationBlockReason: () => "只读" },
      "换鞋凳",
      "storage_display",
    ),
  ).rejects.toThrow("只读");
  expect(fetch).not.toHaveBeenCalled();
});
