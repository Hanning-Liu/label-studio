import { getSnapshot, types } from "mobx-state-tree";

import { analyzeWindowParents, windowContextFor } from "./domain";

const csvNames = (value) =>
  String(value || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

const numberOption = (value, fallback, name, { allowZero = false, maximum = null, nullable = false } = {}) => {
  const raw = value ?? fallback;
  const normalized = String(raw).trim();
  if (nullable && ["", "null", "none"].includes(normalized.toLowerCase())) return null;
  const parsed = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(normalized) ? Number(normalized) : Number.NaN;
  const lowerBoundValid = allowZero ? parsed >= 0 : parsed > 0;
  if (!Number.isFinite(parsed) || !lowerBoundValid || (maximum !== null && parsed > maximum)) {
    const range = allowZero ? `介于 0 和 ${maximum} 之间` : maximum === null ? "大于 0" : `大于 0 且不超过 ${maximum}`;
    throw new Error(`${name} 必须${range}。`);
  }
  return parsed;
};

export const windowOptionsFromAttributes = (attributes) => {
  const roomControls = csvNames(attributes.roomv3controls);
  const windowControls = csvNames(attributes.windowcontrols);
  if (!roomControls.length) throw new Error("roomV3Controls 不能为空。");
  if (!windowControls.length) throw new Error("windowControls 不能为空。");
  return {
    roomControls,
    windowControls,
    boundaryMatchTolerancePx: numberOption(
      attributes.windowboundarymatchtolerancepx,
      "2",
      "windowBoundaryMatchTolerancePx",
    ),
    pairSearchLimitPx: numberOption(attributes.windowpairsearchlimitpx, "40", "windowPairSearchLimitPx"),
    minimumProjectedOverlapPx: numberOption(
      attributes.windowminimumprojectedoverlappx,
      "8",
      "windowMinimumProjectedOverlapPx",
    ),
    maximumTangentDeltaDeg: numberOption(
      attributes.windowmaximumtangentdeltadeg,
      "10",
      "windowMaximumTangentDeltaDeg",
      { allowZero: true, maximum: 90 },
    ),
    flatteningTolerancePx: numberOption(attributes.windowflatteningtolerancepx, "0.5", "windowFlatteningTolerancePx"),
    lowerLevelInwardProjectionLimitPx: numberOption(
      attributes.windowinwardprojectionlimitpx,
      "60",
      "windowInwardProjectionLimitPx",
      { nullable: true },
    ),
  };
};

const validateConfiguredControls = (image, options) => {
  for (const name of options.roomControls) {
    const control = image.annotation?.names?.get(name);
    if (!control || !["rectanglelabels", "polygonlabels"].includes(String(control.type).toLowerCase())) {
      throw new Error(`房间控件 ${name} 缺失或不是 RectangleLabels/PolygonLabels。`);
    }
  }
  for (const name of options.windowControls) {
    const control = image.annotation?.names?.get(name);
    if (!control || String(control.type).toLowerCase() !== "vectorlabels") {
      throw new Error(`窗户控件 ${name} 缺失或不是 VectorLabels。`);
    }
    const labels = (control.children || []).map((child) =>
      String(child.value || "")
        .trim()
        .toLowerCase(),
    );
    if (!labels.includes("window")) throw new Error(`窗户控件 ${name} 必须包含 Window 标签。`);
  }
};

export const RoomWindows = types
  .model("RoomWindows", {
    roomwindowv1: types.optional(types.boolean, false),
    windowcontrols: types.optional(types.string, "window_vector"),
    windowboundarymatchtolerancepx: types.optional(types.string, "2"),
    windowpairsearchlimitpx: types.optional(types.string, "40"),
    windowminimumprojectedoverlappx: types.optional(types.string, "8"),
    windowmaximumtangentdeltadeg: types.optional(types.string, "10"),
    windowflatteningtolerancepx: types.optional(types.string, "0.5"),
    windowinwardprojectionlimitpx: types.optional(types.string, "60"),
  })
  .views((self) => ({
    get windowEnabled() {
      return self.roomwindowv1;
    },
    get windowControlNames() {
      return new Set(csvNames(self.windowcontrols));
    },
    get windowOptions() {
      const options = windowOptionsFromAttributes(self);
      validateConfiguredControls(self, options);
      return options;
    },
    get windowRegions() {
      if (!self.windowEnabled) return [];
      return self.regs.filter((region) =>
        region.results.some((result) => self.windowControlNames.has(result.from_name?.name)),
      );
    },
    get windowData() {
      if (!self.windowEnabled) return [];
      getSnapshot(self.annotation.areas);
      return self.annotation.serializeAnnotation({ fast: true });
    },
    get windowAnalysis() {
      if (!self.windowEnabled) return { rooms: [], traces: [], issues: [] };
      try {
        return analyzeWindowParents(self.windowData, self.windowOptions);
      } catch (error) {
        return {
          rooms: [],
          traces: [],
          issues: [
            {
              code: "invalid_window_config",
              result_id: null,
              room_ids: [],
              candidates: [],
              message: `窗户配置无效：${error.message}`,
            },
          ],
        };
      }
    },
    get windowErrors() {
      return self.windowAnalysis.issues;
    },
  }))
  .actions((self) => {
    const updateRegion = (region, analysis) => {
      const labeling = region?.results.find((result) => self.windowControlNames.has(result.from_name?.name));
      if (!labeling) return;
      const trace = analysis.traces.find(
        (candidate) =>
          candidate.result.id === region.cleanId && self.windowControlNames.has(candidate.result.from_name),
      );
      if (!trace) return;
      const previous = labeling.meta?.window_context || null;
      const next = windowContextFor(trace, self.windowOptions, previous);
      if (JSON.stringify(previous) !== JSON.stringify(next)) labeling.setMetaValue("window_context", next);
    };
    return {
      refreshWindowRegion(region) {
        if (!self.windowEnabled) return [];
        const analysis = self.windowAnalysis;
        updateRegion(region, analysis);
        return analysis.issues;
      },
      refreshWindowDerivations() {
        if (!self.windowEnabled) return [];
        const analysis = self.windowAnalysis;
        self.windowRegions.forEach((region) => updateRegion(region, analysis));
        return analysis.issues;
      },
      finalizeWindowRegion(region) {
        if (!self.windowEnabled) return;
        self.refreshWindowRegion(region);
      },
      validateWindows() {
        return self.windowEnabled ? self.windowErrors : [];
      },
      selectWindowIssue(issue) {
        if (!self.windowEnabled || !issue?.result_id) return false;
        const region = self.windowRegions.find((candidate) => candidate.cleanId === issue.result_id);
        if (!region) return false;
        self.annotation.unselectAreas();
        self.annotation.selectAreas([region]);
        return true;
      },
    };
  });
