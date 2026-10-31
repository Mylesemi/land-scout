# LAND SCOUT — official Onbid API setup

## Confirmed API service bases (provided by the account owner)
- Real-estate list: `https://apis.data.go.kr/B010003/OnbidRlstListSrvc2`
- Announcement details: `https://apis.data.go.kr/B010003/OnbidPbancDtlnfSrvc2`

A **base URL is not a callable operation URL**. The list operation is reported as `getRlstCltrList2` in a public third-party integration; verify it against the official data.go.kr API specification before running. The announcement-detail operation name and its required parameters are not yet verified. Do not guess them.

## GitHub configuration
Repository Settings → Secrets and variables → Actions:
- Secret `DATA_GO_KR_API_KEY`: issued service key (never paste into public files or chat).
- Variable `ONBID_LIST_ENDPOINT`: **complete verified operation URL**, not the service base URL.
- Variable `ONBID_DETAIL_ENDPOINT`: complete verified announcement-detail operation URL (not used by current scaffold).

## Current implementation status
The scheduled workflow and conservative importer exist, but importer **intentionally does not publish records** until the actual response schema, pagination, land classification, auction status, and price fields are mapped and tested. The importer currently assumes common `serviceKey`, `pageNo`, `numOfRows`, `type` request parameter names only as a probe; these must also be checked against the official operation specification.

Never use an API response error as an empty successful inventory. Existing validated data should remain intact on failures.

## Next verification
Use the data.go.kr API page's Swagger/상세기능정보 section or the downloadable official API guide to confirm:
1. Real-estate list operation path and mandatory query parameters.
2. JSON/XML response envelope and item array location.
3. Region, property type, price, status and pagination fields.
4. Announcement detail operation path and `pbancMngNo` linkage.
5. Rate limits and data freshness.

The frontend is currently a manual-import dashboard; it does not yet load `data/auctions.json` automatically.
