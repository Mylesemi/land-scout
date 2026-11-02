"""Onbid real-estate list collector. Conservative, no fabricated data."""
import json, os, re, sys, time, urllib.parse, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

BASE = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2"
DEST = Path("data/auctions.json")
key = os.getenv("DATA_GO_KR_API_KEY", "").strip()
if not key:
    sys.exit("Missing DATA_GO_KR_API_KEY")
endpoint = os.getenv("ONBID_LIST_ENDPOINT", "").strip() or BASE
parsed = urllib.parse.urlparse(endpoint)
if parsed.scheme != "https" or parsed.hostname != "apis.data.go.kr":
    sys.exit("Only official apis.data.go.kr HTTPS endpoints are allowed")

def parse_response(raw):
    try:
        root = json.loads(raw)
        if not isinstance(root, dict):
            raise ValueError("JSON root is not an object")
        envelope = root.get("response", root)
        header = envelope.get("header", envelope.get("result", {})) if isinstance(envelope, dict) else {}
        code = str(header.get("resultCode", ""))
        message = str(header.get("resultMsg", ""))[:120]
        return code, message, root, "json"
    except (ValueError, UnicodeDecodeError):
        root = ET.fromstring(raw)
        code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode") or ""
        message = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg") or ""
        return code, message[:120], root, "xml"

def extract(payload, fmt):
    if fmt == "xml":
        # Only accept objects with the documented stable item identifier.
        return [{node.tag.rsplit("}", 1)[-1]: (node.text or "").strip() for node in item}
                for item in payload.iter() if item.tag.rsplit("}", 1)[-1] in ("item", "row", "cltr")]
    envelope = payload.get("response", payload)
    body = envelope.get("body", envelope.get("result", {}))
    if not isinstance(body, dict):
        return []
    items = body.get("items", body.get("item", body.get("row", [])))
    if isinstance(items, dict):
        items = items.get("item", [])
    if isinstance(items, dict):
        items = [items]
    return items if isinstance(items, list) else []

def request(prpt, pvct, page):
    params = {"serviceKey": key, "pageNo": str(page), "numOfRows": "100",
              "prptDivCd": prpt, "pvctTrgtYn": pvct}
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
    try:
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json, application/xml"}), timeout=30) as resp:
                    raw = resp.read(3_000_000)
                break
            except urllib.error.HTTPError as exc:
                if exc.code != 429 or attempt == 2:
                    if exc.code == 429:
                        print("HTTP 429 response headers: retry-after=" + str(exc.headers.get("Retry-After", "absent")) + ", rate-limit-remaining=" + str(exc.headers.get("X-RateLimit-Remaining", "absent")), flush=True)
                    raise
                delay = (20, 60)[attempt]
                print(f"Onbid rate limited (HTTP 429); retrying after {delay}s", flush=True)
                time.sleep(delay)
    except urllib.error.HTTPError as exc:
        if exc.code == 429:
            raise RuntimeError("HTTP 429 rate limit") from None
        raise RuntimeError(f"HTTP {exc.code}") from None
    except Exception as exc:
        raise RuntimeError(f"Network error {type(exc).__name__}") from None
    return parse_response(raw)

def area_number(value):
    s = str(value or "").replace(",", "").strip()
    if not re.fullmatch(r"\d+(?:\.\d+)?", s):
        return None
    n = float(s)
    return n if n > 0 else None

def price_number(value):
    s = str(value or "").replace(",", "").replace("원", "").strip()
    if not re.fullmatch(r"\d+(?:\.0+)?", s):
        return None
    n = int(float(s))
    return n if n > 0 else None

def normalize(row):
    if not isinstance(row, dict):
        return None
    ident = str(row.get("cltrMngNo") or "").strip()
    name = str(row.get("onbidCltrNm") or "").strip()
    land_area = area_number(row.get("landSqms") or row.get("sqmsCont"))
    building_area = area_number(row.get("bldSqms"))
    price = price_number(row.get("frstBidPrc")) or price_number(row.get("frstCtrsLowstBidPrc"))
    if price is None:
        price = price_number(row.get("lowstBidPrcIndctCont"))
    if not ident:
        rejection_counts["missing_identifier"] += 1
        return None
    if not price or not (land_area or building_area):
        rejection_counts["missing_price_or_area"] += 1
        return None
    category = " ".join(str(row.get(k) or "") for k in ("cltrUsgLclsCtgrNm", "cltrUsgMclsCtgrNm", "cltrUsgSclsCtgrNm"))
    # Prefer the provider's hierarchical classification; reject ambiguous mixed lots.
    land_terms = ("토지", "대지", "임야", "전답", "농지", "잡종지")
    housing_terms = ("주택", "아파트", "빌라", "연립", "다세대", "다가구", "단독", "오피스텔")
    label = category.strip() or name
    if any(t in label for t in housing_terms):
        property_type = "주택"
    elif any(t in label for t in land_terms) or re.search(r"(?:^|\\s)(?:전|답)(?:$|\\s)", label):
        property_type = "토지"
    else:
        rejection_counts["not_land"] += 1
        return None
    area = building_area if property_type == "주택" else land_area
    if not area:
        rejection_counts["missing_price_or_area"] += 1
        return None
    region = str(row.get("lctnSdnm") or "")
    if not region:
        region = str(row.get("zadrNm") or row.get("cltrRadr") or "").split(" ")[0]
    if region.strip() not in ("경기도", "경기"):
        rejection_counts["not_gyeonggi"] += 1
        return None
    if price > 100_000_000:
        rejection_counts["over_budget"] += 1
        return None
    address = str(row.get("zadrNm") or "").strip() or " ".join(str(row.get(k) or "").strip() for k in ("lctnSdnm", "lctnSggnm", "lctnEmdNm")).strip()
    if not address:
        return None
    return {"source": "온비드", "lot_id": ident, "address": address, "min_price": price,
            "area": area, "land_area": land_area, "building_area": building_area, "property_type": property_type, "pnu": (str(row.get("ltnoPnu") or "").strip() if re.fullmatch(r"\d{19}", str(row.get("ltnoPnu") or "").strip()) else None), "category": category.strip(), "name": name,
            "bid_start": row.get("cltrBidBgngDt"), "bid_end": row.get("cltrBidEndDt"),
            "status": row.get("pbctStatNm"), "drive_min": None, "lat": None, "lng": None,
            "road": None, "water": None, "sewer": None, "grid": None,
            "sunlight": None, "legal": None, "url": (row.get("urlAdr") if str(row.get("urlAdr") or "").startswith("https://") else None)}

# Codes are not assumed to have a particular meaning; query a small range and
# use the provider's returned descriptive fields for selection.
codes = [x.strip() for x in os.getenv("ONBID_PROPERTY_CODES", "0002,0004,0005,0007").split(",") if re.fullmatch(r"\d{4}", x.strip())]
max_pages = min(max(int(os.getenv("ONBID_MAX_PAGES", "1")), 1), 20)
request_budget = min(max(int(os.getenv("ONBID_REQUEST_BUDGET", "8")), 1), 100)
requests_used = 0
records = {}
had_items = False
successful = 0
incomplete = False
throttle_hit = False
seen_field_sets = set()
rejection_counts = {"missing_identifier":0,"missing_price_or_area":0,"not_land":0,"not_gyeonggi":0,"over_budget":0}
for code in codes:
    for pvct in ("N", "Y"):
        for page in range(1, max_pages + 1):
            if requests_used >= request_budget:
                incomplete = True
                break
            try:
                result, message, payload, fmt = request(code, pvct, page)
            except RuntimeError as exc:
                if "HTTP 429" in str(exc):
                    print("Provider rate limit reached; publishing verified matches from completed pages only.")
                    incomplete = True
                    throttle_hit = True
                    break
                raise
            requests_used += 1
            time.sleep(0.25)
            print(f"property_code={code} private_contract={pvct} page={page} api_code={result} message={message}")
            if result == "03":
                break
            if result not in ("00", "0"):
                raise RuntimeError(f"Provider rejected query: {result} {message}")
            successful += 1
            items = extract(payload, fmt)
            if not items:
                raise RuntimeError("API success envelope contained no recognized items; refusing silent schema mismatch")
            had_items = True
            if isinstance(items[0], dict):
                fields = tuple(sorted(items[0].keys()))
                if fields not in seen_field_sets:
                    seen_field_sets.add(fields)
                    print("Response item field names (no values):", ",".join(fields)[:1800])
            for item in items:
                row = normalize(item)
                if row:
                    records[row["lot_id"]] = row
            if len(items) < 100:
                break
            if page == max_pages and len(items) == 100:
                incomplete = True
        if requests_used >= request_budget or incomplete and throttle_hit:
            break
    if requests_used >= request_budget or incomplete and throttle_hit:
        break

print("Filter rejection counts:", json.dumps(rejection_counts, ensure_ascii=False))
print("Matched property types:", json.dumps({"토지": sum(x["property_type"] == "토지" for x in records.values()), "주택": sum(x["property_type"] == "주택" for x in records.values())}, ensure_ascii=False))
if incomplete:
    print("Collection is partial due to pagination/request budget or provider throttling; only confirmed matching items will be published.")
if not had_items:
    print("No recognizable API items; existing snapshot preserved. Verify API quota and key status.", file=sys.stderr)
    sys.exit(2)
if not records:
    print("API returned items, but no eligible Gyeonggi land rows. Existing snapshot preserved; this is not an API failure.")
    sys.exit(0)
DEST.parent.mkdir(parents=True, exist_ok=True)
snapshot = {"collection": {"requests": requests_used, "successful_pages": successful, "partial": incomplete, "matched_by_type": {"토지": sum(x["property_type"] == "토지" for x in records.values()), "주택": sum(x["property_type"] == "주택" for x in records.values())}, "rejected": rejection_counts}, "updated": datetime.now(timezone.utc).isoformat(), "status": "partial_verified" if incomplete else "verified_filtered",
            "source": "KAMCO Onbid real-estate list API", "items": list(records.values())}
DEST.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"Published {len(records)} conservatively filtered records; {successful} successful pages; partial={incomplete}")
