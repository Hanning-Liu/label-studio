import { useState } from "react";
import { observer } from "mobx-react";
import { Button } from "@humansignal/ui";

export const PolygonOrthogonalize = observer(({ region }) => {
  const [notice, setNotice] = useState(null);
  const image = region.parent;
  const kind = image?.orthogonalizeRegionKind?.(region);
  if (!kind) return null;
  const signature = () => JSON.stringify(region.points.map(({ x, y }) => [x, y]));
  const blocked = image.polygonOrthogonalizeBlockReason(region);
  const current = notice?.signature === signature() ? notice : null;
  return (
    <div style={{ marginTop: 8 }}>
      <Button type="button" size="small" disabled={!!blocked}
        aria-label={`正交化选中的 ${kind} Polygon`}
        tooltip={blocked || "各边横平竖直并吸附到原图整数像素；不越出所属父级，仅调整当前组成块，支持撤销"}
        onClick={() => {
          try {
            const changed = image.orthogonalizePartitionPolygon(region);
            setNotice({ signature: signature(), error: false, text: changed
              ? "已正交化并吸附到原图像素，支持撤销；请检查相邻区域与复核状态。"
              : "此区域已为正交形状且对齐原图像素，无需调整。" });
          } catch (error) {
            setNotice({ signature: signature(), error: true, text: error.message });
          }
        }}>正交化（横平竖直）</Button>
      <p role={current?.error ? "alert" : "status"} style={{ fontSize: 12, marginTop: 4 }}>
        {blocked || current?.text || "仅调整当前 Polygon，保持父级归属；支持撤销。"}
      </p>
    </div>
  );
});
