from core.context_processors import frontend_asset_revision
from django.test import override_settings


def test_frontend_revision_tracks_entrypoint_contents(tmp_path):
    for name in ('runtime.js', 'vendor.js', 'main.js', 'main.css'):
        (tmp_path / name).write_text(name)
    with override_settings(REACT_APP_ROOT=tmp_path):
        frontend_asset_revision.cache_clear()
        before = frontend_asset_revision()
        assert len(before) == 16
        (tmp_path / 'vendor.js').write_text('updated vendor')
        frontend_asset_revision.cache_clear()
        assert frontend_asset_revision() != before
    frontend_asset_revision.cache_clear()


def test_frontend_revision_allows_missing_development_build(tmp_path):
    with override_settings(REACT_APP_ROOT=tmp_path):
        frontend_asset_revision.cache_clear()
        assert frontend_asset_revision() == ''
    frontend_asset_revision.cache_clear()
