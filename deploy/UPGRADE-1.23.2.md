# Hanning 1.23.2 upgrade and release preparation

The fixed customization baseline is `16de822e75d8cc1b86a15a93e8b4845426349324`
on `integration/occupancy-room-window-l4-20260907`. The upgrade merges the official
`1.23.2` tag, preserving both histories, Shapely 2.1.2 and the `hanning` package.
Use Python 3.13, Poetry 2.3.2 and Node 22. Frontend lockfile changes are not part
of this upgrade. The machine-readable acceptance record is
[`upgrade-1.23.2-acceptance.json`](upgrade-1.23.2-acceptance.json).

## Build and test

Run `poetry check --lock`, then the frontend, backend and script checks documented
in [Hanning-runtime.md](Hanning-runtime.md), against both the fixed baseline and
the upgrade. Run the official new security suites for local files, S3/Redis SSRF,
query traversal, exported media, secret-key permissions and user authorization.
Compare failing test names AND normalized messages, not just failure counts.
Previously recorded failures are not an allowance for additional failures.

Build the runtime using `deploy/Dockerfile.l4-furniture-instances.qa`, with
`VERSION_OVERRIDE=1.23.2` and
`BRANCH_OVERRIDE=upgrade/hanning-1.23.0-to-1.23.2`. Set the build platform to the
inspected production platform. Record the executable Git SHA and immutable image
ID; app and worker must use the same image. The production image must contain its
own frontend assets and installed `hanning` package, without a source bind mount.
The version generator reads commit metadata without fetching historical patches.

## Isolated QA

Use `deploy/compose.hanning-1232.qa.yml`. Supply a private env file outside Git:

```dotenv
HANNING_QA_IMAGE=<verified fixed image tag or digest>
HANNING_QA_MEDIA=<absolute path to a copied media directory>
HANNING_QA_DOCUMENT_ROOT=/nas
HANNING_QA_PORT=18085
HANNING_QA_HOST=http://localhost:18085
```

The Compose project owns a new data volume and an internal network; it never
mounts production data. Keep the source dataset's document root if it differs
from `/nas`, so existing local-storage paths and image URLs remain compatible.
Copy media to the read-only bind directory. Copy the database using SQLite's
backup API, not a live copy of the main file without its WAL:

```sh
python scripts/upgrade_1232_audit.py snapshot SOURCE.sqlite3 NEW_SNAPSHOT.sqlite3 > original-fingerprint.json
python scripts/upgrade_1232_audit.py fingerprint DATABASE.sqlite3 > before.json
python scripts/upgrade_1232_audit.py fingerprint DATABASE.sqlite3 > after.json
python scripts/upgrade_1232_audit.py compare before.json after.json
```

Snapshots refuse to overwrite an existing destination and are created mode 0600.
Fingerprints include every business table, drafts, users and reference bindings.
Only sessions, migration bookkeeping and reference worker heartbeats are reported
separately. A business difference or failed integrity/foreign-key check exits 1.
Run fingerprints at equivalent idle checkpoints, before interactive edits.

For older QA datasets, first boot the selected 1.23.0 baseline to apply its own
customization migrations, then record the upgrade comparison checkpoint. This
normalization is distinct from the 1.23.0-to-1.23.2 comparison. Never label a local
QA fixture as a current production snapshot.

Verify baseline → upgraded app → upgraded worker → restart. Check L1–L4 editing,
draft conflicts, reference review, local/uploaded images and JSON/GraphML/COCO/YOLO
exports. Create new annotations/drafts with the upgraded image, record a fresh
fingerprint, then boot the old image against that same QA database. Confirm new
work remains readable and no unexpected business data changes occur.

## Network and security configuration

Keep `SSRF_PROTECTION_ENABLED=true`, `ML_BLOCK_LOCAL_IP=true` and
`DEBUG_MODAL_EXCEPTIONS=false`. Set `LABEL_STUDIO_HOST` to the actual trusted
service URL; validate container access to it for remote media exports. Uploaded
local media should be included without weakening protection for arbitrary URLs.
For required private services, inventory their resolved addresses and adjust the
blocked CIDRs explicitly; preserve blocks on other sensitive ranges. Do not use
the old blanket disabled protection settings as the upgrade default.

Verify uploaded HTML/SVG/XML are sandboxed through both Django and the deployed
nginx path. Check the generated secret-key file is owner-only. If a production
key may have been exposed, plan key/token rotation in the maintenance window;
rotation invalidates sessions and existing access tokens.

## Production handoff and rollback

Production remains unchanged during preparation. Obtain its normalized Compose
JSON, platform, exact old image IDs, media mounts and consistent database snapshot.
Keep these and all credentials outside Git. Reconcile them with
[the runtime guide](Hanning-runtime.md), rather than treating historical image IDs
or paths in that document as live production state.

After reviewing the trusted host in the normalized input, prepare release files:

```sh
python scripts/prepare_hanning_1232_compose.py production.json \
  --image sha256:VERIFIED_IMAGE_ID \
  --app app --worker worker --output-dir PRIVATE_NEW_RELEASE_DIRECTORY
```

Use the actual service names if different. This generates a private upgrade file
and exact rollback copy; mounts, ports, networks and project identity are retained.
It refuses mutable image tags, missing hosts, mismatched prior service images and
existing output directories. Review `docker compose config` for both files.
For cross-machine deployment, publish/load the platform-matching image first and
verify its digest on the destination; a local arm64 image is not proof of Windows
production-platform acceptance.

Only after all acceptance gates pass, schedule the cutover: save/pause annotation,
stop worker then app, back up data/configuration, verify backup integrity, start
the new app, verify it, then start worker and resume annotation. Preserve the old
image and rollback Compose. Rehearse rollback using the latest QA database,
including post-upgrade annotations. Never overwrite subsequent work with an old
database snapshot. Any failed rollback/data gate blocks release.
