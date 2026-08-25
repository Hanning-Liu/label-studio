#!/usr/bin/env python3
"""Audit and provision the Room v3 / FunctionZone v3 Label Studio pilot.

The command is dry-run by default. With ``--apply`` it renames the two frozen
v2 projects, creates both v3 projects, and imports only Room Task 13 as an
editable Room v3 seed plus a read-only v2 portal reference prediction. The
FunctionZone v3 project intentionally remains empty until an approved Room v3
annotation is supplied to ``function_zone_v3_migration.py``.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from room_v3_common import RoomV3Error
from room_v3_migration import convert as convert_room_v3


class ApiError(RoomV3Error):
    pass


class Client:
    def __init__(self, base_url: str, token: str):
        self.base_url = base_url.rstrip("/")
        self.token = token

    def request(self, method: str, path: str, payload: Any | None = None) -> Any:
        url = f"{self.base_url}{path}"
        body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={
                "Authorization": f"Token {self.token}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")
            raise ApiError(f"{method} {url} failed ({exc.code}): {detail}") from exc
        except urllib.error.URLError as exc:
            raise ApiError(f"{method} {url} failed: {exc}") from exc

    def project(self, project_id: int) -> dict[str, Any]:
        return self.request("GET", f"/api/projects/{project_id}/")

    def task(self, task_id: int) -> dict[str, Any]:
        return self.request("GET", f"/api/tasks/{task_id}/")

    def projects(self) -> list[dict[str, Any]]:
        payload = self.request("GET", "/api/projects/?page_size=100")
        if isinstance(payload, list):
            return payload
        if isinstance(payload, dict) and isinstance(payload.get("results"), list):
            return payload["results"]
        raise ApiError("project list response has an unsupported shape")


def _canonical_annotation_payload(task: dict[str, Any]) -> list[dict[str, Any]]:
    normalized = []
    for annotation in task.get("annotations", []):
        if not isinstance(annotation, dict):
            continue
        results = annotation.get("result") if isinstance(annotation.get("result"), list) else []
        normalized.append(
            {
                "id": annotation.get("id"),
                "was_cancelled": bool(annotation.get("was_cancelled", False)),
                "ground_truth": bool(annotation.get("ground_truth", False)),
                "result": sorted(results, key=lambda result: (str(result.get("id")), str(result.get("from_name")))),
            }
        )
    return sorted(normalized, key=lambda annotation: annotation.get("id") or -1)


def annotation_hash(task: dict[str, Any]) -> str:
    canonical = json.dumps(
        _canonical_annotation_payload(task), ensure_ascii=False, sort_keys=True, separators=(",", ":")
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def create_or_get_project(
    client: Client,
    projects: list[dict[str, Any]],
    *,
    title: str,
    description: str,
    label_config: str,
    apply: bool,
) -> dict[str, Any] | None:
    matches = [project for project in projects if project.get("title") == title]
    if len(matches) > 1:
        raise ApiError(f"multiple projects already use title {title!r}")
    if matches:
        existing = client.project(int(matches[0]["id"]))
        if existing.get("label_config") != label_config:
            raise ApiError(f"existing project {title!r} has a different label config")
        return existing
    if not apply:
        return None
    created = client.request(
        "POST",
        "/api/projects/",
        {"title": title, "description": description, "label_config": label_config},
    )
    projects.append(created)
    return created


def append_frozen_notice(description: str | None, replacement_title: str, replacement_url: str) -> str:
    marker = "[ROOM_V3_FROZEN_BASELINE]"
    original = (description or "").strip()
    if marker in original:
        return original
    notice = (
        f"{marker}\n冻结的 v2 基线：不得修改配置、任务或 annotation。\n"
        f"后续项目：{replacement_title} — {replacement_url}"
    )
    return f"{original}\n\n{notice}".strip()


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Provision the first Room v3 Label Studio pilot safely.")
    parser.add_argument("--url", default=os.environ.get("LABEL_STUDIO_URL", "http://localhost:8080"))
    parser.add_argument("--token", default=os.environ.get("LABEL_STUDIO_API_TOKEN"))
    parser.add_argument("--room-project-id", type=int, default=5)
    parser.add_argument("--zone-project-id", type=int, default=3)
    parser.add_argument("--room-task-id", type=int, default=13)
    parser.add_argument("--zone-task-id", type=int, default=7)
    parser.add_argument("--room-config", required=True, type=Path)
    parser.add_argument("--zone-config", required=True, type=Path)
    parser.add_argument("--backup-dir", required=True, type=Path)
    parser.add_argument("--apply", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if not args.token:
        print("error: --token or LABEL_STUDIO_API_TOKEN is required", file=sys.stderr)
        return 2
    try:
        room_config = args.room_config.read_text(encoding="utf-8")
        zone_config = args.zone_config.read_text(encoding="utf-8")
        client = Client(args.url, args.token)
        room_project_before = client.project(args.room_project_id)
        zone_project_before = client.project(args.zone_project_id)
        room_task_before = client.task(args.room_task_id)
        zone_task_before = client.task(args.zone_task_id)
        before_hashes = {
            "room_task_annotation_sha256": annotation_hash(room_task_before),
            "zone_task_annotation_sha256": annotation_hash(zone_task_before),
        }
        args.backup_dir.mkdir(parents=True, exist_ok=True)
        write_json(args.backup_dir / "project-5-before.json", room_project_before)
        write_json(args.backup_dir / "project-3-before.json", zone_project_before)
        write_json(args.backup_dir / "task-13-before.json", room_task_before)
        write_json(args.backup_dir / "task-7-before.json", zone_task_before)
        bundle = convert_room_v3(room_task_before, source_project_id=args.room_project_id)
        write_json(args.backup_dir / "room-v3-seed-bundle.json", bundle)

        allowed_room_titles = {"Room_Label_v2", "L1_Room_v2_Legacy"}
        allowed_zone_titles = {"Zone_Label", "L2_FunctionZone_v2_Legacy"}
        if room_project_before.get("title") not in allowed_room_titles:
            raise ApiError(f"Project {args.room_project_id} has unexpected title {room_project_before.get('title')!r}")
        if zone_project_before.get("title") not in allowed_zone_titles:
            raise ApiError(f"Project {args.zone_project_id} has unexpected title {zone_project_before.get('title')!r}")

        projects = client.projects()
        room_v3 = create_or_get_project(
            client,
            projects,
            title="L1_Room_v3",
            description=(
                "Room v3 净空间与 Portal 标注。首轮仅迁移 Room v2 Task 13；"
                "房间边界和 Open passage 必须复核，Door/Sliding door 使用 Rectangle 重画。"
            ),
            label_config=room_config,
            apply=args.apply,
        )
        zone_v3 = create_or_get_project(
            client,
            projects,
            title="L2_FunctionZone_v3",
            description=(
                "FunctionZone v3。仅在对应 Room v3 annotation 审核通过后创建任务；"
                "当前项目保留为空以执行该门禁。"
            ),
            label_config=zone_config,
            apply=args.apply,
        )

        imported_task_id = None
        if args.apply:
            if not room_v3 or not zone_v3:
                raise ApiError("v3 project creation did not return project objects")
            room_v3_url = f"{args.url.rstrip('/')}/projects/{room_v3['id']}/data"
            zone_v3_url = f"{args.url.rstrip('/')}/projects/{zone_v3['id']}/data"
            room_patch = {
                "title": "L1_Room_v2_Legacy",
                "description": append_frozen_notice(
                    room_project_before.get("description"), "L1_Room_v3", room_v3_url
                ),
            }
            zone_patch = {
                "title": "L2_FunctionZone_v2_Legacy",
                "description": append_frozen_notice(
                    zone_project_before.get("description"), "L2_FunctionZone_v3", zone_v3_url
                ),
            }
            client.request("PATCH", f"/api/projects/{args.room_project_id}/", room_patch)
            client.request("PATCH", f"/api/projects/{args.zone_project_id}/", zone_patch)

            room_v3_full = client.project(int(room_v3["id"]))
            if int(room_v3_full.get("task_number") or 0) == 0:
                payload = [
                    {
                        **bundle["task"],
                        "annotations": [{"result": bundle["annotation_result"]}],
                        "predictions": [bundle["prediction"]],
                    }
                ]
                response = client.request(
                    "POST",
                    f"/api/projects/{room_v3['id']}/import?commit_to_project=true&return_task_ids=true",
                    payload,
                )
                task_ids = response.get("task_ids") if isinstance(response, dict) else None
                if not isinstance(task_ids, list) or len(task_ids) != 1:
                    raise ApiError(f"Room v3 import did not return exactly one task id: {response!r}")
                imported_task_id = int(task_ids[0])
            elif int(room_v3_full.get("task_number") or 0) == 1:
                # Idempotent rerun: do not create or mutate another task.
                imported_task_id = None
            else:
                raise ApiError("L1_Room_v3 already contains more than the one permitted pilot task")

        room_project_after = client.project(args.room_project_id)
        zone_project_after = client.project(args.zone_project_id)
        room_task_after = client.task(args.room_task_id)
        zone_task_after = client.task(args.zone_task_id)
        after_hashes = {
            "room_task_annotation_sha256": annotation_hash(room_task_after),
            "zone_task_annotation_sha256": annotation_hash(zone_task_after),
        }
        if before_hashes != after_hashes:
            raise ApiError("legacy annotation hashes changed during setup")
        audit = {
            "schema_version": 3,
            "timestamp_utc": datetime.now(timezone.utc).isoformat(),
            "applied": args.apply,
            "base_url": args.url,
            "legacy_projects": {
                "room": {"before": room_project_before, "after": room_project_after},
                "zone": {"before": zone_project_before, "after": zone_project_after},
            },
            "annotation_hashes_before": before_hashes,
            "annotation_hashes_after": after_hashes,
            "v3_projects": {
                "room": room_v3,
                "zone": zone_v3,
                "imported_room_task_id": imported_task_id,
            },
            "gate": "FunctionZone v3 project has no task until Room v3 approval.",
        }
        write_json(args.backup_dir / "setup-audit.json", audit)
        write_json(args.backup_dir / "project-5-after.json", room_project_after)
        write_json(args.backup_dir / "project-3-after.json", zone_project_after)
    except (OSError, RoomV3Error) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    mode = "applied" if args.apply else "dry-run audited"
    print(f"{mode}; legacy annotation hashes unchanged; audit: {args.backup_dir / 'setup-audit.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
