from django.db import migrations, models


class Migration(migrations.Migration):
    dependencies = [('tasks', '0061_reference_sync')]
    operations = [
        migrations.AddField(model_name='referencesyncmapping', name='sync_type', field=models.CharField(default='room_to_function_zone', max_length=48)),
        migrations.AddField(model_name='referencesyncmapping', name='apply_policy', field=models.CharField(default='automatic', max_length=16)),
    ]
