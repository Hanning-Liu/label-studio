import { applySnapshot, getSnapshot, types } from "mobx-state-tree";
import {
  baseContext,
  context,
  GEOMETRY,
  GROUP_TYPES,
  logicalRegions,
  newId,
  parents,
  REFERENCES,
  replaceLogicals,
  resultsForGeometry,
  validateOccupancy,
  localCorrection,
  sourceFingerprint,
  invalidateReviews,
} from "../occupancy/domain";
import {
  area,
  clone,
  difference,
  EPS_AREA,
  equivalent,
  fingerprint,
  intersection,
  resultGeometry,
  union,
} from "../occupancy/geometry";
import { editableParts } from "../occupancy/editing";
import { constraintSpace, constrainRectangle, constrainPolygon, snapOccupancyPoint } from "../occupancy/constraints";
import { pointInPolygon, segmentInsidePolygon } from "../utils/roomConstraintGeometry";

export const Occupancy = types
  .model("Occupancy", { occupancyv1: types.optional(types.boolean, false) })
  .volatile(() => ({
    occupancyFocusId: "",
    occupancyGroup: null,
    occupancyDrawMode: "furniture_group",
    occupancyCorrectionId: "",
    occupancySelectedId: "",
    occupancyEditPartId: "",
    occupancyEditNotice: "",
    occupancyBusy: false,
    occupancyBoundarySnap: true,
    occupancyPixelSnap: true,
  }))
  .views((self) => ({
    get occupancyEnabled() {
      return self.occupancyv1;
    },
    get occupancyData() {
      getSnapshot(self.annotation.areas);
      return self.annotation.serializeAnnotation({ fast: true });
    },
    get occupancyParents() {
      return self.occupancyEnabled ? parents(self.occupancyData) : [];
    },
    get occupancyLogicals() {
      if (!self.occupancyEnabled) return [];
      try {
        return logicalRegions(self.occupancyData);
      } catch {
        return [];
      }
    },
    get occupancyPending() {
      return self.occupancyLogicals.filter((r) => r.context.generation === "pending");
    },
    get occupancyActivePartId() {
      const selected = self.annotation.selectedRegions;
      if (selected.length !== 1 || selected[0].isReadOnly()) return "";
      const id = selected[0].cleanId;
      const logical = self.occupancyLogicals.find((r) => r.parts.some((part) => part.id === id));
      return editableParts(logical).some((part) => part.id === id) ? id : "";
    },
    get occupancyErrors() {
      if (!self.occupancyEnabled) return [];
      try {
        return validateOccupancy(self.occupancyData, self.annotation.referenceVersion);
      } catch (error) {
        return [{ code: "geometry", message: error.message }];
      }
    },
    occupancyIsReference(controlName) {
      return self.occupancyEnabled && REFERENCES.has(controlName);
    },
    occupancyConstrains(region) {
      return self.occupancyEnabled && GEOMETRY.has(region?.control?.name) && !region.isReadOnly();
    },
    occupancyConstraintSpace(region) {
      const c = region?.results.find((r) => GEOMETRY.has(r.from_name?.name))?.meta?.occupancy_context;
      const id = c?.parent_zone_id || (!region || region.isDrawing ? self.occupancyFocusId : "");
      const parent = self.occupancyParents.find((p) => p.id === id);
      if (!parent) throw new Error("所属父分区不存在，请先重新绑定；不能用当前 Focus 替代原归属");
      return constraintSpace(parent.geometry, {
        width: self.naturalWidth,
        height: self.naturalHeight,
        screenWidth: (self.stageWidth || self.naturalWidth) * self.zoomScale,
        screenHeight: (self.stageHeight || self.naturalHeight) * self.zoomScale,
        boundary: self.occupancyBoundarySnap,
        pixel: self.occupancyPixelSnap,
      });
    },
    occupancyDrawBlockReason() {
      if (!self.occupancyEnabled) return "";
      if (self.occupancyBusy || self.annotation.submissionStarted) return "操作或保存正在进行";
      if (self.occupancyPending.length) return "请先处理刚绘制轮廓的预览";
      if (!self.occupancyParents.some((p) => p.id === self.occupancyFocusId)) return "请先选择 Focus 功能分区";
      if (self.occupancyDrawMode === "furniture_group" && !self.occupancyGroup) return "请先创建或选择家具组团";
      return "";
    },
    occupancyOperationBlockReason() {
      if (!self.occupancyEnabled || self.annotation.isReadOnly()) return "此标注不可编辑";
      if (self.annotation.submissionStarted || self.annotation.isDrawing || self.annotation.hasIncompletePolygons)
        return "请先完成绘制或等待提交结束";
      const status = self.annotation.store.referenceSyncController?.state?.status;
      if (
        status?.enabled &&
        (status.source_version !== self.annotation.referenceVersion ||
          status.reference_version !== self.annotation.referenceVersion ||
          status.error)
      )
        return "请先保存、备份并手动应用最新 L2 参考";
      return "";
    },
    occupancyOperationFingerprint() {
      return fingerprint({ reference: self.annotation.referenceVersion, result: self.occupancyData });
    },
  }))
  .actions((self) => ({
    setOccupancySnapping(kind, enabled) {
      if (kind === "boundary") self.occupancyBoundarySnap = enabled;
      if (kind === "pixel") self.occupancyPixelSnap = enabled;
    },
    occupancyDrawingPoint(point, region = null, starting = false) {
      try {
        const space = self.occupancyConstraintSpace(region);
        const snapped = snapOccupancyPoint(point, space);
        if (starting && !pointInPolygon(space.toPixel(snapped), space.ring)) {
          self.occupancyEditNotice = "请在 Focus 功能分区内起笔";
          return null;
        }
        return snapped;
      } catch (error) {
        self.occupancyEditNotice = error.message;
        return null;
      }
    },
    constrainOccupancyRectangle(region, previous, target) {
      if (!self.occupancyConstrains(region)) return target;
      try {
        const accepted = constrainRectangle(previous, target, self.occupancyConstraintSpace(region));
        self.occupancyEditNotice = Object.keys(target).some((key) => Math.abs(target[key] - accepted[key]) > 1e-6)
          ? "已限制在所属功能分区内，并按吸附设置调整；父分区未改变"
          : "";
        return accepted;
      } catch (error) {
        self.occupancyEditNotice = error.message;
        return previous;
      }
    },
    constrainOccupancyPolygon(region, previous, target, snap = true) {
      if (!self.occupancyConstrains(region)) return target;
      try {
        const accepted = constrainPolygon(previous, target, self.occupancyConstraintSpace(region), region.closed, snap);
        self.occupancyEditNotice = accepted.some((p, i) => Math.hypot(p.x - target[i].x, p.y - target[i].y) > 1e-6)
          ? "已限制在所属功能分区内，并按吸附设置调整；父分区未改变"
          : "";
        return accepted;
      } catch (error) {
        self.occupancyEditNotice = error.message;
        return previous;
      }
    },
    occupancyNextPoint(region, point) {
      const snapped = self.occupancyDrawingPoint(point, region);
      if (!snapped) return null;
      const space = self.occupancyConstraintSpace(region),
        previous = region.points.at(-1);
      if (
        !pointInPolygon(space.toPixel(snapped), space.ring) ||
        (previous && !segmentInsidePolygon(space.toPixel(previous), space.toPixel(snapped), space.ring))
      ) {
        self.occupancyEditNotice = "该顶点或连边越出所属功能分区，请沿父分区内部绘制";
        return null;
      }
      self.occupancyEditNotice = "";
      return snapped;
    },
    setOccupancyBusy(value) {
      self.occupancyBusy = value;
    },
    acceptOccupancyEdit(region, value) {
      if (!self.occupancyConstrains(region)) return true;
      const result = region.results.find((r) => GEOMETRY.has(r.from_name?.name));
      const c = result?.meta?.occupancy_context;
      try {
        const parent = self.occupancyParents.find((p) => p.id === c?.parent_zone_id);
        if (!parent) throw new Error("父分区不存在，请先重新绑定");
        const geometry = resultGeometry({
          value,
          original_width: self.naturalWidth,
          original_height: self.naturalHeight,
        });
        if (area(difference(geometry, parent.geometry)) > EPS_AREA)
          throw new Error("调整不能越出所属功能分区，已保留原轮廓");
        self.occupancyEditNotice = "";
        return true;
      } catch (error) {
        self.occupancyEditNotice = error.message;
        return false;
      }
    },
    refreshOccupancyReviews() {
      if (!self.occupancyEnabled) return;
      // Serialize directly instead of reading the computed occupancyData view:
      // this is also called from beforeSend while a point drag may still be in
      // the same MobX derivation turn.
      const next = invalidateReviews(
        self.annotation.serializeAnnotation({ fast: true }),
        self.annotation.referenceVersion,
      );
      const contexts = new Map(next.filter((r) => GEOMETRY.has(r.from_name)).map((r) => [r.id, context(r)]));
      for (const region of self.regs)
        for (const result of region.results) {
          const c = contexts.get(region.cleanId);
          if (!c || !GEOMETRY.has(result.from_name?.name)) continue;
          if (c && fingerprint(result.meta?.occupancy_context || {}) !== fingerprint(c))
            result.setMetaValue("occupancy_context", c);
        }
    },
    startOccupancyTool(name) {
      const reason = self.occupancyDrawBlockReason();
      if (reason) throw new Error(reason);
      self.annotation.unselectAreas();
      const labels = self.annotation.names.get("occupancy_type");
      labels.unselectAll();
      labels.children.find((label) => label.value === self.occupancyDrawMode)?.setSelected(true);
      const tool = self
        .getToolsManager()
        .allTools()
        .find((tool) => tool.control?.name === name);
      if (!tool) throw new Error("绘制工具尚未就绪");
      self.getToolsManager().selectTool(tool, true);
    },
    setOccupancyFocus(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons) throw new Error("请先完成或取消绘制");
      self.occupancyFocusId = id;
      self.occupancyGroup = null;
      self.occupancyCorrectionId = "";
      self.occupancySelectedId = "";
      self.occupancyEditPartId = "";
      self.updateRoomConstraintTools();
    },
    createOccupancyGroup(type, note) {
      if (!GROUP_TYPES[type] || (type === "other" && !note?.trim())) throw new Error("请选择组团类型，其他需填写说明");
      if (!self.occupancyFocusId) throw new Error("请先选择父功能分区");
      self.annotation.unselectAreas();
      self.occupancyGroup = { id: newId(), type, note: note || "", parentId: self.occupancyFocusId };
      self.occupancyDrawMode = "furniture_group";
      self.occupancyCorrectionId = "";
      self.occupancyEditPartId = "";
    },
    selectOccupancyLogical(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons || self.occupancyBusy) return;
      const logical = self.occupancyLogicals.find((r) => r.id === id);
      if (!logical) return;
      self.occupancySelectedId = id;
      self.occupancyFocusId = logical.context.parent_zone_id;
      self.occupancyEditPartId = "";
      self.occupancyGroup =
        logical.type === "furniture_group"
          ? {
              id: logical.context.group_id,
              type: logical.context.group_type,
              note: logical.context.group_note,
              parentId: logical.context.parent_zone_id,
            }
          : null;
      self.annotation.unselectAreas();
      const ids = new Set(logical.parts.map((r) => r.id));
      self.annotation.selectAreas(self.regs.filter((r) => ids.has(r.cleanId)));
      const move = self
        .getToolsManager()
        .allTools()
        .find((tool) => tool.fullName === "MoveTool");
      if (move) self.getToolsManager().selectTool(move, true);
    },
    setOccupancyDrawMode(mode, correctionId = "") {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons) throw new Error("请先完成绘制");
      self.annotation.unselectAreas();
      self.occupancyDrawMode = mode;
      self.occupancyCorrectionId = correctionId;
      self.occupancyEditPartId = "";
    },
    editOccupancyPart(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons || self.occupancyBusy)
        throw new Error("请先完成绘制或等待当前操作结束");
      const logical = self.occupancyLogicals.find((r) => r.parts.some((p) => p.id === id));
      if (!editableParts(logical).some((part) => part.id === id))
        throw new Error("自动补余请使用局部修正，不编辑存储分块顶点");
      self.selectOccupancyLogical(logical.id);
      self.occupancyEditPartId = id;
      self.annotation.unselectAreas();
      self.annotation.selectAreas(self.regs.filter((r) => r.cleanId === id));
    },
    initializeOccupancyRegion(region) {
      if (!self.occupancyEnabled) return;
      const geometry = region.results.find((r) => GEOMETRY.has(r.from_name?.name));
      if (!geometry || geometry.meta?.occupancy_context) return;
      const parent = self.occupancyParents.find((p) => p.id === self.occupancyFocusId);
      if (!parent) return;
      const mode = self.occupancyDrawMode,
        group = mode === "furniture_group" ? self.occupancyGroup : null;
      geometry.setMetaValue("occupancy_context", {
        ...baseContext(parent, self.annotation.referenceVersion, "pending"),
        group_id: group?.id || null,
        group_type: group?.type || null,
        group_note: group?.note || "",
        pending_target_logical_id: self.occupancyCorrectionId || null,
        pending_kind: mode,
      });
      const control = self.annotation.names.get("occupancy_type"),
        result = region.results.find((r) => r.from_name === control);
      if (result) result.setValue([mode]);
      else
        region.addResult({
          area: region,
          from_name: control,
          to_name: self,
          type: "labels",
          value: { labels: [mode] },
        });
    },
    previewOccupancyDrawing(id) {
      const data = self.occupancyData,
        pending = logicalRegions(data).find((r) => r.id === id && r.context.generation === "pending");
      if (!pending) throw new Error("待处理绘制已不存在");
      const parent = parents(data).find((p) => p.id === pending.context.parent_zone_id);
      if (!parent) throw new Error("父功能分区已不存在");
      const clipped = intersection(pending.geometry, parent.geometry);
      if (!clipped.length) throw new Error("绘制范围不在父分区中；请取消该轮廓并重新绘制");
      const c = { ...pending.context, generation: "manual" };
      delete c.pending_target_logical_id;
      delete c.pending_kind;
      const clean = replaceLogicals(data, [id], []);
      let next;
      if (pending.context.pending_target_logical_id)
        next = localCorrection(clean, pending.context.pending_target_logical_id, clipped, pending.type);
      else if (pending.type === "furniture_group") {
        const existing = logicalRegions(clean).find((r) => r.context.group_id === c.group_id);
        if (existing && existing.context.parent_zone_id !== c.parent_zone_id) throw new Error("组团不能跨越父分区");
        c.logical_id = existing?.id || c.group_id;
        next = replaceLogicals(
          clean,
          existing ? [existing.id] : [],
          resultsForGeometry(union(existing?.geometry || [], clipped), pending.type, c, parent.result, newId, [
            ...(existing?.parts || []),
            ...pending.parts,
          ]),
        );
      } else next = [...clean, ...resultsForGeometry(clipped, pending.type, c, parent.result, newId, pending.parts)];
      return {
        results: next,
        geometry: clipped,
        clipped: !equivalent(clipped, pending.geometry),
        fingerprint: self.occupancyOperationFingerprint(),
      };
    },
    applyOccupancyResults(next, expectedFingerprint) {
      const reason = self.occupancyOperationBlockReason();
      if (reason) throw new Error(reason);
      if (expectedFingerprint !== self.occupancyOperationFingerprint())
        throw new Error("预览后内容或参考已变化，请重新打开预览");
      const current = self.occupancyData,
        isO = (r) => GEOMETRY.has(r.from_name) || r.from_name === "occupancy_type";
      if (fingerprint(current.filter((r) => !isO(r))) !== fingerprint(next.filter((r) => !isO(r))))
        throw new Error("操作试图改变参考或 Relations，已停止");
      const snapshot = getSnapshot(self.annotation.areas);
      next = invalidateReviews(next, self.annotation.referenceVersion);
      self.annotation.history.freeze("occupancy-transaction");
      try {
        self.annotation.unselectAreas();
        for (const region of [...self.regs])
          if (region.results.some((r) => GEOMETRY.has(r.from_name?.name))) self.annotation.deleteArea(region);
        self.annotation.deserializeResults(clone(next.filter(isO)));
        self.annotation.updateObjects();
        const actual = self.annotation.serializeAnnotation({ fast: true }).filter(isO);
        if (
          actual.length !== next.filter(isO).length ||
          actual.some((r) => !next.some((n) => n.id === r.id && n.from_name === r.from_name))
        )
          throw new Error("L3 结果未完整载入，已回滚");
        self.occupancyEditPartId = "";
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("occupancy-transaction");
      }
    },
    acceptOccupancyParent(results, oldParentId, newParentId) {
      const p = parents(results).find((candidate) => candidate.id === newParentId);
      if (!p) throw new Error("新的父功能分区不存在");
      return results.map((r) =>
        GEOMETRY.has(r.from_name) && context(r).parent_zone_id === oldParentId
          ? {
              ...r,
              meta: {
                ...r.meta,
                occupancy_context: {
                  ...context(r),
                  parent_zone_id: p.id,
                  parent_room_id: p.roomId,
                  parent_fingerprint: sourceFingerprint(p.result, results),
                  source_version: self.annotation.referenceVersion,
                  review_status: "pending",
                  review_fingerprint: null,
                },
              },
            }
          : r,
      );
    },
  }));
