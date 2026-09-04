import { useState } from "react";
import { Group, Layer, Path, Text } from "react-konva";
import { observer } from "mobx-react";

import { GROUP_TYPES } from "../occupancy/domain";
import { resultGeometry, union } from "../occupancy/geometry";
import { FURNITURE_TYPES } from "./domain";
import { pathData } from "../occupancy/OccupancyLayer";
import { furnitureTypeColor } from "./presentation";
import { furnitureInstanceInteractionLayerListening } from "./referenceDisplay";

const PARENT_COLOR = "#d97706";

const firstPoint = (geometry) => geometry?.[0]?.[0]?.[0] || [0, 0];
const parentLabel = (parent) => {
  const type = GROUP_TYPES[parent.groupType] || parent.groupType || "家具组团";
  return parent.groupNote ? `${type} · ${parent.groupNote}` : type;
};

const instanceHitGeometry = (instance, activePartId) => {
  if (!activePartId || !instance.parts.some((part) => part.id === activePartId)) return instance.geometry;
  try {
    const remaining = instance.parts.filter((part) => part.id !== activePartId).map(resultGeometry);
    return remaining.length ? union(...remaining) : [];
  } catch {
    return [];
  }
};

export const FurnitureInstanceLayer = observer(({ item }) => {
  const [hoveredParent, setHoveredParent] = useState("");
  const [hoveredInstance, setHoveredInstance] = useState("");
  if (!item.furnitureInstancesEnabled) return null;

  const listening = furnitureInstanceInteractionLayerListening(item);
  const activePartId = item.furnitureInstanceActivePartId;
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
        const [x, y] = firstPoint(parent.geometry);
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
              fill={PARENT_COLOR}
              opacity={focused ? 0.2 : hovered ? 0.13 : 0.07}
              stroke={PARENT_COLOR}
              strokeWidth={focused ? 3 : hovered ? 2.5 : 1.5}
              strokeScaleEnabled={false}
              fillRule="evenodd"
            />
            <Text
              x={(x * item.stageWidth) / 100}
              y={(y * item.stageHeight) / 100}
              text={parentLabel(parent)}
              fill={PARENT_COLOR}
              fontSize={12 / item.zoomScale}
              listening={false}
            />
          </Group>
        );
      })}
      {item.furnitureInstanceLogicals
        .map((instance) => ({ instance, geometry: instanceHitGeometry(instance, activePartId) }))
        .filter(({ geometry }) => geometry?.length)
        .map(({ instance, geometry }) => {
          const instanceType = instance.instanceType || instance.context.instance_type;
          const color = furnitureTypeColor(instanceType);
          const selected = instance.id === item.furnitureInstanceEffectiveSelectedId;
          const hovered = instance.id === hoveredInstance;
          const [x, y] = firstPoint(geometry);
          return (
            <Group
              key={instance.id}
              name={`furniture-instance:${instance.id}`}
              onClick={(event) => selectInstance(event, instance.id)}
              onTap={(event) => selectInstance(event, instance.id)}
              onMouseEnter={() => setHoveredInstance(instance.id)}
              onMouseLeave={() => setHoveredInstance("")}
            >
              <Path
                data={pathData(geometry, item.stageWidth / 100, item.stageHeight / 100)}
                fill={color}
                opacity={selected ? 0.42 : hovered ? 0.32 : 0.2}
                stroke={color}
                strokeWidth={selected ? 3 : hovered ? 2.5 : 1.5}
                strokeScaleEnabled={false}
                fillRule="evenodd"
              />
              <Text
                x={(x * item.stageWidth) / 100}
                y={(y * item.stageHeight) / 100}
                text={FURNITURE_TYPES[instanceType] || instanceType}
                fill={color}
                fontSize={12 / item.zoomScale}
                listening={false}
              />
            </Group>
          );
        })}
    </Layer>
  );
});
