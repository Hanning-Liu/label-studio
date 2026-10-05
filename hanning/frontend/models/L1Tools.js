import { types } from "mobx-state-tree";
import { l1Configuration, l1Entries, l1LabelKey, l1ToolShape } from "@hanning/frontend/domain/rooms/l1Tools";

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
  .volatile(() => ({ l1Family: "room", l1Selections: initial() }))
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
    get l1SwitchBlockReason() {
      if (self.annotation?.isReadOnly() || self.annotation?.store?.annotationStore?.viewingAll) return "当前标注为只读";
      if (self.annotation?.submissionStarted) return "正在保存，请稍候";
      if (self.annotation?.isDrawing || self.annotation?.hasIncompletePolygons)
        return self.l1Selection.shape === "vector"
          ? "请先按 Enter 完成绘制，或按 Esc 取消"
          : "请先完成绘制或按 Esc 取消";
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
    const remember = () => session().set(self.name, { family: self.l1Family, selections: self.l1Selections });
    const clearLabels = () => self.l1Config?.controls.forEach(({ control }) => control.unselectAll());
    const activate = (initializing = false) => {
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
        if (!remembered) return self.resetL1Tools();
        self.l1Family = remembered.family;
        self.l1Selections = remembered.selections;
        // Resolve the remembered shape against the current configuration.
        const selection = self.l1Selection;
        if (!choose(self.l1Family, selection.category, selection.shape, true) && !self.l1SwitchBlockReason)
          self.resetL1Tools();
      },
      resetL1Tools() {
        if (!self.l1ToolbarEnabled) return;
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
      setL1RegionCategory(region, category) {
        if (self.l1SwitchBlockReason || region.isReadOnly()) return false;
        const result = region.results.find((result) =>
          self.l1Config?.controls.some((entry) => entry.name === result.from_name.name),
        );
        const label = result?.from_name.children.find((label) => l1LabelKey(label) === category);
        if (!label || (result.mainValue?.[0] !== category && !label.canBeUsed())) return false;
        result.setValue([category]);
        region.notifyDrawingFinished();
        return true;
      },
      prepareL1Tool(tool) {
        if (self.l1ToolBlockReason(tool)) return false;
        const shape = l1ToolShape(tool);
        self.l1Selections = { ...self.l1Selections, [self.l1Family]: { ...self.l1Selection, shape } };
        self.annotation.unselectAreas();
        self.syncL1DrawingLabels(tool);
        remember();
        return true;
      },
    };
  });
