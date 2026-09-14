import signal
import time
from pathlib import Path
from django.core.management.base import BaseCommand
from django.db import close_old_connections
from django.utils import timezone
from tasks.reference_sync.models import ReferenceSyncMapping
from tasks.reference_sync.service import process_pending, reconcile


class Command(BaseCommand):
    help = 'Process durable Room reference sync jobs; no Redis or external credentials.'

    def add_arguments(self,parser):
        parser.add_argument('--once',action='store_true')
        parser.add_argument('--healthcheck',action='store_true')

    def handle(self,*args,**options):
        if options['healthcheck']:
            from datetime import timedelta
            if ReferenceSyncMapping.objects.filter(enabled=True).exclude(worker_heartbeat__gte=timezone.now()-timedelta(seconds=15)).exists():
                raise SystemExit(1)
            return
        running = True
        def stop(*_):
            nonlocal running
            running = False
        signal.signal(signal.SIGTERM,stop)
        signal.signal(signal.SIGINT,stop)
        last_reconcile = 0
        while running:
            close_old_connections()
            ReferenceSyncMapping.objects.filter(enabled=True).update(worker_heartbeat=timezone.now())
            if time.monotonic()-last_reconcile >= 60:
                reconcile()
                last_reconcile = time.monotonic()
            count = process_pending()
            Path('/tmp/room-reference-sync.heartbeat').write_text(str(time.time()))
            if count:
                self.stdout.write(f'Synchronized {count} reference binding(s)')
            if options['once']:
                return
            time.sleep(1)
