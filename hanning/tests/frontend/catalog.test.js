import { catalogDetails, furnitureCatalog, FURNITURE_TYPES, FURNITURE_TYPE_GROUPS } from "@hanning/frontend/domain/catalog";

test("catalog adapters preserve complete descriptions and distinct display/template orders", () => {
  const ids = furnitureCatalog.categories.map((category) => category.id);
  const buttonIds = FURNITURE_TYPE_GROUPS.flatMap((group) => group.types);
  expect(new Set(buttonIds)).toEqual(new Set(ids));
  expect(buttonIds).toHaveLength(ids.length);
  expect(Object.keys(FURNITURE_TYPES)).toEqual([...furnitureCatalog.categories]
    .sort((a, b) => a.template_order - b.template_order).map((category) => category.id));
  for (const category of furnitureCatalog.categories) {
    expect(catalogDetails[category.id]).toEqual({
      definition: category.definition, aliases: category.aliases, confusable: category.confusable,
    });
    expect(FURNITURE_TYPES[category.id]).toBe(category.label);
  }
});
