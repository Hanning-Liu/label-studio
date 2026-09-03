# Room window annotation v1

`room-window-v1.xml` is an independent, backward-compatible extension of the
existing Room v3 annotation configuration. It keeps the visible
`room_rectangle`, `room_polygon`, `portal_rectangle`, `portal_vector`, and
`portal_v2_reference` controls with their existing names, labels, and JSON
semantics, then adds the editable `window_vector` control. The existing
`examples/room-v3/room-v3.xml` file is intentionally unchanged.

Rooms, portals, and windows are authored in the same L1 annotation. The window
control is always open (`closable="false"`), accepts two or more vertices, and
enables Bezier editing. A line, polyline, or Bezier path is saved losslessly;
flattening is calculation-only and must not replace the original vertices or
control points.

Annotators draw on a room inner outline without choosing a room. The windows
domain derives `parent_room_id` from positive-length boundary overlap. Missing
or ambiguous ownership remains a draft error and blocks formal submission.
Internal pairing and automatic exterior classification run only after the
complete configured candidate search.

`fixtures/window-cases.json` contains deterministic percentage-coordinate
cases for parent assignment, internal pairing, and exterior classification.
The fixture is synthetic and contains no production annotation data.

Reference synchronization is used after L1 annotation to copy `window_vector`
results to downstream L2/L3 projects as optional read-only references. The
`readonly: true` flag is set on copied results by synchronization or migration;
visibility of a control in XML does not make a result read-only. Legacy source
templates without `window_vector` retain the original required Room/Portal and
L2/L3 reference sets.

The offline FunctionZone v3 migration accepts windows only when run in the full
Label Studio environment and revalidates their complete server-derived context;
it rejects stale or incomplete references instead of copying them.

The bundled `examples/room-v3/function-zone-v3.xml` L2 configuration and
`examples/occupancy-v1/furniture-group-v1.xml` L3 configuration include the
same control inside their hidden reference containers. Deploy the compatible
target configuration before annotators add L1 windows; synchronization rejects
an unsupported target control instead of dropping window geometry. Generated
L3 configurations also inherit this optional control through
`tasks.occupancy.template.build_template`.

Formal L2 and L3 saves persist read-only projections in target-result metadata
and recompute them from authoritative Room/Window references. Drafts retain the
last projection set but explicitly mark it stale when source geometry,
connection, policy, or target geometry changes. This repository has no L4
annotation persistence service; L4 callers use the pure
`tasks.windows.projections.derive_window_projections` interface and the v4
aggregate adapter.
