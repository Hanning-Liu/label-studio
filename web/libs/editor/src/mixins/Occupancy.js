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
  validateOccupancy,
  sourceFingerprint,
  invalidateReviews,
} from "../occupancy/domain";
import {
  area,
  clone,
  difference,
  EPS_AREA,
  fingerprint,
  resultGeometry,
} from "../occupancy/geometry";
import { editableParts } from "../occupancy/editing";
import { constraintSpace, constrainRectangle, constrainPolygon, snapOccupancyPoint } from "../occupancy/constraints";
import { pointInPolygon, segmentInsidePolygon } from "../utils/roomConstraintGeometry";
import {
  BARRIER_CONTROL,
  BARRIER_LABEL,
  barrierContextFor,
  barrierControlName,
  barrierResults,
  matchOccupancyBarrier,
  occupancyBarrierContext,
} from "../occupancy/barriers";

export const Occupancy = types
  .model("Occupancy", { occupancyv1: types.optional(types.boolean, false) })
  .volatile(() => ({
    occupancyFocusId: "",
    occupancyGroup: null,
    occupancyDrawMode: "furniture_group",
    occupancyCorrectionId: "",
    occupancySelectedId: "",
    occupancyEditPartId: "",
    occupancyDeleteRequestId: "",
    occupancyEditNotice: "",
    occupancyBusy: false,
    occupancyBoundarySnap: true,
    occupancyPixelSnap: true,
    occupancyDrawingControl: "",
    // Display-only diagnostic switch. L1 room results stay loaded even when
    // their redundant canvas geometry is hidden behind complete L2 parents.
    occupancyShowRoomReferences: false,
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
      if (!self.occupancyEnabled) return [];
      return parents(self.occupancyData).map((parent) => {
        const roomRegion = self.regs.find(
          (region) => region.cleanId === parent.roomId && region.results.some((result) => result.meta?.room_graph_node),
        );
        return { ...parent, roomColor: roomRegion?.getOneColor?.() || "#7b8a83" };
      });
    },
    get occupancyLogicals() {
      if (!self.occupancyEnabled) return [];
      try {
        return logicalRegions(self.occupancyData);
      } catch {
        return [];
      }
    },
    get occupancyBarriers() {
      if (!self.occupancyEnabled) return [];
      return barrierResults(self.occupancyData).map((result) => ({
        id: result.id,
        result,
        context: occupancyBarrierContext(result),
      }));
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
      if (self.furnitureInstancesEnabled) return self.furnitureInstanceConstrains?.(region);
      return self.occupancyEnabled && GEOMETRY.has(region?.control?.name) && !region.isReadOnly();
    },
    occupancyConstraintSpace(region) {
      if (self.furnitureInstancesEnabled) return self.furnitureInstanceConstraintSpace(region);
      const c = region?.results.find((r) => GEOMETRY.has(r.from_name?.name))?.meta?.occupancy_context;
      const drawingParentId =
        self.occupancyDrawMode === "furniture_group" ? self.occupancyGroup?.parentId : self.occupancyFocusId;
      const id = c?.parent_zone_id || (!region || region.isDrawing ? drawingParentId || self.occupancyFocusId : "");
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
    occupancyDrawBlockReason(controlName = "") {
      if (!self.occupancyEnabled) return "";
      if (self.occupancyBusy || self.annotation.submissionStarted) return "操作或保存正在进行";
      if (!self.occupancyParents.some((p) => p.id === self.occupancyFocusId)) return "请先选择 Focus 功能分区";
      if (controlName !== BARRIER_CONTROL && self.occupancyDrawMode === "furniture_group" && !self.occupancyGroup)
        return "请先创建或选择家具组团";
      if (
        controlName !== BARRIER_CONTROL &&
        self.occupancyDrawMode === "furniture_group" &&
        self.occupancyGroup?.parentId !== self.occupancyFocusId
      )
        return "待绘制组团所属分区已变化，请重新创建组团";
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
    setOccupancyEditNotice(message) {
      if (self.furnitureInstancesEnabled) {
        self.setFurnitureInstanceEditNotice?.(message);
        return;
      }
      self.occupancyEditNotice = message || "";
    },
    setOccupancyRoomReferencesVisible(visible) {
      self.occupancyShowRoomReferences = !!visible;
    },
    setOccupancySnapping(kind, enabled) {
      if (kind === "boundary") self.occupancyBoundarySnap = enabled;
      if (kind === "pixel") self.occupancyPixelSnap = enabled;
    },
    occupancyDrawingPoint(point, region = null, starting = false) {
      if (self.furnitureInstancesEnabled)
        return self.furnitureInstanceDrawingPoint(point, region, starting, region?.control?.name);
      try {
        const space = self.occupancyConstraintSpace(region);
        const snapped = snapOccupancyPoint(point, space);
        if (starting && !pointInPolygon(space.toPixel(snapped), space.ring)) {
          self.occupancyEditNotice = "请在 Focus 功能分区内起笔";
          return null;
        }
        self.occupancyEditNotice = "";
        return snapped;
      } catch (error) {
        self.occupancyEditNotice = error.message;
        return null;
      }
    },
    constrainOccupancyRectangle(region, previous, target) {
      if (self.furnitureInstancesEnabled)
        return self.constrainFurnitureInstanceRectangle(region, previous, target);
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
      if (self.furnitureInstancesEnabled)
        return self.constrainFurnitureInstancePolygon(region, previous, target, snap);
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
      if (self.furnitureInstancesEnabled) return self.furnitureInstanceNextPoint(region, point);
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
    requestOccupancyDelete(region) {
      const reason = self.occupancyOperationBlockReason();

      if (reason) {
        self.occupancyEditNotice = reason;
        return false;
      }
      const logical = self.occupancyLogicals.find((candidate) =>
        candidate.parts.some((part) => part.id === region?.cleanId),
      );

      if (!logical) {
        self.occupancyEditNotice = "待删除的 L3 区域已不存在，请重新选择";
        return false;
      }
      if (logical.context.generation !== "manual") {
        self.occupancyEditNotice = "自动生成的可通行区域不能单独删除；请在“预览组团”中重新生成";
        return false;
      }
      self.occupancyDeleteRequestId = logical.id;
      self.occupancyFocusId = logical.context.parent_zone_id;
      self.occupancySelectedId = logical.id;
      self.occupancyEditNotice = "";
      return true;
    },
    clearOccupancyDeleteRequest() {
      self.occupancyDeleteRequestId = "";
    },
    acceptOccupancyEdit(region, value) {
      if (self.furnitureInstancesEnabled) return self.acceptFurnitureInstanceEdit(region, value);
      if (!self.occupancyConstrains(region)) return true;
      const result = region.results.find((r) => GEOMETRY.has(r.from_name?.name));
      const c = result?.meta?.occupancy_context;
      try {
        const parent = self.occupancyParents.find((p) => p.id === c?.parent_zone_id);
        if (!parent) throw new Error("父分区不存在，请先重新绑定");
        if (value?.points) {
          const space = self.occupancyConstraintSpace(region);
          const points = value.points.map(([x, y]) => space.toPixel({ x, y }));
          if (!space.inside(points, true)) throw new Error("调整后的多边形无效、自相交或越出所属功能分区");
        }
        const geometry = resultGeometry({
          value,
          original_width: self.naturalWidth,
          original_height: self.naturalHeight,
        });
        if (area(geometry) <= EPS_AREA) throw new Error("调整后的多边形面积过小，已保留原轮廓");
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
    refreshOccupancyBarrier(region, { snap = true, threshold = 10, refreshReview = true } = {}) {
      if (!self.occupancyEnabled || !region) return null;
      const result = region.results.find((candidate) => barrierControlName(candidate) === BARRIER_CONTROL);
      if (!result) return null;
      let serialized = self.annotation
        .serializeAnnotation({ fast: true })
        .find((candidate) => candidate.id === region.cleanId && candidate.from_name === BARRIER_CONTROL);
      if (!serialized) return null;
      const saved = occupancyBarrierContext(serialized);
      const parentId = saved.parent_zone_id || self.occupancyFocusId;
      const parent = self.occupancyParents.find((candidate) => candidate.id === parentId);
      if (!parent) {
        result.setMetaValue("occupancy_barrier_context", {
          ...saved,
          schema_version: 1,
          barrier_type: "wall",
          parent_zone_id: parentId,
          match_rule: "shared_boundary_overlap",
          matched_pairs: [],
          match_error: "所属功能分区已不存在",
        });
        self.occupancyEditNotice = "失效隔墙：所属功能分区已不存在";
        return { matchedPairs: [], reason: "所属功能分区已不存在" };
      }
      const match = matchOccupancyBarrier(self.occupancyData, serialized, {
        parentId,
        width: self.naturalWidth,
        height: self.naturalHeight,
        screenWidth: (self.stageWidth || self.naturalWidth) * self.zoomScale,
        screenHeight: (self.stageHeight || self.naturalHeight) * self.zoomScale,
        threshold,
      });
      if (snap && match.snappedVertices?.length === 2) {
        const previous = [...region.vertices];
        region.vertices.replace(match.snappedVertices.map((vertex, index) => ({
          ...(previous[index] || {}),
          x: (vertex.x * self.naturalWidth) / 100,
          y: (vertex.y * self.naturalHeight) / 100,
          isBezier: false,
        })));
        serialized = self.annotation
          .serializeAnnotation({ fast: true })
          .find((candidate) => candidate.id === region.cleanId && candidate.from_name === BARRIER_CONTROL) || serialized;
      }
      result.setMetaValue("occupancy_barrier_context", {
        ...barrierContextFor(serialized, parent, self.annotation.referenceVersion, match.matchedPairs),
        ...(match.reason ? { match_error: match.reason } : {}),
      });
      self.occupancyEditNotice = match.matchedPairs.length
        ? `隔墙已匹配 ${match.matchedPairs.length} 组家具紧邻关系`
        : `失效隔墙：${match.reason}`;
      if (refreshReview) self.refreshOccupancyReviews();
      return match;
    },
    refreshAllOccupancyBarriers({ snap = false, threshold = 1e-5, refreshReview = false } = {}) {
      const matches = [];
      for (const region of self.regs) {
        if (!region.results.some((candidate) => barrierControlName(candidate) === BARRIER_CONTROL)) continue;
        matches.push(self.refreshOccupancyBarrier(region, { snap, threshold, refreshReview: false }));
      }
      if (refreshReview) self.refreshOccupancyReviews();
      return matches;
    },
    startOccupancyTool(name) {
      const reason = self.occupancyDrawBlockReason(name);
      if (reason) throw new Error(reason);
      self.annotation.unselectAreas();
      const labels = self.annotation.names.get(name === BARRIER_CONTROL ? BARRIER_CONTROL : "occupancy_type");
      labels.unselectAll();
      labels.children
        .find((label) => label.value === (name === BARRIER_CONTROL ? BARRIER_LABEL : self.occupancyDrawMode))
        ?.setSelected(true);
      const tool = self
        .getToolsManager()
        .allTools()
        .find((tool) => tool.control?.name === name);
      if (!tool) throw new Error("绘制工具尚未就绪");
      self.getToolsManager().selectTool(tool, true);
      self.occupancyDrawingControl = name;
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
      self.occupancyDrawingControl = "";
      self.occupancyDrawMode = "furniture_group";
      self.occupancyCorrectionId = "";
      self.occupancyEditPartId = "";
    },
    upgradeLegacyOccupancy() {
      let upgraded = 0;
      for (const region of self.regs) {
        const geometry = region.results.find((result) => GEOMETRY.has(result.from_name?.name));
        const c = geometry?.meta?.occupancy_context;
        if (c?.generation !== "pending" || !c.group_id || !GROUP_TYPES[c.group_type]) continue;
        const upgradedContext = { ...c };
        delete upgradedContext.pending_kind;
        delete upgradedContext.pending_target_logical_id;
        geometry.setMetaValue("occupancy_context", {
          ...upgradedContext,
          logical_id: c.group_id,
          generation: "manual",
          review_status: "pending",
          review_fingerprint: null,
        });
        upgraded += 1;
      }
      return upgraded;
    },
    selectOccupancyLogical(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons || self.occupancyBusy) return;
      const logical = self.occupancyLogicals.find((r) => r.id === id);
      if (!logical) return;
      self.occupancySelectedId = id;
      self.occupancyFocusId = logical.context.parent_zone_id;
      self.occupancyEditPartId = "";
      // Selecting an existing group is for inspection/editing only. A new
      // drawing always requires Create group and can therefore never append a
      // second physical component to the selected group by accident.
      self.occupancyGroup = null;
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
        throw new Error("自动生成区域或内部存储分块不能直接编辑顶点");
      self.selectOccupancyLogical(logical.id);
      self.occupancyEditPartId = id;
      self.annotation.unselectAreas();
      self.annotation.selectAreas(self.regs.filter((r) => r.cleanId === id));
    },
    initializeOccupancyRegion(region) {
      if (!self.occupancyEnabled) return;
      const barrier = region.results.find((result) => barrierControlName(result) === BARRIER_CONTROL);
      if (barrier) {
        if (barrier.meta?.occupancy_barrier_context) return;
        const parent = self.occupancyParents.find((candidate) => candidate.id === self.occupancyFocusId);
        if (!parent) return;
        barrier.setMetaValue("occupancy_barrier_context", {
          ...barrierContextFor({ id: region.cleanId }, parent, self.annotation.referenceVersion, []),
          match_error: "隔墙尚未完成绘制",
        });
        return;
      }
      const geometry = region.results.find((r) => GEOMETRY.has(r.from_name?.name));
      if (!geometry || geometry.meta?.occupancy_context) return;
      const parent = self.occupancyParents.find((p) => p.id === self.occupancyFocusId);
      if (!parent) return;
      const mode = self.occupancyDrawMode,
        group = mode === "furniture_group" ? self.occupancyGroup : null;
      geometry.setMetaValue("occupancy_context", {
        ...baseContext(parent, self.annotation.referenceVersion, "manual", group?.id),
        group_id: group?.id || null,
        group_type: group?.type || null,
        group_note: group?.note || "",
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
    finalizeOccupancyRegion(region) {
      if (!self.occupancyEnabled) return;
      if (region.results.some((result) => barrierControlName(result) === BARRIER_CONTROL)) {
        self.refreshOccupancyBarrier(region, { snap: true, threshold: 10, refreshReview: true });
        return;
      }
      const geometry = region.results.find((result) => GEOMETRY.has(result.from_name?.name));
      const c = geometry?.meta?.occupancy_context;
      if (!c || c.generation !== "manual") return;
      if (c.group_id && self.occupancyGroup?.id === c.group_id) self.occupancyGroup = null;
      self.occupancySelectedId = c.logical_id || "";
      self.occupancyCorrectionId = "";
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
        const replacedRegions = [...self.regs].filter((region) =>
          region.results.some((r) => GEOMETRY.has(r.from_name?.name)),
        );
        self.getToolsManager()?.releaseRegionReferences?.(replacedRegions);
        self.annotation.unselectAreas();
        for (const region of replacedRegions) self.annotation.deleteArea(region);
        self.annotation.deserializeResults(clone(next.filter(isO)));
        self.annotation.updateObjects();
        // Barriers are independent manual results. Re-evaluate their original
        // geometry against the rebuilt furniture set without silently snapping
        // them to a different nearby edge.
        self.refreshAllOccupancyBarriers({ snap: false, threshold: 1e-5, refreshReview: false });
        const actual = self.annotation.serializeAnnotation({ fast: true }).filter(isO);
        if (
          actual.length !== next.filter(isO).length ||
          actual.some((r) => !next.some((n) => n.id === r.id && n.from_name === r.from_name))
        )
          throw new Error("L3 结果未完整载入，已回滚");
        self.occupancyEditPartId = "";
        self.occupancySelectedId = "";
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
