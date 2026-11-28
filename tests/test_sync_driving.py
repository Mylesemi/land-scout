"""Verify that road lookup data cannot make unverified parcels pass the filter."""
import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from sync_driving import parse_table, update_cache


def table(durations, offsets, origin_offset=0):
    return {"code": "Ok", "sources": [{"distance": origin_offset}],
            "durations": [durations], "destinations": [{"distance": value} for value in offsets]}


class DrivingTests(unittest.TestCase):
    def test_only_connected_nearby_roads_yield_estimates(self):
        results = parse_table(table([1800, 1800.01, 500, None], [0, 2, 61, 10]), 4)
        self.assertEqual([entry["seconds"] for entry in results], [1800, 1801, None, None])

    def test_mismatched_response_and_offroad_origin_raise(self):
        for response in (table([10], [0], origin_offset=100), table([10], [])):
            with self.assertRaises(ValueError):
                parse_table(response, 1)

    def test_only_reuses_fresh_cache_for_the_same_point(self):
        now = datetime(2026, 11, 28, tzinfo=timezone.utc)
        points = {"same": [37.2, 127.1], "changed": [37.1, 127.2], "expired": [37.0, 127.0]}
        previous = {
            "same": {"seconds": 99, "point": points["same"], "checked_at": now.isoformat()},
            "changed": {"seconds": 999, "point": points["same"], "checked_at": now.isoformat()},
            "expired": {"seconds": 111, "point": points["expired"], "checked_at": (now - timedelta(days=31)).isoformat()},
        }

        def fetch(requested):
            self.assertEqual(requested, [points["changed"], points["expired"]])
            return table([1000, None], [50, 0])

        results = update_cache(points, previous, now, fetch)
        self.assertEqual([results[key]["seconds"] for key in points], [99, 1000, None])
