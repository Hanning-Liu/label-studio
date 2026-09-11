"""Use the same synthetic cases as the L4 reference display resolver."""
import json
from pathlib import Path
from test_zone_annotation_to_nested_graphml import MODULE


def test_shared_display_and_exporter_boundary_cases():
    fixture = json.loads((Path(__file__).parents[2] / "examples/l4-hierarchy/connectivity-cases.json").read_text())
    width, height = fixture["width"], fixture["height"]
    pixel = lambda points: [(x * width / 100, y * height / 100) for x, y in points]
    epsilon = max(2, round(0.001 * min(width, height)))
    for case in fixture["cases"]:
        actual = [zone["id"] for zone in fixture["zones"]
                  if MODULE.boundary_support_ratio(pixel(case["vertices"]), pixel(zone["points"]), epsilon) >= 0.95]
        assert actual == case["expected"], case["name"]
