"""Fetch cadastral parcel geometries only when an authorized VWorld API key is configured.

Never fabricate a polygon or treat locality centroids as cadastral boundaries.
"""
import json, os, re, urllib.parse, urllib.request
from pathlib import Path

INPUT = Path("data/auctions.json")
OUTPUT = Path("data/parcels.geojson")
KEY = os.getenv("VWORLD_API_KEY", "").strip()
BASE = "https://api.vworld.kr/req/data"

def fetch_parcel(pnu):
    params = {"service": "data", "request": "GetFeature", "data": "LP_PA_CBND_BUBUN",
              "key": KEY, "domain": os.getenv("VWORLD_API_DOMAIN", "localhost"),
              "format": "json", "size": 1, "attrFilter": "pnu:equal:" + pnu,
              "geometry": "true", "crs": "EPSG:4326"}
    url = BASE + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "LAND-SCOUT/1.0"})
    with urllib.request.urlopen(req, timeout=25) as response:
        data = json.load(response)
    response = data.get("response") or {}
    if response.get("status") != "OK":
        return None
    features = ((response.get("result") or {}).get("featureCollection") or {}).get("features") or []
    for feature in features:
        props = feature.get("properties") or {}
        geom = feature.get("geometry") or {}
        if str(props.get("pnu") or "") == pnu and geom.get("type") in ("Polygon", "MultiPolygon"):
            return {"type": "Feature", "properties": {"pnu": pnu, "source": "VWorld cadastral parcel"},
                    "geometry": geom}
    return None

def main():
    data = json.loads(INPUT.read_text(encoding="utf-8"))
    pnus = sorted({str(item.get("pnu")) for item in data.get("items", [])
                   if re.fullmatch(r"\d{19}", str(item.get("pnu") or ""))})
    existing = {}
    if OUTPUT.exists():
        previous = json.loads(OUTPUT.read_text(encoding="utf-8"))
        existing = {f["properties"]["pnu"]: f for f in previous.get("features", [])
                    if f.get("properties", {}).get("pnu") in pnus and f.get("geometry", {}).get("type") in ("Polygon", "MultiPolygon")}
    if KEY:
        for pnu in pnus:
            if pnu in existing:
                continue
            try:
                feature = fetch_parcel(pnu)
                if feature:
                    existing[pnu] = feature
            except Exception as exc:
                print("Parcel request failed for", pnu, type(exc).__name__)
    else:
        print("VWORLD_API_KEY absent: publishing no unverified boundaries")
    output = {"type": "FeatureCollection", "features": list(existing.values())}
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps(output, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Cadastral boundaries:", len(existing), "of", len(pnus), "PNU identifiers")

if __name__ == "__main__":
    main()
