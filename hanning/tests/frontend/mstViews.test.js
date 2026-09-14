import { types } from "mobx-state-tree";
import { mergeViewDefinitions } from "@hanning/frontend/adapters/mstViews";

test("merged MST views stay lazy/reactive and later definitions preserve override order", () => {
  let reads = 0;
  const Model = types.model("DescriptorFixture", { value: 1 })
    .views((self) => mergeViewDefinitions(
      { get doubled() { reads++; return self.value * 2; }, valueLabel() { return "first"; } },
      { valueLabel() { return "last"; } },
    ))
    .actions((self) => ({ setValue(value) { self.value = value; } }));
  const model = Model.create();
  expect(reads).toBe(0);
  expect(model.doubled).toBe(2);
  model.setValue(3);
  expect(model.doubled).toBe(6);
  expect(model.valueLabel()).toBe("last");
});
