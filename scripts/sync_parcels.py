"""Collect public Gyeonggi cadastral polygons with an optional VWorld fallback."""
import json
import math
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
import http.cookiejar
from html.parser import HTMLParser
from datetime import datetime, timezone
from pathlib import Path

from location_utils import candidate_pnu, parcel_address, valid_pnu

INPUT = Path("data/auctions.json")
OUTPUT = Path("data/parcels.geojson")
KEY = os.getenv("VWORLD_API_KEY", "").strip()
DOMAIN = os.getenv("VWORLD_API_DOMAIN", "").strip() or "https://mylesemi.github.io"
BASE = "https://api.vworld.kr"
MAX_REQUESTS = min(200, max(1, int(os.getenv("PARCEL_REQUEST_BUDGET", os.getenv("VWORLD_REQUEST_BUDGET", "150")))))


class ProviderError(Exception):
    pass


def request_json(path, params):
    params = {**params, "key": KEY, "domain": DOMAIN, "format": "json", "version": "2.0"}
    req = urllib.request.Request(
        BASE + path + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "LAND-SCOUT/1.0", "Referer": DOMAIN if "://" in DOMAIN else "https://" + DOMAIN},
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=25) as result:
                data = json.load(result)
            break
        except urllib.error.HTTPError as exc:
            if exc.code not in (429, 500, 502, 503, 504) or attempt == 2:
                raise ProviderError("HTTP_" + str(exc.code)) from None
        except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
            if attempt == 2:
                raise ProviderError("NETWORK_ERROR") from None
        except (ValueError, TypeError):
            raise ProviderError("INVALID_RESPONSE") from None
        time.sleep((2, 5)[attempt])
    response = data.get("response") if isinstance(data, dict) else None
    if not isinstance(response, dict):
        raise ProviderError("INVALID_RESPONSE")
    if response.get("status") == "NOT_FOUND":
        return {}
    if response.get("status") != "OK":
        code = str((response.get("error") or {}).get("code") or "API_ERROR")
        # Never print provider text or exception URLs: they can contain the key.
        raise ProviderError(code if re.fullmatch(r"[A-Z0-9_]{1,60}", code) else "API_ERROR")
    return response.get("result") or {}


def same_lot(address, target):
    actual = parcel_address(address)
    def compact(value):
        return re.sub(r"\s+", "", value).replace("경기도", "경기", 1)
    return bool(actual and target and compact(actual["address"]) == compact(target["address"]))


def resolve_pnu(address):
    """Search the complete parcel address when Onbid's identifier disagrees."""
    target = parcel_address(address)
    if not target:
        return None
    result = request_json("/req/search", {
        "service": "search", "request": "search", "query": target["address"],
        "type": "ADDRESS", "category": "parcel", "size": 5, "page": 1, "crs": "EPSG:4326",
    })
    for item in result.get("items") or []:
        pnu = str(item.get("id") or "")
        if valid_pnu(pnu) and same_lot((item.get("address") or {}).get("parcel"), target):
            suffix = ("2" if target["mountain"] else "1") + f'{target["main"]:04d}{target["sub"]:04d}'
            if pnu[10:] == suffix:
                return pnu
    return None


def valid_geometry(geometry):
    if not isinstance(geometry, dict) or geometry.get("type") not in ("Polygon", "MultiPolygon"):
        return False
    polygons = [geometry.get("coordinates")] if geometry["type"] == "Polygon" else geometry.get("coordinates")
    if not isinstance(polygons, list) or not polygons:
        return False
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            return False
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4 or ring[0] != ring[-1]:
                return False
            for point in ring:
                if not isinstance(point, list) or len(point) < 2:
                    return False
                if any(isinstance(n, bool) or not isinstance(n, (int, float)) or not math.isfinite(n) for n in point[:2]):
                    return False
                if not (124 <= point[0] <= 132 and 33 <= point[1] <= 39.5):
                    return False
            if len({tuple(p[:2]) for p in ring}) < 3:
                return False
    return True


def verified_feature(feature, pnu, address, source="VWorld 연속지적도"):
    props = feature.get("properties") or {}
    if str(props.get("pnu") or props.get("PNU") or "") != pnu or not valid_geometry(feature.get("geometry")):
        return None
    supplied_address = props.get("addr") or props.get("address")
    if supplied_address and not same_lot(supplied_address, parcel_address(address)):
        return None
    return {
        "type": "Feature",
        "properties": {"pnu": pnu, "address": address, "source": source,
                       "verified_at": datetime.now(timezone.utc).isoformat()},
        "geometry": feature["geometry"],
    }


def fetch_parcel(pnu, address):
    result = request_json("/req/data", {
        "service": "data", "request": "GetFeature", "data": "LP_PA_CBND_BUBUN",
        "size": 1, "page": 1, "attrFilter": "pnu:=:" + pnu,
        "geometry": "true", "attribute": "true", "crs": "EPSG:4326",
    })
    for feature in (result.get("featureCollection") or {}).get("features") or []:
        verified = verified_feature(feature, pnu, address)
        if verified:
            return verified
    return None


def representative_point(geometry):
    polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
    points = [point for polygon in polygons for point in polygon[0]]
    # A display reference for a verified polygon, not a road entrance.
    return [(min(p[1] for p in points) + max(p[1] for p in points)) / 2,
            (min(p[0] for p in points) + max(p[0] for p in points)) / 2]


_SEARCH_CLIENT = None
_SEARCH_HEADERS = {}


class _SearchMeta(HTMLParser):
    def __init__(self):
        super().__init__()
        self.values = {}

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "meta" and attrs.get("name") in ("_csrf", "_csrf_header"):
            self.values[attrs["name"]] = attrs.get("content", "")


def resolve_gyeonggi_pnu(address):
    """Use the public portal's exact address search, retaining its CSRF checks."""
    global _SEARCH_CLIENT, _SEARCH_HEADERS
    target = parcel_address(address)
    if not target:
        return None
    try:
        if _SEARCH_CLIENT is None:
            client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
            with client.open("https://gris.gg.go.kr/map/main/grisMapView.do", timeout=25) as response:
                parser = _SearchMeta()
                parser.feed(response.read().decode("utf-8", errors="replace"))
            headers = {"Referer": "https://gris.gg.go.kr/map/main/grisMapView.do",
                       "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                       "X-Requested-With": "XMLHttpRequest"}
            if parser.values.get("_csrf") and parser.values.get("_csrf_header"):
                headers[parser.values["_csrf_header"]] = parser.values["_csrf"]
            _SEARCH_CLIENT, _SEARCH_HEADERS = client, headers
        word = target["address"]
        params = {"param1": "*", "param2": "onestop.onestop", "param3": 0, "param4": 20,
                  "param5": "UTF-8", "param6": "gris.gg.go.kr@onestop~guest$||1|제목^" + chr(36) + "{" + word + "}",
                  "param7": "onestop", "param8": "text_idx", "param9": word}
        request = urllib.request.Request("https://gris.gg.go.kr/srch/selectSearchList.do",
                                         data=urllib.parse.urlencode(params).encode(), headers=_SEARCH_HEADERS)
        with _SEARCH_CLIENT.open(request, timeout=25) as response:
            data = json.load(response)
        if isinstance(data, str):
            data = json.loads(data)
    except urllib.error.HTTPError as exc:
        raise ProviderError("HTTP_" + str(exc.code)) from None
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        raise ProviderError("NETWORK_ERROR") from None
    except (ValueError, TypeError):
        raise ProviderError("INVALID_RESPONSE") from None
    result = data.get("result") if isinstance(data, dict) else None
    if not isinstance(result, dict) or not isinstance(result.get("rows"), list):
        raise ProviderError("INVALID_RESPONSE")
    suffix = ("2" if target["mountain"] else "1") + f'{target["main"]:04d}{target["sub"]:04d}'
    for row in result["rows"]:
        fields = row.get("fields") or {}
        pnu = str(fields.get("pnu") or "")
        if valid_pnu(pnu) and pnu[10:] == suffix and same_lot(fields.get("jibun_nm"), target):
            return pnu
    return None


def fetch_gyeonggi_parcel(pnu, address):
    """Public Gyeonggi cadastral query; no API key or browser session required."""
    if not valid_pnu(pnu) or not pnu.startswith("41"):
        return None
    base = "https://gris.gg.go.kr:8888/grisgis/rest/services/bdsMap_Cbnd/MapServer/2/query"
    # This ArcGIS service does not support pagination. Equality on the full
    # validated PNU selects the parcel without a resultRecordCount parameter.
    params = {"f": "geojson", "where": "PNU='" + pnu + "'", "outFields": "PNU,JIBUN",
              "returnGeometry": "true", "outSR": "4326"}
    request = urllib.request.Request(base + "?" + urllib.parse.urlencode(params),
                                    headers={"User-Agent": "LandScout/1.0 (https://github.com/Mylesemi/land-scout)"})
    try:
        with urllib.request.urlopen(request, timeout=25) as response:
            data = json.load(response)
    except urllib.error.HTTPError as exc:
        raise ProviderError("HTTP_" + str(exc.code)) from None
    except (urllib.error.URLError, ConnectionError, TimeoutError, OSError):
        raise ProviderError("NETWORK_ERROR") from None
    except (ValueError, TypeError):
        raise ProviderError("INVALID_RESPONSE") from None
    if not isinstance(data, dict) or data.get("error"):
        raise ProviderError("INVALID_RESPONSE")
    if data.get("type") != "FeatureCollection" or not isinstance(data.get("features"), list):
        raise ProviderError("INVALID_RESPONSE")
    for feature in data["features"]:
        checked = verified_feature(feature, pnu, address, "경기부동산포털 연속지적도")
        if checked:
            jibun = str(feature.get("properties", {}).get("JIBUN") or "")
            number = re.match(r"^(산\s*)?(\d+)(?:-(\d+))?(?=\s|$)", jibun)
            target = parcel_address(address)
            if jibun and (not number or not target or
                          (bool(number[1]), int(number[2]), int(number[3] or 0)) !=
                          (target["mountain"], target["main"], target["sub"])):
                continue
            checked["properties"]["source_url"] = "https://gris.gg.go.kr/map/main/grisMapView.do?mapCd=01&pnu=" + pnu
            checked["properties"]["provider_jibun"] = str(feature.get("properties", {}).get("JIBUN") or "")
            return checked
    return None


def main():
    data = json.loads(INPUT.read_text(encoding="utf-8"))
    previous = json.loads(OUTPUT.read_text(encoding="utf-8")) if OUTPUT.exists() else {}
    cached = {str(f.get("properties", {}).get("pnu")): f for f in previous.get("features", [])
              if valid_pnu(f.get("properties", {}).get("pnu")) and valid_geometry(f.get("geometry"))}
    features, errors, attempts, unresolved, deferred = {}, {}, 0, 0, 0
    failures = {"gyeonggi": 0, "gyeonggi_search": 0, "vworld": 0}
    resolved_addresses, attempted_parcels = {}, {}
    addresses = {(parcel_address(x.get("name")) or parcel_address(x.get("address")) or {}).get("address")
                 for x in data.get("items", [])}
    lookup_history = {k: v for k, v in (previous.get("lookup_attempts") or {}).items() if k in addresses}
    ordered = sorted(data.get("items", []),
                     key=lambda x: lookup_history.get((parcel_address(x.get("name")) or parcel_address(x.get("address")) or {}).get("address"), ""))

    def record_error(provider, exc):
        code = provider.upper() + "_" + str(exc)
        errors[code] = errors.get(code, 0) + 1
        failures[provider] += 1
        if re.search("KEY|DOMAIN|AUTH", str(exc)):
            failures[provider] = 3
        print("Cadastral provider unavailable:", code, flush=True)

    for item in ordered:
        target = parcel_address(item.get("name")) or parcel_address(item.get("address"))
        if not target:
            item["pnu"], item["parcel_status"] = None, "address_unresolved"
            unresolved += 1
            continue
        address = target["address"]
        raw = item.get("provider_pnu") or item.get("pnu")
        item["provider_pnu"] = raw
        pnu = candidate_pnu(raw, address)
        if not pnu:
            # Reuse a previously verified full-address match before any lookup.
            pnu = next((key for key, feature in cached.items()
                        if same_lot(feature.get("properties", {}).get("address"), target)), None)
        if not pnu:
            if address not in resolved_addresses:
                resolved_addresses[address] = None
                if failures["gyeonggi_search"] < 3 and attempts < MAX_REQUESTS:
                    attempts += 1
                    lookup_history[address] = datetime.now(timezone.utc).isoformat()
                    try:
                        resolved_addresses[address] = resolve_gyeonggi_pnu(address)
                    except ProviderError as exc:
                        record_error("gyeonggi_search", exc)
                if not resolved_addresses[address] and KEY and failures["vworld"] < 3 and attempts < MAX_REQUESTS:
                    attempts += 1
                    try:
                        resolved_addresses[address] = resolve_pnu(address)
                    except ProviderError as exc:
                        record_error("vworld", exc)
            pnu = resolved_addresses[address]
        item["pnu"] = pnu
        feature = features.get(pnu) or cached.get(pnu)
        if feature and not same_lot(feature.get("properties", {}).get("address"), target):
            feature = None
        if not feature and pnu and pnu not in attempted_parcels and attempts < MAX_REQUESTS:
            attempted_parcels[pnu] = None
            lookup_history[address] = datetime.now(timezone.utc).isoformat()
            if failures["gyeonggi"] < 3:
                attempts += 1
                try:
                    attempted_parcels[pnu] = fetch_gyeonggi_parcel(pnu, address)
                except ProviderError as exc:
                    record_error("gyeonggi", exc)
            if not attempted_parcels[pnu] and KEY and failures["vworld"] < 3 and attempts < MAX_REQUESTS:
                attempts += 1
                try:
                    attempted_parcels[pnu] = fetch_parcel(pnu, address)
                except ProviderError as exc:
                    record_error("vworld", exc)
        feature = feature or attempted_parcels.get(pnu)
        if feature:
            features[pnu] = feature
            item["lat"], item["lng"] = representative_point(feature["geometry"])
            item["location_precision"] = "parcel"
            item["geocode_source"] = feature["properties"]["source"]
            item["parcel_status"] = "verified"
        else:
            pending = attempts >= MAX_REQUESTS and (not pnu or pnu not in attempted_parcels)
            deferred += int(pending)
            item["parcel_status"] = "pending" if pending else "provider_error" if errors else "not_found"
            unresolved += 1
    report = {
        "status": "partial" if errors and features else "provider_error" if errors else "pending" if deferred else "complete",
        "checked_at": datetime.now(timezone.utc).isoformat(), "key_configured": bool(KEY),
        "primary_provider": "경기부동산포털",
        "verified_parcels": len(features), "verified_items": sum(x.get("parcel_status") == "verified" for x in data.get("items", [])),
        "unresolved_items": unresolved, "requests": attempts, "deferred_items": deferred, "errors": errors,
    }
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(json.dumps({"type": "FeatureCollection", "features": list(features.values()), "sync": report,
                                 "lookup_attempts": lookup_history},
                                 ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    data["parcels"] = report
    INPUT.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("Cadastral boundary sync:", json.dumps(report, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
