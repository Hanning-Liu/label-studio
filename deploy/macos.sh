#!/bin/sh
# Local macOS entrypoint; reuses the verified app/worker/gateway Compose stack.
set -eu

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
HANNING_MAC_RUNTIME_DIR=${HANNING_MAC_RUNTIME_DIR:-"$(dirname -- "$repo_dir")/runtime"}
case "$HANNING_MAC_RUNTIME_DIR" in
  /*) ;;
  *) echo "HANNING_MAC_RUNTIME_DIR must be an absolute path" >&2; exit 1 ;;
esac
export HANNING_MAC_RUNTIME_DIR
project_name=${HANNING_MAC_PROJECT:-hanning-macos}
env_file="$HANNING_MAC_RUNTIME_DIR/macos.env"

if [ "${1:-}" = init ]; then
  umask 077
  mkdir -p "$HANNING_MAC_RUNTIME_DIR/media" "$HANNING_MAC_RUNTIME_DIR/backups"
  if [ -e "$env_file" ]; then
    echo "Existing configuration retained: $env_file"
  else
    source_sha=$(git -C "$repo_dir" rev-parse --short=12 HEAD)
    sed "s/SOURCE_SHA/$source_sha/g" "$repo_dir/deploy/macos.env.example" > "$env_file"
    echo "Created: $env_file"
  fi
  exit 0
fi

if [ "$#" -eq 0 ] || [ ! -f "$env_file" ]; then
  echo "Run $0 init first, then $0 <compose arguments>, e.g. up -d --wait or ps" >&2
  exit 1
fi

exec docker compose --env-file "$env_file" \
  --file "$repo_dir/deploy/compose.hanning-1232.qa.yml" \
  --project-name "$project_name" "$@"
