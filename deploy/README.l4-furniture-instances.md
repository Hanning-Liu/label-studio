# L4 furniture-instance Mac QA

This recipe builds the repository source with its declared Node 22,
Python 3.13 and Poetry 2.3.2 toolchain. It deliberately uses a separate
Compose project, container, image, SQLite volume and host port.

The Compose build uses `deploy/Dockerfile.l4-furniture-instances.qa`, an
isolated Debian Bookworm slim recipe for Apple Silicon QA. The glibc base lets
Poetry select the locked Linux ARM64 wheels (including OpenCV) instead of
compiling their Alpine/musl source distributions. It does not change or wrap
the repository's production `Dockerfile`; it retains the same frontend build,
entrypoint and non-root UID 1001 runtime. Poetry installs serially in this QA
builder to avoid concurrent downloader stalls observed under Docker Desktop.

## Production data boundary

This Mac QA stack is local-only: do not configure it to connect to a production
Label Studio endpoint, do not add a production NAS bind mount such as `/nas`,
and do not copy or migrate production images into its volume. Use synthetic QA
tasks and images created expressly for this isolated stack.

If an imported test fixture contains a Label Studio local-files image value,
retain the relative `/data/local-files/?d=...` value byte-for-byte. Do not
rewrite it as a Mac host path, NAS path, absolute URL or another machine's
address. The Compose file intentionally mounts only `graph-label-l4-qa-data`.

## Start the isolated service

From the repository root:

```bash
docker compose \
  --project-name graph-label-l4-qa \
  --file deploy/compose.l4-furniture-instances.qa.yml \
  build

L4_QA_PORT=18080 docker compose \
  --project-name graph-label-l4-qa \
  --file deploy/compose.l4-furniture-instances.qa.yml \
  up --detach
```

If this Mac cannot reach Docker Hub but can reach the configured Google mirror,
override only the base-image registry for this build; do not change system DNS:

```bash
L4_QA_BASE_IMAGE_REGISTRY=mirror.gcr.io/library docker compose \
  --project-name graph-label-l4-qa \
  --file deploy/compose.l4-furniture-instances.qa.yml \
  build
```

Open `http://127.0.0.1:18080`. Change `L4_QA_PORT` if that port is occupied.
The published port is bound to the Mac loopback interface only.
The container is `graph-label-l4-qa-app`, the image is
`graph-label-l4-qa:local`, and SQLite/uploads live only in the named Docker
volume `graph-label-l4-qa-data`.

Inspect without entering the container:

```bash
docker compose \
  --project-name graph-label-l4-qa \
  --file deploy/compose.l4-furniture-instances.qa.yml \
  ps

docker compose \
  --project-name graph-label-l4-qa \
  --file deploy/compose.l4-furniture-instances.qa.yml \
  logs --tail 100 app
```

Stop the service while retaining the QA database:

```bash
docker compose \
  --project-name graph-label-l4-qa \
  --file deploy/compose.l4-furniture-instances.qa.yml \
  down
```

Do not point this recipe at an existing Label Studio data directory, do not
reuse a production volume, and do not run `docker system prune`. Removing the
named volume is intentionally not part of the normal workflow.

## Create an L4 project explicitly

After an L3 task has exactly one approved formal annotation, run the dedicated
management command in the QA container. It never guesses a source annotation
and never creates an L4 annotation or draft:

```bash
docker exec graph-label-l4-qa-app \
  python /label-studio/label_studio/manage.py create_furniture_instance_project \
  --source-task SOURCE_TASK_ID \
  --source-annotation SOURCE_ANNOTATION_ID \
  --title L4_FurnitureInstance_v1 \
  --confirm-create
```

The L3 reference is copied as read-only data. Later L3 changes require an
explicit reference apply; existing instance geometry and saved parent IDs are
retained and become stale until reviewed.
