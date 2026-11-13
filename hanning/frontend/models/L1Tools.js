import { orthogonalizePolygon } from "@hanning/frontend/domain/rooms/orthogonalize";
import { applySnapshot, getSnapshot, types } from "mobx-state-tree";
import { l1Configuration, l1Entries, l1LabelKey, l1ToolShape } from "@hanning/frontend/domain/rooms/l1Tools";
import { doorAxis, doorFrame, doorKind, doorOpeningSymbol, doorOperationError, pointAlong, snapDoorPixel } from "@hanning/frontend/domain/rooms/doorOperation";
import { rotatedRectanglePoints } from "@hanning/frontend/domain/rooms/roomConstraintGeometry";

const initial = () => ({
  room: { category: "", shape: "rectangle" },
  opening: { category: "", shape: "rectangle" },
  window: { category: "", shape: "vector" },
});

// The editor rebuilds annotation/image models after submission. Keep only UI
// choices on the live editor store, and discard them when its task changes.
const taskChoices = new WeakMap();

export const L1Tools = types
  .model("L1Tools")
  .volatile(() => ({ l1Family: "room", l1Selections: initial(), l1DoorSpanEdit: null, l1DoorOpeningsVisible: true }))
  .views((self) => ({
    get l1Config() {
      return l1Configuration(self);
    },
    get l1ToolbarEnabled() {
      return Boolean(self.l1Config);
    },
    get l1Selection() {
      return self.l1Selections[self.l1Family];
    },
    l1DoorFrame(region) {
      if (region?.type !== "rectangleregion") return null;
      return doorFrame(rotatedRectanglePoints({
        x: self.internalToImageX(region.x), y: self.internalToImageY(region.y),
        width: self.internalToImageX(region.width), height: self.internalToImageY(region.height), rotation: region.rotation,
      }), { width: self.currentImageEntity.naturalWidth, height: self.currentImageEntity.naturalHeight });
    },
    get l1SlidingDoor() {
      if (!self.l1ToolbarEnabled || self.annotation.selectedRegions.length !== 1) return null;
      const region = self.annotation.selectedRegions[0];
      if (region.parent !== self || !region.results.some((result) =>
        self.roomV3PortalRectangleControlNames.has(result.from_name?.name) && doorKind(result.mainValue?.[0]) === "sliding"))
        return null;
      return region;
    },
    get l1DoorSymbols() {
      if (!self.l1ToolbarEnabled || !self.l1DoorOpeningsVisible) return [];
      return self.regs.flatMap((region) => {
        if (region.hidden || region.type !== "rectangleregion" ||
          (self.multiImage && self.currentImage !== region.item_index)) return [];
        const result = region.results.find(({ from_name }) => self.roomV3PortalRectangleControlNames.has(from_name?.name));
        const kind = doorKind(result?.mainValue?.[0]);
        const operation = result?.meta?.door_operation;
        if (!kind || !operation) return [];
        const frame = self.l1DoorFrame(region);
        const symbol = frame && doorOpeningSymbol(frame, kind, operation);
        return symbol ? [{ id: region.id, ...symbol }] : [];
      });
    },
    get l1SwitchBlockReason() {
      if (self.annotation?.isReadOnly() || self.annotation?.store?.annotationStore?.viewingAll) return "当前标注为只读";
      if (self.annotation?.submissionStarted) return "正在保存，请稍候";
      if (self.annotation?.isDrawing || self.annotation?.hasIncompletePolygons)
        return self.l1Selection.shape === "vector"
          ? "请先按 Enter 完成绘制，或按 Esc 取消"
          : "请先完成绘制或按 Esc 取消";
      return "";
    },
    l1OrthogonalizeBlockReason(region) {
      if (!self.l1ToolbarEnabled || region?.parent !== self || region?.type !== "polygonregion" ||
          !region.results.some((result) => self.roomV3RoomControlNames.has(result.from_name?.name)))
        return "请选择 L1 Polygon 房间";
      if (self.l1SwitchBlockReason) return self.l1SwitchBlockReason;
      if (region.isReadOnly()) return "当前区域为只读";
      if (self.annotation.selectedRegions.length !== 1 || self.annotation.selectedRegions[0] !== region)
        return "请只选中一个 Polygon 房间";
      if (!region.closed) return "请先完成多边形绘制";
      if (!self.imageIsLoaded) return "图片加载完成后才能正交化";
      return "";
    },
    l1ToolBlockReason(tool, starting = false) {
      if (!self.l1ToolbarEnabled || !tool.isDrawingTool) return "";
      // Existing multi-click drawings must still receive their finishing events.
      if (!starting && self.l1SwitchBlockReason) return self.l1SwitchBlockReason;
      if (
        starting &&
        (self.annotation.isReadOnly() ||
          self.annotation.store?.annotationStore?.viewingAll ||
          self.annotation.submissionStarted)
      )
        return "当前不可绘制";
      if (!self.l1Selection.category) return "请先在顶部选择类型";
      const label = tool.control?.children?.find((label) => l1LabelKey(label) === self.l1Selection.category);
      if (starting && !self.annotation.isDrawing && label && !label.canBeUsed()) return "此类型已达到使用上限";
      const valid = l1Entries(self.l1Config, self.l1Family, self.l1Selection.category).some(
        (entry) => entry.name === tool.control?.name && entry.shape === l1ToolShape(tool),
      );
      return valid ? "" : "此画法不适用于当前对象";
    },
  }))
  .actions((self) => {
    const session = () => {
      const store = self.annotation.store;
      const taskId = String(store.task?.id ?? "");
      let state = taskChoices.get(store);
      if (!state || state.taskId !== taskId) {
        state = { taskId, images: new Map() };
        taskChoices.set(store, state);
      }
      return state.images;
    };
    const remember = () => session().set(self.name, {
      family: self.l1Family, selections: self.l1Selections, showDoorOpenings: self.l1DoorOpeningsVisible,
    });
    const clearLabels = () => self.l1Config?.controls.forEach(({ control }) => control.unselectAll());
    const activate = (initializing = false) => {
      self.l1DoorSpanEdit = null;
      self.annotation.unselectAreas();
      clearLabels();
      const tools = self.getToolsManager().allTools();
      const entry = l1Entries(self.l1Config, self.l1Family, self.l1Selection.category).find(
        (entry) => entry.shape === self.l1Selection.shape,
      );
      const tool =
        self.l1Selection.category &&
        entry &&
        tools.find((tool) => tool.control?.name === entry?.name && l1ToolShape(tool) === entry.shape);
      const move = tools.find((tool) => tool.toolName === "MoveTool");
      if (tool || move) {
        if (initializing) self.getToolsManager().selectTool(tool || move, true, true);
        else self.getToolsManager().selectTool(tool || move, true);
      }
    };
    const choose = (family, category, shape, initializing = false) => {
      if (!self.l1ToolbarEnabled || self.l1SwitchBlockReason) return false;
      const entries = l1Entries(self.l1Config, family, category);
      if (!entries.length) return false;
      shape = entries.some((entry) => entry.shape === shape) ? shape : entries[0].shape;
      self.l1Family = family;
      self.l1Selections = { ...self.l1Selections, [family]: { category, shape } };
      activate(initializing);
      remember();
      return true;
    };
    return {
      initializeL1Tools() {
        if (!self.l1ToolbarEnabled) return;
        const remembered = session().get(self.name);
        self.l1DoorOpeningsVisible = remembered?.showDoorOpenings ?? true;
        if (!remembered) return self.resetL1Tools();
        self.l1Family = remembered.family;
        self.l1Selections = remembered.selections;
        // Resolve the remembered shape against the current configuration.
        const selection = self.l1Selection;
        if (!choose(self.l1Family, selection.category, selection.shape, true) && !self.l1SwitchBlockReason)
          self.resetL1Tools();
      },
      toggleL1DoorOpenings() {
        self.l1DoorOpeningsVisible = !self.l1DoorOpeningsVisible;
        remember();
      },
      resetL1Tools() {
        if (!self.l1ToolbarEnabled) return;
        self.l1DoorSpanEdit = null;
        self.l1Family = "room";
        self.l1Selections = initial();
        clearLabels();
        const move = self
          .getToolsManager()
          .allTools()
          .find((tool) => tool.toolName === "MoveTool");
        if (move) self.getToolsManager().selectTool(move, true, true);
        remember();
      },
      selectL1Family(family) {
        const remembered = self.l1Selections[family];
        if (remembered) return choose(family, remembered.category, remembered.shape);
        return false;
      },
      selectL1MoveTool() {
        if (!self.l1ToolbarEnabled || self.l1SwitchBlockReason) return false;
        self.l1DoorSpanEdit = null;
        const manager = self.getToolsManager();
        const move = manager.allTools().find((tool) => tool.toolName === "MoveTool");
        if (!move) return false;
        // Select explicitly: repeated V must not toggle back to drawing.
        if (!move.selected) manager.selectTool(move, true);
        return true;
      },
      selectL1Category(category) {
        return choose(self.l1Family, category, self.l1Selection.shape);
      },
      selectL1Label(control, label) {
        const entry = self.l1Config?.controls.find((entry) => entry.name === control.name);
        return entry ? choose(entry.family, l1LabelKey(label), entry.shape) : false;
      },
      resumeL1Drawing(tool, area) {
        const entry = self.l1Config?.controls.find((entry) => entry.name === tool.control?.name);
        const category = area.results.find((result) => result.from_name.name === entry?.name)?.mainValue?.[0];
        if (!entry || !category || self.annotation.isReadOnly()) return false;
        self.l1Family = entry.family;
        self.l1Selections = { ...self.l1Selections, [entry.family]: { category, shape: entry.shape } };
        remember();
        return true;
      },
      finishL1Vector() {
        if (!self.l1ToolbarEnabled || self.annotation.isReadOnly() || !self.annotation.isDrawing) return false;
        const tool = self.getToolsManager().findSelectedTool();
        const area = tool?.getCurrentArea?.();
        if (tool?.toolName !== "VectorTool" || !area || area.incomplete) return false;
        tool.complete();
        return true;
      },
      cancelL1Drawing() {
        if (
          !self.l1ToolbarEnabled ||
          self.annotation.isReadOnly() ||
          self.annotation.store?.annotationStore?.viewingAll
        )
          return false;
        const tool = self
          .getToolsManager()
          .allTools()
          .find(
            (tool) =>
              tool.isDrawingTool &&
              tool.getCurrentArea?.() &&
              self.l1Config.controls.some((entry) => entry.name === tool.control?.name),
          );
        if (!tool || (!self.annotation.isDrawing && !self.annotation.hasIncompletePolygons)) return false;
        tool.stopListening?.();
        if (tool.cancelDrawing) tool.cancelDrawing();
        else tool.deleteRegion();
        tool._resetState?.();
        self.syncL1DrawingLabels(tool);
        remember();
        return true;
      },
      syncL1DrawingLabels(tool) {
        if (!self.l1ToolbarEnabled) return;
        clearLabels();
        tool.control.children.find((label) => l1LabelKey(label) === self.l1Selection.category)?.setSelected(true);
      },
      orthogonalizeL1Room(region) {
        const blocked = self.l1OrthogonalizeBlockReason(region);
        if (blocked) throw new Error(blocked);
        const original = region.points.map(({ x, y }) => ({ x, y }));
        const fitted = orthogonalizePolygon(original, self.naturalWidth, self.naturalHeight);
        if (!fitted.changed) return false;
        const previous = getSnapshot(region);
        const history = self.annotation.history;
        history.freeze("l1-orthogonalize");
        try {
          region.setPoints(fitted.points.flatMap(({ x, y }) => [x, y]));
          if (region.points.some((p, i) => Math.abs(p.x - fitted.points[i].x) > 1e-7 || Math.abs(p.y - fitted.points[i].y) > 1e-7))
            throw new Error("当前边界约束不允许完整正交化，已保留原形状。");
          region.notifyDrawingFinished();
          return true;
        } catch (error) {
          applySnapshot(region, previous);
          throw error;
        } finally {
          history.unfreeze("l1-orthogonalize");
        }
      },
      setL1RegionCategory(region, category) {
        if (self.l1SwitchBlockReason || region.isReadOnly()) return false;
        const result = region.results.find((result) =>
          self.l1Config?.controls.some((entry) => entry.name === result.from_name.name),
        );
        const label = result?.from_name.children.find((label) => l1LabelKey(label) === category);
        if (!label || (result.mainValue?.[0] !== category && !label.canBeUsed())) return false;
        const history = self.annotation.history;
        history.freeze("l1-region-category");
        try {
          if (result.mainValue?.[0] !== category) {
            self.cancelL1DoorSpan(region.id);
            if (result.meta?.door_operation != null) result.setMetaValue("door_operation", null);
          }
          result.setValue([category]);
          region.notifyDrawingFinished();
        } finally {
          history.unfreeze("l1-region-category");
        }
        return true;
      },
      startL1DoorSpan(region, mode = "draw", span = null, savedPixels = null) {
        if (self.l1SlidingDoor !== region || self.l1SwitchBlockReason || region.isReadOnly()) return false;
        const frame = self.l1DoorFrame(region);
        if (!frame) return false;
        let points = null;
        if (mode === "adjust") {
          const axis = doorAxis(frame);
          const step = 1 / frame.spanPx;
          const oldPoints = savedPixels?.map(([x, y]) => ({ x, y }));
          const start = snapDoorPixel(frame, oldPoints?.[0] ?? pointAlong(...axis, span[0]), 0, 1 - step);
          const end = start && snapDoorPixel(frame, oldPoints?.[1] ?? pointAlong(...axis, span[1]), start.ratio + step);
          if (savedPixels && !doorOperationError({
            version: 1, kind: "sliding", clear_span: span, clear_span_points_px: savedPixels,
          }, "sliding", frame)) {
            points = oldPoints;
          } else if (end) {
            span = [start.ratio, end.ratio];
            points = [start.pixel, end.pixel];
          } else {
            mode = "draw";
            span = null;
          }
        }
        self.l1DoorSpanEdit = { id: region.id, mode, start: null, span, points, notice: "" };
        return true;
      },
      cancelL1DoorSpan(id) {
        if (!self.l1DoorSpanEdit || (id != null && id !== self.l1DoorSpanEdit.id)) return false;
        self.l1DoorSpanEdit = null;
        return true;
      },
      placeL1DoorSpanPoint(point, endpoint = null) {
        const edit = self.l1DoorSpanEdit;
        const region = self.l1SlidingDoor;
        if (!edit || region?.id !== edit.id || self.l1SwitchBlockReason || region.isReadOnly()) return;
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
        const frame = self.l1DoorFrame(region);
        if (!frame) return;
        if (edit.mode === "draw") {
          const snapped = snapDoorPixel(frame, point);
          if (!snapped || (edit.start && Math.abs(snapped.ratio - edit.start.ratio) * frame.spanPx < 1 - 1e-6)) {
            self.l1DoorSpanEdit = { ...edit, notice: "请选择门洞内另一个可用像素点。" };
          } else if (!edit.start) {
            self.l1DoorSpanEdit = { ...edit, start: snapped, notice: "" };
          } else {
            const ends = [edit.start, snapped].sort((a, b) => a.ratio - b.ratio);
            self.l1DoorSpanEdit = { ...edit, mode: "adjust", span: ends.map((end) => end.ratio),
              points: ends.map((end) => end.pixel), notice: "" };
          }
        } else if (edit.span && (endpoint === 0 || endpoint === 1)) {
          const step = 1 / frame.spanPx;
          const snapped = snapDoorPixel(frame, point,
            endpoint === 0 ? 0 : edit.span[0] + step, endpoint === 0 ? edit.span[1] - step : 1);
          if (!snapped) return edit.points[endpoint];
          const span = [...edit.span];
          const points = [...edit.points];
          span[endpoint] = snapped.ratio;
          points[endpoint] = snapped.pixel;
          self.l1DoorSpanEdit = { ...edit, span, points };
          return snapped.pixel;
        }
      },
      setL1DoorOperation(region, operation) {
        if (!self.l1ToolbarEnabled || region?.parent !== self || self.l1SwitchBlockReason || region.isReadOnly() ||
            self.annotation.selectedRegions.length !== 1 || self.annotation.selectedRegions[0] !== region)
          throw new Error("请选择一个可编辑的 L1 门洞。");
        const result = region.results.find((candidate) =>
          self.roomV3PortalRectangleControlNames.has(candidate.from_name?.name),
        );
        const kind = doorKind(result?.mainValue?.[0]);
        const frame = self.l1DoorFrame(region);
        if (!kind || !frame) throw new Error("请先确认门型与门洞几何。");
        const error = doorOperationError(operation, kind, frame);
        if (error) throw new Error(error);
        const history = self.annotation.history;
        history.freeze("l1-door-operation");
        try {
          result.setMetaValue("door_operation", operation);
          region.notifyDrawingFinished();
          self.cancelL1DoorSpan(region.id);
        } finally {
          history.unfreeze("l1-door-operation");
        }
      },
      prepareL1Tool(tool) {
        if (self.l1ToolBlockReason(tool)) return false;
        self.l1DoorSpanEdit = null;
        const shape = l1ToolShape(tool);
        self.l1Selections = { ...self.l1Selections, [self.l1Family]: { ...self.l1Selection, shape } };
        self.annotation.unselectAreas();
        self.syncL1DrawingLabels(tool);
        remember();
        return true;
      },
    };
  });
