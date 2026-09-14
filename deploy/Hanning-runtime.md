# Hanning development and runtime entry

## Directories

Daily development uses `C:\Users\HANI\Desktop\hanning\label-studio`.
Private deployment inputs, images, QA evidence and backups use the adjacent
`C:\Users\HANI\Desktop\hanning\label-studio-runtime` directory, outside Git.
Previous Codex checkout/deployment directories are retained as backups.

Use Node 22, Python 3.13 and Poetry 2.3.2 with the existing lockfiles.
From the repository root, `poetry install --with test` installs backend/test
dependencies. From `web`, run `yarn install --frozen-lockfile --ignore-engines`
and `yarn ls:dev` with `NODE_ENV=development` and `BUILD_NO_SERVER=true` set in
the shell (PowerShell uses `$env:NAME='value'`). The custom source tree is
resolved by `@hanning/*`; do not install a second React/MobX/MST tree in it.

## Verification and building

From `web`, run Editor and DataManager unit tests with the existing Jest configs:

```powershell
node node_modules/jest/bin/jest.js --config libs/editor/jest.config.js --maxWorkers=2
node node_modules/jest/bin/jest.js --config libs/datamanager/jest.config.ts --maxWorkers=2
node node_modules/typescript/bin/tsc -p ../hanning/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p ../hanning/tsconfig.typed.json --noEmit
$env:NODE_ENV='production'
node node_modules/nx/bin/nx.js run-many --target=build --projects=editor,datamanager,labelstudio --configuration=production --parallel=1
```

Backend compatibility tests run from `label_studio` with the development Python:

```powershell
python -m pytest --import-mode=importlib --pyargs tasks.furniture_instances tasks.occupancy tasks.windows tasks.reference_sync tests.test_draft_revision tests.test_frontend_asset_revision -q
```

From the repository root, run `python -m unittest discover -s scripts/tests -v`.
The fast catalog entry is `python -m hanning.scripts.verify_catalog`; separate
frontend/backend environments can use `--frontend-only` / `--backend-only`.
See [the catalog guide](L4-furniture-catalog.md) for explicit project upgrades.

The broad typecheck includes existing Editor/UI TypeScript dependencies. At this
migration baseline it reports 55 existing diagnostics, all reproduced in the
pre-migration image. The typed customization entry passes independently. Editor
also retains 61 existing ImageView test failures; compare exact diagnostics/test
names with the release evidence and never accept additional failures as baseline.

Build from the new repository root and record the complete executable commit:

```powershell
$boundaryCode = (git rev-parse HEAD).Trim()
$boundaryImage = "label-studio-window-l4:boundary-$($boundaryCode.Substring(0,9))"
docker build -f deploy/Dockerfile.l4-furniture-instances.qa --build-arg VERSION_OVERRIDE=1.23.0 --build-arg BRANCH_OVERRIDE=refactor/hanning-customization-boundary -t $boundaryImage .
docker image inspect $boundaryImage --format '{{.Id}}'
```

The active Dockerfile includes `hanning` in both build stages and the installed
application. Production does not depend on a host source mount. Record tests,
the image ID, executable SHA and any later documentation-only release SHA in
the release record. The root Dockerfile is not this deployment's build entry.

## Production handoff and cutover

Production remains on the previous image until isolated QA passes and the user
confirms 8080 is saved and editing is paused. The production Compose project is
`label-studio-l1-l4-production`; its file is
`label-studio-runtime\production\compose.production.json`.

Recheck identities, then stop worker before app. Back up the stopped data volume,
database, environment files and Compose; verify SQLite `PRAGMA quick_check` and
business fingerprints. Keep external volume `label-studio-data`, container names
`label-studio` / `label-studio-reference-sync`, port 8080 and existing network.
Both services must use the same accepted fixed image. Bind new runtime `images`
to `/nas:ro` without changing task image URLs.

From the private production directory, with the reviewed Compose in place:

```powershell
docker compose -p label-studio-l1-l4-production -f compose.production.json stop worker
docker compose -p label-studio-l1-l4-production -f compose.production.json stop app
# Complete and verify the stopped-data backup before continuing.
docker compose -p label-studio-l1-l4-production -f compose.production.json up -d --no-deps app
docker inspect label-studio --format '{{.State.Health.Status}}'
# Continue only after app is healthy.
docker compose -p label-studio-l1-l4-production -f compose.production.json up -d --no-deps worker
```

Verify actual image IDs, mounts and Compose working directory; HTTP/image access,
saved authors/results/drafts, lineage, 31 categories and spatial overview. Compare
business fingerprints separately from worker heartbeat fields. No project config
upgrade is part of this migration.

## Rollback

Preserve `label-studio-window-l4:piano-42500f284`, image ID
`sha256:a7242e63e05088fb751da43056934890f770c17a9c7d0c250e18823d338e423c`.
The release backup contains the pre-cutover Compose and environment files.
Use the recorded rollback Compose from the private production directory:

```powershell
docker compose -p label-studio-l1-l4-production -f compose.production.json stop worker
docker compose -p label-studio-l1-l4-production -f compose.production.json stop app
docker compose -p label-studio-l1-l4-production -f compose.rollback.json up -d --no-deps app
docker inspect label-studio --format '{{.State.Health.Status}}'
# Continue only after app is healthy.
docker compose -p label-studio-l1-l4-production -f compose.rollback.json up -d --no-deps worker
```

Rollback uses the same current production volume; never restore an old database
over subsequent annotations. New image paths can remain, or use the recorded old
mount when necessary. Keep old source/deployment backups and all Docker volumes.
Stop QA services after acceptance. Remove only individually listed, archived
temporary containers/images created during this migration; never use prune.
