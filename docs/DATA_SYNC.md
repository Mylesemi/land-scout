# LAND SCOUT data sync

This is a fail-closed integration scaffold. It does **not** claim that Onbid records are being imported yet.

## GitHub setup

Repository Settings → Secrets and variables → Actions:
- Secret: `DATA_GO_KR_API_KEY` (paste the issued key, never commit it).
- Variable: `ONBID_LIST_ENDPOINT` (the exact HTTPS request URL shown in the API documentation, without the key).

Actions → Sync Onbid auctions → Run workflow. The first run intentionally fails after reporting the top-level response schema. The exact Onbid API product, response field names, pagination, auction status, and land classification must be verified before enabling publication. Never post your API key or the full authenticated request URL in an issue or chat.

GitHub Pages only hosts static files; `data/auctions.json` is a generated static snapshot. If collection fails, previously verified data remains unchanged. Drive times, water, sewer, solar yield and legal access remain unverified unless independently sourced.
