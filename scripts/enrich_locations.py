"""Optional exact-address geocoding and routing. No estimated coordinates."""
import json, os, re, urllib.parse, urllib.request
from pathlib import Path
DATA = Path("data/auctions.json")
GEO_KEY = os.getenv("KAKAO_REST_API_KEY", "").strip()
ROUTE_KEY = os.getenv("KAKAO_MOBILITY_API_KEY", "").strip()
ORIGIN = os.getenv("LAND_SCOUT_ORIGIN_COORDS", "").strip()

def fetch(url, key):
    request = urllib.request.Request(url, headers={"Authorization": "KakaoAK " + key})
    with urllib.request.urlopen(request, timeout=15) as response:
        return json.load(response)

def lot_address(name):
    match = re.search(r"((?:경기도|경기)\s+.+?\s+(?:산\s*)?\d+(?:-\d+)?)\s", name + " ")
    return match.group(1) if match else None

def geocode(address):
    url = "https://dapi.kakao.com/v2/local/search/address.json?" + urllib.parse.urlencode({"query": address})
    for doc in fetch(url, GEO_KEY).get("documents", []):
        detail = doc.get("address") or {}
        if detail.get("address_name", "").replace(" ", "") == address.replace(" ", ""):
            return float(doc["y"]), float(doc["x"])
    return None

def route(origin, destination):
    params = {"origin": f"{origin[0]},{origin[1]}", "destination": f"{destination[1]},{destination[0]}", "priority": "RECOMMEND"}
    url = "https://apis-navi.kakaomobility.com/v1/directions?" + urllib.parse.urlencode(params)
    routes = fetch(url, ROUTE_KEY).get("routes", [])
    if not routes or routes[0].get("result_code") != 0:
        return None
    duration = routes[0].get("summary", {}).get("duration")
    return round(duration / 60, 1) if isinstance(duration, (int, float)) and duration >= 0 else None

def main():
    if not DATA.exists() or not GEO_KEY:
        print("Enrichment skipped: missing snapshot or KAKAO_REST_API_KEY")
        return
    data = json.loads(DATA.read_text(encoding="utf-8"))
    origin = None
    if ROUTE_KEY and re.fullmatch(r"\d+(?:\.\d+)?,\d+(?:\.\d+)?", ORIGIN):
        lon, lat = map(float, ORIGIN.split(","))
        if 124 <= lon <= 132 and 33 <= lat <= 39:
            origin = lon, lat
    stats = {"geocoded": 0, "routed": 0, "unmatched": 0}
    for item in data.get("items", []):
        address = lot_address(item.get("name", ""))
        if not address:
            stats["unmatched"] += 1
            continue
        try:
            coords = geocode(address)
            if coords is None:
                stats["unmatched"] += 1
                continue
            item["lat"], item["lng"] = coords
            item["geocode_source"] = "Kakao Local exact address match"
            stats["geocoded"] += 1
            if origin:
                minutes = route(origin, coords)
                if minutes is not None:
                    item["drive_min"] = minutes
                    item["drive_source"] = "Kakao Mobility recommended route"
                    stats["routed"] += 1
        except Exception as exc:
            print("Enrichment unavailable for", item.get("lot_id"), type(exc).__name__)
    data["enrichment"] = stats
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Enrichment stats:", stats)

if __name__ == "__main__":
    main()
