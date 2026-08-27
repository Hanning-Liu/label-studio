from django.db import migrations, models
import django.db.models.deletion


class Migration(migrations.Migration):
    dependencies = [('tasks', '0060_add_allow_skip_to_task')]
    operations = [
        migrations.CreateModel(name='ReferenceSyncMapping', fields=[
            ('id', models.AutoField(primary_key=True, serialize=False, auto_created=True, verbose_name='ID')),
            ('enabled', models.BooleanField(default=False)),
            ('auto_create', models.BooleanField(default=True)),
            ('worker_heartbeat', models.DateTimeField(null=True)),
            ('source_project', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='projects.project')),
            ('target_project', models.ForeignKey(on_delete=django.db.models.deletion.PROTECT, related_name='+', to='projects.project')),
        ]),
        migrations.CreateModel(name='ReferenceSyncBinding', fields=[
            ('id', models.AutoField(primary_key=True, serialize=False, auto_created=True, verbose_name='ID')),
            ('source_task_id', models.BigIntegerField()),
            ('source_annotation_id', models.BigIntegerField(null=True)),
            ('prediction_id', models.BigIntegerField(null=True)),
            ('source_data_hash', models.CharField(max_length=64, default='')),
            ('desired_hash', models.CharField(max_length=64, default='')),
            ('applied_hash', models.CharField(max_length=64, default='')),
            ('generation', models.PositiveIntegerField(default=0)),
            ('status', models.CharField(max_length=24, default='pending')),
            ('error', models.TextField(default='')),
            ('attempts', models.PositiveIntegerField(default=0)),
            ('next_attempt_at', models.DateTimeField(null=True)),
            ('last_synced_at', models.DateTimeField(null=True)),
            ('updated_at', models.DateTimeField(auto_now=True)),
            ('mapping', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='bindings', to='tasks.referencesyncmapping')),
            ('target_task', models.OneToOneField(null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='reference_sync', to='tasks.task')),
        ]),
        migrations.CreateModel(name='ReferenceSyncAudit', fields=[
            ('id', models.AutoField(primary_key=True, serialize=False, auto_created=True, verbose_name='ID')),
            ('created_at', models.DateTimeField(auto_now_add=True)),
            ('source_hash', models.CharField(max_length=64)),
            ('operation', models.CharField(max_length=24, default='sync')),
            ('summary', models.JSONField(default=dict)),
            ('before', models.JSONField(default=dict)),
            ('after', models.JSONField(default=dict)),
            ('binding', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='audits', to='tasks.referencesyncbinding')),
        ]),
        migrations.AddConstraint(model_name='referencesyncmapping', constraint=models.UniqueConstraint(fields=('source_project', 'target_project'), name='reference_sync_project_pair')),
        migrations.AddConstraint(model_name='referencesyncbinding', constraint=models.UniqueConstraint(fields=('mapping', 'source_task_id'), name='reference_sync_source_target')),
    ]
