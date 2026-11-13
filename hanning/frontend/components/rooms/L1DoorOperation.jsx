import { useEffect, useId, useState } from "react";
import { observer } from "mobx-react";
import { isAlive } from "mobx-state-tree";
import { CheckOutlined, CloseOutlined, DragOutlined, EditOutlined } from "@ant-design/icons";
import { doorOperationError, pointAlong } from "@hanning/frontend/domain/rooms/doorOperation";
import styles from "./L1Controls.module.scss";

const midpoint = ([a, b]) => pointAlong(a, b, 0.5);
const edgeLabel = (index, labels) => labels[index];
const parseEdge = (value) => value === "" ? null : Number(value);

function DoorDiagram({ frame, hinge, swing }) {
  const marker = useId();
  const points = frame.edges.map(([point]) => point);
  const center = midpoint(frame.swingEdges.map((edge) => midpoint(frame.edges[edge])));
  const size = Math.max(...points.map(({ x, y }) => Math.hypot(x - center.x, y - center.y)));
  const view = ({ x, y }) => [(x - center.x) * 86 / size + 120, (y - center.y) * 86 / size + 116];
  const line = ([a, b], color, width, arrow = false) => {
    const [x1, y1] = view(a);
    const [x2, y2] = view(b);
    return <line {...{ x1, y1, x2, y2 }} stroke={color} strokeWidth={width}
      markerEnd={arrow ? `url(#${marker})` : undefined} />;
  };
  const direction = frame.swingEdges.includes(swing) && midpoint(frame.edges[swing]);
  const target = direction && pointAlong(center, direction,
    1 + (size * 0.45) / Math.hypot(direction.x - center.x, direction.y - center.y));
  return (
    <svg viewBox="0 0 240 232" className={styles.doorDiagram} role="img" aria-label="按原图方向显示门洞、铰链端、开启侧或通行段">
      <defs><marker id={marker} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4"
        orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z" fill="#0b8174" /></marker></defs>
      <polygon points={points.map((point) => view(point).join(",")).join(" ")} fill="none" stroke="currentColor" strokeWidth="1.5" />
      {frame.hingeEdges.includes(hinge) && line(frame.edges[hinge], "#be5011", 5)}
      {target && line([center, target], "#0b8174", 3, true)}
      {frame.edges.map((edge, index) => {
        const mid = midpoint(edge);
        const distance = Math.hypot(mid.x - center.x, mid.y - center.y);
        const [x, y] = view(pointAlong(center, mid, 1 + size * 0.23 / distance));
        const end = frame.hingeEdges.indexOf(index);
        return <text key={index} x={x} y={y} textAnchor="middle" dominantBaseline="middle" fill="currentColor" fontSize="13">
          {end === -1 ? edgeLabel(frame.swingEdges.indexOf(index), ["侧 A", "侧 B"]) : edgeLabel(end, ["端 1", "端 2"])}
        </text>;
      })}
    </svg>
  );
}

const DoorFields = observer(({ region, kind, saved, frame, disabled }) => {
  const image = region.parent;
  const edit = image.l1DoorSpanEdit?.id === region.id ? image.l1DoorSpanEdit : null;
  const [hinge, setHinge] = useState(saved?.hinge_edge ?? "");
  const [swing, setSwing] = useState(saved?.swing_edge ?? "");
  const [groups, setGroups] = useState(saved?.group_leaf_counts?.join(", ") ?? "");
  const [notice, setNotice] = useState("");
  const span = edit ? edit.span : saved?.clear_span ?? null;
  const pixels = edit ? edit.points?.map(({ x, y }) => [x, y]) : saved?.clear_span_points_px;
  const counts = groups.trim() ? groups.trim().split(/[,，]/).map((item) => Number(item.trim())) : null;
  const operation = kind === "swing"
    ? { version: 1, kind, hinge_edge: parseEdge(String(hinge)), swing_edge: parseEdge(String(swing)) }
    : { version: 1, kind, clear_span: span, group_leaf_counts: counts,
      ...(pixels ? { clear_span_points_px: pixels } : {}) };
  const error = doorOperationError(operation, kind, frame);
  const clearingAll = edit?.mode === "clear" && counts == null;
  const unchanged = JSON.stringify(operation) === JSON.stringify(saved);
  const apply = (value) => {
    try {
      region.parent.setL1DoorOperation(region, value);
      setNotice("");
    } catch (error) {
      setNotice(error.message);
    }
  };
  const edgeSelect = (title, value, setValue, edges, names) => (
    <label>{title}
      <select value={value} onChange={(e) => setValue(e.target.value === "" ? "" : Number(e.target.value))}>
        <option value="">请选择</option>
        {edges.map((edge, i) => <option key={edge} value={edge}>{names[i]}</option>)}
      </select>
    </label>
  );
  return (
    <fieldset className={styles.doorFields} disabled={disabled}>
      <legend>{kind === "swing" ? "平开门开启方式" : "推拉门通行与门组"}</legend>
      {kind === "swing" ? <>
        <DoorDiagram frame={frame} hinge={hinge} swing={swing} />
        {edgeSelect("铰链段", hinge, setHinge, frame.hingeEdges, ["端 1", "端 2"])}
        {edgeSelect("门扇开启侧", swing, setSwing, frame.swingEdges, ["侧 A", "侧 B"])}
      </> : <>
        <div className={styles.doorActions}>
          {edit?.mode !== "clear" && <button type="button" className={styles.doorDraw}
            aria-pressed={edit?.mode === "draw"} disabled={edit?.mode === "draw"}
            onClick={() => image.startL1DoorSpan(region)}>
            <EditOutlined aria-hidden="true" />
            {edit?.mode === "draw" ? "正在标注通行段" : span ? "重画通行段" : "在平面图上标注通行段"}
          </button>}
          {span && !edit && <button type="button"
            onClick={() => image.startL1DoorSpan(region, "adjust", span, pixels)}>
            <DragOutlined aria-hidden="true" />调整端点
          </button>}
          {edit && <button type="button" onClick={() => image.cancelL1DoorSpan(region.id)}>
            <CloseOutlined aria-hidden="true" />取消绘制
          </button>}
          {span && <button type="button"
            onClick={() => image.startL1DoorSpan(region, "clear")}>移除通行段</button>}
        </div>
        {edit && <span className={styles.doorStatus} role="status">{edit.notice || (edit.mode === "draw" ?
          (edit.start == null ? "1/2 · 在平面图上点击第一个端点" : "2/2 · 点击第二个端点") :
          edit.mode === "adjust" ? "可拖动平面图上的两个端点" : "应用后移除通行段")}</span>}
        <label>每组扇数（逗号分隔）<input type="text" placeholder="2, 2" value={groups}
          onChange={(e) => setGroups(e.target.value)} /></label>
        {span && !error && <output>有效通行净宽：{((span[1] - span[0]) * frame.spanPx).toFixed(1)} 原图像素</output>}
        {counts && counts.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 100) &&
          <output>{counts.length} 组 / 共 {counts.reduce((sum, n) => sum + n, 0)} 扇</output>}
      </>}
      <div className={styles.doorActions}>
        <button type="button" className={styles.doorApply}
          disabled={edit?.mode === "draw" || (!clearingAll && (!!error || unchanged))}
          onClick={() => apply(clearingAll ? null : operation)}>
          <CheckOutlined aria-hidden="true" />应用开启信息
        </button>
        {saved && !edit && <button type="button" onClick={() => apply(null)}>清除开启信息</button>}
      </div>
      {(notice || (error && (span || counts))) && <p role="alert">{notice || error}</p>}
    </fieldset>
  );
});

export const L1DoorOperation = observer(({ region, result, kind }) => {
  const image = region.parent;
  const id = region.id;
  useEffect(() => () => {
    if (isAlive(image)) image.cancelL1DoorSpan(id);
  }, [image, id]);
  const frame = image.l1DoorFrame(region);
  if (!frame) return null;
  const saved = result.meta?.door_operation;
  return <DoorFields key={JSON.stringify(saved ?? null)} {...{ region, kind, saved, frame }}
    disabled={region.isReadOnly() || !!image.l1SwitchBlockReason || image.annotation.selectedRegions.length !== 1} />;
});
