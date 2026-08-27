import { isAlive, types } from "mobx-state-tree";

export const ReadOnlyControlMixin = types.model("ReadOnlyControlMixin", {}).views((self) => ({
  isReadOnly() {
    return self.result?.isReadOnly() || self.annotation?.isReadOnly();
  },
}));

export const ReadOnlyRegionMixin = types
  .model("ReadOnlyRegionMixin", {
    readonly: types.optional(types.boolean, false),
  })
  .views((self) => ({
    isReadOnly() {
      if (!isAlive(self)) {
        return false;
      }
      return (
        (self.parent?.occupancyEnabled && self.results?.some((r) => self.parent.occupancyIsReference(r.from_name?.name))) ||
        (self.parent?.occupancyEnabled && self.results?.some((r) => r.meta?.occupancy_context?.generation === "remainder")) ||
        self.locked ||
        self.readonly ||
        self.annotation.isReadOnly() ||
        (self.parent && (self.parent.isReadOnly?.() || self.parent.result?.isReadOnly?.()))
      );
    },
  }));
