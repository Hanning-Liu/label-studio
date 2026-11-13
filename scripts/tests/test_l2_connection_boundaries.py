import pytest

from hanning.backend.reference_sync.results import validate_connection_boundaries


def zone(identifier, points):
    return {"id": identifier, "from_name": "zone_polygon", "type": "polygon", "value": {"points": points}}


def vector(control, start, end):
    return {
        "id": "edge", "from_name": control, "type": "vectorlabels",
        "value": {"vertices": [{"x": x, "y": y} for x, y in (start, end)], "closed": False},
    }


@pytest.mark.parametrize("control", ["connection_vector", "visual_connection_vector"])
def test_requires_full_coverage_on_two_distinct_zone_boundaries(control):
    zones = [
        zone("left", [[0, 0], [50, 0], [50, 25], [50, 50], [50, 100], [0, 100]]),
        zone("right", [[50, 10], [100, 10], [100, 90], [50, 90]]),
    ]
    validate_connection_boundaries(zones + [vector(control, (50, 75), (50, 15))])
    for start, end in [
        ((49, 15), (49, 75)),  # Inside the left zone.
        ((50, 0), (50, 75)),  # Extends past the shared boundary.
        ((50, 15), (60, 75)),  # One end leaves the boundary.
        ((50, 25), (50, 25)),  # No length.
    ]:
        with pytest.raises(ValueError, match="edge"):
            validate_connection_boundaries(zones + [vector(control, start, end)])


def test_endpoints_on_shared_boundary_do_not_allow_crossing_a_gap():
    zones = [
        zone("left", [[0, 0], [50, 0], [50, 100], [0, 100]]),
        zone("right", [[50, 0], [100, 0], [100, 100], [50, 100], [50, 60], [60, 60], [60, 40], [50, 40]]),
    ]
    with pytest.raises(ValueError, match="edge"):
        validate_connection_boundaries(zones + [vector("visual_connection_vector", (50, 20), (50, 80))])


def test_shared_boundary_allows_floating_point_sliver_but_not_overlapping_zones():
    left = zone("left", [[0, 0], [50, 0], [50, 100], [0, 100]])
    line = vector("connection_vector", (50, 20), (50, 80))
    almost = zone("right", [[49.9999999, 10], [100, 10], [100, 90], [49.9999999, 90]])
    validate_connection_boundaries([left, almost, line])
    overlapping = zone("right", [[50, 10], [100, 10], [100, 90], [40, 90], [40, 85], [50, 85]])
    with pytest.raises(ValueError, match="edge"):
        validate_connection_boundaries([left, overlapping, line])
