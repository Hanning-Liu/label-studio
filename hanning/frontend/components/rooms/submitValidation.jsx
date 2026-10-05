import { useState } from "react";
import { Modal } from "antd";
import { Button } from "@humansignal/ui";
import { focusOccupancy } from "@hanning/frontend/domain/occupancy/focus";
import { regionToInternalPolygon, vectorToInternalSegment } from "@hanning/frontend/domain/rooms/imageGeometry";

const findRegion = (item, id) => item.regs.find((region) => region.cleanId === id);
const regionTitle = (region, id) => region
  ? `${Number.isFinite(region.region_index) ? `#${region.region_index} ` : ""}${region.labelName || "未分类区域"}`
  : `已不存在的区域（${id}）`;

export function roomValidationItems(item, issues) {
  return issues.map((issue) => {
    const targets = [...new Set(issue.regionIds)].map((id) => ({
      id,
      title: regionTitle(findRegion(item, id), id),
    }));
    let message = issue.message;
    for (const target of targets) message = message.split(target.id).join(target.title);
    return { ...issue, message, targets };
  });
}

export async function locateRoomValidation(item, regionId) {
  if (item.annotation.isDrawing || item.annotation.hasIncompletePolygons) throw new Error("请先完成绘制或按 Esc 取消。");
  const region = findRegion(item, regionId);
  if (!region) throw new Error("该区域已不存在，请关闭提示后重新检查任务。");
  const points = regionToInternalPolygon(region, item) || vectorToInternalSegment(region, item);
  if (!points?.length || points.some(({ x, y }) => !Number.isFinite(x) || !Number.isFinite(y))) {
    throw new Error("该区域坐标无效，请通过右侧区域列表检查。");
  }
  if (item.l1ToolbarEnabled && !item.selectL1MoveTool()) throw new Error("当前状态不能切换工具，请关闭提示后重试。");
  item.annotation.unselectAreas();
  item.annotation.selectAreas([region]);
  await focusOccupancy(item, [[points.map(({ x, y }) => [x, y])]], '[data-testid="l1-tools"]');
  return region;
}

export const RoomValidationContent = ({ items, onLocate }) => {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <section aria-label="L1 几何校验问题">
      <p>编号与画布标签、右侧区域列表一致。点击定位后会关闭此提示，并选中对应区域。</p>
      <ol style={{ maxHeight: "50vh", overflowY: "auto", paddingLeft: 24 }}>
        {items.map((issue, index) => (
          <li key={index} style={{ marginBottom: 16 }}>
            <strong>{issue.message}</strong>
            <p>{issue.hint}</p>
            {issue.targets.map((target, targetIndex) => (
              <Button
                key={target.id}
                type="button"
                size="small"
                disabled={busy}
                className="mr-2 mb-2"
                onClick={async () => {
                  setBusy(true);
                  try {
                    await onLocate(target.id);
                    setError("");
                  } catch (cause) {
                    setError(cause.message || "无法定位该区域");
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {targetIndex ? "定位相关房间" : "定位并选中"} {target.title}
              </Button>
            ))}
          </li>
        ))}
      </ol>
      {error && <p role="alert">{error}</p>}
    </section>
  );
};

export function showRoomValidationWarning(item, issues) {
  let modal;
  modal = Modal.warning({
    title: `L1 几何校验未通过（${issues.length} 项）`,
    content: <RoomValidationContent items={roomValidationItems(item, issues)} onLocate={async (id) => {
      await locateRoomValidation(item, id);
      modal?.destroy();
    }} />,
    okText: "关闭",
    width: 700,
  });
  return modal;
}
