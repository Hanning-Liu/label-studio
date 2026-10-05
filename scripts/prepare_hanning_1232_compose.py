#!/usr/bin/env python3
"""Prepare deployment/rollback JSON from an inspected production Compose file.

Run against `docker compose config --format json` saved outside Git. This command
does not invoke Docker, start services, change data, or overwrite existing files.
"""
import argparse
import copy
import json
import os
import re
from pathlib import Path


def prepare(source, image, app='app', worker='worker'):
    if not re.fullmatch(r'(?:sha256:|[^\s]+@sha256:)[0-9a-f]{64}', image):
        raise ValueError('Upgrade image must be an immutable image ID or repository digest')
    if app == worker:
        raise ValueError('App and worker must be different services')
    services = source.get('services', {})
    if any(name not in services or not services[name].get('image') for name in (app, worker)):
        raise ValueError('Both selected services must exist and have a recorded image')
    if services[app]['image'] != services[worker]['image']:
        raise ValueError('Inspect the different app/worker images before preparing a release')
    if not re.fullmatch(r'(?:sha256:|[^\s]+@sha256:)[0-9a-f]{64}', services[app]['image']):
        raise ValueError('Pin the old app/worker image ID or digest in the reviewed input for rollback')
    upgraded = copy.deepcopy(source)
    for name in (app, worker):
        service = upgraded['services'][name]
        service['image'] = image
        # Deployment consumes the verified image, never a fresh implicit build.
        service.pop('build', None)
        environment = service.setdefault('environment', {})
        if not isinstance(environment, dict):
            raise ValueError('Use normalized Compose JSON with dictionary environment values')
        if not environment.get('LABEL_STUDIO_HOST'):
            raise ValueError('Record the trusted LABEL_STUDIO_HOST in the reviewed input first')
        environment.update(SSRF_PROTECTION_ENABLED='true', ML_BLOCK_LOCAL_IP='true',
                           DEBUG_MODAL_EXCEPTIONS='false')
    return upgraded, copy.deepcopy(source)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--image', required=True)
    parser.add_argument('--output-dir', required=True, type=Path)
    parser.add_argument('--app', default='app')
    parser.add_argument('--worker', default='worker')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    destination = args.output_dir.resolve()
    if destination.is_relative_to(repo):
        raise ValueError('Keep production configuration and credentials outside the repository')
    upgraded, rollback = prepare(json.loads(args.source.read_text()), args.image, args.app, args.worker)
    # A new private directory makes partial output and accidental replacement explicit.
    destination.mkdir(mode=0o700, parents=True, exist_ok=False)
    for name, document in [('compose.upgrade.json', upgraded), ('compose.rollback.json', rollback)]:
        fd = os.open(destination / name, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        with os.fdopen(fd, 'w') as stream:
            json.dump(document, stream, indent=2)
            stream.write('\n')
    print('Prepared upgrade and rollback files; no services were changed.')


if __name__ == '__main__':
    main()
