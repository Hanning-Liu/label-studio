import { types } from "mobx-state-tree";

export const roomAttributes = {
  roomv3validate: types.optional(types.boolean, false),
  roomv3controls: types.optional(types.string, "room_rectangle,room_polygon"),
  portalrectanglecontrols: types.optional(types.string, "portal_rectangle"),
  portalvectorcontrols: types.optional(types.string, "portal_vector"),
  roomv3referencecontrols: types.optional(types.string, "portal_v2_reference"),
  roomv3tolerance: types.optional(types.string, "0.02"),
  partitioncontextschema: types.optional(types.string, "1"),
  functionzonev3validate: types.optional(types.boolean, false),
  functionzonecontrols: types.optional(types.string, "zone_rectangle,zone_polygon"),
  connectionvectorcontrols: types.optional(types.string, "connection_vector,visual_connection_vector"),
  geometryreviewmap: types.optional(
    types.string,
    "connection_vector:connection_review,visual_connection_vector:visual_connection_review",
  ),
  functionzonecoveragetolerance: types.optional(types.string, "0.001"),
};
