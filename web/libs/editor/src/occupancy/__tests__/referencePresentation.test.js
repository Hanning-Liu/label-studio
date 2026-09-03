import { referenceSourcePath, referenceState, shortReferenceVersion } from "../referencePresentation";

test("reference path uses user-facing Chinese labels and preserves ids", () => {
  expect(referenceSourcePath({ source_project_id: 10, source_task_id: 20, source_annotation_id: 11 })).toEqual([
    { label: "L2 功能分区项目", idLabel: "项目编号", id: "10" },
    { label: "平面图任务", idLabel: "任务编号", id: "20" },
    { label: "正式提交的标注", idLabel: "标注编号", id: "11" },
  ]);
});

test("reference versions are shortened for the main view but can remain complete in technical details", () => {
  expect(shortReferenceVersion("484d1fb2be79d25ef5287432afbb7300dcf4477a0235039c660b1c09ae3c702b")).toBe(
    "484d1fb2be79…",
  );
  expect(shortReferenceVersion(null)).toBe("暂无版本信息");
});

test("reference state explains current, changed and unavailable sources", () => {
  expect(referenceState(null, false).title).toBe("正在读取参考状态");
  expect(referenceState({}, false).title).toBe("当前参考已是最新版本");
  expect(referenceState({}, true).title).toBe("来源有新版本，尚未应用");
  expect(referenceState({ error: "来源任务不存在" }, true)).toEqual({
    tone: "error",
    title: "参考来源当前不可用",
    detail: "来源任务不存在",
  });
});
