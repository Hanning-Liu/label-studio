import copy
from unittest.mock import patch
from django.test import TransactionTestCase
from rest_framework.test import APIClient
from organizations.models import Organization
from projects.models import Project
from users.models import User
from tasks.furniture_instances.test_template import SOURCE_CONFIG
from tasks.furniture_instances.template import build_template
from tasks.furniture_instances.test_validation import reference_results, instance_results, mark_reviewed, SOURCE_VERSION
from tasks.furniture_instances.validation import validate
from hanning.backend.catalog.custom import custom_entry, valid_type
from hanning.backend.catalog.api import extend_config

URL = '/api/projects/furniture-catalog/'

class FurnitureCatalogTests(TransactionTestCase):
    def setUp(self):
        self.user = User.objects.create(email='catalog-test@example.invalid')
        self.org = Organization.create_organization(created_by=self.user, title='catalog tests')
        self.user.active_organization = self.org
        self.user.save()
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.projects = [Project.objects.create(title=f'L4 {n}', organization=self.org,
            created_by=self.user, label_config=build_template(SOURCE_CONFIG)) for n in range(2)]
        self.other = Project.objects.create(title='L3', organization=self.org, created_by=self.user,
            label_config=SOURCE_CONFIG)

    def post(self, **kwargs):
        return self.client.post(URL, {'project_id':self.projects[0].id,'label':'换鞋凳',
                                      'group':'storage_display',**kwargs}, format='json')

    def test_create_shared_and_idempotent_without_replacing_other_config(self):
        before = self.other.label_config
        response = self.post()
        self.assertEqual(response.status_code,201,response.data)
        entry = response.data['category']
        self.assertEqual(entry, custom_entry('换鞋凳','storage_display'))
        for p in self.projects:
            p.refresh_from_db()
            self.assertIn(entry['id'],p.label_config)
            self.assertIn('furnitureGroup="storage_display"',p.label_config)
            self.assertEqual(p.label_config.count(entry['id']),1)
        self.other.refresh_from_db();self.assertEqual(self.other.label_config,before)
        self.assertEqual(self.post(label=' 换鞋凳 ').status_code,200)
        self.org.refresh_from_db();self.assertEqual(self.org.furniture_catalog,[entry])
        self.assertEqual(self.post(group='living_dining').status_code,400)
        future = extend_config(build_template(SOURCE_CONFIG),self.org.furniture_catalog)
        self.assertIn(entry['id'],future)
        self.assertEqual(extend_config(future,[entry]),future)

    def test_duplicate_alias_invalid_name_or_group_rejected(self):
        for fields in [{'label':'沙发'},{'label':'SOFA'},{'label':'a'*41},{'group':'unknown'},{'label':'\x00x'}]:
            response=self.post(**fields);self.assertEqual(response.status_code,400,response.data)
        self.org.refresh_from_db();self.assertEqual(self.org.furniture_catalog,[])

    def test_failure_rolls_back_registry_and_all_project_configs(self):
        original=[p.label_config for p in self.projects]
        real=Project.save
        def fail(project,*args,**kwargs):
            if project.id==self.projects[1].id:raise ValueError('fixture failure')
            return real(project,*args,**kwargs)
        with patch.object(Project,'save',fail):
            self.assertEqual(self.post().status_code,400)
        self.org.refresh_from_db();self.assertEqual(self.org.furniture_catalog,[])
        for p,config in zip(self.projects,original):p.refresh_from_db();self.assertEqual(p.label_config,config)

    def test_unauthenticated_nonowner_and_other_workspace_denied(self):
        self.client.force_authenticate(None)
        self.assertIn(self.post().status_code,[401,403])
        outsider=User.objects.create(email='outsider-catalog@example.invalid')
        other=Organization.create_organization(created_by=outsider,title='other')
        outsider.active_organization=other;outsider.save()
        self.client.force_authenticate(outsider)
        self.assertEqual(self.post().status_code,404)
        outsider.active_organization=self.org;outsider.save()
        self.assertEqual(self.post().status_code,403)

    def test_custom_result_validates_and_forged_metadata_rejected(self):
        entry=custom_entry('换鞋凳','storage_display')
        refs=reference_results();manual=instance_results(refs,instance_type=entry['id'])
        for row in manual:row['meta']['furniture_instance_context']['catalog_entry']=copy.deepcopy(entry)
        mark_reviewed(manual)
        self.assertEqual(validate(refs+manual,SOURCE_VERSION),[])
        manual[0]['meta']['furniture_instance_context']['catalog_entry']['label']='another'
        self.assertTrue(validate(refs+manual,SOURCE_VERSION))
        self.assertFalse(valid_type(entry['id'],{}))
