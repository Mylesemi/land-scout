"""Conservative keyless geocoding for Onbid properties using public OSM Nominatim.

Public Nominatim policy: maximum 1 request/second, identifying User-Agent,
small batch, caching, no bulk address harvesting. No guessed map pins.
"""
import json, os, re, time, urllib.parse, urllib.request
from pathlib import Path
from location_utils import parcel_address

DATA = Path("data/auctions.json")
CACHE = Path("data/geocode_cache.json")
AGENT = "LandScout/1.0 (public GitHub project: https://github.com/Mylesemi/land-scout)"
LIMIT = 15

def lot_address(name):
    # Require a complete Korean cadastral lot number, not a district centroid.
    lot = parcel_address(name)
    return lot["address"] if lot else None

def normalize(value):
    return re.sub(r"\s+", "", str(value or "")).replace("경기도", "경기", 1)

def geocode(address):
    params = urllib.parse.urlencode({"q": address, "format": "jsonv2", "limit": 5, "addressdetails": 1})
    req = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + params,
                                 headers={"User-Agent": AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        results = json.load(resp)
    # Nominatim may return a road/neighborhood centroid for an unrecognized lot.
    # Accept only results whose full display address explicitly contains the lot
    # number and relevant locality; reject all ambiguous matches.
    lot = parcel_address(address)
    if not lot:
        return None
    number = ("산" if lot["mountain"] else "") + str(lot["main"]) + ("-" + str(lot["sub"]) if lot["sub"] else "")
    for result in results:
        display = str(result.get("display_name", ""))
        details = result.get("address") or {}
        house = str(details.get("house_number") or "")
        if not all(normalize(part) in normalize(display) for part in lot["district"].split()):
            continue
        if normalize(house) != normalize(number):
            continue
        lat, lon = float(result["lat"]), float(result["lon"])
        if 36.0 <= lat <= 39.0 and 126.0 <= lon <= 128.8:
            return [lat, lon]
    return None

def area_geocode(address):
    lot = parcel_address(address)
    if not lot:
        return None
    # Search only the locality, and explicitly label this as an approximate area.
    area = lot["district"]
    params = urllib.parse.urlencode({"q": area, "format": "jsonv2", "limit": 5, "addressdetails": 1})
    req = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + params,
                                 headers={"User-Agent": AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        results = json.load(resp)
    for result in results:
        display = normalize(result.get("display_name", ""))
        if not all(normalize(part) in display for part in lot["district"].split()):
            continue
        lat, lon = float(result["lat"]), float(result["lon"])
        if 36.0 <= lat <= 39.0 and 126.0 <= lon <= 128.8:
            return [lat, lon]
    return None

def main():
    if not DATA.exists():
        return
    data = json.loads(DATA.read_text(encoding="utf-8"))
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    stats = {"geocoded": 0, "parcel_geocoded": 0, "exact": 0, "approximate": 0, "routed": 0, "unmatched": 0, "requests": 0, "provider": "VWorld / OpenStreetMap Nominatim"}
    area_cache = {}
    for item in data.get("items", []):
        if item.get("parcel_status") == "verified" and item.get("location_precision") == "parcel":
            stats["geocoded"] += 1
            stats["parcel_geocoded"] += 1
            continue
        item["lat"] = item["lng"] = item["drive_min"] = None
        item.pop("location_precision", None)
        item.pop("geocode_source", None)
        item.pop("drive_source", None)
        address = lot_address(item.get("name", ""))
        if not address:
            stats["unmatched"] += 1
            continue
        if address not in cache:
            if stats["requests"] >= LIMIT:
                stats["unmatched"] += 1
                continue
            if stats["requests"]:
                time.sleep(1.2)
            stats["requests"] += 1
            try:
                cache[address] = geocode(address)
            except Exception as exc:
                print("Geocoding failed:", type(exc).__name__)
                stats["unmatched"] += 1
                continue
        coords = cache[address]
        if coords is None:
            area = parcel_address(address)["district"]
            cache_key = "area:" + area
            if cache_key in cache:
                area_cache[area] = cache[cache_key]
            if area not in area_cache and stats["requests"] < LIMIT:
                time.sleep(1.2)
                stats["requests"] += 1
                try:
                    area_cache[area] = area_geocode(address)
                    cache[cache_key] = area_cache[area]
                except Exception as exc:
                    print("Area lookup failed:", type(exc).__name__)
                    area_cache[area] = None
            coords = area_cache.get(area)
            if coords is None:
                stats["unmatched"] += 1
                continue
            item["location_precision"] = "area"
            item["lat"], item["lng"] = coords
            item["geocode_source"] = "OSM approximate locality (not property location)"
            stats["geocoded"] += 1
            stats["approximate"] += 1
            continue
        item["lat"], item["lng"] = coords
        item["location_precision"] = "exact"
        item["geocode_source"] = "OpenStreetMap Nominatim exact lot match"
        stats["geocoded"] += 1
        stats["exact"] += 1
    data["enrichment"] = {**stats, "geocode_configured": True, "route_configured": False}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Geocoding:", stats)

if __name__ == "__main__":
    main()
