# L1-L4 occupancy schema foundation

This directory defines the complete aggregated floorplan contract for the
existing L1-L3 pipeline plus room-outline windows and L4 furniture instances.

## Files

- `multilevel-occupancy.schema.json`: authoritative JSON Schema 2020-12
  contract.
- `example.json`: complete `floorplan-unified/4` example containing L1 rooms
  and a portal, L2 zones, L3 occupancy and walkability, paired and exterior
  windows, one L4 furniture instance, and L2-L4 window projections.

## Compatibility

The contract extends the existing unified format instead of replacing it:

- `floorplan-unified/1` and `/2` keep their existing required fields.
- `floorplan-unified/3` keeps the current L1-L3 fields and requires
  `occupancy_regions` plus `occupancy_relations`, exactly as the current viewer
  pipeline does.
- `floorplan-unified/4` adds the required window and L4 collections while
  preserving all existing node, connection, relation, occupancy, barrier,
  provenance and raw-result fields.
- Existing IDs, Label Studio control names, source annotation records and
  Polygon/MultiPolygon components and holes are not rewritten.

The schema has been checked against the current real
`floorplan-unified/3` aggregate, so compatibility is executable rather than
description-only.

## Level contracts

### L1: rooms and room connections

- Rooms remain `nodes` with `kind: "room"`.
- Door, sliding-door and open-passage results remain `connections` with
  `kind: "portal"`.
- Room geometry, Label Studio raw results, provenance and existing identity
  corrections retain their current representation.

### L2: function zones

- Function zones remain `nodes` with `kind: "zone"` and `parent_room_id`.
- Movement and visual vectors remain `connections`.
- Direct-boundary, visual-boundary and derived-junction evidence remains in
  `analysis_relations`.

### L3: occupancy

- Furniture groups, walkable regions and restricted-free regions remain in
  `occupancy_regions` and the corresponding unified `nodes`.
- Walkable-to-furniture, transition, spatial-measurement, true shared-boundary
  and manual-barrier relations remain in `occupancy_relations`.
- Existing `occupancy_barriers` are retained without changing their geometry
  or matched-pair semantics.
- Stable furniture-group values include the current categories from
  `sleeping` through `other`, including `leisure_recreation` and
  `plant_decor`.

### Room-outline windows

- A user draws one open `window_trace` on one room's inner outline without
  selecting the room first.
- The full trace must overlap exactly one room boundary over positive length.
  The system derives `parent_room_id`; zero or multiple room matches are
  semantic validation errors.
- A room-to-room window is formed from two traces on opposite sides of the wall
  using `mutual_outward_projection`: different parent rooms, compatible
  tangents, positive projected overlap, bounded separation and mutual-best
  matching.
- After the complete pairing pass, a valid room-boundary trace with no opposite
  candidate inside the configured search limit is automatically classified as
  a room-to-exterior window. No per-window user confirmation is required.
- Automatic exterior classification records the search limit, zero candidate
  count, trace fingerprint and algorithm version, and uses
  `review_status: "derived"` so it is distinguishable from human confirmation.
- Line, polyline and Bezier paths are supported. Bezier control points remain
  source data; flattening is only an auditable calculation step.

### L4: furniture instances

- Every instance has the complete `room_id` -> `zone_id` -> `group_id` parent
  chain.
- Geometry is Polygon or MultiPolygon in image-percent coordinates and retains
  rings and holes.
- Orientation is `unknown` unless an explicit front direction or front edge is
  annotated. Category, location or rectangle rotation must not be used to
  invent a front side.

### Window propagation

- L2 receives `bounds_zone` only from positive-length overlap between the
  window trace and a function-zone boundary.
- L3 and L4 receive `adjacent_to_window` only from positive-area intersection
  with the room-side inward projection of that trace.
- Each derived relation stores the source connection, source trace, path
  interval, evidence values, algorithm version and source/target fingerprints.

## Validation boundary

JSON Schema validates document shape, enums, required evidence and conditional
records. The aggregation/submission validator must additionally enforce facts
that require comparing multiple geometries or IDs:

1. Unique stable IDs and valid references across all collections.
2. Parent chains that agree with the referenced L1-L3 entities.
3. Exactly one full-path room-boundary match for every window trace.
4. Distinct rooms, mutual-best pairing and the configured geometric thresholds
   for room-to-room windows.
5. A completed pairing search with zero valid opposite candidates before
   automatic exterior classification.
6. Closed rings, valid polygons, preserved MultiPolygon parts and holes.
7. Ordered, non-overlapping path intervals and real overlap evidence for all
   derived window projections.
8. Fingerprint freshness and source-version/concurrency checks.

This branch contains the schema foundation only. It does not migrate projects,
modify annotations, change the running 8080 service, or alter viewer data.

## Local checks

After dependencies are installed, compile and validate with Ajv 2020 in strict
mode. In addition to `example.json`, validate a current
`floorplan-unified/3` aggregate to guard backward compatibility. Negative tests
should cover missing window parents, one-sided internal windows, invalid
automatic-exterior evidence, incomplete Bezier controls, incomplete L4 parent
chains and invalid L2-L4 projection evidence.
