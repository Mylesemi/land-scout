"""Cache pilot road-network estimates for verified single-parcel land lots."""
import json
import math
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from location_utils import parcel_address, valid_pnu
from sync_parcels import representative_point, same_lot, valid_geometry

AUCTIONS = Path("data/auctions.json")
PARCELS = Path("data/parcels.geojson")
DEST = Path("data/driving.json")
ORIGIN = {"lat": 37.238128, "lng": 127.075942, "label": "힐스테이트서천 인근 도로"}
API = "https://routing.openstreetmap.de/routed-car/table/v1/driving/"
MAX_ROAD_OFFSET = 60
CACHE_DAYS = 30
RECHECK_UNKNOWN_DAYS = 7
BATCH_SIZE = 16
MAX_REQUESTS = 2


def candidates(items, features):
    parcels = {
        str(feature["properties"]["pnu"]): feature for feature in features
        if valid_pnu(feature.get("properties", {}).get("pnu")) and valid_geometry(feature.get("geometry"))
    }
    points = {}
    for item in items:
        pnu = str(item.get("pnu") or "")
        feature = parcels.get(pnu)
        if (item.get("property_type") != "토지" or item.get("multiple_parcels") or
                item.get("location_precision") != "parcel" or not feature):
            continue
        if not same_lot(item["address"], parcel_address(feature["properties"].get("address", ""))):
            continue
        lat, lng = representative_point(feature["geometry"])
        points[pnu] = [round(lat, 6), round(lng, 6)]
    # Allocate the limited lookup budget to nearby parcels first.
    return dict(sorted(points.items(), key=lambda entry:
                       (entry[1][0] - ORIGIN["lat"]) ** 2 + (0.8 * (entry[1][1] - ORIGIN["lng"])) ** 2))


def read_table(points):
    def coordinate(lat, lng):
        return f"{lng:.6f},{lat:.6f}"

    source = coordinate(ORIGIN["lat"], ORIGIN["lng"])
    coords = ";".join([source] + [coordinate(*point) for point in points])
    query = urlencode({"sources": 0, "destinations": ";".join(map(str, range(1, len(points) + 1)))})
    request = Request(API + coords + "?" + query, headers={
        "User-Agent": "LAND-SCOUT/1.0 (+https://github.com/Mylesemi/land-scout)",
        "Referer": "https://mylesemi.github.io/land-scout/",
        "Accept": "application/json",
    })
    with urlopen(request, timeout=15) as response:
        return json.load(response)


def valid_number(value):
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def parse_table(data, count):
    if data.get("code") != "Ok":
        raise ValueError("OSRM returned an unsuccessful status")
    sources = data.get("sources", [])
    destinations = data.get("destinations", [])
    durations = data.get("durations", [])
    if (len(sources) != 1 or len(durations) != 1 or len(destinations) != count or
            len(durations[0]) != count):
        raise ValueError("Unexpected OSRM table shape")
    origin_offset = sources[0].get("distance")
    if not valid_number(origin_offset) or origin_offset > 25:
        raise ValueError("OSRM could not locate the origin road")
    results = []
    for duration, destination in zip(durations[0], destinations):
        road_offset = destination.get("distance")
        if not valid_number(road_offset):
            raise ValueError("OSRM omitted the destination road offset")
        if duration is not None and not valid_number(duration):
            raise ValueError("OSRM returned an invalid duration")
        results.append({"seconds": math.ceil(duration) if duration is not None and road_offset <= MAX_ROAD_OFFSET else None,
                        "road_offset_m": math.ceil(road_offset)})
    return results


def age(entry, now):
    try:
        return now - datetime.fromisoformat(entry["checked_at"])
    except (KeyError, TypeError, ValueError):
        return timedelta.max


def update_cache(points, previous, now, fetch=read_table):
    cached = {
        pnu: entry for pnu, entry in previous.items()
        if entry.get("point") == points.get(pnu) and timedelta(0) <= age(entry, now) <= timedelta(days=CACHE_DAYS)
    }
    pending = [pnu for pnu in points if pnu not in cached or
               (cached[pnu].get("seconds") is None and age(cached[pnu], now) > timedelta(days=RECHECK_UNKNOWN_DAYS))]
    for i in range(0, min(len(pending), MAX_REQUESTS * BATCH_SIZE), BATCH_SIZE):
        if i:
            time.sleep(1.1)
        batch = pending[i:i + BATCH_SIZE]
        try:
            results = parse_table(fetch([points[pnu] for pnu in batch]), len(batch))
        except (OSError, ValueError, TypeError, AttributeError, KeyError) as exc:
            print(f"OSRM lookup unavailable ({type(exc).__name__}); retained cached estimates.")
            break
        for pnu, result in zip(batch, results):
            cached[pnu] = {**result, "point": points[pnu], "checked_at": now.isoformat()}
    return cached


def main():
    items = json.loads(AUCTIONS.read_text(encoding="utf-8"))["items"]
    features = json.loads(PARCELS.read_text(encoding="utf-8"))["features"]
    points = candidates(items, features)
    previous = json.loads(DEST.read_text(encoding="utf-8")) if DEST.exists() else {}
    old_routes = previous["routes"] if previous.get("origin") == ORIGIN else {}
    routes = update_cache(points, old_routes, datetime.now(timezone.utc))
    data = {"origin": ORIGIN, "provider": "FOSSGIS OSRM / OpenStreetMap", "routes": routes}
    output = DEST.with_suffix(".tmp")
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    output.replace(DEST)
    print(f"OSRM estimates: {sum(route['seconds'] is not None for route in routes.values())}/{len(points)} eligible parcel locations")


if __name__ == "__main__":
    main()
