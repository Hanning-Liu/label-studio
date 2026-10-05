import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('prepare_compose', Path(__file__).parents[1] / 'prepare_hanning_1232_compose.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class PrepareComposeTests(unittest.TestCase):
    def setUp(self):
        self.source = {'name': 'existing-production', 'services': {
            name: {'image': 'sha256:' + 'b' * 64, 'environment': {'LABEL_STUDIO_HOST': 'https://labels.example.test',
                    'USER_ADDITIONAL_BANNED_SUBNETS': '169.254.0.0/16'},
                   'volumes': [{'type': 'volume', 'source': 'existing-data', 'target': '/label-studio/data'}],
                   'networks': ['existing-network']}
            for name in ('app', 'worker')}, 'volumes': {'existing-data': {'external': True}}}
        self.image = 'sha256:' + 'a' * 64

    def test_preserves_runtime_identity_and_exact_rollback(self):
        upgrade, rollback = module.prepare(self.source, self.image)
        self.assertEqual(rollback, self.source)
        self.assertEqual(upgrade['name'], self.source['name'])
        self.assertEqual(upgrade['volumes'], self.source['volumes'])
        for name in ('app', 'worker'):
            self.assertEqual(upgrade['services'][name]['volumes'], self.source['services'][name]['volumes'])
            self.assertEqual(upgrade['services'][name]['networks'], ['existing-network'])
            self.assertEqual(upgrade['services'][name]['image'], self.image)
            self.assertEqual(upgrade['services'][name]['environment']['SSRF_PROTECTION_ENABLED'], 'true')
        self.assertEqual(self.source['services']['app']['image'], 'sha256:' + 'b' * 64)

    def test_rejects_missing_host_and_mismatched_old_images(self):
        del self.source['services']['app']['environment']['LABEL_STUDIO_HOST']
        with self.assertRaises(ValueError):
            module.prepare(self.source, self.image)
        self.source['services']['worker']['image'] = 'different-old-image'
        with self.assertRaises(ValueError):
            module.prepare(self.source, self.image)

    def test_rejects_mutable_image_tag(self):
        with self.assertRaises(ValueError):
            module.prepare(self.source, 'label-studio:latest')

    def test_rejects_mutable_rollback_image(self):
        for service in self.source['services'].values():
            service['image'] = 'label-studio:old'
        with self.assertRaisesRegex(ValueError, 'Pin the old'):
            module.prepare(self.source, self.image)


if __name__ == '__main__':
    unittest.main()
