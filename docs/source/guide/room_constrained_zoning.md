# Room-constrained partition annotation

This extension adds opt-in room constraints and opening snapping to image Rectangle and Polygon controls. Projects that omit the new attributes keep the standard Label Studio behavior.

## Configuration

Add the following attributes to each partition `Rectangle`, `RectangleLabels`, `Polygon`, or `PolygonLabels` control:

```xml
constrainTo="label,polygon_label"
openingFrom="opening_label"
constraintSnapPx="10"
openingSnapAngleDeg="5"
```

- `constrainTo` lists the room controls that provide focus candidates and boundaries.
- `openingFrom` identifies the read-only opening control used for snapping.
- `constraintSnapPx` is a screen-pixel threshold and is therefore stable while zooming.
- `openingSnapAngleDeg` is the maximum undirected angle difference for line snapping.

See `examples/room-constrained-zoning/config.xml` for a complete example.

## Build the reference predictions

The converter accepts one Label Studio room annotation task and the matching GraphML. Room node IDs and opening edge IDs must exactly match the Label Studio result IDs.

```powershell
python scripts/room_layout_predictions.py `
  --input-json C:\path\to\room-annotation.json `
  --input-graphml C:\path\to\room-graph.graphml `
  --output-json C:\path\to\partition-predictions.json
```

The command fails without writing partial output when the two files disagree. Its output:

- keeps the `label`, `polygon_label`, and `opening_label` results and their IDs;
- marks every reference result `readonly: true`;
- uses prediction model version `room-layout-reference-v1`;
- stores GraphML node attributes under `meta.room_graph_node`;
- stores the unordered room endpoints and edge attributes under `meta.room_graph_edge`.

Import the generated JSON into a partition project that uses the matching configuration. The editor displays a `Focus room` selector. A constrained tool cannot start until a room is selected.

## Partition result contract

The focused room is captured when a partition is created. Moving, resizing, rotating, or editing vertices does not reassign the partition to a later focus selection.

```json
{
  "meta": {
    "partition_context": {
      "schema_version": 1,
      "parent_room_id": "room-result-id",
      "opening_ids": ["collinear-opening-result-id"],
      "connected_room_ids": ["room-at-the-other-end"]
    }
  }
}
```

Opening relationships are recomputed after every accepted geometry change. An opening is recorded only when a partition edge is collinear with it and has positive-length overlap.

## Compatibility and current limits

- Room boundaries can be a rotated Rectangle or a closed simple Polygon, including a simple concave Polygon.
- Self-intersections, holes, multiple rings, atriums, and column holes are not supported.
- Openings remain editable only in the source room project.
- Connectivity levels are deliberately not stored by Label Studio. A later JSON-to-GraphML v2 converter can run BFS in each room's partition adjacency graph, starting from partitions with non-empty `opening_ids`.
- GraphML v2 should add full room and partition geometry, `parent_room_id`, partition adjacency edges, opening relationships, and the computed connectivity level. Existing room-only GraphML remains the compatibility baseline.
