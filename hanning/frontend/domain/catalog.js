import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import catalog from "../../catalog/furniture.json";

// Template and button ordering are deliberately independent historical contracts.
export const furnitureCatalog = catalog;
export const FURNITURE_TYPES = Object.fromEntries(
  [...catalog.categories].sort((a, b) => a.template_order - b.template_order).map(({ id, label }) => [id, label]),
);
export const FURNITURE_TYPE_GROUPS = Object.freeze(
  [...catalog.groups]
    .sort((a, b) => a.order - b.order)
    .map(({ id, name, color }) => ({
      id,
      name,
      color,
      types: catalog.categories
        .filter((category) => category.group === id)
        .sort((a, b) => a.display_order - b.display_order)
        .map((category) => category.id),
    })),
);
export const catalogDetails = Object.fromEntries(
  catalog.categories.map(({ id, definition, aliases, confusable }) => [id, { definition, aliases, confusable }]),
);

export const customFurnitureEntries = {};
export const normalizeFurnitureName = (value) => value.normalize("NFKC").trim().replace(/\s+/gu, " ");
export function customFurnitureEntry(label, group) {
  label = normalizeFurnitureName(label);
  if (!label || [...label].length > 40 || /\p{C}/u.test(label) || !catalog.groups.some((g) => g.id === group))
    throw new Error("类别名称须为 1–40 个可见字符，并选择有效大类");
  return { id: `custom_${bytesToHex(sha256(utf8ToBytes(`${group}\n${label}`))).slice(0, 32)}`, label, group };
}
export function validCustomFurnitureEntry(entry, id) {
  try {
    const expected = customFurnitureEntry(entry.label, entry.group);
    return Object.keys(entry).length === 3 && entry.id === id && expected.id === id && expected.label === entry.label;
  } catch {
    return false;
  }
}
export function registerCustomFurnitureEntry(entry) {
  if (!validCustomFurnitureEntry(entry, entry?.id)) throw new Error("自定义家具类别身份无效");
  if (Object.hasOwn(FURNITURE_TYPES, entry.id)) return;
  customFurnitureEntries[entry.id] = { ...entry };
  FURNITURE_TYPES[entry.id] = entry.label;
  FURNITURE_TYPE_GROUPS.find((g) => g.id === entry.group).types.push(entry.id);
  catalogDetails[entry.id] = { definition: `自定义家具类别：${entry.label}`, aliases: [], confusable: [] };
}
export function registerFurnitureConfig(config) {
  if (!config?.includes("custom_")) return;
  const xml = new DOMParser().parseFromString(config, "text/xml");
  for (const choice of xml.querySelectorAll('Choices[name="furniture_instance_type"] > Choice[furnitureGroup]')) {
    registerCustomFurnitureEntry({
      id: choice.getAttribute("alias"),
      label: choice.getAttribute("value"),
      group: choice.getAttribute("furnitureGroup"),
    });
  }
}
export function furnitureNameExists(name) {
  const normalized = normalizeFurnitureName(name).toLowerCase();
  return Object.entries(FURNITURE_TYPES).some(([id, label]) =>
    [id, label, ...(catalogDetails[id]?.aliases || [])].some(
      (value) => normalizeFurnitureName(value).toLowerCase() === normalized,
    ),
  );
}
