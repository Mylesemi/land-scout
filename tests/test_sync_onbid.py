"""Offline regression tests for the collector's parsing and conservative filters."""
import ast
import json
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

source = Path("scripts/sync_onbid.py").read_text(encoding="utf-8")
tree = ast.parse(source)
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("parse_response", "extract", "normalize", "price_number", "area_number")]
namespace = {"json": json, "ET": ET, "re": __import__("re"), "rejection_counts": {"missing_identifier": 0, "missing_price_or_area": 0, "not_land": 0, "not_gyeonggi": 0, "over_budget": 0}}
exec(compile(ast.Module(body=functions, type_ignores=[]), "<collector-functions>", "exec"), namespace)

class CollectorTests(unittest.TestCase):
    def test_syntax(self):
        self.assertTrue(tree.body)

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

    def test_decimal_area_and_first_bid(self):
        row = {"cltrMngNo": "123", "onbidCltrNm": "대지", "landSqms": "32.75", "frstBidPrc": "45000000", "cltrUsgLclsCtgrNm": "토지", "lctnSdnm": "경기도", "lctnSggnm": "용인시"}
        out = namespace["normalize"](row)
        self.assertIsNotNone(out)
        self.assertEqual(out["area"], 32.75)
        self.assertEqual(out["min_price"], 45000000)

    def test_verified_land(self):
        row = {"cltrMngNo": "123", "onbidCltrNm": "토지", "landSqms": "100", "lowstBidPrcIndctCont": "90000000",
               "cltrUsgLclsCtgrNm": "토지", "lctnSdnm": "경기도", "lctnSggnm": "용인시"}
        out = namespace["normalize"](row)
        self.assertIsNotNone(out)
        self.assertEqual(out["min_price"], 90000000)
        self.assertIsNone(out["drive_min"])
        self.assertIsNone(out["lat"])
        self.assertIsNone(out["url"])
        for changes in ({"lowstBidPrcIndctCont": "100000001"}, {"lctnSdnm": "서울특별시"},
                        {"cltrUsgLclsCtgrNm": "건물"}, {"landSqms": ""}, {"cltrMngNo": ""}):
            bad = dict(row, **changes)
            self.assertIsNone(namespace["normalize"](bad))

    def test_price_rejects_ambiguous_values(self):
        self.assertIsNone(namespace["price_number"]("약 5천만원"))
        self.assertIsNone(namespace["price_number"]("-100"))
        self.assertEqual(namespace["price_number"]("10,000,000"), 10000000)

if __name__ == "__main__":
    unittest.main()
