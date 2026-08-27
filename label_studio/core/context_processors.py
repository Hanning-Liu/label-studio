"""This file and its contents are licensed under the Apache License 2.0. Please see the included NOTICE for copyright information and LICENSE for a copy of the license.
"""
import hashlib
from functools import lru_cache
from pathlib import Path

from core.feature_flags import all_flags
from core.utils.common import collect_versions
from django.conf import settings as django_settings


@lru_cache(maxsize=1)
def frontend_asset_revision():
    """Invalidate entrypoint caches when a custom frontend replaces the base image build."""
    digest = hashlib.sha256()
    try:
        for name in ('runtime.js', 'vendor.js', 'main.js', 'main.css'):
            digest.update((Path(django_settings.REACT_APP_ROOT) / name).read_bytes())
    except OSError:
        return ''
    return digest.hexdigest()[:16]


def sentry_fe(request):
    # return the value you want as a dictionary, you may add multiple values in there
    return {'SENTRY_FE': django_settings.SENTRY_FE}


def settings(request):
    """Make available django settings on each template page"""
    versions = collect_versions()

    os_release = versions.get('label-studio-os-backend', {}).get('commit', 'none')[0:6]
    # django templates can't access names with hyphens
    versions['lsf'] = versions.get('label-studio-frontend', {})
    versions['lsf']['commit'] = versions['lsf'].get('commit', os_release)[0:6]

    versions['dm2'] = versions.get('dm2', {})
    versions['dm2']['commit'] = versions['dm2'].get('commit', os_release)[0:6]

    versions['backend'] = {}
    if 'label-studio-os-backend' in versions:
        versions['backend']['commit'] = versions['label-studio-os-backend'].get('commit', 'none')[0:6]
    if 'label-studio-enterprise-backend' in versions:
        versions['backend']['commit'] = versions['label-studio-enterprise-backend'].get('commit', 'none')[0:6]

    versions['frontend_assets'] = frontend_asset_revision() or versions['backend'].get('commit', 'none')

    feature_flags = {}
    if hasattr(request, 'user'):
        feature_flags = all_flags(request.user)

    return {'settings': django_settings, 'versions': versions, 'feature_flags': feature_flags}
