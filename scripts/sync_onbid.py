"""Onbid API connectivity diagnostics; never publishes unverified records."""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

key = os.getenv("DATA_GO_KR_API_KEY", "").strip()
endpoint = os.getenv("ONBID_LIST_ENDPOINT", "").strip() or "https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2"
if not key:
    sys.exit("Missing DATA_GO_KR_API_KEY GitHub Actions secret")
parsed = urllib.parse.urlparse(endpoint)
if parsed.scheme != "https" or parsed.hostname != "apis.data.go.kr":
    sys.exit("Only https://apis.data.go.kr endpoints are allowed")

# Do not print request URL or exception text containing serviceKey.
# Required by the real-estate list API metadata: prptDivCd and pvctTrgtYn.
# Default code values are provisional and must be validated with the provider's code table.
params = {
    "serviceKey": key,
    "pageNo": "1",
    "numOfRows": "10",
    "prptDivCd": os.getenv("ONBID_PRPT_DIV_CD", "0001"),
    "pvctTrgtYn": os.getenv("ONBID_PVCT_TRGT_YN", "N"),
}
url = endpoint + ("&" if "?" in endpoint else "?") + urllib.parse.urlencode(params)
req = urllib.request.Request(url, headers={"Accept": "application/json, application/xml", "User-Agent": "LAND-SCOUT/1"})
try:
    with urllib.request.urlopen(req, timeout=30) as res:
        status = res.status
        raw = res.read(1_000_000)
        content_type = res.headers.get("Content-Type", "")
except urllib.error.HTTPError as e:
    sys.exit(f"Onbid HTTP error {e.code}. Check operation URL, request parameters and API authorization.")
except Exception as e:
    sys.exit(f"Onbid network error: {type(e).__name__} (request URL and key hidden)")
print(f"HTTP {status}; content-type {content_type.split(';')[0]}; bytes {len(raw)}")
try:
    payload = json.loads(raw)
    if not isinstance(payload, dict):
        sys.exit("Unexpected JSON root (not an object)")
    print("JSON top-level fields:", ", ".join(list(payload)[:15]))
    response = payload.get("response", {})
    if isinstance(response, dict):
        header = response.get("header", {})
        if isinstance(header, dict):
            print("API resultCode:", str(header.get("resultCode", "unknown"))[:50])
            print("API resultMsg:", str(header.get("resultMsg", "unknown"))[:150])
            if str(header.get("resultCode", "")) == "03":
                print("NODATA: current query returned no records. No publication or overwrite.")
            elif str(header.get("resultCode", "")) not in ("", "00", "0"):
                sys.exit("API reported an error; publication blocked")
except (ValueError, UnicodeDecodeError):
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        sys.exit("Neither JSON nor valid XML response; check operation and required parameters")
    print("XML root:", root.tag)
    code = root.findtext(".//resultCode") or root.findtext(".//returnReasonCode")
    message = root.findtext(".//resultMsg") or root.findtext(".//returnAuthMsg")
    print("API resultCode:", str(code)[:50])
    print("API resultMsg:", str(message)[:150])
    if code == "03":
        print("NODATA: current query returned no records. No publication or overwrite.")
    elif code and code not in ("00", "0"):
        sys.exit("API reported an error; publication blocked")
print("Connectivity response parsed. Auction publication is disabled until official item schema and required filters are validated.")
