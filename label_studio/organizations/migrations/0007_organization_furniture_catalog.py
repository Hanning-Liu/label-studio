from django.db import migrations, models

class Migration(migrations.Migration):
    dependencies = [('organizations', '0006_alter_organizationmember_deleted_at')]
    operations = [migrations.AddField(model_name='organization', name='furniture_catalog',
                                     field=models.JSONField(default=list, blank=True))]
