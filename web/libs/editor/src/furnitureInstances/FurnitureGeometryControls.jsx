import { useEffect, useRef, useState } from "react";
import { observer } from "mobx-react";
import { CONTROLS, FURNITURE_TYPES } from "./domain";
import { groupCreationState, createGroupInstance } from "./creation";
import { parentEdgeAngles, rectanglePixelCenter } from "./rectanglePreview";
import { applyFurnitureInstanceOperation } from "./operations";
import { useFurnitureReviewSession } from "./reviewSession";
import styles from "./FurnitureInstanceControls.module.scss";

export const FurnitureGeometryControls = observer(({ item }) => {
  const review = useFurnitureReviewSession(item);
  const [type, setType] = useState("");
  const [step, setStep] = useState(0.1);
  const currentType = useRef(type);
  currentType.current = type;
  useEffect(() => setType(""), [item.annotation, item.furnitureInstanceFocusId]);
  useEffect(() => {
    const cancel = (e) => {
      if (e.key === "Escape" && item.furnitureInstanceGeometryPreview && !review.busy) {
        e.preventDefault();
        item.cancelFurnitureRectanglePreview();
      }
    };
    document.addEventListener("keydown", cancel, true);
    return () => document.removeEventListener("keydown", cancel, true);
  }, [item, review]);
  const parents = item.furnitureInstanceParents,
    focus = parents.find((p) => p.id === item.furnitureInstanceFocusId);
  const selected = item.furnitureInstanceLogicals.find((i) => i.id === item.furnitureInstanceEffectiveSelectedId);
  const part =
    selected?.parts.find((p) => p.id === item.furnitureInstanceActivePartId) ||
    (selected?.parts.length === 1 ? selected.parts[0] : null);
  const parent = parents.find((p) => p.id === selected?.context.group_id);
  const rectangle = part?.from_name === CONTROLS.rectangle ? part : null;
  const preview = item.furnitureInstanceGeometryPreview;
  const drawing = item
    .getToolsManager()
    ?.allTools()
    .find((tool) => tool.currentArea?.isDrawing && tool.control?.name === CONTROLS.rectangle)?.currentArea;
  const center = rectangle ? rectanglePixelCenter(rectangle) : { x: 0, y: 0 };
  const angle = preview?.angle ?? rectangle?.value.rotation ?? 0;
  const modify = (options) => {
    try {
      item.previewFurnitureRectangle({ ...options, fit: false });
      review.setError("");
    } catch (error) {
      review.setError(error.message);
    }
  };
  let duplicate = null,
    creationError = "";
  if (focus && type)
    try {
      duplicate = groupCreationState(item.furnitureInstanceData, focus.id, type).duplicate;
    } catch (error) {
      creationError = error.message;
    }
  const blocked = review.navigationBlock || (item.annotation.isReadOnly() ? "当前标注为只读" : "");
  const ownCount = item.furnitureInstanceLogicals.filter((i) => i.context.group_id === focus?.id).length;
  const edges =
    rectangle && parent ? parentEdgeAngles(parent, rectangle.original_width, rectangle.original_height) : [];
  const create = async () => {
    let id;
    const ok = await review.run(async () => {
      id = await createGroupInstance(item, type, () => currentType.current === type);
      return "已创建一个家具实例并保存草稿，请检查后复核。";
    });
    if (ok && id) item.selectFurnitureInstance(id);
  };
  return (
    <section className={styles.geometryControls} aria-label="轮廓创建与角度辅助">
      <strong>使用组团轮廓</strong>
      <div className={styles.row}>
        <label>
          新实例类别
          <select
            aria-label="轮廓创建类别"
            value={type}
            disabled={!!blocked || !focus}
            onChange={(e) => setType(e.target.value)}
          >
            <option value="">人工选择类别</option>
            {item.furnitureInstanceAvailableTypes.map((t) => (
              <option key={t} value={t}>
                {FURNITURE_TYPES[t]}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          disabled={!!blocked || !!review.referenceBlock || !focus || !type || !!duplicate || !!creationError}
          onClick={create}
        >
          使用本组轮廓创建实例
        </button>
        <button
          type="button"
          disabled={!!blocked || !focus}
          onClick={() => {
            try {
              const tool = item
                .getToolsManager()
                .allTools()
                .find(
                  (t) => t.control?.name === CONTROLS.rectangle && t.toolName === "Rectangle3PointTool" && !t.dynamic,
                );
              if (!tool) throw new Error("三点矩形工具尚未就绪");
              item.startFurnitureInstanceTool(CONTROLS.rectangle, tool);
            } catch (error) {
              review.setError(error.message);
            }
          }}
        >
          三点矩形：两点定边，第三点定宽
        </button>
      </div>
      {focus && <small>本组已有 {ownCount} 个实例，本操作将新增一个；父组团与已有实例保持不变。</small>}
      {duplicate && (
        <p>
          已有同类别、同轮廓实例。
          <button type="button" disabled={!!blocked} onClick={() => review.locate(duplicate.id)}>
            定位已有实例
          </button>
        </p>
      )}
      {creationError && <p role="alert">{creationError}</p>}
      {drawing && (
        <output aria-live="polite">
          绘制角度 {(drawing.rotation || 0).toFixed(2)}° · 宽 {((drawing.width * item.naturalWidth) / 100).toFixed(1)}{" "}
          px × 高 {((drawing.height * item.naturalHeight) / 100).toFixed(1)} px
        </output>
      )}
      {rectangle && parent && (
        <>
          <strong>矩形角度与恢复预览</strong>
          <div className={styles.row}>
            <label>
              角度（°）
              <input
                aria-label="矩形目标角度"
                type="number"
                step={step}
                value={angle}
                disabled={!!blocked}
                onChange={(e) => modify({ angle: e.target.valueAsNumber })}
              />
            </label>
            <label>
              微调步长
              <select aria-label="角度微调步长" value={step} onChange={(e) => setStep(Number(e.target.value))}>
                <option value={0.1}>0.1°</option>
                <option value={1}>1°</option>
              </select>
            </label>
            <button type="button" disabled={!!blocked} onClick={() => modify({ angle: angle - step })}>
              −{step}°
            </button>
            <button type="button" disabled={!!blocked} onClick={() => modify({ angle: angle + step })}>
              +{step}°
            </button>
            <label>
              与父组团边平行
              <select
                aria-label="选择父组团对齐边"
                defaultValue=""
                disabled={!!blocked}
                onChange={(e) => {
                  const edge = edges.find((x) => x.key === e.target.value);
                  if (edge) modify({ angle: edge.angle });
                }}
              >
                <option value="">选择具体边</option>
                {edges.map((e) => (
                  <option key={e.key} value={e.key}>
                    {e.label} · {e.angle.toFixed(2)}°
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={styles.row}>
            <label>
              中心 X（原图像素）
              <input
                type="number"
                aria-label="预览中心 X"
                step="0.1"
                disabled={!!blocked}
                value={preview?.centerX ?? center.x}
                onChange={(e) => modify({ centerX: e.target.valueAsNumber })}
              />
            </label>
            <label>
              中心 Y（原图像素）
              <input
                type="number"
                aria-label="预览中心 Y"
                step="0.1"
                disabled={!!blocked}
                value={preview?.centerY ?? center.y}
                onChange={(e) => modify({ centerY: e.target.valueAsNumber })}
              />
            </label>
            <label>
              尺寸比例（%）
              <input
                type="number"
                aria-label="预览尺寸比例"
                min="0.01"
                step="1"
                disabled={!!blocked}
                value={(preview?.scale ?? 1) * 100}
                onChange={(e) => modify({ scale: e.target.valueAsNumber / 100 })}
              />
            </label>
            <button
              type="button"
              disabled={!!blocked}
              onClick={() => {
                try {
                  item.previewFurnitureRectangle({ angle, fit: true });
                } catch (error) {
                  review.setError(error.message);
                }
              }}
            >
              按目标角度适配
            </button>
          </div>
          <small>预览可拖动中心；仅应用合法轮廓。方向证据保留，修改后需重新检查。Esc 取消。</small>
          {preview && (
            <>
              <p role="status">
                {preview.valid ? `预览有效 · 尺寸 ${(preview.scale * 100).toFixed(2)}%` : preview.issue}
              </p>
              <div className={styles.row}>
                <button
                  type="button"
                  disabled={!!blocked || !!review.referenceBlock || !preview.valid}
                  onClick={() =>
                    review.run(() =>
                      applyFurnitureInstanceOperation(item, () => {
                        item.applyFurnitureRectanglePreview();
                        return "几何已应用并保存，请重新复核。";
                      }),
                    )
                  }
                >
                  应用几何预览
                </button>
                <button type="button" disabled={review.busy} onClick={() => item.cancelFurnitureRectanglePreview()}>
                  取消预览
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
});
