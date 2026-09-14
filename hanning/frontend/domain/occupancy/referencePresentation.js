const entityId = (value) => (value === null || value === undefined || value === "" ? "未提供" : String(value));

export function referenceSourcePath(status) {
  return [
    { label: "L2 功能分区项目", idLabel: "项目编号", id: entityId(status?.source_project_id) },
    { label: "平面图任务", idLabel: "任务编号", id: entityId(status?.source_task_id) },
    { label: "正式提交的标注", idLabel: "标注编号", id: entityId(status?.source_annotation_id) },
  ];
}

export function shortReferenceVersion(value) {
  if (!value) return "暂无版本信息";
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

export function referenceState(status, changed) {
  if (!status) {
    return {
      tone: "neutral",
      title: "正在读取参考状态",
      detail: "请稍候，来源路径会在状态读取完成后显示。",
    };
  }
  if (status?.error) {
    return {
      tone: "error",
      title: "参考来源当前不可用",
      detail: status.error,
    };
  }
  if (changed) {
    return {
      tone: "warning",
      title: "来源有新版本，尚未应用",
      detail: "当前 L3 仍使用原参考；应用前不会改动现有家具组团或空闲区域。",
    };
  }
  return {
    tone: "success",
    title: "当前参考已是最新版本",
    detail: "本任务使用的 L2 参考与来源端正式标注一致。",
  };
}
