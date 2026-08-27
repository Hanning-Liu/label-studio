# L3 and reference-sync production snapshot

This branch captures the source used for the 2026-08-26 L3 occupancy and
Room-to-FunctionZone reference-sync deployment.

## One project, two services

Both containers use the same Label Studio codebase and the same production
data volumes:

- `web` runs the Label Studio web application and API on port 8080.
- `reference-sync` runs `python manage.py reference_sync_worker` in the
  background and does not expose a web port.

The services are defined together in `deploy/compose.reference-sync.yml`.
Set `REFERENCE_SYNC_IMAGE` to a verified immutable image tag or digest before
starting the Compose project.

## Data boundary

Git stores application source, migrations, tests, Dockerfiles, and deployment
configuration. Production SQLite data, NAS content, secrets, local `.env`
files, and Docker volumes are intentionally excluded.

## Release management

For future releases, build one immutable image from a reviewed Git commit and
run both services from that same image digest. The staged Dockerfiles in this
snapshot preserve the validated local build chain; consolidating them into one
CI-ready Dockerfile should be handled as a separate tested change.
