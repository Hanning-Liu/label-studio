import { observer } from "mobx-react";
import { Layer, Path, Text, Group } from "react-konva";
import { TYPES, GROUP_TYPES } from "./domain";
import { resultGeometry, union } from "./geometry";
import { occupancyLogicalLayerListening } from "./editing";
export const COLORS = {
  furniture_group: "#b06e28",
  walkable: "#249376",
  restricted_free: "#5967b6",
  unclassified: "#c36d94",
};
export const pathData = (multi, scaleX = 1, scaleY = 1) =>
  multi
    .map((polygon) =>
      polygon
        .map((ring) => `${ring.map(([x, y], i) => `${i ? "L" : "M"}${x * scaleX},${y * scaleY}`).join(" ")} Z`)
        .join(" "),
    )
    .join(" ");
export const OccupancyLayer = observer(({ item }) => {
  if (!item.occupancyEnabled) return null;
  const listening = occupancyLogicalLayerListening(item);
  const drawingIds = new Set(item.regs.filter((region) => region.isDrawing).map((region) => region.cleanId));
  return (
    <Layer name="occupancy-logical-regions">
      {item.occupancyLogicals
        .filter((r) => !r.parts.some((part) => drawingIds.has(part.id)))
        .map((r) => {
          const geometry = union(
            ...r.parts.filter((part) => part.id !== item.occupancyActivePartId).map(resultGeometry),
          );
          if (!geometry.length) return null;
          const color = COLORS[r.type];
          const selected = item.occupancySelectedId === r.id;
          const [x, y] = geometry[0]?.[0]?.[0] || [0, 0];
          return (
            <Group
              key={r.id}
              listening={listening}
              onClick={(event) => {
                event.cancelBubble = true;
                item.selectOccupancyLogical(r.id);
              }}
            >
              <Path
                data={pathData(geometry, item.stageWidth / 100, item.stageHeight / 100)}
                fill={color}
                opacity={selected ? 0.38 : 0.2}
                stroke={color}
                strokeWidth={selected ? 3 : 1.5}
                strokeScaleEnabled={false}
                fillRule="evenodd"
              />
              <Text
                x={(x * item.stageWidth) / 100}
                y={(y * item.stageHeight) / 100}
                text={r.type === "furniture_group" ? GROUP_TYPES[r.context.group_type] : TYPES[r.type]}
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
