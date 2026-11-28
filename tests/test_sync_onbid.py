"""Offline regression tests for the collector's parsing and conservative filters."""
import json
import unittest
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import sync_onbid
namespace = vars(sync_onbid)

class CollectorTests(unittest.TestCase):
    def test_xml_no_data(self):
        code, msg, payload, fmt = namespace["parse_response"](b"<result><resultCode>03</resultCode><resultMsg>NODATA_ERROR</resultMsg></result>")
        self.assertEqual((code, fmt), ("03", "xml"))

    def test_json_items(self):
        obj = {"response": {"header": {"resultCode": "00"}, "body": {"items": {"item": [{"cltrMngNo": "A"}]}}}}
        code, msg, payload, fmt = namespace["parse_response"](json.dumps(obj).encode())
        self.assertEqual(code, "00")
        self.assertEqual(namespace["extract"](payload, fmt)[0]["cltrMngNo"], "A")

    def test_top_level_api_envelope(self):
        obj = {"header": {"resultCode": "00", "resultMsg": "NORMAL_CODE"},
               "body": {"items": {"item": [{"cltrMngNo": "A"}]}}}
        code, msg, payload, fmt = namespace["parse_response"](json.dumps(obj).encode())
        self.assertEqual(code, "00")
        self.assertEqual(namespace["extract"](payload, fmt)[0]["cltrMngNo"], "A")

    def test_result_envelope_no_data(self):
        raw = b'{"result":{"resultCode":"03","resultMsg":"NODATA_ERROR"}}'
        code, msg, payload, fmt = namespace["parse_response"](raw)
        self.assertEqual((code, msg, fmt), ("03", "NODATA_ERROR", "json"))

    def test_decimal_area_and_current_bid(self):
        row = {"dspsMthodCd": "0001", "cltrMngNo": "123", "onbidCltrNm": "대지", "landSqms": "32.75", "frstBidPrc": "90000000", "lowstBidPrcIndctCont": "45000000", "cltrUsgLclsCtgrNm": "토지", "lctnSdnm": "경기도", "lctnSggnm": "용인시"}
        out = namespace["normalize"](row)
        self.assertIsNotNone(out)
        self.assertEqual(out["area"], 32.75)
        self.assertEqual(out["min_price"], 45000000)

    def test_housing_with_building_area(self):
        row = {"dspsMthodCd":"0001","cltrMngNo":"H1","onbidCltrNm":"경기도 용인시 아파트","bldSqms":"84.92","lowstBidPrcIndctCont":"85000000","cltrUsgLclsCtgrNm":"부동산","cltrUsgMclsCtgrNm":"주택","lctnSdnm":"경기도","lctnSggnm":"용인시"}
        out = namespace["normalize"](row)
        self.assertIsNotNone(out)
        self.assertEqual(out["property_type"], "주택")
        self.assertEqual(out["area"], 84.92)

    def test_no_false_land_match_from_common_korean_syllable(self):
        row = {"dspsMthodCd":"0001","cltrMngNo":"X1","onbidCltrNm":"경기도 용인시 상가 전용시설","landSqms":"40","lowstBidPrcIndctCont":"30000000","cltrUsgLclsCtgrNm":"상가","lctnSdnm":"경기도","lctnSggnm":"용인시"}
        self.assertIsNone(namespace["normalize"](row))

    def test_verified_land(self):
        row = {"dspsMthodCd": "0001", "cltrMngNo": "123", "onbidCltrNm": "토지", "landSqms": "100", "lowstBidPrcIndctCont": "90000000",
               "cltrUsgLclsCtgrNm": "토지", "lctnSdnm": "경기도", "lctnSggnm": "용인시"}
        out = namespace["normalize"](row)
        self.assertIsNotNone(out)
        self.assertEqual(out["min_price"], 90000000)
        self.assertIsNone(out["drive_min"])
        self.assertIsNone(out["lat"])
        self.assertIsNone(out["url"])
        for changes in ({"lowstBidPrcIndctCont": "100000001"}, {"lctnSdnm": "서울특별시"},
                        {"cltrUsgLclsCtgrNm": "건물"}, {"landSqms": ""}, {"cltrMngNo": ""},
                        {"dspsMthodCd": "0002"}, {"dspsMthodCd": ""}, {"lowstBidPrcIndctCont": "비공개", "frstBidPrc": "90000000"}):
            bad = dict(row, **changes)
            self.assertIsNone(namespace["normalize"](bad))

    def test_combined_parcels_are_marked_and_keep_representative_address(self):
        row={"dspsMthodCd":"0001","cltrMngNo":"C1","onbidCltrNm":"경기도 광주시 남종면 삼성리 234, 235-2","landSqms":"100","lowstBidPrcIndctCont":"90000000","cltrUsgLclsCtgrNm":"토지","lctnSdnm":"경기도"}
        out=namespace["normalize"](row)
        self.assertTrue(out["multiple_parcels"])
        self.assertEqual(out["address"],"경기도 광주시 남종면 삼성리 234")

    def test_price_rejects_ambiguous_values(self):
        self.assertIsNone(namespace["price_number"]("약 5천만원"))
        self.assertIsNone(namespace["price_number"]("-100"))
        self.assertEqual(namespace["price_number"]("10,000,000"), 10000000)

    def test_scoped_query_adds_lots_deduplicates_rounds_and_rejects_wrong_city(self):
        base = {"dspsMthodCd": "0001", "landSqms": "100", "lowstBidPrcIndctCont": "90000000",
                "cltrUsgLclsCtgrNm": "토지", "lctnSdnm": "경기도"}
        original = dict(base, cltrMngNo="lot1", onbidCltrNm="경기도 용인시 기흥구 서천동 100")
        local = dict(base, cltrMngNo="lot2", onbidCltrNm="경기도 용인시 기흥구 서천동 101")
        wrong_city = dict(base, cltrMngNo="lot3", onbidCltrNm="경기도 고양시 일산동구 식사동 100")

        def fetch(mode, page, district):
            if mode == "Y":
                return "03", "", {}, "json"
            items = [original, local, wrong_city] if district else [original]
            return "00", "", {"body": {"items": items}}, "json"

        rows, report = sync_onbid.collect(fetch, 4, 2, 8, {"용인시": ("용인시 기흥구",)})
        self.assertEqual({row["lot_id"] for row in rows}, {"lot1", "lot2"})
        self.assertEqual(report["focus_regions"]["용인시"]["added_lots"], 1)
        self.assertFalse(report["partial"])

    def test_exhausting_budget_keeps_unchecked_regions_partial(self):
        def fetch(mode, page, district):
            return "03", "", {}, "json"

        rows, report = sync_onbid.collect(fetch, 4, 2, 2, {"용인시": ("용인시 기흥구",)})
        self.assertEqual(rows, [])
        self.assertTrue(report["partial"])
        self.assertFalse(report["focus_regions"]["용인시"]["complete"])

if __name__ == "__main__":
    unittest.main()
