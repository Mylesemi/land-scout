"""Prevent wrong-parcel matches, false success and malformed map geometry."""
import contextlib
import io
import json
import sys
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_parcels as parcels
from location_utils import candidate_pnu, parcel_address, valid_pnu

ADDRESS = "경기도 군포시 당동 957-2"
PNU = "4141010100109570002"
GEOMETRY = {"type": "Polygon", "coordinates": [[[126.94,37.34],[126.941,37.34],[126.941,37.341],[126.94,37.34]]]}
FEATURE = {"type": "Feature", "properties": {"pnu": PNU, "addr": ADDRESS}, "geometry": GEOMETRY}


class ParcelTests(unittest.TestCase):
    def test_standardizes_legacy_land_and_mountain_flags(self):
        self.assertEqual(candidate_pnu("4141010100009570002", ADDRESS), PNU)
        self.assertEqual(candidate_pnu("4145011300100470004", "경기도 하남시 감북동 산47-4"), "4145011300200470004")
        self.assertTrue(valid_pnu(PNU))
        self.assertFalse(valid_pnu("4141010100009570002"))

    def test_mismatched_onbid_lot_is_unresolved(self):
        self.assertIsNone(candidate_pnu("4111312800003270001", "경기도 수원시 권선구 고색동 326-7 답"))
        self.assertIsNone(candidate_pnu(None, ADDRESS))

    def test_address_requires_actual_lot_and_preserves_ri(self):
        self.assertIsNone(parcel_address("경기도 군포시 당동"))
        self.assertEqual(parcel_address("경기도 가평군 설악면 위곡리 산 64-2 임야")["locality"], "위곡리")
        self.assertEqual(parcel_address(ADDRESS + " 외 1필지 아파트")["address"], ADDRESS)

    def test_rejects_different_city_with_same_locality(self):
        self.assertFalse(parcels.same_lot("경기도 다른시 당동 957-2", parcel_address(ADDRESS)))

    def test_verifies_pnu_address_and_geometry_together(self):
        self.assertIsNotNone(parcels.verified_feature(FEATURE, PNU, ADDRESS))
        for bad in (
            {**FEATURE, "properties": {"pnu": "4141010100109570003", "addr": ADDRESS}},
            {**FEATURE, "properties": {"pnu": PNU, "addr": "경기도 군포시 당동 957-3"}},
            {**FEATURE, "geometry": {"type": "Polygon", "coordinates": [[[0,0],[1,0],[1,1],[0,0]]]}}
        ):
            self.assertIsNone(parcels.verified_feature(bad, PNU, ADDRESS))

    def test_rejects_open_or_non_numeric_rings(self):
        self.assertFalse(parcels.valid_geometry({"type":"Polygon","coordinates":[[[126,37],[127,37],[127,38]]]}))
        self.assertFalse(parcels.valid_geometry({"type":"Polygon","coordinates":[[[126,37],[127,37],["bad",38],[126,37]]]}))

    def test_fetch_uses_documented_equality_and_matches_result(self):
        with patch.object(parcels, "request_json", return_value={"featureCollection":{"features":[FEATURE]}}) as request:
            self.assertIsNotNone(parcels.fetch_parcel(PNU, ADDRESS))
            self.assertEqual(request.call_args.args[1]["attrFilter"], "pnu:=:" + PNU)

    def test_address_search_does_not_accept_nearby_lot(self):
        bad = {"id":PNU, "address":{"parcel":ADDRESS.replace("957-2","957-3")}}
        good = {"id":PNU, "address":{"parcel":ADDRESS}}
        with patch.object(parcels, "request_json", return_value={"items":[bad,good]}):
            self.assertEqual(parcels.resolve_pnu(ADDRESS), PNU)
        with patch.object(parcels, "request_json", return_value={"items":[bad]}):
            self.assertIsNone(parcels.resolve_pnu(ADDRESS))

    def test_provider_error_is_reported_and_cached_boundaries_survive(self):
        cached = parcels.verified_feature(FEATURE, PNU, ADDRESS)
        rows = [
            {"name":ADDRESS,"pnu":"4141010100009570002"},
            {"name":"경기도 군포시 당동 958-2","pnu":"4141010100009580002"}
        ]
        with tempfile.TemporaryDirectory() as folder:
            src, dst = Path(folder)/"auctions.json", Path(folder)/"parcels.geojson"
            src.write_text(json.dumps({"items":rows}))
            dst.write_text(json.dumps({"features":[cached]}))
            with patch.multiple(parcels,INPUT=src,OUTPUT=dst,KEY="test-only"), patch.object(parcels,"fetch_parcel",side_effect=parcels.ProviderError("HTTP_502")), contextlib.redirect_stdout(io.StringIO()):
                parcels.main()
            output=json.loads(dst.read_text())
            items=json.loads(src.read_text())["items"]
            self.assertEqual(output["sync"]["status"],"partial")
            self.assertEqual(output["sync"]["errors"],{"HTTP_502":1})
            self.assertEqual(output["sync"]["verified_items"],1)
            self.assertEqual(items[0]["location_precision"],"parcel")
            self.assertEqual(items[1]["parcel_status"],"provider_error")

    def test_never_prints_secret_in_provider_exception(self):
        secret = "private-test-token"
        exc = urllib.error.HTTPError("https://api.vworld.kr/?key="+secret,403,"Forbidden",{},None)
        with patch.object(parcels,"KEY",secret), patch.object(parcels.urllib.request,"urlopen",side_effect=exc):
            with self.assertRaisesRegex(parcels.ProviderError,"^HTTP_403$") as caught:
                parcels.request_json("/req/data",{})
            self.assertNotIn(secret,str(caught.exception))


if __name__ == "__main__":
    unittest.main()
