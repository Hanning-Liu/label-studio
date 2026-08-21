#!/usr/bin/env python3
"""Import grouped GraphML into Cytoscape and create collapsible Groups.

The tool uses only Python's standard library and Cytoscape's built-in CyREST
API. It never clears the current session. Existing networks or session files
are replaced only when the corresponding explicit flag is supplied.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_VISUAL_STYLE = (
    Path(__file__).resolve().parent
    / "cytoscape_styles"
    / "floorplan_multilevel_groups_v1.json"
)

COMPOUND_PREFERENCE_MESSAGE = (
    "Cytoscape Group Preferences are not using Compound Node. Set "
    "Edit -> Preferences -> Group Preferences -> Visualization for group "
    "to 'Compound Node', keep Double-Click action as 'Expand/Contract', "
    "uncheck 'Show collapsed node as a Nested Network', then rerun the command."
)


class CytoscapeError(RuntimeError):
    """Raised when CyREST cannot complete or verify the requested workflow."""


class CyRestClient:
    def __init__(self, base_url: str = "http://127.0.0.1:1234/v1", timeout: float = 30.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def request(
        self,
        method: str,
        path: str,
        body: Any | None = None,
        expect_json: bool = True,
        accept: str = "application/json",
    ) -> Any:
        url = f"{self.base_url}/{path.lstrip('/')}"
        data = None
        headers = {"Accept": accept}
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                payload = response.read()
        except urllib.error.HTTPError as exc:
            details = exc.read().decode("utf-8", errors="replace")
            raise CytoscapeError(
                f"CyREST {method} {url} failed with HTTP {exc.code}: {details}"
            ) from exc
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise CytoscapeError(f"cannot reach Cytoscape CyREST at {url}: {exc}") from exc
        if not expect_json or not payload:
            return payload.decode("utf-8", errors="replace")
        try:
            return json.loads(payload.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise CytoscapeError(f"CyREST returned non-JSON data for {method} {url}") from exc

    def command(self, namespace: str, command: str, body: dict[str, Any]) -> Any:
        encoded_namespace = urllib.parse.quote(namespace, safe="")
        encoded_command = urllib.parse.quote(command, safe="")
        response = self.request(
            "POST", f"commands/{encoded_namespace}/{encoded_command}", body=body
        )
        if isinstance(response, dict) and response.get("errors"):
            raise CytoscapeError(
                f"Cytoscape command {namespace} {command} failed: {response['errors']}"
            )
        return response

    def version(self) -> dict[str, Any]:
        response = self.request("GET", "version")
        if not isinstance(response, dict):
            raise CytoscapeError("Cytoscape version response is not an object")
        return response

    def command_namespace(self, namespace: str) -> str:
        response = self.request(
            "GET",
            f"commands/{urllib.parse.quote(namespace, safe='')}",
            expect_json=False,
            accept="text/plain",
        )
        return str(response)

    def network_suids(self) -> set[int]:
        response = self.request("GET", "networks")
        if not isinstance(response, list):
            raise CytoscapeError("CyREST networks response is not a list")
        return {int(value) for value in response}

    def network_payload(self, network_suid: int) -> dict[str, Any]:
        response = self.request("GET", f"networks/{network_suid}")
        if not isinstance(response, dict):
            raise CytoscapeError(f"network {network_suid} response is not an object")
        return response

    def network_name(self, network_suid: int) -> str:
        payload = self.network_payload(network_suid)
        data = payload.get("data")
        if isinstance(data, dict):
            return str(data.get("name") or data.get("shared_name") or network_suid)
        return str(network_suid)

    def delete_network(self, network_suid: int) -> None:
        self.request("DELETE", f"networks/{network_suid}", expect_json=False)

    def rename_network(self, network_suid: int, name: str) -> None:
        self.command(
            "network",
            "rename",
            {"network": f"SUID:{network_suid}", "name": name},
        )

    def style_names(self) -> list[str]:
        response = self.request("GET", "styles")
        if not isinstance(response, list):
            raise CytoscapeError("CyREST styles response is not a list")
        return [str(value) for value in response]

    def visual_style(self, name: str) -> dict[str, Any]:
        response = self.request("GET", f"styles/{urllib.parse.quote(name, safe='')}")
        if not isinstance(response, dict):
            raise CytoscapeError(f"visual style {name!r} response is not an object")
        return response

    def create_visual_style(self, style: dict[str, Any]) -> str:
        response = self.request("POST", "styles", body=style)
        if not isinstance(response, dict) or not response.get("title"):
            raise CytoscapeError(f"visual style create returned an invalid response: {response}")
        return str(response["title"])

    def delete_visual_style(self, name: str) -> None:
        self.request(
            "DELETE",
            f"styles/{urllib.parse.quote(name, safe='')}",
            expect_json=False,
        )

    def update_visual_style_defaults(
        self, name: str, defaults: list[dict[str, Any]]
    ) -> None:
        # Cytoscape 3.10.4 accepts the defaults list directly. In particular,
        # COMPOUND_NODE_PADDING is silently ignored by POST /styles but is
        # persisted by this endpoint.
        self.request(
            "PUT",
            f"styles/{urllib.parse.quote(name, safe='')}/defaults",
            body=defaults,
            expect_json=False,
        )

    def apply_visual_style(self, name: str, network_suid: int) -> None:
        self.request(
            "GET",
            f"apply/styles/{urllib.parse.quote(name, safe='')}/{network_suid}",
        )

    def network_view_suids(self, network_suid: int) -> list[int]:
        response = self.request("GET", f"networks/{network_suid}/views")
        if not isinstance(response, list):
            raise CytoscapeError(f"network {network_suid} views response is not a list")
        return [int(value) for value in response]

    def node_visual_properties(
        self, network_suid: int, view_suid: int, node_suid: int
    ) -> dict[str, Any]:
        response = self.request(
            "GET", f"networks/{network_suid}/views/{view_suid}/nodes/{node_suid}"
        )
        if not isinstance(response, list):
            raise CytoscapeError(
                f"visual properties for node {node_suid} are not a list"
            )
        return {
            str(item["visualProperty"]): item.get("value")
            for item in response
            if isinstance(item, dict) and "visualProperty" in item
        }

    def set_node_visual_property_bypass(
        self,
        network_suid: int,
        view_suid: int,
        node_suid: int,
        visual_property: str,
        value: Any,
    ) -> None:
        encoded_property = urllib.parse.quote(visual_property, safe="")
        self.request(
            "PUT",
            f"networks/{network_suid}/views/{view_suid}/nodes/{node_suid}/"
            f"{encoded_property}/bypass",
            body={"visualProperty": visual_property, "value": value},
            expect_json=False,
        )

    def import_graphml(self, graphml_path: Path, before: set[int]) -> int:
        response = self.command("network", "load file", {"file": str(graphml_path.resolve())})
        candidates = _find_integer_lists(response, "networks")
        response_ids = {value for values in candidates for value in values}
        for _ in range(40):
            after = self.network_suids()
            new_ids = after - before
            if response_ids:
                new_ids &= response_ids
            if len(new_ids) == 1:
                return next(iter(new_ids))
            if len(new_ids) > 1:
                raise CytoscapeError(
                    "GraphML import created more than one network: "
                    + ", ".join(str(value) for value in sorted(new_ids))
                )
            time.sleep(0.25)
        raise CytoscapeError("GraphML import did not produce a new Cytoscape network")

    def create_group(
        self, network_suid: int, group_name: str, member_canonical_ids: list[str]
    ) -> int:
        node_list = ",".join(f"name:{value}" for value in member_canonical_ids)
        response = self.command(
            "group",
            "create",
            {
                "groupName": group_name,
                "network": f"SUID:{network_suid}",
                "nodeList": node_list,
            },
        )
        group_suids = _find_scalar_in_response(response, "group")
        if len(group_suids) != 1:
            raise CytoscapeError(
                f"group create for {group_name!r} did not return exactly one group SUID: {response}"
            )
        return group_suids[0]

    def collapse_group(self, network_suid: int, group_suid: int) -> None:
        self.command(
            "group",
            "collapse",
            {"network": f"SUID:{network_suid}", "groupList": f"SUID:{group_suid}"},
        )

    def expand_group(self, network_suid: int, group_suid: int) -> None:
        self.command(
            "group",
            "expand",
            {"network": f"SUID:{network_suid}", "groupList": f"SUID:{group_suid}"},
        )

    def list_groups(self, network_suid: int) -> Any:
        return self.command("group", "list", {"network": f"SUID:{network_suid}"})

    def group_info(self, network_suid: int, group_suid: int) -> Any:
        return self.command(
            "group",
            "get",
            {"network": f"SUID:{network_suid}", "node": f"SUID:{group_suid}"},
        )

    def node_columns(self, network_suid: int) -> dict[str, str]:
        response = self.request("GET", f"networks/{network_suid}/tables/defaultnode/columns")
        if not isinstance(response, list):
            raise CytoscapeError("default node table columns response is not a list")
        return {
            str(column["name"]): str(column["type"])
            for column in response
            if isinstance(column, dict) and "name" in column and "type" in column
        }

    def create_node_column(self, network_suid: int, name: str, value: Any) -> None:
        if isinstance(value, bool):
            column_type = "Boolean"
        elif isinstance(value, int):
            column_type = "Integer"
        elif isinstance(value, float):
            column_type = "Double"
        else:
            column_type = "String"
        self.request(
            "POST",
            f"networks/{network_suid}/tables/defaultnode/columns",
            body={"name": name, "type": column_type},
            expect_json=False,
        )

    def set_group_attributes(
        self, network_suid: int, group_suid: int, attributes: dict[str, Any]
    ) -> None:
        columns = self.node_columns(network_suid)
        for name, value in attributes.items():
            if name == "SUID" or value is None or name in columns:
                continue
            self.create_node_column(network_suid, name, value)
            columns[name] = type(value).__name__
        row = {"SUID": group_suid, **attributes}
        self.request(
            "PUT",
            f"networks/{network_suid}/tables/defaultnode",
            body={"key": "SUID", "dataKey": "SUID", "data": [row]},
            expect_json=False,
        )

    def node_row(self, network_suid: int, node_suid: int) -> dict[str, Any]:
        response = self.request(
            "GET", f"networks/{network_suid}/tables/defaultnode/rows/{node_suid}"
        )
        if not isinstance(response, dict):
            raise CytoscapeError(f"node row {node_suid} response is not an object")
        return response

    def save_session(self, path: Path) -> Any:
        return self.command("session", "save as", {"file": str(path.resolve())})


def _find_integer_lists(payload: Any, key: str) -> list[list[int]]:
    found: list[list[int]] = []
    if isinstance(payload, dict):
        for current_key, value in payload.items():
            if current_key == key and isinstance(value, list):
                integers = []
                for item in value:
                    try:
                        integers.append(int(item))
                    except (TypeError, ValueError):
                        continue
                found.append(integers)
            found.extend(_find_integer_lists(value, key))
    elif isinstance(payload, list):
        for value in payload:
            found.extend(_find_integer_lists(value, key))
    return found


def _find_scalar_in_response(payload: Any, key: str) -> list[int]:
    found: list[int] = []
    if isinstance(payload, dict):
        for current_key, value in payload.items():
            if current_key == key and not isinstance(value, (dict, list)):
                try:
                    found.append(int(value))
                except (TypeError, ValueError):
                    pass
            found.extend(_find_scalar_in_response(value, key))
    elif isinstance(payload, list):
        for value in payload:
            found.extend(_find_scalar_in_response(value, key))
    return found


def _all_integers(payload: Any) -> set[int]:
    values: set[int] = set()
    if isinstance(payload, dict):
        for value in payload.values():
            values.update(_all_integers(value))
    elif isinstance(payload, list):
        for value in payload:
            values.update(_all_integers(value))
    elif isinstance(payload, int):
        values.add(payload)
    elif isinstance(payload, str):
        for token in payload.replace("[", " ").replace("]", " ").replace(",", " ").split():
            token = token.removeprefix("SUID:")
            try:
                values.add(int(token))
            except ValueError:
                pass
    return values


def _network_elements(payload: dict[str, Any]) -> tuple[list[Any], list[Any]]:
    elements = payload.get("elements")
    if not isinstance(elements, dict):
        data = payload.get("data")
        elements = data.get("elements") if isinstance(data, dict) else None
    if not isinstance(elements, dict):
        raise CytoscapeError("imported network response has no elements object")
    nodes = elements.get("nodes", [])
    edges = elements.get("edges", [])
    if not isinstance(nodes, list) or not isinstance(edges, list):
        raise CytoscapeError("imported network nodes/edges are not lists")
    return nodes, edges


def _element_data_by_suid(elements: list[Any], kind: str) -> dict[int, dict[str, Any]]:
    indexed: dict[int, dict[str, Any]] = {}
    for element in elements:
        data = element.get("data") if isinstance(element, dict) else None
        if not isinstance(data, dict):
            raise CytoscapeError(f"imported network contains a {kind} without data")
        raw_suid = data.get("SUID", data.get("id"))
        try:
            suid = int(raw_suid)
        except (TypeError, ValueError) as exc:
            raise CytoscapeError(f"imported {kind} has no numeric SUID: {data}") from exc
        indexed[suid] = data
    return indexed


def _group_data(payload: Any, group_name: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise CytoscapeError(f"group get for {group_name!r} returned a non-object")
    data = payload.get("data", payload)
    if not isinstance(data, dict):
        raise CytoscapeError(f"group get for {group_name!r} has no data object")
    return data


def _group_suids(data: dict[str, Any], key: str, group_name: str) -> list[int]:
    values = data.get(key)
    if not isinstance(values, list):
        raise CytoscapeError(f"group {group_name!r} response has no {key} list")
    try:
        return [int(value) for value in values]
    except (TypeError, ValueError) as exc:
        raise CytoscapeError(
            f"group {group_name!r} response contains a non-numeric {key} SUID"
        ) from exc


def load_manifest(path: Path) -> dict[str, Any]:
    try:
        manifest = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CytoscapeError(f"cannot read group manifest {path}: {exc}") from exc
    if not isinstance(manifest, dict) or manifest.get("schema_version") != 1:
        raise CytoscapeError("group manifest must be a schema_version 1 object")
    groups = manifest.get("groups")
    if not isinstance(groups, list) or not groups:
        raise CytoscapeError("group manifest does not contain any groups")
    for group in groups:
        if not isinstance(group, dict):
            raise CytoscapeError("group manifest contains a non-object group")
        members = group.get("member_canonical_ids")
        if not isinstance(members, list) or len(members) < 2:
            raise CytoscapeError(
                f"group {group.get('group_name')} must contain at least two members"
            )
    return manifest


def load_visual_style(path: Path) -> dict[str, Any]:
    try:
        style = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CytoscapeError(f"cannot read visual style {path}: {exc}") from exc
    if not isinstance(style, dict) or not str(style.get("title") or "").strip():
        raise CytoscapeError("visual style must be an object with a non-empty title")
    for key in ("defaults", "mappings"):
        if not isinstance(style.get(key), list):
            raise CytoscapeError(f"visual style {key!r} must be a list")
    return style


def _canonical_mapping(mapping: dict[str, Any]) -> dict[str, Any]:
    normalized = dict(mapping)
    if isinstance(normalized.get("map"), list):
        normalized["map"] = sorted(
            (dict(value) for value in normalized["map"]),
            key=lambda value: str(value.get("key")),
        )
    return normalized


def _style_matches(expected: dict[str, Any], actual: dict[str, Any]) -> bool:
    actual_defaults = {
        str(value.get("visualProperty")): value.get("value")
        for value in actual.get("defaults", [])
        if isinstance(value, dict) and value.get("visualProperty")
    }
    for value in expected.get("defaults", []):
        visual_property = str(value.get("visualProperty"))
        if actual_defaults.get(visual_property) != value.get("value"):
            return False

    expected_mappings = {
        str(value.get("visualProperty")): _canonical_mapping(value)
        for value in expected.get("mappings", [])
        if isinstance(value, dict) and value.get("visualProperty")
    }
    actual_mappings = {
        str(value.get("visualProperty")): _canonical_mapping(value)
        for value in actual.get("mappings", [])
        if isinstance(value, dict) and value.get("visualProperty")
    }
    return actual_mappings == expected_mappings


def ensure_visual_style(
    client: CyRestClient,
    style: dict[str, Any],
    *,
    replace_style: bool = False,
) -> dict[str, Any]:
    title = str(style["title"])
    matches = [name for name in client.style_names() if name == title]
    if len(matches) > 1:
        raise CytoscapeError(
            f"multiple visual styles named {title!r} exist; remove duplicates before rerunning"
        )
    if matches:
        current = client.visual_style(title)
        if _style_matches(style, current):
            return {"title": title, "action": "reused"}
        if not replace_style:
            raise CytoscapeError(
                f"visual style {title!r} exists with different contents; pass --replace-style"
            )
        client.delete_visual_style(title)
        action = "replaced"
    else:
        action = "created"
    created_title = client.create_visual_style(style)
    if created_title != title:
        raise CytoscapeError(
            f"Cytoscape created visual style {created_title!r}, expected {title!r}"
        )
    client.update_visual_style_defaults(title, style["defaults"])
    created = client.visual_style(title)
    if not _style_matches(style, created):
        raise CytoscapeError(f"visual style {title!r} failed round-trip verification")
    return {"title": title, "action": action}


def _assert_compound_group_node(
    client: CyRestClient, network_suid: int, group_suid: int, group_name: str
) -> None:
    payload = client.network_payload(network_suid)
    nodes, _ = _network_elements(payload)
    node_data = _element_data_by_suid(nodes, "node")
    if group_suid not in node_data:
        raise CytoscapeError(f"{COMPOUND_PREFERENCE_MESSAGE} Group: {group_name!r}.")


def _verify_group_visuals(
    client: CyRestClient,
    network_suid: int,
    group_suid: int,
    expected_label: str,
) -> dict[str, Any]:
    views = client.network_view_suids(network_suid)
    if len(views) != 1:
        raise CytoscapeError(
            f"expected exactly one network view for visual verification, found {len(views)}"
        )
    properties = client.node_visual_properties(network_suid, views[0], group_suid)
    expected = {
        "COMPOUND_NODE_PADDING": 24.0,
        "COMPOUND_NODE_SHAPE": "ROUND_RECTANGLE",
        "NODE_FILL_COLOR": "#8B5CF6",
        "NODE_TRANSPARENCY": 31,
        "NODE_BORDER_PAINT": "#6D28D9",
        "NODE_BORDER_WIDTH": 3.0,
        "NODE_BORDER_STROKE": "LONG_DASH",
        "NODE_BORDER_TRANSPARENCY": 255,
        "NODE_LABEL": expected_label,
        "NODE_LABEL_TRANSPARENCY": 255,
        "NODE_SHAPE": "ROUND_RECTANGLE",
    }
    mismatches = {
        key: {"expected": value, "actual": properties.get(key)}
        for key, value in expected.items()
        if properties.get(key) != value
    }
    if mismatches:
        raise CytoscapeError(
            "group visual style verification failed: "
            + json.dumps(mismatches, ensure_ascii=False, sort_keys=True)
        )
    return {key: properties[key] for key in expected}


def apply_groups(
    client: CyRestClient,
    graphml_path: Path,
    manifest: dict[str, Any],
    session_output: Path,
    *,
    replace_existing: bool = False,
    overwrite_session: bool = False,
    visual_style: dict[str, Any] | None = None,
    replace_style: bool = False,
) -> dict[str, Any]:
    if not graphml_path.is_file():
        raise CytoscapeError(f"GraphML file does not exist: {graphml_path}")
    if session_output.exists() and not overwrite_session:
        raise CytoscapeError(
            f"session output already exists; pass --overwrite-session: {session_output}"
        )

    version = client.version()
    cytoscape_version = str(version.get("cytoscapeVersion") or "")
    if cytoscape_version != "3.10.4":
        raise CytoscapeError(
            f"this workflow is verified for Cytoscape 3.10.4, found {cytoscape_version or 'unknown'}"
        )
    group_commands = client.command_namespace("group")
    for required in ("create", "collapse", "expand", "get", "list"):
        if required not in group_commands:
            raise CytoscapeError(f"Cytoscape group command {required!r} is unavailable")

    network_name = str(manifest.get("network_name") or "")
    before = client.network_suids()
    collisions = [suid for suid in before if client.network_name(suid) == network_name]
    if collisions and not replace_existing:
        raise CytoscapeError(
            f"network {network_name!r} already exists; pass --replace-existing to replace it"
        )
    network_suid = client.import_graphml(graphml_path, before)
    try:
        payload = client.network_payload(network_suid)
        nodes, edges = _network_elements(payload)
        node_data_by_suid = _element_data_by_suid(nodes, "node")
        edge_data_by_suid = _element_data_by_suid(edges, "edge")
        # Compound Node view providers can expose visual-only container nodes in
        # the network payload. Stable GraphML data nodes always carry a
        # canonical_id, so count those rather than the renderer's containers.
        data_nodes = [
            node
            for node in nodes
            if isinstance(node, dict)
            and isinstance(node.get("data"), dict)
            and node["data"].get("canonical_id")
        ]
        expected_counts = manifest.get("expected_counts", {})
        expected_nodes = expected_counts.get("total_data_nodes")
        expected_edges = expected_counts.get("total_edges")
        if expected_nodes is not None and len(data_nodes) != int(expected_nodes):
            raise CytoscapeError(
                "imported data node count mismatch: expected "
                f"{expected_nodes}, found {len(data_nodes)}"
            )
        if expected_edges is not None and len(edges) != int(expected_edges):
            raise CytoscapeError(
                f"imported edge count mismatch: expected {expected_edges}, found {len(edges)}"
            )
        visual_only_nodes = len(nodes) - len(data_nodes)
        imported_groups = set(_all_integers(client.list_groups(network_suid)))
        if visual_only_nodes or imported_groups:
            raise CytoscapeError(
                "the imported network collection contains stale or implicit Cytoscape "
                f"Groups before setup (visual-only nodes={visual_only_nodes}, "
                f"groups={sorted(imported_groups)}). Ungroup those containers or start "
                "from a clean session, then rerun; the script will not guess which "
                "containers are safe to remove."
            )
    except Exception:
        try:
            if network_suid in client.network_suids():
                client.delete_network(network_suid)
        except CytoscapeError:
            pass
        raise

    created_groups: list[dict[str, Any]] = []
    try:
        for group in manifest["groups"]:
            group_name = str(group["group_name"])
            members = [str(value) for value in group["member_canonical_ids"]]
            group_suid = client.create_group(network_suid, group_name, members)
            _assert_compound_group_node(client, network_suid, group_suid, group_name)
            attributes = dict(group.get("parent_node_attributes", {}))
            # Cytoscape owns the immutable ``name`` of a Group node. Including it
            # in a table update causes Cytoscape 3.10.4 to ignore the whole row.
            attributes.pop("name", None)
            attributes["canonical_id"] = str(group["group_canonical_id"])
            attributes["group_base_display_name"] = group_name
            attributes["display_name"] = f"{group_name} ⊞ {len(members)} zones"
            attributes["node_kind"] = "room_group"
            attributes["hierarchy_level"] = "room"
            attributes["has_zone_group"] = True
            attributes["is_expandable_group"] = True
            client.set_group_attributes(network_suid, group_suid, attributes)
            info = client.group_info(network_suid, group_suid)
            info_data = _group_data(info, group_name)
            if info_data.get("collapsed") is True:
                raise CytoscapeError(f"new group {group_name!r} was unexpectedly collapsed")

            member_suids = _group_suids(info_data, "nodes", group_name)
            internal_edge_suids = _group_suids(info_data, "internalEdges", group_name)
            external_edge_suids = _group_suids(info_data, "externalEdges", group_name)
            try:
                actual_members = {
                    str(node_data_by_suid[suid]["canonical_id"]) for suid in member_suids
                }
                actual_internal_ids = {
                    str(edge_data_by_suid[suid]["name"])
                    for suid in internal_edge_suids
                    if edge_data_by_suid[suid].get("edge_kind") == "direct_boundary"
                }
                actual_external_ids = {
                    str(edge_data_by_suid[suid]["opening_result_id"])
                    for suid in external_edge_suids
                    if edge_data_by_suid[suid].get("edge_kind")
                    == "zone_external_opening"
                }
            except KeyError as exc:
                raise CytoscapeError(
                    f"group {group_name!r} refers to an unknown or incomplete network element: {exc}"
                ) from exc

            expected_members = set(members)
            expected_internal_ids = {
                str(value) for value in group.get("expected_internal_edge_ids", [])
            }
            expected_external_ids = {
                str(value) for value in group.get("expected_external_opening_ids", [])
            }
            if actual_members != expected_members:
                raise CytoscapeError(
                    f"group {group_name!r} member mismatch: expected "
                    f"{sorted(expected_members)}, found {sorted(actual_members)}"
                )
            if len(internal_edge_suids) != len(expected_internal_ids) or (
                actual_internal_ids != expected_internal_ids
            ):
                raise CytoscapeError(
                    f"group {group_name!r} internal edge mismatch: expected "
                    f"{sorted(expected_internal_ids)}, found {sorted(actual_internal_ids)}"
                )
            if len(external_edge_suids) != len(expected_external_ids) or (
                actual_external_ids != expected_external_ids
            ):
                raise CytoscapeError(
                    f"group {group_name!r} external edge mismatch: expected "
                    f"{sorted(expected_external_ids)}, found {sorted(actual_external_ids)}"
                )
            row = client.node_row(network_suid, group_suid)
            if str(row.get("canonical_id")) != str(group["group_canonical_id"]):
                raise CytoscapeError(
                    f"group node attributes were not persisted for {group_name}"
                )
            created_groups.append(
                {
                    "group_name": group_name,
                    "group_suid": group_suid,
                    "member_count": len(members),
                    "display_label": attributes["display_name"],
                    "expected_internal_edge_count": len(
                        group.get("expected_internal_edge_ids", [])
                    ),
                    "expected_external_edge_count": len(
                        group.get("expected_external_opening_ids", [])
                    ),
                    "verified_member_canonical_ids": sorted(actual_members),
                    "verified_internal_edge_ids": sorted(actual_internal_ids),
                    "verified_external_opening_ids": sorted(actual_external_ids),
                    "group_info_expanded": info,
                }
            )

        style_report = None
        if visual_style is not None:
            style_report = ensure_visual_style(
                client, visual_style, replace_style=replace_style
            )
            client.apply_visual_style(style_report["title"], network_suid)
            views = client.network_view_suids(network_suid)
            if len(views) != 1:
                raise CytoscapeError(
                    "expected exactly one network view for compound-node setup, "
                    f"found {len(views)}"
                )
            for group in created_groups:
                client.set_node_visual_property_bypass(
                    network_suid,
                    views[0],
                    group["group_suid"],
                    "COMPOUND_NODE_SHAPE",
                    "ROUND_RECTANGLE",
                )
                # The Compound renderer applies its own 50/255 opacity floor to
                # group containers. A node bypass preserves the intended 12%
                # fill without changing the fully opaque label and border.
                client.set_node_visual_property_bypass(
                    network_suid,
                    views[0],
                    group["group_suid"],
                    "NODE_TRANSPARENCY",
                    31,
                )
                group["verified_visual_properties"] = _verify_group_visuals(
                    client,
                    network_suid,
                    group["group_suid"],
                    group["display_label"],
                )

        for group in created_groups:
            client.collapse_group(network_suid, group["group_suid"])
            info = client.group_info(network_suid, group["group_suid"])
            info_data = _group_data(info, group["group_name"])
            if info_data.get("collapsed") is not True:
                raise CytoscapeError(f"group {group['group_name']!r} was not collapsed")
            group["group_info_collapsed"] = info

        listed = client.list_groups(network_suid)
        listed_suids = set(_all_integers(listed))
        expected_group_suids = {group["group_suid"] for group in created_groups}
        if listed_suids != expected_group_suids:
            raise CytoscapeError(
                "Cytoscape group list mismatch: expected exactly "
                f"{sorted(expected_group_suids)}, found {sorted(listed_suids)}"
            )

        for suid in collisions:
            client.delete_network(suid)
        if client.network_name(network_suid) != network_name:
            client.rename_network(network_suid, network_name)
        if client.network_name(network_suid) != network_name:
            raise CytoscapeError(
                f"could not restore imported network name to {network_name!r}"
            )

        session_output.parent.mkdir(parents=True, exist_ok=True)
        temporary_session = session_output.with_name(
            f".{session_output.stem}.cytoscape-tmp-{time.time_ns()}{session_output.suffix}"
        )
        client.save_session(temporary_session)
        if not temporary_session.exists():
            raise CytoscapeError(
                f"Cytoscape did not create temporary session file: {temporary_session}"
            )
        temporary_session.replace(session_output)
    except Exception:
        try:
            if network_suid in client.network_suids():
                client.delete_network(network_suid)
        except CytoscapeError:
            pass
        raise

    return {
        "schema_version": 1,
        "status": "ok",
        "cytoscape_version": cytoscape_version,
        "cyrest_url": client.base_url,
        "network_name": network_name,
        "network_suid": network_suid,
        "imported_counts": {"nodes": len(data_nodes), "edges": len(edges)},
        "preexisting_visual_container_node_count": visual_only_nodes,
        "groups": created_groups,
        "visual_style": style_report,
        "compound_group_view_verified": True,
        "session_output": str(session_output.resolve()),
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Import multilevel GraphML, create Cytoscape Groups, and save a .cys session."
    )
    parser.add_argument("--graphml", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--session-output", required=True, type=Path)
    parser.add_argument("--cyrest-url", default="http://127.0.0.1:1234/v1")
    parser.add_argument("--replace-existing", action="store_true")
    parser.add_argument("--overwrite-session", action="store_true")
    parser.add_argument("--visual-style", type=Path, default=DEFAULT_VISUAL_STYLE)
    parser.add_argument("--replace-style", action="store_true")
    parser.add_argument("--setup-report", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report_path = args.setup_report or args.session_output.with_suffix(".setup-report.json")
    try:
        manifest = load_manifest(args.manifest)
        visual_style = load_visual_style(args.visual_style)
        report = apply_groups(
            CyRestClient(args.cyrest_url),
            args.graphml,
            manifest,
            args.session_output,
            replace_existing=args.replace_existing,
            overwrite_session=args.overwrite_session,
            visual_style=visual_style,
            replace_style=args.replace_style,
        )
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
    except CytoscapeError as exc:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(
                {"schema_version": 1, "status": "error", "error": str(exc)},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"Cytoscape setup failed: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"Cytoscape setup failed while writing output: {exc}", file=sys.stderr)
        return 2

    print(
        f"created and collapsed {len(report['groups'])} Cytoscape Group(s) in network "
        f"{report['network_name']} ({report['network_suid']})\n"
        f"- session: {args.session_output}\n- setup report: {report_path}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
