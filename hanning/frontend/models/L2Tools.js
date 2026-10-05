import { types } from "mobx-state-tree";
import { l1Entries, l1LabelKey, l1ToolShape } from "@hanning/frontend/domain/rooms/l1Tools";

import { l2Configuration } from "@hanning/frontend/domain/rooms/l2Tools";

const initial = () => ({
  zone: { category: "", shape: "rectangle" },
  connection: { category: "", shape: "vector" },
  visual: { category: "", shape: "vector" },
});

// The editor rebuilds annotation/image models after submission. Keep only UI
// choices on the live editor store, and discard them when its task changes.
const taskChoices = new WeakMap();

export const L2Tools = types
  .model("L2Tools")
  .volatile(() => ({ l2Family: "zone", l2Selections: initial() }))
  .views((self) => ({
    get l2Config() {
      return l2Configuration(self);
    },
    get l2ToolbarEnabled() {
      return Boolean(self.l2Config);
    },
    get l2Selection() {
      return self.l2Selections[self.l2Family];
    },
    get l2SwitchBlockReason() {
      if (self.annotation?.isReadOnly() || self.annotation?.store?.annotationStore?.viewingAll) return "当前标注为只读";
      if (self.annotation?.submissionStarted) return "正在保存，请稍候";
      if (self.annotation?.isDrawing || self.annotation?.hasIncompletePolygons)
        return self.l2Selection.shape === "vector"
          ? "请先按 Enter 完成绘制，或按 Esc 取消"
          : "请先完成绘制或按 Esc 取消";
      return "";
    },
    l2ToolBlockReason(tool, starting = false) {
      if (!self.l2ToolbarEnabled || !tool.isDrawingTool) return "";
      // Existing multi-click drawings must still receive their finishing events.
      if (!starting && self.l2SwitchBlockReason) return self.l2SwitchBlockReason;
      if (
        starting &&
        (self.annotation.isReadOnly() ||
          self.annotation.store?.annotationStore?.viewingAll ||
          self.annotation.submissionStarted)
      )
        return "当前不可绘制";
      if (!self.l2Selection.category) return "请先在顶部选择类型";
      const entry = self.l2Config.controls.find((entry) => entry.name === tool.control?.name);
      if (entry?.family === "zone" && !self.focusedRoom) return "请先选择 Focus room";
      const label = entry?.labels.find((label) => l1LabelKey(label) === self.l2Selection.category);
      if (starting && !self.annotation.isDrawing && label && !label.canBeUsed()) return "此类型已达到使用上限";
      const valid = l1Entries(self.l2Config, self.l2Family, self.l2Selection.category).some(
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
    const remember = () => session().set(self.name, { family: self.l2Family, selections: self.l2Selections });
    const clearLabels = () => self.l2Config?.controls.forEach(({ labelControl }) => labelControl.unselectAll());
    const activate = (initializing = false) => {
      self.annotation.unselectAreas();
      clearLabels();
      const tools = self.getToolsManager().allTools();
      const entry = l1Entries(self.l2Config, self.l2Family, self.l2Selection.category).find(
        (entry) => entry.shape === self.l2Selection.shape,
      );
      const tool =
        self.l2Selection.category &&
        entry &&
        tools.find((tool) => tool.control?.name === entry?.name && l1ToolShape(tool) === entry.shape);
      const move = tools.find((tool) => tool.toolName === "MoveTool");
      if (tool || move) {
        if (initializing) {
          if (tool) self.syncL2DrawingLabels(tool);
          self.getToolsManager().selectTool(tool || move, true, true);
        } else self.getToolsManager().selectTool(tool || move, true);
      }
    };
    const choose = (family, category, shape, initializing = false) => {
      if (!self.l2ToolbarEnabled || self.l2SwitchBlockReason) return false;
      const entries = l1Entries(self.l2Config, family, category);
      if (!entries.length) return false;
      shape = entries.some((entry) => entry.shape === shape) ? shape : entries[0].shape;
      self.l2Family = family;
      self.l2Selections = { ...self.l2Selections, [family]: { category, shape } };
      activate(initializing);
      remember();
      return true;
    };
    return {
      initializeL2Tools() {
        if (!self.l2ToolbarEnabled) return;
        const remembered = session().get(self.name);
        if (!remembered) return self.resetL2Tools();
        self.l2Family = remembered.family;
        self.l2Selections = remembered.selections;
        // Resolve the remembered shape against the current configuration.
        const selection = self.l2Selection;
        if (!choose(self.l2Family, selection.category, selection.shape, true) && !self.l2SwitchBlockReason)
          self.resetL2Tools();
      },
      resetL2Tools() {
        if (!self.l2ToolbarEnabled) return;
        self.l2Family = "zone";
        self.l2Selections = initial();
        clearLabels();
        const move = self
          .getToolsManager()
          .allTools()
          .find((tool) => tool.toolName === "MoveTool");
        if (move) self.getToolsManager().selectTool(move, true, true);
        remember();
      },
      selectL2Family(family) {
        const remembered = self.l2Selections[family];
        if (remembered) return choose(family, remembered.category, remembered.shape);
        return false;
      },
      selectL2MoveTool() {
        if (!self.l2ToolbarEnabled || self.l2SwitchBlockReason) return false;
        const manager = self.getToolsManager();
        const move = manager.allTools().find((tool) => tool.toolName === "MoveTool");
        if (!move) return false;
        // Select explicitly: repeated V must not toggle back to drawing.
        if (!move.selected) manager.selectTool(move, true);
        return true;
      },
      selectL2Category(category) {
        return choose(self.l2Family, category, self.l2Selection.shape);
      },
      selectL2Label(control, label) {
        const entry = self.l2Config?.controls.find((entry) => entry.labelControl.name === control.name);
        return entry ? choose(entry.family, l1LabelKey(label), self.l2Selections[entry.family].shape) : false;
      },
      resumeL2Drawing(tool, area) {
        const entry = self.l2Config?.controls.find((entry) => entry.name === tool.control?.name);
        const category = area.results.find((result) => result.from_name.name === entry?.labelControl.name)
          ?.mainValue?.[0];
        if (!entry || !category || self.annotation.isReadOnly()) return false;
        self.l2Family = entry.family;
        self.l2Selections = { ...self.l2Selections, [entry.family]: { category, shape: entry.shape } };
        remember();
        return true;
      },
      finishL2Vector() {
        if (!self.l2ToolbarEnabled || self.annotation.isReadOnly() || !self.annotation.isDrawing) return false;
        const tool = self.getToolsManager().findSelectedTool();
        const area = tool?.getCurrentArea?.();
        if (tool?.toolName !== "VectorTool" || !area || area.incomplete) return false;
        tool.complete();
        return true;
      },
      cancelL2Drawing() {
        if (
          !self.l2ToolbarEnabled ||
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
              self.l2Config.controls.some((entry) => entry.name === tool.control?.name),
          );
        if (!tool || (!self.annotation.isDrawing && !self.annotation.hasIncompletePolygons)) return false;
        tool.stopListening?.();
        if (tool.cancelDrawing) tool.cancelDrawing();
        else tool.deleteRegion();
        tool._resetState?.();
        self.syncL2DrawingLabels(tool);
        remember();
        return true;
      },
      syncL2DrawingLabels(tool) {
        if (!self.l2ToolbarEnabled) return;
        clearLabels();
        self.l2Config.controls
          .find((entry) => entry.name === tool.control?.name)
          ?.labels.find((label) => l1LabelKey(label) === self.l2Selection.category)
          ?.setSelected(true);
      },
      setL2RegionCategory(region, category) {
        if (self.l2SwitchBlockReason || region.isReadOnly()) return false;
        const result = region.results.find((result) =>
          self.l2Config?.controls.some((entry) => entry.labelControl.name === result.from_name.name),
        );
        const label = result?.from_name.children.find((label) => l1LabelKey(label) === category);
        if (!label || (result.mainValue?.[0] !== category && !label.canBeUsed())) return false;
        result.setValue([category]);
        region.notifyDrawingFinished();
        return true;
      },
      prepareL2Tool(tool) {
        // Choosing a category/shape may precede Focus room; canStartDrawing
        // separately enforces the room constraint before creating any geometry.
        if (
          self.l2SwitchBlockReason ||
          !self.l2Selection.category ||
          !l1Entries(self.l2Config, self.l2Family, self.l2Selection.category).some(
            (entry) => entry.name === tool.control?.name && entry.shape === l1ToolShape(tool),
          )
        )
          return false;
        const shape = l1ToolShape(tool);
        self.l2Selections = { ...self.l2Selections, [self.l2Family]: { ...self.l2Selection, shape } };
        self.annotation.unselectAreas();
        self.syncL2DrawingLabels(tool);
        remember();
        return true;
      },
    };
  });
