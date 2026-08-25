# Room v3 pilot

This directory contains the Label Studio configurations used by the Room v3 pilot.

- `room-v3.xml` annotates editable room net-space geometries and v3 portals. Migrated v2 Door and Sliding door vectors are provided separately as read-only reference predictions.
- `function-zone-v3.xml` consumes approved Room v3 rooms and portals as read-only predictions, while functional zones and connectivity vectors remain editable.

Room v3 submission validation computes `room_graph_node` and `room_graph_edge` schema-v3 metadata. It rejects positive-area room overlap, invalid portal contacts, rectangle portals that enter a room interior, and zero-thickness open-passage vectors that are not fully supported by the shared boundary of exactly two rooms.

FunctionZone v3 tasks must not be created until the corresponding Room v3 annotation has passed review. Both migrated connectivity controls require an explicit per-region `Reviewed` choice before submission.

Pilot tooling lives in `scripts/`:

- `room_v3_migration.py` converts a Room v2 task into one editable Room v3 annotation plus a read-only Door/Sliding-door reference prediction.
- `function_zone_v3_migration.py` creates a FunctionZone v3 seed only from an explicitly approved Room v3 annotation.
- `room_v3_to_graphml.py` emits Room/Exterior nodes and rectangle/vector Portal edges while keeping the v2 conversion path available.
- `room_v3_sqlite_audit.py` compares read-only before/after SQLite snapshots and verifies Legacy project configuration, counts, and normalized annotation hashes.

For the browser viewer, export the project in Label Studio's raw JSON format and generate a self-describing Room v3 GraphML:

```powershell
python scripts\room_v3_to_graphml.py `
  --input-json task-19-label-studio.json `
  --annotation-id 10 `
  --room-label-config examples\room-v3\room-v3.xml `
  --output-graphml room-v3.graphml `
  --output-json room-v3-graph.json
```

When `--room-label-config` is supplied, room and Portal colors are read from the current Label Studio XML and missing or conflicting colors stop the conversion. The GraphML includes graph-level provenance, room centroids in percent/pixels, Portal metrics, and a synthetic positioned `Exterior` node when required.
