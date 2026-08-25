#!/usr/bin/env python3
"""Audit a Room v3 pilot migration from read-only Label Studio SQLite snapshots."""

from __future__ import annotations

import argparse
import hashlib
import json
import sqlite3
from pathlib import Path
from typing import Any


def _json_value(value: str | None, fallback: Any) -> Any:
    if not value:
        return fallback
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return fallback


def _annotation_payload(connection: sqlite3.Connection, task_id: int) -> list[dict[str, Any]]:
    rows = connection.execute(
        """
        SELECT id, result, was_cancelled, ground_truth
        FROM task_completion
        WHERE task_id = ?
        ORDER BY id
        """,
        (task_id,),
    ).fetchall()
    payload = []
    for row in rows:
        results = _json_value(row["result"], [])
        if not isinstance(results, list):
            results = []
        payload.append(
            {
                "id": row["id"],
                "was_cancelled": bool(row["was_cancelled"]),
                "ground_truth": bool(row["ground_truth"]),
                "result": sorted(
                    results,
                    key=lambda result: (str(result.get("id")), str(result.get("from_name"))),
                ),
            }
        )
    return payload


def annotation_hash(connection: sqlite3.Connection, task_id: int) -> str:
    canonical = json.dumps(
        _annotation_payload(connection, task_id),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def _sha256_text(value: str | None) -> str:
    return hashlib.sha256((value or "").encode("utf-8")).hexdigest()


def _count_results(connection: sqlite3.Connection, table: str, task_id: int) -> tuple[int, int, dict[str, int]]:
    rows = connection.execute(f"SELECT result FROM {table} WHERE task_id = ?", (task_id,)).fetchall()
    result_count = 0
    control_counts: dict[str, int] = {}
    for row in rows:
        results = _json_value(row["result"], [])
        if not isinstance(results, list):
            continue
        result_count += len(results)
        for result in results:
            control = str(result.get("from_name") or "<missing>")
            control_counts[control] = control_counts.get(control, 0) + 1
    return len(rows), result_count, dict(sorted(control_counts.items()))


def task_summary(connection: sqlite3.Connection, task_id: int) -> dict[str, Any]:
    row = connection.execute(
        "SELECT id, project_id, data, total_annotations, total_predictions FROM task WHERE id = ?",
        (task_id,),
    ).fetchone()
    if row is None:
        return {"id": task_id, "missing": True}
    annotations, annotation_results, annotation_controls = _count_results(
        connection, "task_completion", task_id
    )
    predictions, prediction_results, prediction_controls = _count_results(connection, "prediction", task_id)
    return {
        "id": row["id"],
        "project_id": row["project_id"],
        "data": _json_value(row["data"], {}),
        "stored_total_annotations": row["total_annotations"],
        "stored_total_predictions": row["total_predictions"],
        "annotations": annotations,
        "annotation_results": annotation_results,
        "annotation_control_counts": annotation_controls,
        "predictions": predictions,
        "prediction_results": prediction_results,
        "prediction_control_counts": prediction_controls,
        "annotation_sha256": annotation_hash(connection, task_id),
    }


def project_summary(connection: sqlite3.Connection, project_id: int) -> dict[str, Any]:
    row = connection.execute(
        "SELECT id, title, description, label_config FROM project WHERE id = ?",
        (project_id,),
    ).fetchone()
    if row is None:
        return {"id": project_id, "missing": True}
    task_count = connection.execute(
        "SELECT COUNT(*) FROM task WHERE project_id = ?", (project_id,)
    ).fetchone()[0]
    annotation_count = connection.execute(
        "SELECT COUNT(*) FROM task_completion WHERE project_id = ?", (project_id,)
    ).fetchone()[0]
    prediction_count = connection.execute(
        "SELECT COUNT(*) FROM prediction WHERE project_id = ?", (project_id,)
    ).fetchone()[0]
    return {
        "id": row["id"],
        "title": row["title"],
        "description": row["description"],
        "label_config_sha256": _sha256_text(row["label_config"]),
        "tasks": task_count,
        "annotations": annotation_count,
        "predictions": prediction_count,
    }


def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"file:{path.resolve().as_posix()}?mode=ro", uri=True)
    connection.row_factory = sqlite3.Row
    return connection


def build_report(before_path: Path, after_path: Path) -> dict[str, Any]:
    with connect(before_path) as before, connect(after_path) as after:
        legacy_project_checks = {}
        for project_id in (3, 5):
            before_project = project_summary(before, project_id)
            after_project = project_summary(after, project_id)
            legacy_project_checks[str(project_id)] = {
                "before": before_project,
                "after": after_project,
                "label_config_hash_unchanged": (
                    before_project.get("label_config_sha256")
                    == after_project.get("label_config_sha256")
                ),
                "task_count_unchanged": before_project.get("tasks") == after_project.get("tasks"),
                "annotation_count_unchanged": (
                    before_project.get("annotations") == after_project.get("annotations")
                ),
                "prediction_count_unchanged": (
                    before_project.get("predictions") == after_project.get("predictions")
                ),
            }

        legacy_checks = {}
        for task_id in (7, 13):
            before_summary = task_summary(before, task_id)
            after_summary = task_summary(after, task_id)
            legacy_checks[str(task_id)] = {
                "before": before_summary,
                "after": after_summary,
                "annotation_hash_unchanged": (
                    before_summary.get("annotation_sha256") == after_summary.get("annotation_sha256")
                ),
                "annotation_count_unchanged": (
                    before_summary.get("annotations") == after_summary.get("annotations")
                    and before_summary.get("annotation_results")
                    == after_summary.get("annotation_results")
                ),
            }

        return {
            "schema_version": 1,
            "before_database": str(before_path.resolve()),
            "after_database": str(after_path.resolve()),
            "legacy_project_checks": legacy_project_checks,
            "legacy_annotation_checks": legacy_checks,
            "projects_after": {
                str(project_id): project_summary(after, project_id)
                for project_id in (3, 5, 9, 10)
            },
            "room_v3_task": task_summary(after, 19),
        }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before-db", required=True, type=Path)
    parser.add_argument("--after-db", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    report = build_report(args.before_db, args.after_db)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(json.dumps(report, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()
