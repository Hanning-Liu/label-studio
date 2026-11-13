import copy
import unittest

from hanning.backend.reference_sync.results import merge_results, validate_orphan_zone_rebinds


def rectangle(identifier, control, x, width, parent=None):
    result = {
        "id": identifier, "from_name": control,
        "type": "rectangle" if parent else "rectanglelabels",
        "value": {"x": x, "y": 10, "width": width, "height": 10, "rotation": 0},
    }
    if parent:
        result["meta"] = {"partition_context": {"parent_room_id": parent}}
    return result


class ZoneRebindTest(unittest.TestCase):
    def setUp(self):
        self.refs = [rectangle("open", "room_rectangle", 10, 40)]
        self.prior = [
            rectangle("orphan", "zone_rectangle", 10, 10, "deleted"),
            rectangle("peer", "zone_rectangle", 20, 10, "open"),
        ]
        self.prior[0]["meta"]["reference_review"] = {"status": "pending", "reason": "source_missing"}
        self.changed = copy.deepcopy(self.prior)
        self.changed[0]["meta"]["partition_context"]["parent_room_id"] = "open"

    def test_rebind_preserves_geometry_and_stays_pending(self):
        merged = merge_results(self.changed, self.refs, "revision", prior=self.refs + self.prior)
        validate_orphan_zone_rebinds(merged, self.prior)
        zone = next(r for r in merged if r["id"] == "orphan")
        self.assertEqual(zone["value"], self.prior[0]["value"])
        self.assertEqual(zone["meta"]["partition_context"]["parent_room_id"], "open")
        self.assertFalse(zone["meta"]["partition_context"]["requires_geometry_review"])
        self.assertEqual(zone["meta"]["reference_review"]["status"], "pending")

    def test_rejects_overlap_outside_or_redraw(self):
        for x in (5, 15, 45):
            with self.subTest(x=x):
                prior = copy.deepcopy(self.prior)
                changed = copy.deepcopy(self.changed)
                prior[0]["value"]["x"] = x
                changed[0]["value"]["x"] = x
                with self.assertRaises(ValueError):
                    validate_orphan_zone_rebinds(self.refs + changed, prior)
        self.changed[0]["value"]["width"] = 9
        with self.assertRaisesRegex(ValueError, "保留原轮廓"):
            validate_orphan_zone_rebinds(self.refs + self.changed, self.prior)
