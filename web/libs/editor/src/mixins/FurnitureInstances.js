import { applySnapshot, getSnapshot, types } from "mobx-state-tree";
import { walkableReferencesFor } from "../furnitureInstances/walkableReferences";
import { furnitureScopeFor, instanceInScope } from "../furnitureInstances/scope";
import { groupCreationState, groupInstanceResults } from "../furnitureInstances/creation";
import { rectanglePreview, rectanglePreviewToken } from "../furnitureInstances/rectanglePreview";

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
import {
  area,
  clone,
  difference,
  EPS_AREA,
  fingerprint,
  resultGeometry,
  validationMultiGeometry,
  VALIDATION_EPS_AREA,
} from "../occupancy/geometry";
import { getFurnitureReviewSession } from "../furnitureInstances/reviewSession";
import { furnitureParentUpdate } from "../furnitureInstances/parentUpdate";
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
    furnitureInstanceRoomId: "",
    furnitureInstanceZoneId: "",
    furnitureInstanceOverview: false,
    furnitureInstanceRoomBackground: false,
    furnitureInstanceReferenceLayers: { windows: true, openings: true, connections: true, barriers: true },
    furnitureInstanceGeometryPreview: null,
    furnitureInstanceTransformCandidate: null,
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
    furnitureInstanceShowAllNames: false,
    furnitureInstanceHoveredId: "",
  }))
  .views((self) => ({
    get furnitureInstancesEnabled() {
      return self.furnitureinstancesv1;
    },
    get furnitureInstanceAvailableTypes() {
      const control = self.annotation.names.get(CONTROLS.type);
      if (!control?.perregion || !["single", "single-radio"].includes(control.choice) || control.toNameTag !== self)
        return [];
      const configured = new Set(control.tiedChildren.map((choice) => choice.resultValue));
      return Object.keys(FURNITURE_TYPES).filter((type) => configured.has(type));
    },
    get furnitureInstanceDraftType() {
      return self.furnitureInstanceAvailableTypes.includes(self.furnitureInstanceType)
        ? self.furnitureInstanceType
        : self.furnitureInstanceAvailableTypes[0] || "";
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
        return self.furnitureInstanceScope.groups;
      } catch {
        return [];
      }
    },
    get furnitureInstanceScope() {
      return furnitureScopeFor(self, self.furnitureInstanceData);
    },
    furnitureInstanceWithinScope(instance) {
      return instanceInScope(self, instance);
    },
    furnitureInstanceRegionInScope(region) {
      const value = context(contextResult(region));
      return (
        !self.furnitureInstancesEnabled ||
        !value.instance_id ||
        region?.isDrawing ||
        (value.room_id === self.furnitureInstanceRoomId && value.zone_id === self.furnitureInstanceZoneId)
      );
    },
    get furnitureInstanceWalkableReferences() {
      return walkableReferencesFor(self, self.furnitureInstanceData);
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
      const id = effectiveFurnitureInstanceSelection(self.annotation.selectedRegions, self.furnitureInstanceSelectedId);
      const instance = self.furnitureInstanceLogicals.find((candidate) => candidate.id === id);
      return instance && instanceInScope(self, instance) ? id : "";
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
      if (getFurnitureReviewSession(self).unsaved) return "请先重试保存或导出窗口备份";
      if (self.furnitureInstanceBusy || self.annotation.submissionStarted) return "操作或保存正在进行";
      if (GEOMETRY_CONTROLS.has(control)) {
        if (!self.furnitureInstanceRoomId || !self.furnitureInstanceZoneId)
          return "请先选择房间、功能分区及 Focus 家具组团";
        if (!self.furnitureInstanceParents.some((parent) => parent.id === self.furnitureInstanceFocusId))
          return "请先选择 Focus 家具组团";
        if (!self.furnitureInstanceDraftType) return "当前项目未配置可用的家具实例类别";
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
      if (getFurnitureReviewSession(self).unsaved) return "请先重试保存或导出窗口备份";
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
      if (getFurnitureReviewSession(self).unsaved) return "请先重试保存或导出窗口备份";
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
    setFurnitureInstanceShowAllNames(value) {
      self.furnitureInstanceShowAllNames = Boolean(value);
    },
    setFurnitureInstanceHoveredId(value) {
      self.furnitureInstanceHoveredId = value || "";
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
      if (!self.furnitureInstanceAvailableTypes.includes(type))
        throw new Error("当前项目尚未启用该家具类别，请先升级配置");
      self.furnitureInstanceType = type;
      self.furnitureInstanceNote = note || "";
    },
    setFurnitureInstanceCategory(id, type) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      if (!self.furnitureInstanceAvailableTypes.includes(type)) throw new Error("当前项目尚未启用该家具类别");
      const instance = self.furnitureInstanceLogicals.find((candidate) => candidate.id === id);
      if (!instance) throw new Error("家具实例不存在");
      if (instance.context.instance_type === type && instance.instanceType === type) return false;
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-category");
      try {
        for (const region of self.regs) {
          for (const result of region.results) {
            const value = context(result);
            if (value.instance_id !== id) continue;
            if (controlName(result) === CONTROLS.type) result.setValue([type]);
            result.setMetaValue("furniture_instance_context", {
              ...value,
              instance_type: type,
              review_status: "pending",
              review_fingerprint: null,
            });
          }
        }
        const current = self.annotation.serializeAnnotation({ fast: true });
        const errors = validateFurnitureInstances(current, current, { review: false }).filter(
          (issue) => issue.instanceId === id,
        );
        if (errors.length) throw new Error(errors.map((issue) => issue.message).join("；"));
        self.furnitureInstanceEditNotice = "已修改当前实例类别，请重新确认复核。";
        return true;
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-category");
      }
    },
    setFurnitureInstanceFocus(id) {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons) throw new Error("请先完成或取消绘制");
      if (id && !self.furnitureInstanceParents.some((parent) => parent.id === id))
        throw new Error("Focus 家具组团不存在");
      if (id) {
        const parent = self.furnitureInstanceParents.find((p) => p.id === id);
        self.setFurnitureInstanceSpace(parent.roomId, parent.zoneId);
      }
      self.furnitureInstanceFocusId = id || "";
      self.furnitureInstanceSelectedId = "";
      self.furnitureInstanceDrawingControl = "";
      self.furnitureInstanceEditNotice = "";
      self.furnitureInstanceGeometryPreview = null;
      self.furnitureInstanceTransformCandidate = null;
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
      self.furnitureInstanceGeometryPreview = null;
      self.furnitureInstanceTransformCandidate = null;
      // List/search/review navigation follows saved identities; canvas only
      // exposes hit targets within the current scope.
      const room = self.furnitureInstanceScope.rooms.find((r) => r.id === instance.context.room_id);
      const zone = self.furnitureInstanceScope.zones.find(
        (z) => z.id === instance.context.zone_id && z.roomId === room?.id,
      );
      if (!room || !zone) {
        self.furnitureInstanceEditNotice = "原父房间或分区已失效，不能按位置重绑实例";
        return;
      }
      self.furnitureInstanceRoomId = room.id;
      self.furnitureInstanceZoneId = zone.id;
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
    setFurnitureInstanceSpace(roomId = "", zoneId = "") {
      if (self.annotation.isDrawing || self.annotation.hasIncompletePolygons || self.furnitureInstanceBusy)
        throw new Error("请先完成绘制或等待保存结束");
      if (getFurnitureReviewSession(self).unsaved) throw new Error("请先重试保存或导出窗口备份");
      const scope = self.furnitureInstanceScope;
      if (roomId && !scope.rooms.some((r) => r.id === roomId)) throw new Error("房间不存在");
      if (zoneId && !scope.zones.some((z) => z.id === zoneId && z.roomId === roomId))
        throw new Error("分区不属于当前房间");
      self.furnitureInstanceRoomId = roomId;
      self.furnitureInstanceZoneId = zoneId;
      self.furnitureInstanceFocusId = "";
      self.furnitureInstanceSelectedId = "";
      self.furnitureInstanceHoveredId = "";
      self.furnitureInstanceDrawingControl = "";
      self.furnitureInstanceGeometryPreview = null;
      self.furnitureInstanceTransformCandidate = null;
      self.annotation.unselectAreas();
      getFurnitureReviewSession(self).clear();
      self.updateRoomConstraintTools?.();
    },
    setFurnitureInstanceReferenceDisplay(key, enabled) {
      if (key === "overview") self.furnitureInstanceOverview = !!enabled;
      else if (key === "roomBackground") self.furnitureInstanceRoomBackground = !!enabled;
      else if (Object.hasOwn(self.furnitureInstanceReferenceLayers, key))
        self.furnitureInstanceReferenceLayers = { ...self.furnitureInstanceReferenceLayers, [key]: !!enabled };
    },
    createFurnitureInstanceFromGroup(groupId, type, token) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      if (groupId !== self.furnitureInstanceFocusId || !self.furnitureInstanceAvailableTypes.includes(type))
        throw new Error("Focus 或项目类别配置已改变");
      const current = self.furnitureInstanceData;
      if (groupCreationState(current, groupId, type).token !== token) throw new Error("父组团已改变");
      const created = groupInstanceResults(current, groupId, type, self.annotation.referenceVersion);
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-from-group");
      try {
        self.annotation.deserializeResults(clone(created.results));
        self.annotation.updateObjects();
        const actual = self.furnitureInstanceData.filter((r) => context(r).instance_id === created.id);
        if (!sameFurnitureResultKeys(actual, created.results)) throw new Error("新实例分块未完整载入");
        return created.id;
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-from-group");
      }
    },
    previewFurnitureRectangle(options = {}) {
      if (self.furnitureInstanceBusy || self.annotation.isDrawing || self.annotation.hasIncompletePolygons)
        throw new Error("请先完成绘制或等待保存结束");
      const instance = self.furnitureInstanceLogicals.find((i) => i.id === self.furnitureInstanceEffectiveSelectedId);
      const part =
        instance?.parts.find((p) => p.id === self.furnitureInstanceActivePartId) ||
        (instance?.parts.length === 1 ? instance.parts[0] : null);
      if (part?.from_name !== CONTROLS.rectangle) throw new Error("请先选择一个矩形实例或其矩形分块");
      const parent = self.furnitureInstanceParents.find((p) => p.id === instance.context.group_id);
      if (!parent) throw new Error("原父组团不存在");
      const token = rectanglePreviewToken(instance, parent, self.annotation.referenceVersion);
      const previous = self.furnitureInstanceGeometryPreview;
      if (previous && previous.token !== token) throw new Error("预览期间实例或参考已改变，请取消后重新预览");
      const parameters = { ...(previous?.options || {}), ...options };
      const preview = rectanglePreview(
        part,
        parent.geometry,
        parameters,
        instance.parts.filter((p) => p.id !== part.id),
      );
      self.furnitureInstanceGeometryPreview = {
        ...preview,
        options: parameters,
        token,
        instanceId: instance.id,
        regionId: part.id,
        reference: self.annotation.referenceVersion,
        annotationId: self.annotation.id,
      };
      self.furnitureInstanceTransformCandidate = null;
      return preview;
    },
    cancelFurnitureRectanglePreview() {
      self.furnitureInstanceGeometryPreview = null;
      self.furnitureInstanceTransformCandidate = null;
    },
    applyFurnitureRectanglePreview() {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      const preview = self.furnitureInstanceGeometryPreview;
      const instance = self.furnitureInstanceLogicals.find((i) => i.id === preview?.instanceId);
      const parent = self.furnitureInstanceParents.find((p) => p.id === instance?.context.group_id);
      if (
        !preview?.valid ||
        !instance ||
        !parent ||
        preview.annotationId !== self.annotation.id ||
        preview.instanceId !== self.furnitureInstanceEffectiveSelectedId ||
        preview.token !== rectanglePreviewToken(instance, parent, self.annotation.referenceVersion)
      )
        throw new Error("预览无效、实例或参考已改变，请重新预览");
      const region = self.regs.find((r) => r.cleanId === preview.regionId);
      if (!region) throw new Error("矩形分块已不存在");
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-rectangle-preview");
      try {
        // Preview has already passed the same pixel-space containment rules.
        // Do not re-snap an explicitly accepted value during model application.
        applySnapshot(region, { ...getSnapshot(region), ...preview.value });
        self.refreshFurnitureInstanceReviews([instance.id]);
        const actual = self.furnitureInstanceData;
        const issues = validateFurnitureInstances(actual, actual, { review: false }).filter(
          (e) => (!e.instanceId || e.instanceId === instance.id) && e.code !== "orientation",
        );
        if (issues.length) throw new Error(issues.map((e) => e.message).join("；"));
        self.annotation.updateObjects();
        self.furnitureInstanceGeometryPreview = null;
        self.furnitureInstanceEditNotice = instance.orientationResults.length
          ? "已应用几何，待重新复核；原方向证据已保留，请检查并在失效时重标。"
          : "已应用几何，请重新复核。";
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-rectangle-preview");
      }
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
      // Rectangle controls have standard, three-point and dynamic tools.
      // Cancel the tool that owns the draft, not the first registered variant.
      const tool = manager.allTools().find((candidate) => candidate.control?.name === control && candidate.currentArea);
      const area = tool?.currentArea;
      const hadDraft = Boolean(area);
      if (area) {
        if (tool.cancelDrawing) tool.cancelDrawing(area);
        else {
          tool.deleteRegion?.();
          tool._resetState?.();
        }
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
    startFurnitureInstanceTool(name, requestedTool = null) {
      const manager = self.getToolsManager();
      const tools = manager.allTools();
      // A rectangle control owns ordinary, three-point and dynamic variants.
      // Preserve a toolbar's exact selection; name-only callers use a manual tool.
      const tool = requestedTool ?? tools.find((candidate) => candidate.control?.name === name && !candidate.dynamic);
      if (!tool || !tools.includes(tool) || tool.control?.name !== name) throw new Error("绘制工具尚未就绪");
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
        ? self.furnitureInstanceDraftType
        : name === CONTROLS.frontDirection
          ? "front_direction"
          : "front_edge";
      state?.children?.find((label) => label.alias === value || label.value === value)?.setSelected(true);
      manager.selectTool(tool, true);
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
        const constrained = Object.keys(target).some((key) => Math.abs(target[key] - accepted[key]) > 1e-6);
        self.furnitureInstanceEditNotice = constrained
          ? "候选轮廓已受原父组团边界限制；可缩小或使用角度适配预览。"
          : "";
        self.furnitureInstanceTransformCandidate =
          constrained && target.width > 0 && target.height > 0
            ? {
                geometry: resultGeometry({
                  value: target,
                  original_width: self.naturalWidth,
                  original_height: self.naturalHeight,
                }),
                valid: false,
              }
            : null;
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
        if (
          area(
            difference(
              validationMultiGeometry(geometry, self.naturalWidth, self.naturalHeight),
              validationMultiGeometry(parent.geometry, self.naturalWidth, self.naturalHeight),
            ),
          ) > VALIDATION_EPS_AREA
        )
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
            self.furnitureInstanceDraftType,
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
      if (region.results.some((item) => GEOMETRY_CONTROLS.has(controlName(item))))
        self.selectFurnitureInstance(value.instance_id);
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
    acceptFurnitureInstanceParentUpdate(id, expectedToken) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      const current = self.annotation.serializeAnnotation({ fast: true });
      const next = furnitureParentUpdate(current, current, id);
      if (expectedToken && next.token !== expectedToken) throw new Error("实例或父组团已变化，请重新检查");
      if (next.results === current) return;
      const contexts = new Map(next.results.map((result) => [resultKey(result), context(result)]));
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-parent-update");
      try {
        for (const region of self.regs)
          for (const result of region.results) {
            const value = contexts.get(`${region.cleanId}\u0000${controlName(result)}`);
            if (value?.instance_id === id) result.setMetaValue("furniture_instance_context", value);
          }
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-parent-update");
      }
      self.furnitureInstanceEditNotice = "已接受原父组团更新，当前实例待复核。";
    },
    confirmFurnitureInstanceReviews(ids) {
      const reason = self.furnitureInstanceOperationBlockReason();
      if (reason) throw new Error(reason);
      const current = self.annotation.serializeAnnotation({ fast: true });
      const next = confirmFurnitureInstances(current, current, ids);
      const contexts = new Map(next.map((result) => [resultKey(result), context(result)]));
      const requested = new Set(ids);
      const snapshot = getSnapshot(self.annotation.areas);
      self.annotation.history.freeze("furniture-instance-review");
      try {
        for (const region of self.regs)
          for (const result of region.results) {
            const value = contexts.get(`${region.cleanId}\u0000${controlName(result)}`);
            if (requested.has(value?.instance_id)) result.setMetaValue("furniture_instance_context", value);
          }
      } catch (error) {
        applySnapshot(self.annotation.areas, snapshot);
        self.annotation.updateObjects();
        throw error;
      } finally {
        self.annotation.history.unfreeze("furniture-instance-review");
      }
      self.furnitureInstanceEditNotice = "";
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
      if (results.some((result) => !self.furnitureInstanceAvailableTypes.includes(context(result).instance_type)))
        throw new Error("导入包含当前项目尚未启用的家具类别，请先升级项目配置");
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
