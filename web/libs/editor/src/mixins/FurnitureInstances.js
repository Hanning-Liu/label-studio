import { applySnapshot, getSnapshot, types } from "mobx-state-tree";

import {
  ALL_CONTROLS,
  baseContext,
  CONTROLS,
  context,
  controlName,
  effectiveFurnitureInstanceSelection,
  FURNITURE_TYPES,
  furnitureGroups,
  furnitureInstances,
  GEOMETRY_CONTROLS,
  ORIENTATION_CONTROLS,
  resultContext,
  sameFurnitureResultKeys,
} from "../furnitureInstances/domain";
import {
  assertFrontEdgeOnBoundary,
  confirmFurnitureInstances,
  constrainFurniturePolygon,
  constrainFurnitureRectangle,
  furnitureConstraintSpace,
  invalidateFurnitureReviews,
  pointInGeometry,
  snapFurniturePoint,
  validateFurnitureInstances,
  VECTOR_EPS,
} from "../furnitureInstances/constraints";
import { area, clone, difference, EPS_AREA, fingerprint, resultGeometry } from "../occupancy/geometry";
import { GEOMETRY as OCCUPANCY_GEOMETRY, REFERENCES as OCCUPANCY_REFERENCES } from "../occupancy/domain";

const REFERENCE_CONTROLS = new Set([
  ...OCCUPANCY_REFERENCES,
  ...OCCUPANCY_GEOMETRY,
  "occupancy_type",
  "occupancy_barrier_vector",
]);

const resultKey = (result) => `${result.id}\u0000${controlName(result)}`;
const contextResult = (region) => region?.results?.find((result) => context(result).instance_id);

export const FurnitureInstances = types
  .model("FurnitureInstances", {
    furnitureinstancesv1: types.optional(types.boolean, false),
    furnitureinstanceorientation: types.optional(types.boolean, true),
  })
  .volatile(() => ({
    furnitureInstanceFocusId: "",
    furnitureInstanceSelectedId: "",
    furnitureInstanceType: "bed",
    furnitureInstanceNote: "",
    furnitureInstanceDrawingControl: "",
    furnitureInstanceDeleteRequestId: "",
    furnitureInstanceEditNotice: "",
    furnitureInstanceBusy: false,
    furnitureInstanceBoundarySnap: true,
    furnitureInstancePixelSnap: true,
  }))
  .views((self) => ({
    get furnitureInstancesEnabled() {
      return self.furnitureinstancesv1;
    },
    get furnitureInstanceOrientationEnabled() {
      return self.furnitureInstancesEnabled && self.furnitureinstanceorientation;
    },
    get furnitureInstanceData() {
      getSnapshot(self.annotation.areas);
      return self.annotation.serializeAnnotation({ fast: true });
    },
    get furnitureInstanceParents() {
      if (!self.furnitureInstancesEnabled) return [];
      try {
        return furnitureGroups(self.furnitureInstanceData);
      } catch {
        return [];
      }
    },
    get furnitureInstanceLogicals() {
      if (!self.furnitureInstancesEnabled) return [];
      try {
        return furnitureInstances(self.furnitureInstanceData);
      } catch {
        return [];
      }
    },
    get furnitureInstanceErrors() {
      if (!self.furnitureInstancesEnabled) return [];
      try {
        return validateFurnitureInstances(self.furnitureInstanceData, self.furnitureInstanceData);
      } catch (error) {
        return [{ code: "geometry", message: error.message }];
      }
    },
    get furnitureInstanceActivePartId() {
      const selected = self.annotation.selectedRegions;
      if (selected.length !== 1 || selected[0].isReadOnly()) return "";
      const result = contextResult(selected[0]);
      return result && GEOMETRY_CONTROLS.has(controlName(result)) ? selected[0].cleanId : "";
    },
    get furnitureInstanceEffectiveSelectedId() {
      return effectiveFurnitureInstanceSelection(self.annotation.selectedRegions, self.furnitureInstanceSelectedId);
    },
    furnitureInstanceIsReference(name) {
      return self.furnitureInstancesEnabled && REFERENCE_CONTROLS.has(name);
    },
    furnitureInstanceTransientOrientationRegion(region) {
      const activeControl = self.furnitureInstanceDrawingControl;
      return Boolean(
        self.furnitureInstanceOrientationEnabled &&
          ORIENTATION_CONTROLS.has(activeControl) &&
          region?.isDrawing &&
          region?.incomplete &&
          region.results?.some((result) => controlName(result) === activeControl),
      );
    },
    furnitureInstanceConstrains(region) {
      return (
        self.furnitureInstancesEnabled &&
        !region?.isReadOnly?.() &&
        region?.results?.some((result) => GEOMETRY_CONTROLS.has(controlName(result)))
      );
    },
    furnitureInstanceConstraintSpace(region) {
      const saved = context(contextResult(region));
      const groupId = saved.group_id || (!region || region.isDrawing ? self.furnitureInstanceFocusId : "");
      const parent = self.furnitureInstanceParents.find((candidate) => candidate.id === groupId);
      if (!parent) throw new Error("原父家具组团不存在；不能用当前 Focus 静默替代原归属");
      return furnitureConstraintSpace(parent.geometry, {
        width: self.naturalWidth,
        height: self.naturalHeight,
        screenWidth: (self.stageWidth || self.naturalWidth) * self.zoomScale,
        screenHeight: (self.stageHeight || self.naturalHeight) * self.zoomScale,
        boundary: self.furnitureInstanceBoundarySnap,
        pixel: self.furnitureInstancePixelSnap,
      });
    },
    furnitureInstanceDrawBlockReason(control = "") {
      if (!self.furnitureInstancesEnabled) return "";
      if (self.furnitureInstanceBusy || self.annotation.submissionStarted) return "操作或保存正在进行";
      if (GEOMETRY_CONTROLS.has(control)) {
        if (!self.furnitureInstanceParents.some((parent) => parent.id === self.furnitureInstanceFocusId))
          return "请先选择 Focus 家具组团";
        if (!Object.hasOwn(FURNITURE_TYPES, self.furnitureInstanceType)) return "请选择家具实例类别";
      }
      if ([CONTROLS.frontDirection, CONTROLS.frontEdge].includes(control)) {
        if (!self.furnitureInstanceOrientationEnabled) return "当前项目未启用家具朝向标注";
        const instance = self.furnitureInstanceLogicals.find(
          (candidate) => candidate.id === self.furnitureInstanceEffectiveSelectedId,
        );
        if (!instance) return "请先选择需要标注朝向的家具实例";
        if (instance.context.group_id !== self.furnitureInstanceFocusId) return "所选实例不在当前 Focus 家具组团内";
        if (instance.orientationResults.length) return "该实例已有朝向证据；请先明确删除旧证据";
      }
      return "";
    },
    furnitureInstanceOperationBlockReason() {
      if (!self.furnitureInstancesEnabled || self.annotation.isReadOnly()) return "此标注不可编辑";
      if (self.annotation.submissionStarted || self.annotation.isDrawing || self.annotation.hasIncompletePolygons)
        return "请先完成绘制或等待提交结束";
      const status = self.annotation.store.referenceSyncController?.state?.status;
      if (
        status?.enabled &&
        (status.sync_type !== "occupancy_to_furniture_instances" ||
          status.source_version !== self.annotation.referenceVersion ||
          status.reference_version !== self.annotation.referenceVersion ||
          status.error)
      )
        return "请先保存、备份并手动应用最新 L3 参考";
      return "";
    },
    furnitureInstanceOrientationResetBlockReason(id) {
      if (!self.furnitureInstancesEnabled || self.annotation.isReadOnly()) return "此标注不可编辑";
      if (self.annotation.submissionStarted) return "请等待提交结束";
      const orientationDrawing = ORIENTATION_CONTROLS.has(self.furnitureInstanceDrawingControl);
      if ((self.annotation.isDrawing || self.annotation.hasIncompletePolygons) && !orientationDrawing)
        return "请先完成或取消当前几何绘制";
      const status = self.annotation.store.referenceSyncController?.state?.status;
      if (
        status?.enabled &&
        (status.sync_type !== "occupancy_to_furniture_instances" ||
          status.source_version !== self.annotation.referenceVersion ||
          status.reference_version !== self.annotation.referenceVersion ||
          status.error)
      )
        return "请先保存、备份并手动应用最新 L3 参考";
      if (!self.furnitureInstanceLogicals.some((candidate) => candidate.id === id)) return "家具实例不存在";
      return "";
    },
  }))
  .actions((self) => ({
    setFurnitureInstanceEditNotice(message) {
      self.furnitureInstanceEditNotice = message || "";
    },
    setFurnitureInstanceBusy(value) {
      self.furnitureInstanceBusy = !!value;
    },
    setFurnitureInstanceSnapping(kind, enabled) {
      if (kind === "boundary") self.furnitureInstanceBoundarySnap = !!enabled;
      if (kind === "pixel") self.furnitureInstancePixelSnap = !!enabled;
    },
    setFurnitureInstanceDraft(type, note = "") {
      if (!Object.hasOwn(FURNITURE_TYPES, type)) throw new Error("家具实例类别无效");
      self.furnitureInstanceType = type;
      self.furnitureInstanceNote = note || "";
    },
    setFurnitureInstanceFocus(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons) throw new Error("请先完成或取消绘制");
      if (id && !self.furnitureInstanceParents.some((parent) => parent.id === id))
        throw new Error("Focus 家具组团不存在");
      self.furnitureInstanceFocusId = id || "";
      self.furnitureInstanceSelectedId = "";
      self.furnitureInstanceDrawingControl = "";
      self.furnitureInstanceEditNotice = "";
      self.annotation.unselectAreas();
      self.updateRoomConstraintTools?.();
    },
    selectFurnitureInstance(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons || self.furnitureInstanceBusy) return;
      if (!id) {
        self.furnitureInstanceSelectedId = "";
        self.furnitureInstanceDrawingControl = "";
        self.annotation.unselectAreas();
        self.updateRoomConstraintTools?.();
        return;
      }
      const instance = self.furnitureInstanceLogicals.find((candidate) => candidate.id === id);
      if (!instance) return;
      self.furnitureInstanceSelectedId = id;
      self.furnitureInstanceFocusId = instance.context.group_id;
      self.furnitureInstanceDrawingControl = "";
      self.annotation.unselectAreas();
      const regionIds = new Set(instance.results.map((result) => result.id));
      self.annotation.selectAreas(self.regs.filter((region) => regionIds.has(region.cleanId)));
      const move = self
        .getToolsManager()
        .allTools()
        .find((tool) => tool.fullName === "MoveTool");
      if (move) self.getToolsManager().selectTool(move, true);
      self.updateRoomConstraintTools?.();
    },
    finishFurnitureInstanceOrientationDrawing(name = "", selectMove = false) {
      const control = ORIENTATION_CONTROLS.has(name) ? name : self.furnitureInstanceDrawingControl;
      if (!ORIENTATION_CONTROLS.has(control)) return;
      self.annotation.names.get(control)?.unselectAll?.();
      if (self.furnitureInstanceDrawingControl === control) self.furnitureInstanceDrawingControl = "";
      if (selectMove) {
        const manager = self.getToolsManager();
        const move = manager.allTools().find((tool) => tool.fullName === "MoveTool");
        if (move) manager.selectTool(move, true);
      }
      self.updateRoomConstraintTools?.();
    },
    cancelFurnitureInstanceOrientationDrawing({ selectMove = true } = {}) {
      const control = self.furnitureInstanceDrawingControl;
      if (!ORIENTATION_CONTROLS.has(control)) return false;
      const manager = self.getToolsManager();
      const tool = manager.allTools().find((candidate) => candidate.control?.name === control);
      const ownArea = tool?.currentArea;
      const area = self.furnitureInstanceTransientOrientationRegion(ownArea)
        ? ownArea
        : self.regs.find((region) => self.furnitureInstanceTransientOrientationRegion(region));
      const hadDraft = Boolean(area);
      if (hadDraft) {
        if (tool.cancelDrawing) tool.cancelDrawing(area);
        else tool.deleteRegion?.();
      } else if (self.annotation.isDrawing) {
        self.annotation.setIsDrawing(false);
        self.annotation.history.unfreeze();
      }
      self.finishFurnitureInstanceOrientationDrawing(control, selectMove);
      return hadDraft;
    },
    cancelFurnitureInstanceGeometryDrawing(name = "") {
      const control = GEOMETRY_CONTROLS.has(name) ? name : self.furnitureInstanceDrawingControl;
      if (!GEOMETRY_CONTROLS.has(control)) return false;
      const manager = self.getToolsManager();
      const tool = manager.allTools().find((candidate) => candidate.control?.name === control);
      const area = tool?.currentArea;
      const hadDraft = Boolean(area);
      if (area) {
        if (tool.cancelDrawing) tool.cancelDrawing(area);
        else tool.deleteRegion?.();
      } else if (self.annotation.isDrawing) {
        self.annotation.setIsDrawing(false);
        self.annotation.history.unfreeze();
      }
      self.furnitureInstanceDrawingControl = "";
      self.annotation.names.get(CONTROLS.type)?.resetSelected?.();
      const move = manager.allTools().find((candidate) => candidate.fullName === "MoveTool");
      if (move) manager.selectTool(move, true);
      self.updateRoomConstraintTools?.();
      return hadDraft;
    },
    startFurnitureInstanceTool(name) {
      if (ORIENTATION_CONTROLS.has(name) && ORIENTATION_CONTROLS.has(self.furnitureInstanceDrawingControl)) {
        if (
          self.furnitureInstanceDrawingControl === name &&
          self.getToolsManager().findSelectedTool()?.control?.name === name
        )
          return;
        self.cancelFurnitureInstanceOrientationDrawing({ selectMove: false });
      }
      const reason = self.furnitureInstanceDrawBlockReason(name);
      if (reason) throw new Error(reason);
      if (ORIENTATION_CONTROLS.has(name)) self.furnitureInstanceSelectedId = self.furnitureInstanceEffectiveSelectedId;
      self.annotation.unselectAreas();
      const stateName = GEOMETRY_CONTROLS.has(name) ? CONTROLS.type : name;
      const state = self.annotation.names.get(stateName);
      if (GEOMETRY_CONTROLS.has(name)) state?.resetSelected?.();
      else state?.unselectAll?.();
      const value = GEOMETRY_CONTROLS.has(name)
        ? self.furnitureInstanceType
        : name === CONTROLS.frontDirection
          ? "front_direction"
          : "front_edge";
      state?.children?.find((label) => label.alias === value || label.value === value)?.setSelected(true);
      const tool = self
        .getToolsManager()
        .allTools()
        .find((candidate) => candidate.control?.name === name);
      if (!tool) throw new Error("绘制工具尚未就绪");
      self.getToolsManager().selectTool(tool, true);
      self.furnitureInstanceDrawingControl = name;
    },
    furnitureInstanceDrawingPoint(point, region = null, starting = false, control = "") {
      try {
        if (GEOMETRY_CONTROLS.has(control)) {
          const space = self.furnitureInstanceConstraintSpace(region);
          const snapped = snapFurniturePoint(point, space);
          if (starting && !space.containsPoint(space.toPixel(snapped)))
            throw new Error("请在 Focus 家具组团实体内部起笔（不能落在孔洞中）");
          self.furnitureInstanceEditNotice = "";
          return snapped;
        }
        const instance = self.furnitureInstanceLogicals.find(
          (candidate) => candidate.id === self.furnitureInstanceEffectiveSelectedId,
        );
        if (!instance) throw new Error("朝向目标实例不存在");
        const source = instance.parts[0];
        const width = source?.original_width;
        const height = source?.original_height;
        if (!(width > 0 && height > 0)) throw new Error("家具实例缺少有效原图尺寸");
        const toPixel = (candidate) => ({ x: (candidate.x * width) / 100, y: (candidate.y * height) / 100 });
        const fromPixel = (candidate) => ({ x: (candidate.x * 100) / width, y: (candidate.y * 100) / height });
        let accepted = point;
        if (control === CONTROLS.frontDirection) {
          if (self.furnitureInstancePixelSnap) {
            const pixel = toPixel(point);
            const rounded = fromPixel({ x: Math.round(pixel.x), y: Math.round(pixel.y) });
            accepted = starting && !pointInGeometry(rounded, instance.geometry, true) ? point : rounded;
          }
          if (starting && !pointInGeometry(accepted, instance.geometry, true))
            throw new Error("front_direction 起点必须位于所选实例内部或边界");
        } else if (control === CONTROLS.frontEdge) {
          const space = furnitureConstraintSpace(instance.geometry, {
            width,
            height,
            screenWidth: (self.stageWidth || self.naturalWidth) * self.zoomScale,
            screenHeight: (self.stageHeight || self.naturalHeight) * self.zoomScale,
            boundary: true,
            pixel: self.furnitureInstancePixelSnap,
          });
          const snapped = space.boundaryPoints(space.toPixel(point))[0];
          if (!snapped) throw new Error("front_edge 端点必须吸附在所选实例的真实边界");
          accepted = space.fromPixel(snapped);
        } else {
          return point;
        }
        const first = region?.vertices?.[0];
        if (first) {
          const previous = fromPixel(first);
          if (Math.hypot(previous.x - accepted.x, previous.y - accepted.y) <= VECTOR_EPS)
            throw new Error("朝向证据的两个端点不能重合");
          if (control === CONTROLS.frontEdge)
            assertFrontEdgeOnBoundary(
              {
                original_width: width,
                original_height: height,
                value: { closed: false, vertices: [previous, accepted] },
              },
              instance.geometry,
            );
        }
        self.furnitureInstanceEditNotice = "";
        return accepted;
      } catch (error) {
        self.furnitureInstanceEditNotice = error.message;
        return null;
      }
    },
    constrainFurnitureInstanceRectangle(region, previous, target) {
      if (!self.furnitureInstanceConstrains(region)) return target;
      try {
        const accepted = constrainFurnitureRectangle(previous, target, self.furnitureInstanceConstraintSpace(region));
        self.furnitureInstanceEditNotice = "";
        return accepted;
      } catch (error) {
        self.furnitureInstanceEditNotice = error.message;
        return previous;
      }
    },
    constrainFurnitureInstancePolygon(region, previous, target, snap = true) {
      if (!self.furnitureInstanceConstrains(region)) return target;
      try {
        const accepted = constrainFurniturePolygon(
          previous,
          target,
          self.furnitureInstanceConstraintSpace(region),
          region.closed,
          snap,
        );
        self.furnitureInstanceEditNotice = "";
        return accepted;
      } catch (error) {
        self.furnitureInstanceEditNotice = error.message;
        return previous;
      }
    },
    furnitureInstanceNextPoint(region, point) {
      const snapped = self.furnitureInstanceDrawingPoint(point, region, false, controlName(contextResult(region)));
      if (!snapped) return null;
      const space = self.furnitureInstanceConstraintSpace(region);
      const previous = region.points.at(-1);
      if (
        !space.containsPoint(space.toPixel(snapped)) ||
        (previous && !space.segmentInside(space.toPixel(previous), space.toPixel(snapped)))
      ) {
        self.furnitureInstanceEditNotice = "该顶点或连边越出父家具组团或穿过孔洞";
        return null;
      }
      return snapped;
    },
    acceptFurnitureInstanceEdit(region, value) {
      if (!self.furnitureInstanceConstrains(region)) return true;
      try {
        const result = region.results.find((candidate) => GEOMETRY_CONTROLS.has(controlName(candidate)));
        const parent = self.furnitureInstanceParents.find((candidate) => candidate.id === context(result).group_id);
        if (!parent) throw new Error("父家具组团不存在，不能按当前 Focus 重绑");
        const geometry = resultGeometry({
          value,
          original_width: self.naturalWidth,
          original_height: self.naturalHeight,
        });
        if (area(difference(geometry, parent.geometry)) > EPS_AREA)
          throw new Error("调整不能越出原父家具组团或填入其孔洞");
        self.furnitureInstanceEditNotice = "";
        return true;
      } catch (error) {
        self.furnitureInstanceEditNotice = error.message;
        return false;
      }
    },
    initializeFurnitureInstanceRegion(region, savedContext = null) {
      if (!self.furnitureInstancesEnabled || !region) return;
      const main = region.results.find((result) => ALL_CONTROLS.has(controlName(result)));
      if (!main) return;
      let value = savedContext;
      if (!value) {
        if (GEOMETRY_CONTROLS.has(controlName(main))) {
          const parent = self.furnitureInstanceParents.find(
            (candidate) => candidate.id === self.furnitureInstanceFocusId,
          );
          if (!parent) return;
          value = baseContext(
            parent,
            self.annotation.referenceVersion,
            self.furnitureInstanceType,
            self.furnitureInstanceNote,
          );
        } else {
          value = self.furnitureInstanceLogicals.find(
            (candidate) => candidate.id === self.furnitureInstanceSelectedId,
          )?.context;
        }
      }
      if (!value) return;
      for (const result of region.results) {
        const name = controlName(result);
        if (!ALL_CONTROLS.has(name)) continue;
        const role =
          name === CONTROLS.type
            ? "category"
            : GEOMETRY_CONTROLS.has(name)
              ? "geometry"
              : name === CONTROLS.frontDirection
                ? "front_direction"
                : "front_edge";
        result.setMetaValue("furniture_instance_context", resultContext(value, role));
      }
      if (GEOMETRY_CONTROLS.has(controlName(main))) {
        const categoryControl = self.annotation.names.get(CONTROLS.type);
        const category = region.results.find((result) => controlName(result) === CONTROLS.type);
        if (category) {
          category.setValue([value.instance_type]);
          category.setMetaValue("furniture_instance_context", resultContext(value, "category"));
        } else if (categoryControl) {
          region.addResult({
            area: region,
            from_name: categoryControl,
            to_name: self,
            type: "choices",
            value: { choices: [value.instance_type] },
            meta: { furniture_instance_context: resultContext(value, "category") },
          });
        }
      }
    },
    finalizeFurnitureInstanceRegion(region) {
      if (!self.furnitureInstancesEnabled) return;
      const result = contextResult(region);
      const value = context(result);
      if (!value.instance_id) return;
      const orientationEdit = ORIENTATION_CONTROLS.has(controlName(result));
      const wasReviewed = orientationEdit && value.review_status === "reviewed";
      self.furnitureInstanceSelectedId = value.instance_id;
      self.furnitureInstanceFocusId = value.group_id;
      if (orientationEdit) self.finishFurnitureInstanceOrientationDrawing(controlName(result), true);
      else self.furnitureInstanceDrawingControl = "";
      self.refreshFurnitureInstanceReviews(wasReviewed ? [value.instance_id] : []);
      if (wasReviewed)
        self.furnitureInstanceEditNotice =
          "已修改 reviewed 实例；复核状态已变为 needs_review（保存值 pending），请重新确认复核。";
      self.updateRoomConstraintTools?.();
    },
    refreshFurnitureInstanceReviews(forcePendingIds = []) {
      if (!self.furnitureInstancesEnabled) return;
      const forced = new Set(forcePendingIds);
      let next = invalidateFurnitureReviews(
        self.annotation.serializeAnnotation({ fast: true }),
        self.annotation.serializeAnnotation({ fast: true }),
      );
      if (forced.size)
        next = next.map((result) => {
          const value = context(result);
          return forced.has(value.instance_id)
            ? {
                ...result,
                meta: {
                  ...result.meta,
                  furniture_instance_context: {
                    ...value,
                    review_status: "pending",
                    review_fingerprint: null,
                  },
                },
              }
            : result;
        });
      const contexts = new Map(
        next
          .filter((result) => ALL_CONTROLS.has(controlName(result)))
          .map((result) => [resultKey(result), context(result)]),
      );
      for (const region of self.regs)
        for (const result of region.results) {
          const value = contexts.get(`${region.cleanId}\u0000${controlName(result)}`);
          if (value && fingerprint(result.meta?.furniture_instance_context || {}) !== fingerprint(value))
            result.setMetaValue("furniture_instance_context", value);
        }
    },
    confirmFurnitureInstanceReviews(ids) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      const current = self.annotation.serializeAnnotation({ fast: true });
      const next = confirmFurnitureInstances(current, current, ids);
      const contexts = new Map(next.map((result) => [resultKey(result), context(result)]));
      for (const region of self.regs)
        for (const result of region.results) {
          const value = contexts.get(`${region.cleanId}\u0000${controlName(result)}`);
          if (value?.instance_id) result.setMetaValue("furniture_instance_context", value);
        }
    },
    requestFurnitureInstanceDelete(region) {
      const value = typeof region === "string" ? { instance_id: region } : context(contextResult(region));
      if (!value.instance_id) return false;
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) {
        self.furnitureInstanceEditNotice = reason;
        return false;
      }
      self.furnitureInstanceDeleteRequestId = value.instance_id;
      return true;
    },
    clearFurnitureInstanceDeleteRequest() {
      self.furnitureInstanceDeleteRequestId = "";
    },
    deleteFurnitureInstance(id) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) {
        self.furnitureInstanceEditNotice = reason;
        throw new Error(reason);
      }
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-delete");
      try {
        const regions = self.regs.filter((region) =>
          region.results.some((result) => context(result).instance_id === id),
        );
        if (!regions.length) throw new Error("待删除家具实例已不存在");
        self.getToolsManager()?.releaseRegionReferences?.(regions);
        self.annotation.unselectAreas();
        for (const region of regions) self.annotation.deleteArea(region);
        self.furnitureInstanceSelectedId = "";
        self.furnitureInstanceDeleteRequestId = "";
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-delete");
      }
    },
    clearFurnitureInstanceOrientation(id) {
      const reason = self.furnitureInstanceOrientationResetBlockReason(id);
      if (reason) {
        self.furnitureInstanceEditNotice = reason;
        throw new Error(reason);
      }
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-orientation-delete");
      try {
        const instance = self.furnitureInstanceLogicals.find((candidate) => candidate.id === id);
        if (!instance) throw new Error("家具实例不存在");
        const wasReviewed = instance.context.review_status === "reviewed";
        const regions = [...self.regs].filter((candidate) =>
          candidate.results.some(
            (result) => ORIENTATION_CONTROLS.has(controlName(result)) && context(result).instance_id === id,
          ),
        );
        const manager = self.getToolsManager();
        const selectedControl = manager.findSelectedTool()?.control?.name;
        const drawingControl = ORIENTATION_CONTROLS.has(self.furnitureInstanceDrawingControl)
          ? self.furnitureInstanceDrawingControl
          : ORIENTATION_CONTROLS.has(selectedControl)
            ? selectedControl
            : "";
        const drawingTool = ORIENTATION_CONTROLS.has(drawingControl)
          ? manager.allTools().find((candidate) => candidate.control?.name === drawingControl)
          : null;
        const ownArea = drawingTool?.currentArea;
        const drawingArea = self.furnitureInstanceTransientOrientationRegion(ownArea)
          ? ownArea
          : self.regs.find((region) => self.furnitureInstanceTransientOrientationRegion(region));
        const drawingBelongsToInstance =
          drawingArea &&
          (regions.includes(drawingArea) || (self.furnitureInstanceSelectedId === id && drawingArea.incomplete));
        if (drawingBelongsToInstance) {
          if (drawingTool.cancelDrawing) drawingTool.cancelDrawing(drawingArea);
          else drawingTool.deleteRegion?.();
        }
        const remaining = regions.filter((region) => self.regs.includes(region));
        self.getToolsManager()?.releaseRegionReferences?.(remaining);
        self.annotation.unselectAreas();
        for (const region of remaining) self.annotation.deleteArea(region);
        self.finishFurnitureInstanceOrientationDrawing(drawingControl, true);
        const changed = Boolean(regions.length);
        if (changed) {
          self.refreshFurnitureInstanceReviews(wasReviewed ? [id] : []);
          if (wasReviewed)
            self.furnitureInstanceEditNotice =
              "朝向已恢复 unknown；reviewed 实例已变为 needs_review（保存值 pending），请重新确认复核。";
          else self.furnitureInstanceEditNotice = "";
        } else {
          self.furnitureInstanceEditNotice = "";
        }
        return changed;
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-orientation-delete");
      }
    },
    importFurnitureInstanceResults(results) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      if (!Array.isArray(results)) throw new Error("导入结果必须为列表");
      const current = self.annotation.serializeAnnotation({ fast: true });
      const references = current.filter((result) => !ALL_CONTROLS.has(controlName(result)));
      const checked = [...references, ...clone(results)];
      const issues = validateFurnitureInstances(checked, checked, { review: false });
      if (issues.length) throw new Error(issues.map((issue) => issue.message).join("；"));
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-import");
      try {
        const prior = self.regs.filter((region) =>
          region.results.some((result) => ALL_CONTROLS.has(controlName(result))),
        );
        self.getToolsManager()?.releaseRegionReferences?.(prior);
        self.annotation.unselectAreas();
        for (const region of prior) self.annotation.deleteArea(region);
        self.annotation.deserializeResults(clone(results));
        self.annotation.updateObjects();
        const actual = self.annotation
          .serializeAnnotation({ fast: true })
          .filter((result) => ALL_CONTROLS.has(controlName(result)));
        if (!sameFurnitureResultKeys(actual, results)) throw new Error("L4 结果未完整载入，已回滚");
        self.furnitureInstanceSelectedId = "";
        self.furnitureInstanceDeleteRequestId = "";
        self.furnitureInstanceDrawingControl = "";
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-import");
      }
    },
  }));
