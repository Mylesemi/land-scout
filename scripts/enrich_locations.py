"""Conservative keyless geocoding for Onbid properties using public OSM Nominatim.

Public Nominatim policy: maximum 1 request/second, identifying User-Agent,
small batch, caching, no bulk address harvesting. No guessed map pins.
"""
import json, os, re, time, urllib.parse, urllib.request
from pathlib import Path

DATA = Path("data/auctions.json")
CACHE = Path("data/geocode_cache.json")
AGENT = "LandScout/1.0 (public GitHub project: https://github.com/Mylesemi/land-scout)"
LIMIT = 15

def lot_address(name):
    # Require a complete Korean cadastral lot number, not a district centroid.
    match = re.search(r"((?:경기도|경기)\s+.+?\s+(?:산\s*)?\d+(?:-\d+)?)(?=\s|$)", name)
    return match.group(1) if match else None

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
    parts = address.split()
    lot = re.search(r"(?:산\s*)?\d+(?:-\d+)?$", address)
    if not lot or len(parts) < 4:
        return None
    locality = parts[-2]
    for result in results:
        display = str(result.get("display_name", ""))
        details = result.get("address") or {}
        house = str(details.get("house_number") or "")
        if normalize(locality) not in normalize(display):
            continue
        if normalize(house) != normalize(lot.group(0)):
            continue
        lat, lon = float(result["lat"]), float(result["lon"])
        if 36.0 <= lat <= 39.0 and 126.0 <= lon <= 128.8:
            return [lat, lon]
    return None

def area_geocode(address):
    parts = address.split()
    if len(parts) < 3:
        return None
    # Search only the locality, and explicitly label this as an approximate area.
    area = " ".join(parts[:-1])
    params = urllib.parse.urlencode({"q": area, "format": "jsonv2", "limit": 5, "addressdetails": 1})
    req = urllib.request.Request("https://nominatim.openstreetmap.org/search?" + params,
                                 headers={"User-Agent": AGENT, "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as resp:
        results = json.load(resp)
    locality = parts[-2]
    for result in results:
        display = normalize(result.get("display_name", ""))
        if normalize(locality) not in display:
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
    stats = {"geocoded": 0, "routed": 0, "unmatched": 0, "requests": 0, "provider": "OpenStreetMap Nominatim"}
    area_cache = {}
    for item in data.get("items", []):
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
            try:
                cache[address] = geocode(address)
            except Exception as exc:
                print("Geocoding failed:", type(exc).__name__)
                stats["unmatched"] += 1
                continue
            stats["requests"] += 1
        coords = cache[address]
        if coords is None:
            area = " ".join(address.split()[:-1])
            if area not in area_cache and stats["requests"] < LIMIT:
                time.sleep(1.2)
                try:
                    area_cache[area] = area_geocode(address)
                except Exception as exc:
                    print("Area lookup failed:", type(exc).__name__)
                    area_cache[area] = None
                stats["requests"] += 1
            coords = area_cache.get(area)
            if coords is None:
                stats["unmatched"] += 1
                continue
            item["location_precision"] = "area"
            item["lat"], item["lng"] = coords
            item["geocode_source"] = "OSM approximate locality (not property location)"
            stats["geocoded"] += 1
            continue
        item["lat"], item["lng"] = coords
        item["location_precision"] = "exact"
        item["geocode_source"] = "OpenStreetMap Nominatim exact lot match"
        stats["geocoded"] += 1
    data["enrichment"] = {**stats, "geocode_configured": True, "route_configured": False}
    CACHE.parent.mkdir(parents=True, exist_ok=True)
    CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    DATA.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Geocoding:", stats)

if __name__ == "__main__":
    main()
