import json
from io import StringIO
from unittest import TestCase

from django.core.management import call_command
from django.core.management.base import CommandError
from django.test import TransactionTestCase
from lxml import etree
from organizations.models import Organization
from projects.models import Project
from users.models import User

from .catalog_upgrade import config_sha256, upgrade_choices
from .template import build_template
from .test_template import SOURCE_CONFIG


def old_config():
    root = etree.fromstring(build_template(SOURCE_CONFIG).encode())
    control = root.xpath('.//Choices[@name="furniture_instance_type"]')[0]
    for choice in list(control):
        if choice.get('alias') in ('dressing_table', 'bar_counter'):
            control.remove(choice)
    root.append(etree.Comment('retain custom layout'))
    etree.SubElement(root, 'Header', value='自定义提示', size='5')
    return etree.tostring(root, encoding='unicode')


class CatalogUpgradeTests(TestCase):
    def test_preserves_original_xml_bytes_and_supports_empty_control(self):
        original = old_config().replace('/>', ' />').replace('\n', '\r\n')
        updated, _ = upgrade_choices(original)
        for alias, label in [('dressing_table', '梳妆台'), ('bar_counter', '吧台/餐吧台')]:
            inserted = f'<Choice value="{label}" alias="{alias}"/>'
            updated = updated.replace('    ' + inserted + '\r\n', '').replace(inserted, '')
        self.assertEqual(updated, original)
        root = etree.fromstring(original.encode())
        control = root.xpath('.//Choices[@name="furniture_instance_type"]')[0]
        for choice in list(control):
            control.remove(choice)
        control.text = None
        empty = etree.tostring(root, encoding='unicode')
        expanded, additions = upgrade_choices(empty)
        self.assertEqual(additions, ['dressing_table', 'bar_counter'])
        self.assertEqual(len(etree.fromstring(expanded.encode()).xpath('.//Choices[@name="furniture_instance_type"]/Choice')), 2)

    def test_append_preserves_existing_tree_and_is_idempotent(self):
        original = old_config()
        updated, additions = upgrade_choices(original)
        self.assertEqual(additions, ['dressing_table', 'bar_counter'])
        root = etree.fromstring(updated.encode())
        for node in root.xpath('.//Choice[@alias="dressing_table" or @alias="bar_counter"]'):
            node.getparent().remove(node)
        normalized = etree.XMLParser(remove_blank_text=True)
        self.assertEqual(
            etree.tostring(etree.fromstring(etree.tostring(root), normalized)),
            etree.tostring(etree.fromstring(original.encode(), normalized)),
        )
        self.assertEqual(upgrade_choices(updated), (updated, []))

    def test_rejects_alias_label_control_and_mode_conflicts(self):
        for old, new in [
            ('alias="desk"', 'alias="dressing_table"'),
            ('value="书桌"', 'value="梳妆台"'),
            ('alias="desk"', 'alias="bed"'),
            ('name="furniture_instance_polygon"', 'name="furniture_instance_type"'),
            ('choice="single"', 'choice="multiple"'),
        ]:
            with self.subTest(new=new), self.assertRaises(ValueError):
                upgrade_choices(old_config().replace(old, new))


class CatalogUpgradeCommandTests(TransactionTestCase):
    def setUp(self):
        user = User.objects.create(email='catalog-qa@example.invalid')
        org = Organization.create_organization(created_by=user, title='catalog QA')
        self.project = Project.objects.create(title='explicit target', label_config=old_config(),
                                              created_by=user, organization=org)

    def test_preview_identity_concurrency_apply_and_repeat(self):
        original = self.project.label_config
        output = StringIO()
        call_command('upgrade_furniture_instance_choices', project_id=self.project.id, stdout=output)
        report = json.loads(output.getvalue())
        self.assertFalse(report['applied'])
        self.project.refresh_from_db()
        self.assertEqual(self.project.label_config, original)
        options = dict(project_id=self.project.id, apply=True, expected_title=self.project.title,
                       expected_config_sha256=config_sha256(original), stdout=StringIO())
        with self.assertRaises(CommandError):
            call_command('upgrade_furniture_instance_choices', **{**options, 'expected_title': 'wrong'})
        with self.assertRaises(CommandError):
            call_command('upgrade_furniture_instance_choices', **{**options, 'expected_config_sha256': 'stale'})
        call_command('upgrade_furniture_instance_choices', **options)
        self.project.refresh_from_db()
        self.assertIn('dressing_table', self.project.label_config)
        updated = self.project.label_config
        call_command('upgrade_furniture_instance_choices', **{**options, 'expected_config_sha256': config_sha256(updated)})
        self.project.refresh_from_db()
        self.assertEqual(self.project.label_config, updated)
