// Called immediately after the official result/area metadata merge.
// Preserve the owner of each context and server provenance without changing
// upstream serialization, geometry, result fields or the final empty-meta check.
export function applyResultMetadataOwnership(data, { meta, type, fromName, image, areaMeta }) {
  if (type === "labels" && fromName === "function_zone" && image.wholeRoomInheritanceEnabled) {
    // Do not add geometry-owned metadata to existing paired category
    // results merely by opening/saving a whole-room enabled project.
    const shared = { ...areaMeta };
    for (const key of [
      "partition_context",
      "zone_inheritance",
      "room_graph_node",
      "room_graph_edge",
      "geometry_review",
      "reference_review",
    ])
      delete shared[key];
    data.meta = { ...meta, ...shared };
  }
  // Inheritance belongs to the geometry result, not the shared area's
  // initial metadata snapshot or its paired Labels result. Otherwise a
  // later confirmation is overwritten by the imported pending state.
  if (meta?.zone_inheritance && (type === "rectangle" || type === "polygon")) {
    data.meta.zone_inheritance = meta.zone_inheritance;
    if (meta.partition_context) data.meta.partition_context = meta.partition_context;
  } else if (data.meta.zone_inheritance) {
    delete data.meta.zone_inheritance;
  }
  // L3 ownership/review metadata belongs only to the physical geometry.
  // Area-level imported metadata is an initial snapshot and must not
  // overwrite a later review invalidation or confirmation.
  if (meta?.occupancy_context && (type === "rectangle" || type === "polygon")) {
    data.meta.occupancy_context = meta.occupancy_context;
  } else if (data.meta.occupancy_context) {
    delete data.meta.occupancy_context;
  }
    // Downstream window relations are server-owned geometry metadata. An
  // area's shared snapshot must never copy them onto paired Labels.
  for (const key of ["window_projections", "window_projection_state"]) {
    if (meta?.[key] && (type === "rectangle" || type === "polygon")) data.meta[key] = meta[key];
    else if (data.meta[key]) delete data.meta[key];
  }
  // Window ownership and pairing evidence belong to the VectorLabels
  // result. An area's imported metadata is only an initial snapshot and
  // must not overwrite a refreshed/stale context after vertex editing.
  if (image.windowEnabled && meta?.window_context && type === "vectorlabels") {
    data.meta.window_context = meta.window_context;
  } else if (image.windowEnabled && data.meta.window_context) {
    delete data.meta.window_context;
    }
    // L4 identity belongs to every explicit instance result (geometry,
  // category, or orientation evidence). Never let another result's
  // area-level metadata overwrite its role/provenance during a refresh.
  if (
    meta?.furniture_instance_context &&
    ["rectangle", "polygon", "choices", "vectorlabels"].includes(type)
  ) {
    data.meta.furniture_instance_context = meta.furniture_instance_context;
    if (meta.furniture_instance_provenance)
      data.meta.furniture_instance_provenance = meta.furniture_instance_provenance;
    else delete data.meta.furniture_instance_provenance;
  } else {
    delete data.meta.furniture_instance_context;
    delete data.meta.furniture_instance_provenance;
    }
}
