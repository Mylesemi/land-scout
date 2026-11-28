"""Onbid real-estate list collector. Conservative, no fabricated data."""
import json, os, re, sys, time, urllib.parse, urllib.request, urllib.error
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path
from location_utils import candidate_pnu, parcel_address

BASE = "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2"
DEST = Path("data/auctions.json")
PAGE_SIZE = 100
FOCUS_REGIONS = {
    "용인시": ("용인시", "용인시 기흥구", "용인시 수지구", "용인시 처인구"),
    "수원시": ("수원시", "수원시 영통구", "수원시 권선구", "수원시 팔달구", "수원시 장안구"),
    "화성시": ("화성시", "화성시 동탄구", "화성시 병점구", "화성시 효행구", "화성시 만세구"),
    "오산시": ("오산시",),
}
REJECTIONS = ("missing_identifier", "missing_price_or_area", "not_land", "not_gyeonggi", "over_budget", "not_sale")
rejection_counts = dict.fromkeys(REJECTIONS, 0)

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

def request(endpoint, key, prpt, pvct, page, district):
    params = {"serviceKey": key, "pageNo": str(page), "numOfRows": str(PAGE_SIZE),
              "prptDivCd": prpt, "pvctTrgtYn": pvct, "resultType": "json",
              "dspsMthodCd": "0001", "lctnSdnm": "경기도", "lowstBidPrcEnd": "100000000"}
    if district:
        params["lctnSggnm"] = district
    url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
    try:
        for attempt in range(3):
            try:
                with urllib.request.urlopen(urllib.request.Request(url, headers={"Accept": "application/json, application/xml"}), timeout=30) as resp:
                    raw = resp.read(3_000_000)
                break
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                    raise
                retry_after = str(exc.headers.get("Retry-After", ""))
                delay = min(int(retry_after), 60) if retry_after.isdigit() else (5, 15)[attempt]
                print(f"Onbid HTTP {exc.code}; retrying after {delay}s", flush=True)
                time.sleep(delay)
            except (urllib.error.URLError, ConnectionError, TimeoutError, OSError) as exc:
                if attempt == 2:
                    raise
                delay = (2, 5)[attempt]
                print(f"Onbid transient network error {type(exc).__name__}; retrying after {delay}s", flush=True)
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
    sale_code = str(row.get("dspsMthodCd") or "").strip()
    sale_name = str(row.get("dspsMthodNm") or "").strip()
    if sale_code != "0001" and not (not sale_code and sale_name == "매각"):
        rejection_counts["not_sale"] += 1
        return None
    land_area = area_number(row.get("landSqms") or row.get("sqmsCont"))
    building_area = area_number(row.get("bldSqms"))
    # frstBidPrc is an INITIAL estimate, not the current auction price.
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
    elif any(t in label for t in land_terms) or re.search(r"(?:^|\s)(?:전|답)(?:$|\s)", label):
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
    named_lot = parcel_address(name)
    address = named_lot["address"] if named_lot else (str(row.get("zadrNm") or "").strip() or " ".join(str(row.get(k) or "").strip() for k in ("lctnSdnm", "lctnSggnm", "lctnEmdNm")).strip())
    if not address:
        return None
    return {"source": "온비드", "lot_id": ident, "condition_id": str(row.get("pbctCdtnNo") or ""),
            "address": address, "min_price": price, "disposal": "매각",
            "share": str(row.get("alcYn") or "").upper() == "Y" or "지분" in name,
            "multiple_parcels": bool(re.search(r"외\s*\d+\s*필지|(?:동|리|가)\s+(?:산\s*)?\d+(?:-\d+)?\s*[,，]\s*(?:산\s*)?\d", name)),
            "provider_pnu": str(row.get("ltnoPnu") or "").strip() or None,
            "area": area, "land_area": land_area, "building_area": building_area, "property_type": property_type,
            "pnu": candidate_pnu(row.get("ltnoPnu"), name), "category": category.strip(), "name": name,
            "bid_start": row.get("cltrBidBgngDt"), "bid_end": row.get("cltrBidEndDt"),
            "status": row.get("pbctStatNm"), "drive_min": None, "lat": None, "lng": None,
            "road": None, "water": None, "sewer": None, "grid": None,
            "sunlight": None, "legal": None, "url": (row.get("urlAdr") if str(row.get("urlAdr") or "").startswith("https://") else None)}

def matches_district(row, district):
    return row["address"].split()[1:1 + len(district.split())] == district.split()


def collect(fetch, province_pages, district_pages, budget, focus_regions=FOCUS_REGIONS):
    districts = [district for scope in focus_regions.values() for district in scope]
    stages = ([""], districts)
    states = {
        (district, mode): {"status": "pending", "seen_lots": set()}
        for group in stages for district in group for mode in ("N", "Y")
    }
    records = {}
    requests_used = successful = 0
    stopped = False
    rejection_counts.update(dict.fromkeys(REJECTIONS, 0))

    for group, pages in zip(stages, (province_pages, district_pages)):
        # Preserve the province feed. Within a stage, give each scope page 1
        # before requesting later pages from a district with many results.
        for page in range(1, pages + 1):
            for district in group:
                for mode in ("N", "Y"):
                    state = states[district, mode]
                    if stopped or requests_used >= budget or state["status"] != "pending":
                        continue
                    requests_used += 1
                    try:
                        result, message, payload, fmt = fetch(mode, page, district)
                    except RuntimeError:
                        if successful == 0:
                            raise
                        state["status"] = "error"
                        stopped = True
                        continue
                    print(f"area={district or '경기도'} private_contract={mode} page={page} code={result}")
                    if result == "03":
                        successful += 1
                        state["status"] = "complete"
                        continue
                    if result not in ("00", "0"):
                        if not district:
                            raise RuntimeError(f"Onbid rejected the province query ({result} {message})")
                        state["status"] = "error"
                        continue
                    items = extract(payload, fmt)
                    if not items:
                        if not district:
                            raise RuntimeError("Onbid reported success with an unrecognized item format")
                        state["status"] = "error"
                        continue
                    successful += 1
                    for item in items:
                        row = normalize(item)
                        if row and (not district or matches_district(row, district)):
                            records[row["lot_id"], row["condition_id"]] = row
                            state["seen_lots"].add(row["lot_id"])
                    if len(items) < PAGE_SIZE:
                        state["status"] = "complete"

    province_lots = states["", "N"]["seen_lots"] | states["", "Y"]["seen_lots"]
    summary = {}
    scoped_complete = True
    for city, areas in focus_regions.items():
        statuses = {
            district: {mode: states[district, mode]["status"] for mode in ("N", "Y")}
            for district in areas
        }
        directly_seen = set().union(*(states[d, m]["seen_lots"] for d in areas for m in ("N", "Y")))
        city_lots = {row["lot_id"] for row in records.values() if matches_district(row, city)}
        complete = city_lots <= directly_seen and all(
            status == "complete" for modes in statuses.values() for status in modes.values()
        )
        scoped_complete &= complete
        summary[city] = {"complete": complete, "lots": len(city_lots),
                         "added_lots": len(city_lots - province_lots), "scopes": statuses}

    partial = not scoped_complete or any(states["", m]["status"] != "complete" for m in ("N", "Y"))
    return list(records.values()), {"requests": requests_used, "successful_pages": successful,
                                    "partial": partial, "focus_regions": summary,
                                    "rejected": dict(rejection_counts)}


def main():
    key = os.getenv("DATA_GO_KR_API_KEY", "").strip()
    if not key:
        sys.exit("Missing DATA_GO_KR_API_KEY")
    endpoint = os.getenv("ONBID_LIST_ENDPOINT", "").strip() or BASE
    parsed = urllib.parse.urlparse(endpoint)
    if parsed.scheme != "https" or parsed.hostname != "apis.data.go.kr":
        sys.exit("Only official apis.data.go.kr HTTPS endpoints are allowed")
    codes = ",".join(code.strip() for code in os.getenv("ONBID_PROPERTY_CODES", "0007,0010,0005,0002,0003,0006,0008,0011,0013").split(",")
                     if re.fullmatch(r"\d{4}", code.strip()))
    province_pages = min(max(int(os.getenv("ONBID_MAX_PAGES", "4")), 1), 20)
    district_pages = min(max(int(os.getenv("ONBID_DISTRICT_PAGES", "2")), 1), 10)
    budget = min(max(int(os.getenv("ONBID_REQUEST_BUDGET", "48")), 2), 100)

    def fetch(mode, page, district):
        time.sleep(0.25)
        return request(endpoint, key, codes, mode, page, district)

    rows, collection = collect(fetch, province_pages, district_pages, budget)
    if not rows and collection["partial"]:
        sys.exit("Incomplete collection with no confirmed items; preserving last snapshot")
    collection["matched_by_type"] = {kind: sum(row["property_type"] == kind for row in rows) for kind in ("토지", "주택")}
    snapshot = {"collection": collection, "updated": datetime.now(timezone.utc).isoformat(),
                "status": "partial_verified" if collection["partial"] else "verified_filtered",
                "source": "KAMCO Onbid real-estate list API", "items": rows}
    DEST.parent.mkdir(parents=True, exist_ok=True)
    DEST.write_text(json.dumps(snapshot, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Published {len(rows)} rounds. Focus regions:", json.dumps(collection["focus_regions"], ensure_ascii=False))


if __name__ == "__main__":
    main()
