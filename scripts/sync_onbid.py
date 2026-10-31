"""Conservative Onbid importer. Never fabricate auction data.
Configure exact official endpoint and field mapping after inspecting a real API response.
"""
import json, os, sys, urllib.parse, urllib.request
from pathlib import Path

DEST = Path("data/auctions.json")
key = os.getenv("DATA_GO_KR_API_KEY", "").strip()
endpoint = os.getenv("ONBID_LIST_ENDPOINT", "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2").strip()
if not key or not endpoint:
    sys.exit("Configuration missing: DATA_GO_KR_API_KEY secret")
if not endpoint.startswith("https://"):
    sys.exit("Endpoint must use HTTPS")
if not ("onbid" in urllib.parse.urlparse(endpoint).hostname.lower() or "data.go.kr" in urllib.parse.urlparse(endpoint).hostname.lower()):
    sys.exit("Endpoint host must be official Onbid or data.go.kr")

# Different Onbid API products expose different query parameters and result schemas.
# Fetch one response for schema validation; do not publish ambiguous records.
params = {"serviceKey": key, "pageNo": "1", "numOfRows": "100", "type": "json"}
url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "LandScout/2"})
try:
    with urllib.request.urlopen(req, timeout=25) as response:
        body = response.read(2_000_000)
    payload = json.loads(body)
except Exception as exc:
    sys.exit(f"API request or JSON decoding failed (existing published data preserved): {type(exc).__name__}: {exc}")

# Deliberately stop before publishing until response field mapping is verified.
# Prevents silently treating errors, wrong item types, or incomplete pagination as real inventory.
print("API reachable; top-level response keys:", list(payload)[:15] if isinstance(payload, dict) else type(payload).__name__)
print("API connectivity probe completed. Publication remains disabled pending verified field mapping.")
