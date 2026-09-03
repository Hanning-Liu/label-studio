import {
  baseContext as occupancyBaseContext,
  parents,
  resultsForGeometry as occupancyResultsForGeometry,
} from "../../occupancy/domain";
import { resultGeometry } from "../../occupancy/geometry";
import {
  ALL_CONTROLS,
  baseContext,
  CONTROLS,
  controlName,
  furnitureGroups,
  resultForOrientation,
  resultsForGeometry,
} from "../domain";

let sequence = 0;
export const id = () => `test-${++sequence}`;

export const resetIds = () => {
  sequence = 0;
};

export const SOURCE = { to_name: "image", original_width: 1000, original_height: 500, image_rotation: 0 };

export const square = (left, top, right, bottom) => [
  [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
    [left, top],
  ],
];

export function makeOccupancy(
  groupDefinitions = [{ id: "group-g", type: "study_work", note: "", geometry: [square(10, 10, 90, 90)] }],
) {
  const room = {
    id: "room-r",
    from_name: "room_polygon",
    to_name: "image",
    type: "polygonlabels",
    original_width: SOURCE.original_width,
    original_height: SOURCE.original_height,
    value: { points: square(0, 0, 100, 100)[0].slice(0, -1), polygonlabels: ["Study"] },
    meta: { room_graph_node: { room_type: "Study" } },
  };
  const zone = {
    id: "zone-z",
    from_name: "zone_polygon",
    to_name: "image",
    type: "polygon",
    original_width: SOURCE.original_width,
    original_height: SOURCE.original_height,
    value: { points: square(0, 0, 100, 100)[0].slice(0, -1) },
    meta: { partition_context: { parent_room_id: room.id } },
  };
  const results = [
    room,
    zone,
    {
      id: zone.id,
      from_name: "function_zone",
      to_name: "image",
      type: "labels",
      value: { labels: ["Study/work"] },
    },
  ];
  const parent = parents(results)[0];
  for (const definition of groupDefinitions) {
    const occupancyContext = {
      ...occupancyBaseContext(parent, "l2-snapshot", "manual", `logical-${definition.id}`),
      group_id: definition.id,
      group_type: definition.type,
      group_note: definition.note || "",
    };
    results.push(
      ...occupancyResultsForGeometry(definition.geometry, "furniture_group", occupancyContext, parent.result, id),
    );
  }
  return results;
}

export function makeInstance(
  occupancyResults,
  {
    groupId = "group-g",
    instanceId = "instance-i",
    instanceType = "desk",
    note = "",
    geometry = [square(20, 20, 40, 40)],
    rectangle,
    orientation,
  } = {},
) {
  const group = furnitureGroups(occupancyResults).find((candidate) => candidate.id === groupId);
  const furnitureContext = baseContext(group, "l3-snapshot", instanceType, note, instanceId);
  const drawn = rectangle
    ? {
        ...SOURCE,
        id: "drawn-rectangle",
        from_name: CONTROLS.rectangle,
        type: "rectangle",
        value: rectangle,
      }
    : null;
  const actualGeometry = drawn ? resultGeometry(drawn) : geometry;
  const results = resultsForGeometry(
    actualGeometry,
    instanceType,
    furnitureContext,
    drawn || SOURCE,
    id,
    drawn ? [drawn] : [],
  );
  if (orientation)
    results.push(resultForOrientation(orientation.status, orientation.vertices, furnitureContext, SOURCE, id));
  return results;
}

export function stampProvenance(results, ids = { project: 14, task: 24, annotation: 104 }) {
  return results.map((result) =>
    ALL_CONTROLS.has(controlName(result))
      ? {
          ...result,
          meta: {
            ...result.meta,
            furniture_instance_provenance: {
              schema_version: 1,
              project_id: ids.project,
              task_id: ids.task,
              annotation_id: ids.annotation,
              result_id: result.id,
            },
          },
        }
      : result,
  );
}
