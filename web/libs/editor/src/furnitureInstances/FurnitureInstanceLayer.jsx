import { useState } from "react";
import { Group, Layer, Path, Text, Rect, Line } from "react-konva";
import Konva from "konva";
import { observer } from "mobx-react";

import { GROUP_TYPES } from "../occupancy/domain";
import { resultGeometry, union } from "../occupancy/geometry";
import { pathData } from "../occupancy/OccupancyLayer";
import { withAlpha } from "../utils/roomConstraintGeometry";
import { FF_ZOOM_OPTIM, isFF } from "../utils/feature-flags";
import { furnitureTypeColor } from "./presentation";
import { furnitureInstanceInteractionLayerListening } from "./referenceDisplay";
import {
  furnitureInstanceNames,
  furnitureNativePartIds,
  furnitureShapeStyles,
  layoutFurnitureLabels,
} from "./appearance";

const PARENT_COLOR = "#d97706";
const parentLabel = (parent) => {
  const type = GROUP_TYPES[parent.groupType] || parent.groupType || "家具组团";
  return parent.groupNote ? `${type} · ${parent.groupNote}` : type;
};

export const instanceHitGeometry = (instance, activePartIds) => {
  const ids = activePartIds instanceof Set ? activePartIds : new Set([activePartIds]);
  if (!instance.parts.some((part) => ids.has(part.id))) return instance.geometry;
  try {
    const remaining = instance.parts.filter((part) => !ids.has(part.id)).map(resultGeometry);
    return remaining.length ? union(...remaining) : [];
  } catch {
    return [];
  }
};

export const FurnitureInstanceLayer = observer(({ item }) => {
  const [hoveredParent, setHoveredParent] = useState("");
  if (!item.furnitureInstancesEnabled) return null;
  const listening = furnitureInstanceInteractionLayerListening(item);
  const activePartIds = furnitureNativePartIds(item);
  const selectParent = (event, id) => {
    event.cancelBubble = true;
    item.setFurnitureInstanceFocus(id);
  };
  const selectInstance = (event, id) => {
    event.cancelBubble = true;
    item.selectFurnitureInstance(id);
  };

  return (
    <Layer name="furniture-instance-logical-regions" listening={listening}>
      {item.furnitureInstanceParents.map((parent) => {
        const focused = parent.id === item.furnitureInstanceFocusId;
        const hovered = parent.id === hoveredParent;
        return (
          <Group
            key={parent.id}
            name={`furniture-parent:${parent.id}`}
            onClick={(event) => selectParent(event, parent.id)}
            onTap={(event) => selectParent(event, parent.id)}
            onMouseEnter={() => setHoveredParent(parent.id)}
            onMouseLeave={() => setHoveredParent("")}
          >
            <Path
              data={pathData(parent.geometry, item.stageWidth / 100, item.stageHeight / 100)}
              fill={withAlpha(PARENT_COLOR, focused ? 0.04 : 0)}
              stroke={withAlpha(PARENT_COLOR, focused || hovered ? 0.9 : 0.25)}
              strokeWidth={focused || hovered ? 2 : 1}
              strokeScaleEnabled={false}
              fillRule="evenodd"
            />
          </Group>
        );
      })}
      {item.furnitureInstanceLogicals
        .map((instance) => ({ instance, geometry: instanceHitGeometry(instance, activePartIds) }))
        .filter(({ geometry }) => geometry?.length)
        .map(({ instance, geometry }) => {
          const selected = instance.id === item.furnitureInstanceEffectiveSelectedId;
          const hovered = instance.id === item.furnitureInstanceHoveredId;
          const style = furnitureShapeStyles(
            instance.instanceType || instance.context.instance_type,
            selected ? "selected" : hovered ? "hover" : "normal",
          );
          const data = pathData(geometry, item.stageWidth / 100, item.stageHeight / 100);
          return (
            <Group
              key={instance.id}
              name={`furniture-instance:${instance.id}`}
              onClick={(event) => selectInstance(event, instance.id)}
              onTap={(event) => selectInstance(event, instance.id)}
              onMouseEnter={() => item.setFurnitureInstanceHoveredId(instance.id)}
              onMouseLeave={() => item.setFurnitureInstanceHoveredId("")}
            >
              {style.haloColor && (
                <Path
                  data={data}
                  stroke={style.haloColor}
                  strokeWidth={style.strokeWidth + 2}
                  strokeScaleEnabled={false}
                  listening={false}
                />
              )}
              <Path
                data={data}
                fill={style.fillColor}
                stroke={style.strokeColor}
                strokeWidth={style.strokeWidth}
                strokeScaleEnabled={false}
                fillRule="evenodd"
              />
            </Group>
          );
        })}
    </Layer>
  );
});

export function furnitureScreenTransform(item) {
  const optimized = isFF(FF_ZOOM_OPTIM);
  const zoom = item.zoomScale || 1;
  const matrix = new Konva.Transform();
  matrix.translate(
    (item.zoomingPositionX || 0) + (optimized ? item.alignmentOffset?.x || 0 : 0),
    (item.zoomingPositionY || 0) + (optimized ? item.alignmentOffset?.y || 0 : 0),
  );
  matrix.rotate(((item.rotation || 0) * Math.PI) / 180);
  matrix.scale(zoom, zoom);
  matrix.translate(-(item.stageTranslate?.x || 0), -(item.stageTranslate?.y || 0));
  return matrix;
}

export const FurnitureInstanceLabels = observer(({ item }) => {
  if (!item.furnitureInstancesEnabled) return null;
  const transform = furnitureScreenTransform(item);
  const inverse = transform.copy().invert().decompose();
  const optimized = isFF(FF_ZOOM_OPTIM);
  const viewport = {
    width: (optimized ? item.containerWidth : item.canvasSize?.width) || item.stageWidth,
    height: (optimized ? item.containerHeight : item.canvasSize?.height) || item.stageHeight,
  };
  const bounds = (geometry) => {
    const points = geometry
      .flat(2)
      .map(([x, y]) => transform.point({ x: (x * item.stageWidth) / 100, y: (y * item.stageHeight) / 100 }));
    if (!points.length) return null;
    const x = Math.min(...points.map((p) => p.x));
    const y = Math.min(...points.map((p) => p.y));
    return { x, y, width: Math.max(...points.map((p) => p.x)) - x, height: Math.max(...points.map((p) => p.y)) - y };
  };
  const names = furnitureInstanceNames(item.furnitureInstanceLogicals);
  const candidates = item.furnitureInstanceLogicals.flatMap((instance) => {
    const selected = instance.id === item.furnitureInstanceEffectiveSelectedId;
    const hovered = instance.id === item.furnitureInstanceHoveredId;
    if (
      !selected &&
      !hovered &&
      !item.furnitureInstanceShowAllNames &&
      instance.context.group_id !== item.furnitureInstanceFocusId
    )
      return [];
    const box = bounds(instance.geometry);
    return box
      ? [
          {
            id: instance.id,
            text: names.get(instance.id),
            bounds: box,
            color: furnitureTypeColor(instance.instanceType || instance.context.instance_type),
            priority: selected ? 3 : hovered ? 2 : 1,
          },
        ]
      : [];
  });
  for (const parent of item.furnitureInstanceParents) {
    if (parent.id !== item.furnitureInstanceFocusId) continue;
    const box = bounds(parent.geometry);
    if (box)
      candidates.push({
        id: parent.id,
        text: `Focus · ${parentLabel(parent)}`,
        bounds: box,
        color: PARENT_COLOR,
        priority: 0,
        parent: true,
      });
  }
  const labels = layoutFurnitureLabels(candidates, viewport);
  return (
    <Layer name="furniture-instance-names" {...inverse} listening={false}>
      {labels.map((label) => (
        <Group key={label.id} name={`furniture-label:${label.id}`} listening={false}>
          <Line
            points={[label.bounds.x, label.bounds.y, label.x + label.width / 2, label.y + label.height / 2]}
            stroke="#475569"
            strokeWidth={1}
            listening={false}
          />
          <Rect
            x={label.x}
            y={label.y}
            width={label.width}
            height={label.height}
            fill="#f8fafc"
            stroke={label.priority >= 2 ? "#334155" : "#cbd5e1"}
            strokeWidth={1}
            cornerRadius={3}
            listening={false}
          />
          <Rect x={label.x} y={label.y + 2} width={3} height={label.height - 4} fill={label.color} listening={false} />
          <Text
            x={label.x + 8}
            y={label.y + 5}
            width={label.width - 12}
            height={18}
            wrap="none"
            ellipsis
            text={label.text}
            fill="#111827"
            fontSize={13}
            fontStyle={label.priority >= 2 ? "bold" : "normal"}
            listening={false}
          />
        </Group>
      ))}
    </Layer>
  );
});
