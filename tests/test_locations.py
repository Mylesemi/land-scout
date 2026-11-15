import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import enrich_locations as locations


class LocationTests(unittest.TestCase):
    def test_exact_geocode_rejects_same_dong_in_another_city(self):
        response = [{"display_name": "경기도 다른시 당동 957-2",
                     "address": {"house_number": "957-2"}, "lat": "37.3", "lon": "127.0"}]
        with patch.object(locations.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            self.assertIsNone(locations.geocode("경기도 군포시 당동 957-2"))

    def test_spaced_mountain_lot_keeps_its_locality(self):
        response = [{"display_name": "경기도 가평군 설악면 위곡리 산64-2",
                     "address": {"house_number": "산64-2"}, "lat": "37.6", "lon": "127.5"}]
        with patch.object(locations.urllib.request, "urlopen", return_value=io.BytesIO(json.dumps(response).encode())):
            self.assertEqual(locations.geocode("경기도 가평군 설악면 위곡리 산 64-2"), [37.6, 127.5])
