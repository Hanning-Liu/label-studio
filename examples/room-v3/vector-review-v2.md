# FunctionZone Vector review UX v2

The compact review dock is enabled for FunctionZone images with `wholeRoomZoneInheritance="true"` and room constraints. It is sticky inside `.lsf-main-content`, not over the Regions sidebar or submit controls. Reference details, inheritance/subdivision and recovery exports remain available in dialogs.

## Review contract

- Editable manual traffic/visual Vectors use the original per-region `connection_review` / `visual_connection_review` Choices control, `Reviewed`, sharing the Vector ID. Read-only Portals are excluded.
- Individual and bulk review use `ImageModel.setVectorReview`. Undo restores a batch in one step. Exceptions during writes restore the result snapshots.
- Bulk review requires explicit user confirmation, a successful pre-save, and an unchanged snapshot of pending Vector geometry/category, zones and reference version. It then saves again. A post-save failure retains local review edits and reports them as unsaved.
- Pending reference updates, unfinished drawing, read-only/compare views and submission prevent review. Reference sync and existing submit/geometry checks are unchanged.
- Locating is view-only. It selects the Vector, aligns the canvas below the measured dock, fits only if necessary, and pans to the center of the intersection of the canvas and visible scroll viewport, with about 48px padding. Normal pan limits remain unchanged; review navigation alone may use extra edge space.
- Room category definitions remain in a hidden View. FunctionZone room-label hotkeys are inert; L1 shortcuts are unchanged.

## Relevant code

- `web/libs/editor/src/mixins/VectorReview.js`: shared model operations and protected batch flow.
- `web/libs/editor/src/utils/vectorReviewFocus.js`: view-only fit, scroll and pan.
- `web/libs/editor/src/components/ImageView/VectorReviewControls.jsx`: list, explicit confirmation and current-Vector controls.
- `ImageView.jsx`, `ReferenceSyncControls.jsx`, `WholeRoomInheritanceControls.jsx`: sticky layout and compact dialogs.
- `function-zone-v3.xml`: compatible hidden room-control definitions.

## Validation

141 tests passed across Vector review, focus, inheritance, constraints and the pre-existing Image suite. Browser validation used an isolated Task20 database copy: batch confirmation added only five review results, one Undo restored the original 88 results, and save/reload retained the correct states. Sticky scrolling, modal stacking, horizontal/vertical positioning, zoom-to-fit and a 1100×760 viewport were checked.

Production Task20 was not confirmed or submitted during deployment. Its 88 results remained identical, including the user's two reviewed Vectors and five pending Vectors. Backend/API/schema and the running reference-sync worker were not replaced.
