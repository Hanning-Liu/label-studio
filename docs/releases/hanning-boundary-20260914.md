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

## Remaining gates

Catalog consolidation, business/model/geometry extraction, final full regression,
real-data interaction QA and rollback-reader compatibility, GitHub release and
production cutover are not yet accepted. Production cutover requires the final
user handoff confirming 8080 is saved and editing is paused.
