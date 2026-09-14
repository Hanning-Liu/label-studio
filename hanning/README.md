# Hanning customization boundary

This package contains the opt-in L1–L4 floorplan customization of Label Studio
1.23.0. It is part of the main repository, not a separate Git repository.

Upstream reference: `2a9bfbcbf0a844b999de97e601d16050a893f5fb`.
Migration baseline: `c015e56a23b090f16f12a559c9be78b94b62a673`.

## Integration boundaries

The Nx workspace remains `web`. `@hanning/*` resolves to this directory in
Webpack, TypeScript and Jest. Webpack and Jest resolve dependencies from
`web/node_modules`; React, MobX and MST must retain one runtime instance.
`web/tools/hanning-hash.mjs` hashes file names and contents for Nx build/unit
inputs, including additions and deletions outside the Nx workspace.

Poetry packages `hanning` together with `label_studio`. The active Dockerfile
copies it into both the frontend and Python build stages. Importing this
package does not enable custom behavior on ordinary projects.

## Existing operation guides

- [Hierarchical annotation](../docs/l4-hierarchical-annotation.md)
- [Furniture catalog and explicit project upgrades](../deploy/L4-furniture-catalog.md)
- [Window lineage](../deploy/L1-L4-window-lineage.md)

The single category source is `catalog/furniture.json`. Frontend adapters are
`frontend/domain/catalog.js`; installed Python code uses `backend/catalog` and
`importlib.resources`. Template order, button order and historical additions
are independent fields. The migration-only `verify_catalog_baseline` command
compares against Git history; it is not required for future category additions.

The function-level source and integration map is maintained here as extraction
proceeds. Historical motivation is not inferred from a file name or UI appearance.

## Verified source map and extraction destinations

Status: baseline inventory, before business extraction. The destinations below
are the implementation map, not a claim that those modules have already moved.
Classification comes from `git diff` against the upstream commit and the baseline
history. Pure custom paths do not exist at that upstream commit.

| User workflow | Baseline function / module | Upstream behavior and custom difference | Destination | Retained integration and reason | Existing regression |
|---|---|---|---|---|---|
| Save geometry, category and direction | `regions/Result.js: serialize` | Upstream merges result and area metadata; added ownership rules keep L2/L3 geometry context, window projection/context and L4 role/provenance on the correct result | `frontend/domain/resultMetadata.js` | `Result.serialize` retains the upstream merge and delegates immediately after it | Image windows, occupancy, whole-room and furniture tests; schemaContract |
| Select room and constrain zones/openings | `Image.js: roomConstraintControls` through `constrainRectangle`; `csvNames`, `rectangleToInternalPolygon`, `regionToInternalPolygon`, `vectorToInternalSegment`, `canvasRectangleFromEdge` | Custom views and geometry helpers added after upstream `suggestions`; upstream coordinate conversion and region models remain | `frontend/models/roomViews.js`, `frontend/domain/roomGeometry.js` | Image views registration must preserve getters rather than evaluate them while spreading | Image.roomConstraints, roomConstraintGeometry |
| Update room/opening and review metadata | `Image.js: refreshRoomV3Metadata`, `refreshGeometryReviewMetadata`, `validateFunctionZoneV3`, `invalidateGeometryReviews` | Added room graph, opening evidence, partition validation and review invalidation | `frontend/models/roomActions.js` | Existing MST actions registration preserves transaction/history boundaries | Image.roomV3Config, Image.roomConstraints, whole-room tests |
| Focus and drawing availability | `Image.js: setFocusedRoom`, `setRoomConstraintNotice`, `updateRoomConstraintTools` | Custom focus state and tool eligibility | `frontend/models/roomActions.js` | Image volatile state, attach cleanup and tool lifecycle remain in upstream host | DrawingTool, tools Manager/Base, Image tests |
| Prepare and validate submission | `Image.js: beforeSend`, `validate` | Modified upstream lifecycle dispatches L4, L3 and L1/L2 preparation/validation | Existing Image integration | Keep branching, order and lifecycle in place; only import/delegate policies | submitValidation, AppStore and Image tests |
| Furniture creation/edit/review/navigation | `FurnitureInstances`; furnitureInstances domain, constraints, operations, reviewSession and UI | Pure custom; no upstream counterpart | `frontend/models/FurnitureInstances.js`, `frontend/domain/furnitureInstances/`, `frontend/components/furnitureInstances/` | Original imports may forward; Image composition order stays identical | FurnitureInstances and Image.furnitureInstances suites |
| L3 occupancy, barriers and references | `Occupancy`; occupancy domain, constraints, geometry, transform, operations and UI | Pure custom; no upstream counterpart | `frontend/models/Occupancy.js`, `frontend/domain/occupancy/`, `frontend/components/occupancy/` | Original region/tool events perform mutations and history | Occupancy and Image.occupancy suites |
| Window geometry, pairing and provenance | `RoomWindows`; windows domain/geometry/pairing/fingerprint | Pure custom; no upstream counterpart | `frontend/models/RoomWindows.js`, `frontend/domain/windows/` | Vector model and drawing lifecycle retain event writes | Windows domain/geometry and Image.windows |
| Whole-room inheritance and vector review | `WholeRoomInheritance`, `VectorReview`, associated controls and helpers | Pure custom; no upstream counterpart | `frontend/models/`, `frontend/components/`, `frontend/domain/` | Image model composition and ImageView slots retain order and context | WholeRoomInheritance, VectorReviewControls, referenceReview |
| Read-only reference display and Focus selector | `ImageView: RoomFocusSelector`, reference controls, occupancy/furniture layer partition policies | Custom component/policies added around upstream Stage/Regions | `frontend/components/`, existing custom display domain modules | `ImageView`, `StageContent`, `RegionsLayer` retain layer order, events and context | ReferenceSyncControls, FurnitureInstanceLayer, spatial progress |
| Shape constraints and appearance | `RectRegion`, `PolygonRegion`, `VectorRegion`, `DrawingTool` delegate to room/occupancy/furniture policies | Modified upstream events plus custom geometry/appearance functions | `frontend/domain/` | Official shape models, Transformer and drawing lifecycle retain model writes and history | constraints, appearance, geometry, drawing tests |
| Furniture catalog/template/upgrade | `FURNITURE_TYPES`, `FURNITURE_TYPE_GROUPS`, `catalogDetails`, `FURNITURE_TYPE_CHOICES`, `ADDITIONS` | Pure custom, currently five manually maintained sources | `catalog/furniture.json`, frontend/backend catalog adapters | Existing names/shapes stay available; five historical additions retain their separate order | appearance, presentation, template, catalog_upgrade, aggregation |
| Window/furniture/occupancy save validation | `tasks.windows`, `tasks.furniture_instances`, `tasks.occupancy` | Pure custom validation/preparation/provenance modules | `backend/validation/` | Existing API/serializers/permission checks and actual save locations remain | Backend geometry/reference/validation and API tests |
| Safe source synchronization | `reference_sync.service: sync_atomic`, `prepare_write`, `finalize_saved_result`, `process_binding`; lineage/results modules | Pure custom; explicit source identity, stale checks, locks and provenance | `backend/reference_sync/` | `tasks.reference_sync.models`, migrations and API/command entry points remain; dispatch UIDs unchanged | Reference sync, lineage, concurrency and draft revision tests |
| Frontend asset freshness | `core.context_processors.frontend_asset_revision` | Added SHA-256 of four built entrypoint files; upstream injects versions | `backend/adapters/frontend_assets.py` | Context processor keeps cached wrapper and settings injection | test_frontend_asset_revision |
| Research export and round trip | `scripts/furniture_instances_to_unified.py`, lineage bundle, room/zone exporters | Pure custom CLIs and geometry aggregation | `scripts/`, `backend/` as applicable | Old script names/arguments, `--lineage-manifest`, atomic output and exact source evidence retained | scripts/tests and schemaContract |

The core write lifecycle remains in `AppStore.persistAnnotation`,
`Annotation.saveDraft`, DataManager `lsf-sdk`, `appDraftGuard`, `ImageTransformer`
and `Toolbar/Tool`. A failed post-mutation save only retries persistence.

History anchors: `c49c5f2d4` (room constraints), `9112915cb` (Room v3),
`c61a14dc6` / `c5b961591` (occupancy), `1b6b7aff2` (windows), `4683100a7`
(furniture), `c5f577307` (integration), `e105fd3ad` (hierarchy/geometry).
These establish implementation provenance; they do not prove unrecorded motives.
