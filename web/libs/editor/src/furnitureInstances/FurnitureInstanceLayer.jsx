import { useState } from "react";
import { Group, Layer, Path, Text, Rect, Line, Circle } from "react-konva";
import Konva from "konva";
import { observer } from "mobx-react";

import { GROUP_TYPES } from "../occupancy/domain";
import { resultGeometry, union } from "../occupancy/geometry";
import { pathData } from "../occupancy/OccupancyLayer";
import { withAlpha } from "../utils/roomConstraintGeometry";
import { FF_ZOOM_OPTIM, isFF } from "../utils/feature-flags";
import { furnitureTypeColor } from "./presentation";
import { furnitureInstanceInteractionLayerListening } from "./referenceDisplay";
import { instanceInScope } from "./scope";
import {
  furnitureInstanceNames,
  furnitureLabelLeader,
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
  const preview = item.furnitureInstanceGeometryPreview || item.furnitureInstanceTransformCandidate;
  const selectParent = (event, id) => {
    event.cancelBubble = true;
    if (item.furnitureInstanceGeometryPreview) return;
    item.setFurnitureInstanceFocus(id);
  };
  const selectInstance = (event, id) => {
    event.cancelBubble = true;
    item.selectFurnitureInstance(id);
  };
  const scope = item.furnitureInstanceScope;
  const spaces = scope
    ? !item.furnitureInstanceRoomId
      ? scope.rooms
      : !item.furnitureInstanceZoneId
        ? scope.zones.filter((z) => z.roomId === item.furnitureInstanceRoomId)
        : []
    : [];

  return (
    <Layer name="furniture-instance-logical-regions" listening={listening}>
      {scope?.rooms.map((room) => (
        <Path
          key={`room-outline:${room.id}`}
          data={pathData(room.geometry, item.stageWidth / 100, item.stageHeight / 100)}
          stroke={withAlpha("#2563eb", room.id === item.furnitureInstanceRoomId ? 0.65 : 0.12)}
          strokeWidth={room.id === item.furnitureInstanceRoomId ? 2 : 1}
          strokeScaleEnabled={false}
          fillEnabled={false}
          listening={false}
        />
      ))}
      {scope?.zones
        .filter((z) => z.id === item.furnitureInstanceZoneId)
        .map((zone) => (
          <Path
            key={`zone-outline:${zone.id}`}
            data={pathData(zone.geometry, item.stageWidth / 100, item.stageHeight / 100)}
            stroke="#0891b2"
            strokeWidth={2}
            dash={[6, 3]}
            strokeScaleEnabled={false}
            fillEnabled={false}
            listening={false}
          />
        ))}
      {spaces.map((space) => (
        <Group
          key={`space:${space.id}`}
          name={`furniture-space:${space.id}`}
          onClick={(event) => {
            event.cancelBubble = true;
            item.setFurnitureInstanceSpace(space.roomId || space.id, space.roomId ? space.id : "");
          }}
          onTap={(event) => {
            event.cancelBubble = true;
            item.setFurnitureInstanceSpace(space.roomId || space.id, space.roomId ? space.id : "");
          }}
        >
          <Path
            data={pathData(space.geometry, item.stageWidth / 100, item.stageHeight / 100)}
            fill={withAlpha(space.roomId ? "#0891b2" : "#2563eb", 0.04)}
            stroke={space.roomId ? "#0891b2" : "#2563eb"}
            strokeWidth={1.5}
            strokeScaleEnabled={false}
            fillRule="evenodd"
          />
        </Group>
      ))}
      {item.furnitureInstanceWalkableReferences?.regions
        .filter((r) => !scope || item.furnitureInstanceOverview || r.zoneId === item.furnitureInstanceZoneId)
        .map((region) => (
          <Path
            key={`walkable:${region.id}`}
            name={`walkable-reference:${region.id}`}
            data={pathData(region.geometry, item.stageWidth / 100, item.stageHeight / 100)}
            stroke={withAlpha("#249376", 0.28)}
            strokeWidth={1}
            strokeScaleEnabled={false}
            fillEnabled={false}
            fillRule="evenodd"
            listening={false}
          />
        ))}
      {item.furnitureInstanceParents
        .filter(
          (parent) =>
            !scope ||
            (parent.roomId === item.furnitureInstanceRoomId && parent.zoneId === item.furnitureInstanceZoneId),
        )
        .map((parent) => {
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
                fill={withAlpha(PARENT_COLOR, focused ? 0.08 : hovered ? 0.1 : 0.06)}
                stroke={withAlpha(PARENT_COLOR, focused || hovered ? 1 : 0.7)}
                strokeWidth={focused ? 2.5 : hovered ? 2 : 1.5}
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
          const inScope = instanceInScope(item, instance);
          const style = furnitureShapeStyles(
            instance.instanceType || instance.context.instance_type,
            selected ? "selected" : hovered ? "hover" : "normal",
          );
          const data = pathData(geometry, item.stageWidth / 100, item.stageHeight / 100);
          return (
            <Group
              key={instance.id}
              name={`furniture-instance:${instance.id}`}
              listening={inScope && !item.furnitureInstanceGeometryPreview}
              opacity={inScope ? 1 : 0.18}
              onClick={(event) => inScope && selectInstance(event, instance.id)}
              onTap={(event) => inScope && selectInstance(event, instance.id)}
              onMouseEnter={() => inScope && item.setFurnitureInstanceHoveredId(instance.id)}
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
      {preview && (
        <Group name="furniture-geometry-preview">
          <Path
            data={pathData(preview.geometry, item.stageWidth / 100, item.stageHeight / 100)}
            stroke={preview.valid ? "#0891b2" : "#dc2626"}
            strokeWidth={2}
            dash={[6, 3]}
            strokeScaleEnabled={false}
            fillEnabled={false}
            listening={false}
          />
          {item.furnitureInstanceGeometryPreview && (
            <Circle
              name="furniture-preview-center"
              x={(preview.centerX * item.stageWidth) / item.naturalWidth}
              y={(preview.centerY * item.stageHeight) / item.naturalHeight}
              radius={5 / item.zoomScale}
              fill="#ffffff"
              stroke="#0891b2"
              strokeWidth={2}
              strokeScaleEnabled={false}
              draggable={!item.furnitureInstanceBusy}
              onDragMove={(event) => {
                try {
                  item.previewFurnitureRectangle({
                    centerX: (event.target.x() * item.naturalWidth) / item.stageWidth,
                    centerY: (event.target.y() * item.naturalHeight) / item.stageHeight,
                    fit: false,
                  });
                } catch {
                  item.cancelFurnitureRectanglePreview();
                }
              }}
            />
          )}
        </Group>
      )}
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
  const scope = item.furnitureInstanceScope;
  const spaces = scope
    ? !item.furnitureInstanceRoomId
      ? scope.rooms
      : !item.furnitureInstanceZoneId
        ? scope.zones.filter((z) => z.roomId === item.furnitureInstanceRoomId)
        : []
    : [];
  for (const space of spaces) {
    const box = bounds(space.geometry);
    if (box)
      candidates.push({
        id: `space:${space.id}`,
        text: space.label,
        bounds: box,
        color: space.roomId ? "#0891b2" : "#2563eb",
        priority: 2,
        parent: true,
      });
  }
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
          <Line points={furnitureLabelLeader(label)} stroke="#475569" strokeWidth={1} listening={false} />
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
