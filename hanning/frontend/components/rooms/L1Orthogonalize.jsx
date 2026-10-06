import { useState } from "react";
import { observer } from "mobx-react";
import { Button } from "@humansignal/ui";

export const L1Orthogonalize = observer(({ region }) => {
  const [notice, setNotice] = useState(null);
  const image = region.parent;
  if (!image?.l1ToolbarEnabled || region.type !== "polygonregion" ||
      !region.results.some((result) => image.roomV3RoomControlNames.has(result.from_name?.name))) return null;
  const signature = () => JSON.stringify(region.points.map(({ x, y }) => [x, y]));
  const blocked = image.l1OrthogonalizeBlockReason(region);
  const currentNotice = notice?.signature === signature() ? notice : null;
  return (
    <div style={{ marginTop: 12 }}>
      <Button
        type="button"
        size="small"
        disabled={!!blocked}
        aria-label="正交化选中的 Polygon 房间"
        tooltip={blocked || "将每条边按更接近的水平或垂直方向对齐，端点吸附到原图整数像素；支持撤销"}
        onClick={() => {
          try {
            const changed = image.orthogonalizeL1Room(region);
            setNotice({ signature: signature(), error: false, text: changed
              ? "已正交化并吸附到原图像素，可通过底部撤销恢复。请检查门窗及相邻房间的衔接。"
              : "此房间已为正交形状且对齐原图像素，无需调整。" });
          } catch (error) {
            setNotice({ signature: signature(), error: true, text: error.message });
          }
        }}
      >正交化（横平竖直）</Button>
      <p role={currentNotice?.error ? "alert" : "status"} style={{ fontSize: 12, marginTop: 8 }}>
        {blocked || currentNotice?.text || "仅调整当前房间，支持撤销；请检查门窗及相邻房间的衔接。"}
      </p>
    </div>
  );
});
