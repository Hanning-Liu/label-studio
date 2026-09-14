import catalog from "../../catalog/furniture.json";

// Template and button ordering are deliberately independent historical contracts.
export const furnitureCatalog = catalog;
export const FURNITURE_TYPES = Object.freeze(Object.fromEntries(
  [...catalog.categories].sort((a, b) => a.template_order - b.template_order).map(({ id, label }) => [id, label]),
));
export const FURNITURE_TYPE_GROUPS = Object.freeze(
  [...catalog.groups].sort((a, b) => a.order - b.order).map(({ id, name, color }) => ({
    name,
    color,
    types: catalog.categories.filter((category) => category.group === id)
      .sort((a, b) => a.display_order - b.display_order).map((category) => category.id),
  })),
);
export const catalogDetails = Object.fromEntries(catalog.categories.map(({ id, definition, aliases, confusable }) =>
  [id, { definition, aliases, confusable }],
));
