import { applySnapshot, getSnapshot, types } from "mobx-state-tree";
import { orthogonalizePolygon } from "@hanning/frontend/domain/rooms/orthogonalize";
import { polygonCandidate } from "@hanning/frontend/domain/rooms/regionPolicies";

// L2/L3 geometry edits use the stored parent, never the current drawing focus.
export const PolygonOrthogonalization = types.model("PolygonOrthogonalization")
  .views((self) => ({
    orthogonalizeRegionKind(region) {
      if (region?.parent !== self || region?.type !== "polygonregion") return "";
      if (self.l2ToolbarEnabled && self.l2Config.controls.some((entry) =>
        entry.family === "zone" && entry.shape === "polygon" && entry.name === region.control?.name)) return "L2 功能分区";
      if (self.occupancyEnabled && !self.furnitureInstancesEnabled && region.control?.name === "occupancy_polygon") {
        const logical = self.occupancyLogicals.find((r) => r.parts.some((part) => part.id === region.cleanId));
        if (logical?.type === "furniture_group" && logical.context.generation === "manual") return "L3 家具组团";
      }
      return "";
    },
    polygonOrthogonalizeBlockReason(region) {
      const kind = self.orthogonalizeRegionKind(region);
      if (!kind) return "请选择 L2 功能分区或 L3 家具组团的 Polygon";
      const annotation = self.annotation;
      if (annotation.isReadOnly() || annotation.store?.annotationStore?.viewingAll || region.isReadOnly()) return "当前区域为只读";
      if (annotation.submissionStarted || self.occupancyBusy) return "正在操作或保存，请稍候";
      if (annotation.isDrawing || annotation.hasIncompletePolygons || !region.closed) return "请先完成绘制或按 Esc 取消";
      if (annotation.selectedRegions.length !== 1 || annotation.selectedRegions[0] !== region) return "请只选中一个 Polygon";
      if (!self.imageIsLoaded) return "图片加载完成后才能正交化";
      if (kind === "L3 家具组团") {
        const blocked = self.occupancyOperationBlockReason();
        if (blocked) return blocked;
        if (self.occupancyActivePartId !== region.cleanId) return "请先选中可编辑的完整组团组成块；带孔或拆分存储的片段不能单独正交化";
        try { self.occupancyConstraintSpace(region); } catch (error) { return error.message; }
      } else {
        if (!self.getRoomPolygon(region.partitionContext?.parent_room_id)) return "所属房间不存在，请先修复父级参考";
        const status = annotation.store.referenceSyncController?.state?.status;
        if (status?.enabled && (status.error || status.source_version !== annotation.referenceVersion ||
            status.reference_version !== annotation.referenceVersion)) return "请先应用最新房间参考";
      }
      return "";
    },
  }))
  .actions((self) => ({
    orthogonalizePartitionPolygon(region) {
      const blocked = self.polygonOrthogonalizeBlockReason(region);
      if (blocked) throw new Error(blocked);
      const original = region.points.map(({ x, y }) => ({ x, y }));
      const fitted = orthogonalizePolygon(original, self.naturalWidth, self.naturalHeight);
      if (!fitted.changed) return false;
      // The fit already snaps to pixels. Additional boundary attraction could
      // bend orthogonal edges, so only containment is applied for this operation.
      const accepted = polygonCandidate(region, original, fitted.points, { snap: false });
      const matches = (points) => points.every((p, i) =>
        Math.abs(p.x - fitted.points[i].x) * self.naturalWidth / 100 < 1e-7 &&
        Math.abs(p.y - fitted.points[i].y) * self.naturalHeight / 100 < 1e-7);
      if (!matches(accepted)) throw new Error("正交化及像素吸附会越出父级边界，已保留原形状。请先调整靠近边界的顶点。");
      const isL3 = self.orthogonalizeRegionKind(region) === "L3 家具组团";
      if (isL3 && !self.acceptOccupancyEdit(region, { points: fitted.points.map(({ x, y }) => [x, y]) }))
        throw new Error(self.occupancyEditNotice || "当前组团不能正交化，已保留原形状。");
      const previous = getSnapshot(self.annotation.areas);
      const history = self.annotation.history;
      history.freeze("partition-orthogonalize");
      try {
        region.setPoints(fitted.points.flatMap(({ x, y }) => [x, y]), { snap: false });
        if (!matches(region.points)) throw new Error("当前边界约束不允许完整正交化，已保留原形状。");
        if (isL3) {
          self.refreshAllOccupancyBarriers({ snap: false, threshold: 1e-5, refreshReview: false });
          self.refreshOccupancyReviews();
        }
        region.notifyDrawingFinished();
        return true;
      } catch (error) {
        applySnapshot(self.annotation.areas, previous);
        throw error;
      } finally {
        history.unfreeze("partition-orthogonalize");
      }
    },
  }));
