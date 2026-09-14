# Hanning boundary migration — execution record

This record is updated as each acceptance gate passes. It is not a production
release announcement until the final deployment section is completed.

## Verified migration baseline

- Official 1.23.0 ancestor: `2a9bfbcbf0a844b999de97e601d16050a893f5fb`.
- Clean source and GitHub integration branch: `c015e56a23b090f16f12a559c9be78b94b62a673`.
- Stable tag: `l1-l4-stable-20260914-piano`, dereferences to that commit.
- Production executable commit: `42500f284f9673394a64635ce4211aeea2212885`.
- Production image: `label-studio-window-l4:piano-42500f284`,
  `sha256:a7242e63e05088fb751da43056934890f770c17a9c7d0c250e18823d338e423c`.
- Both production containers healthy; external `label-studio-data` volume and
  read-only `/nas` image mount verified before any work.

The new repository is an independent `--no-hardlinks` local clone on
`refactor/hanning-customization-boundary`, with GitHub retained as origin.
All 27 source refs were inventoried, `git bundle --all` was verified, and the
clone passed `git fsck --full --no-reflogs`. The bundle SHA-256 is
`e3e7f0c011f043bb4e6fc8a9e88b97b2017e44485d7eb10aac1e97ad703c29a6`.
Old source/deployment paths and their backups remain intact.

Private runtime materials are adjacent in `label-studio-runtime`, outside Git.
The copied Compose and two environment files have identical content hashes and
access ACLs. All six images have matching per-file SHA-256. Credential contents
were not printed. Production Compose and containers have not been switched.

## Baseline and infrastructure validation

Rebuilt environments use Node 22 and Python 3.13 with Poetry 2.3.2 and unchanged
lockfiles. The host's default Node 24/Python 3.12 are not used for application
builds or backend regression.

| Check | Result |
|---|---|
| Backend baseline | 169 passed, 43.44 seconds |
| Export/aggregation baseline | 53 passed, 0.442 seconds |
| Editor baseline | 3763 passed, 61 failed, 5 existing skips, 62.244 seconds; all 61 failures in ImageView's existing `referenceSyncController` test setup |
| External source discovery/formats | 2 smoke tests pass: JSX, TypeScript, JSON, SCSS and identical React/MobX/MST imports |
| TypeScript boundary check | Passed |
| Editor development build | Passed |
| Editor/DataManager/application production builds | All three passed |
| wheel/sdist | Built and wheel imported from a separate temporary installation outside the source directory |
| Actual Nx unit cache | Initial 1.797s; repeat hit 0.668s; only hanning README changed, miss 1.745s |
| Actual Nx build cache | Initial 60.274s; repeat hit 0.815s; only hanning README changed, miss 65.827s |

The first build exposed an over-broad dependency search override; retaining
normal nested resolution and using `web/node_modules` only as a fallback fixed
all three builds. No dependency version was changed. Early baseline collection
attempts with an incorrect Python import root or missing test fixture mounts
were corrected and rerun; they are not classified as product failures.

A consistent online SQLite backup was made through a read-only production
volume mount. `quick_check` passed. At the captured snapshot, project 13/task 23
had 74 furniture instances and 525 formal result rows. The old production image
successfully exported the four-level lineage bundle from the read-only QA copy:
12 windows, no lineage issues. The database, uploads, configs, raw results,
draft backup and lineage evidence remain private in runtime QA storage.

## Extraction and final regression

The 31-category/9-group catalog now has one maintained resource. A migration-only
comparison against the Git baseline verified exact labels, group colors, button
order, template order, descriptions and the five historical additions. Existing
configured/custom options and preview/apply upgrade guards are unchanged.

Custom domains, components and five Image model mixins moved first. Room model
getters/actions and shape policies followed, preserving getter descriptors, MST
composition/action order and the original lifecycle insertion points. Backend
validation/reference services and 11 export/migration scripts now live under
`hanning`; original Python modules and CLI/management command paths delegate to
the same implementation. Task API, serializers, ReferenceSync models and existing
migrations were not changed. See [the function map](../../hanning/README.md).

Executable candidate commit: `32dfbc1c569742e27f5679d63c95641cf0d21798`.

| Validation | Evidence |
|---|---|
| Catalog frontend / backend / aggregation | 253 / 57 / 53 passed; exact catalog baseline comparison passed |
| Metadata extraction | 288 frontend tests and 2 asset revision tests passed |
| Model/shape integration | 844 passed |
| Final Editor | 3773 passed, 61 failed, 5 existing skips; exact failed-test-name set equals baseline |
| Final DataManager | 12 suites, 671 passed |
| Extracted backend | 169 passed, 42.36 seconds |
| Extracted script compatibility / round trips | 53 passed, 0.481 seconds |
| All three production build targets | Passed |
| Typed custom entry | Passed with `hanning/tsconfig.typed.json` |
| Broad dependency typecheck | 55 diagnostics, all reproduced by the original source image (234 diagnostics with its broader source roots); no new diagnostic keys |
| Final wheel/sdist | All 63 Python/runtime JSON files included; independent installed import, 4 old/new module identity pairs and exporter style resource passed |
| Real-data export equivalence | All 16 files in old-image vs extracted-code lineage bundles byte-identical on the same initial snapshot |

No assertions were weakened or tests newly skipped. The broad typecheck does
not report a clean upstream tree: its existing Editor/UI diagnostics are retained
and documented separately from the clean custom typed entry. Private logs and
machine-readable reports are in runtime `audit`, including `editor-final.json`,
`datamanager-final.json`, `backend-extraction.xml`, `typecheck-*.log`,
`packages-final/installation-check.json` and `extraction-build.log`.

## Interaction QA and release gates

A fresh consistent copy at `2026-09-14T09:21:17Z` passed SQLite quick_check;
task 23 then contained 77 instances / 531 formal result rows. Its SHA-256 is
`d5b31920c0210f505b38454d5014cd12860455e3aa4b67c0e2865e439bb5172c`.
Private evidence is under runtime `qa/interaction`. It uses independent volume
`label-studio-hanning-boundary-qa-interaction-20260914-data` and Compose project
`label-studio-hanning-boundary-qa` on `127.0.0.1:18087`, with new runtime images
mounted read-only. Production was not stopped or refreshed for this backup.

Accepted image: `label-studio-window-l4:boundary-32dfbc1c5`.
Docker image ID:
`sha256:9739f01bb4a27adce77737bfea2dcb11148110ea712d77a079194d0d8bd9b6c4`.
The final image runs independently without a source mount. Its export of the
fresh 77-instance snapshot matches all 16 old-image bundle files byte-for-byte.

| Real-data QA | Result |
|---|---|
| Startup and pure browsing | App/worker healthy; source-vs-startup business fingerprints equal. Space filters, room/zone/group Focus and reference background/overview toggles leave all 531 window-serialized results identical, including review metadata |
| Complete UI write workflow | In the copied Study/work group, outline-create one instance, change piano to bookshelf, draw a two-point front direction, confirm review, save the draft, click Update, and reopen |
| Reopened state | 78 instances, all reviewed, no pending or blocked instances; the new instance retains `front_direction` |
| Original data protection | All 531 original results unchanged; exactly 3 results added for the QA instance's geometry/category/direction. All project configs, other annotations, final draft inventory, predictions and reference bindings/mappings unchanged |
| Authorship and task identity | Original annotation author and task image data preserved. Task 23 changes only `updated_at`/`updated_by_id`; annotation 13 also changes result, lead_time and result_count as expected from the explicit QA save |
| Real download and round trip | Browser file contains 78 reviewed instances. It matches export from the saved database; original import code reconstructs all 157 furniture source results exactly; aggregation produces the same furniture section |
| Rollback reader | Preserved piano image, without the hanning package, reads 78 instances / 534 results and runs full existing geometry, parent, orientation and review validation with zero errors |
| Backup and shutdown | Saved QA database passes quick_check. Worker stopped before app; all data volumes retained |

The in-app browser stopped producing downloads after one reload; opening a fresh
QA tab restored file download without a code change. Its file-chooser API timed
out, so real-file reimport/aggregation equivalence was verified in the same
frontend runtime using the actual importer; UI file selection is not claimed as
passed. Initial image-loading MST warnings concern the unchanged ImageEntity
file; the saved results and completed interaction workflow remained valid.

Evidence includes `qa/interaction/interaction-verification.json`,
`window-browse-before.json`, `window-browse-after.json`,
`browser-furniture-export.json`, `after-submit.sqlite3`,
`old-reader-verification.json`, and `audit/qa-roundtrip.json`. No real annotation
payload or credential is included in Git. The QA-only account exists only in
the copied volume.

Measured wall-clock evidence (Shanghai time): initial migration evidence was
written at 16:11, extraction committed at 17:18, final image build ran
17:18:57–17:24:38 (340.2 seconds), and browser QA ran from approximately 17:26
through 17:50, including tool recovery. Final Jest suite spans were 30.445 seconds
for Editor and 1.399 seconds for DataManager. Inspection/extraction overlapped
test/build work; a separate exclusive analysis stopwatch was not recorded.
These are this run's observations, not a promised duration for future releases.

## Release references and production handoff

Feature branch: `refactor/hanning-customization-boundary`.
Stable branch: `integration/occupancy-room-window-l4-20260907`.
Annotated release tag: `l1-l4-stable-20260914-hanning-boundary`.
The tag identifies the documentation-inclusive release commit; executable code
is the `32dfbc1c5` commit recorded above. Later changes before this tag are
documentation only. Full local/tracking/remote SHA verification is retained in
private runtime `audit/release-identity.json` after publication.

Production cutover remains pending the final user handoff confirming 8080 is
saved and editing is paused. Private production `compose.candidate.json` uses
the accepted image and new image mount; `compose.rollback.json` uses the fixed
piano image and current data volume. Active `compose.production.json` still has
the original deployment contents. [The runtime guide](../../deploy/Hanning-runtime.md)
contains the new maintenance entry and rollback procedure. No production project
configuration upgrade or database restore is part of this release.
