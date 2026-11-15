# LAND SCOUT 데이터 수집과 검증

배포: https://mylesemi.github.io/land-scout/

GitHub Pages는 정적 파일을 표시하고, GitHub Actions가 온비드 매각 후보와 지도 정보를 갱신합니다. 브라우저에는 API 인증키를 전달하지 않습니다.

## 수집 범위

- 온비드 부동산 목록 API의 경기도, 매각, 최저입찰가 1억원 이하 조건을 서버에 전달합니다.
- 재산유형 9종을 함께 요청하고 입찰·수의계약 가능 물건을 모두 확인합니다.
- 응답의 용도 분류와 토지·건물 면적을 대조해 토지 및 주택만 남깁니다.
- lowstBidPrcIndctCont의 현재 최저입찰가를 사용합니다. 최초 예정가 frstBidPrc로 대체하지 않으며 비공개·해석 불가능한 금액은 게시하지 않습니다.
- 물건관리번호와 공매조건번호를 함께 저장합니다. 화면에서는 같은 물건의 일정을 묶고 가장 가까운 유효 일정을 먼저 보여줍니다. 후속 회차의 가격은 일정표에서 구분합니다.
- 기본 수집은 N/Y 각각 4페이지, 전체 8페이지입니다. 페이지가 남아 있으면 collection.partial=true로 기록하고 화면에도 일부 수집이라고 표시합니다. 전체 재고를 수집했다고 표시하지 않습니다.
- 정상적인 무자료 응답은 빈 목록으로 반영합니다. 오류 응답을 정상적인 빈 목록으로 해석하지 않습니다.

## 실행 순서

.github/workflows/sync-onbid.yml

1. Python 및 JavaScript 회귀 테스트
2. scripts/sync_onbid.py: 공식 목록 수집
3. scripts/sync_parcels.py: 주소·지번·도형 대조
4. scripts/enrich_locations.py: 미확인 위치에 한해 캐시와 OSM 참고 위치 보완
5. data/auctions.json, data/geocode_cache.json, data/parcels.geojson 커밋
6. GitHub Pages 자동 배포

기존 스케줄은 매일 **한국시간 09:20**입니다. Actions의 **Sync Onbid auctions → Run workflow**로 수동 실행할 수도 있습니다. 화면의 새로고침은 이미 게시된 최신 파일을 다시 가져옵니다.

## 인증 설정

GitHub 저장소 Settings → Secrets and variables → Actions:

| 종류 | 이름 | 용도 |
| --- | --- | --- |
| Secret | DATA_GO_KR_API_KEY | 공공데이터포털 온비드 API 키 |
| Secret | VWORLD_API_KEY | 선택 사항. VWorld 보조 경계·주소 조회 키 |
| Variable | ONBID_LIST_ENDPOINT | 선택 사항. 기본값은 아래 공식 목록 operation |
| Variable | VWORLD_API_DOMAIN | 키에 등록한 도메인. 기본값 https://mylesemi.github.io |

기본 목록 operation:
https://apis.data.go.kr/B010003/OnbidRlstListSrvc2/getRlstCltrList2

ONBID_DETAIL_ENDPOINT는 현재 수집기가 사용하지 않습니다.

## 필지 경계 검증

경기도 공식 경기부동산포털의 공개 연속지적도 REST 서비스에서 먼저 조회합니다. API 키와 로그인 없이 PNU 동등 조건으로 도형과 지번만 요청하며 좌표계는 EPSG:4326입니다. 확인된 PNU와 JIBUN을 매물 지번과 대조하고 출처 및 공식 지적도 링크를 함께 저장합니다. 공개 서비스가 제공하지 않는 도형은 선택적으로 VWorld에서 보완합니다. 주소 검색은 사이트의 일반 공개 검색과 같은 세션·CSRF 검증 절차를 사용하며 로그인 정보나 토큰을 파일에 저장하지 않습니다.

공개 서비스의 query는 페이지 분할을 지원하지 않으므로 resultRecordCount 등을 붙이지 않습니다. 전체 필지 목록 대신 대상 물건의 PNU 1개만 조회합니다.

- 온비드 원본 식별자는 provider_pnu에 보존합니다.
- 응답에서 관측된 일반/산 구분값을 그대로 신뢰하지 않고 매물명의 지번과 대조해 표준 19자리 PNU 후보를 만듭니다. 본번·부번이 다르면 그 식별자는 사용하지 않습니다.
- 후보가 없는 경우 경기부동산포털의 공개 주소 검색에서 전체 지번이 일치하는 식별자를 찾고, 필요한 경우 VWorld 주소 검색으로 보완합니다. 다른 시·군의 같은 동 이름이나 인근 번지는 허용하지 않습니다.
- 보조 조회에서는 VWorld 연속지적도 LP_PA_CBND_BUBUN에 attrFilter=pnu:=:<PNU>를 전달합니다. 응답 PNU, 주소(제공된 경우), Polygon/MultiPolygon 좌표를 검증한 도형만 게시합니다.
- 경계 중심은 지도 표시용입니다. 도로 진입점이나 실주행 경로의 검증 좌표로 취급하지 않습니다.
- 확인된 도형은 보존합니다. 미확인 필지를 면적에 맞춘 사각형이나 원으로 대신 그리지 않습니다.
- 조회는 기본 150건으로 제한하며 PARCEL_REQUEST_BUDGET 환경변수(기존 VWORLD_REQUEST_BUDGET도 지원)로 1~200 사이에서 조정할 수 있습니다. 조회 이력을 저장해 다음 실행에서는 아직 조회하지 않은 주소부터 이어갑니다.
- 같은 제공처에서 3건의 오류가 발생하면 그 제공처 요청을 중단합니다. VWorld 오류가 경기부동산포털 조회까지 중단시키지 않으며 인증 오류도 무한 재시도하지 않습니다.
- parcels.sync와 auctions.parcels에 조회 상태, 요청 수, 미확인 수, 키를 포함하지 않는 오류 코드를 기록합니다.

| 상태 | 의미 |
| --- | --- |
| complete | 이번 실행의 조회가 끝남. 모든 매물의 경계를 찾았다는 뜻은 아님 |
| pending | 요청 예산에 도달해 다음 실행으로 이어짐 |
| partial | 제공처 오류가 있었으나 확인된 도형이 있음 |
| provider_error | 제공처 연결·응답 오류로 신규 경계를 확인하지 못함 |


2026-11-15 실행에서는 온비드 수집은 성공했으나 VWorld HTTPS 조회에 네트워크 오류와 HTTP 502가 발생했습니다. 이후 경기부동산포털의 공개 도형 조회를 우선 사용하는 경로를 연결했습니다. VWorld 보조 조회가 실패해도 키 없이 확인한 필지 도형을 유지하고 나머지 물건 대조를 이어갑니다.

## 위치·정보 표시

- 청록 구획: 확인된 연속지적도
- 파란 마커: 정확한 지번 위치가 별도로 확인된 좌표
- 노란 점선 마커: 행정구역 참고 위치. 같은 좌표는 묶어서 표시
- 좌표 없음: 목록과 지번 지도 검색만 제공
- 지분 매각과 여러 필지의 대표 경계를 구분해서 표시

OSM Nominatim은 캐시를 사용하고 1초 이상 간격으로 소량만 조회합니다. VWorld에서 확인한 좌표를 OSM 보완 단계가 지우지 않습니다.

서천 힐스테이트의 정확한 출입구 좌표, 실주행 30분, 진입도로, 상하수도, 일조 및 전력계통 연계는 아직 검증되지 않았습니다. 이를 적합 판정에 사용하지 않습니다.

## 검증 명령

저장소 루트에서:

~~~sh
python -m unittest discover -s tests -p "test_*.py" -v
node --check app.js
node --test tests/test_frontend.cjs
~~~

UI 확인 범위: 주소 검색, 종류·지분·가격·위치 필터, 정렬, 일정 묶음, 24건 페이지 이동, 마커 선택 연동, 가상 도형을 사용한 경계 확대. 가상 도형은 테스트 미리보기에만 사용하며 운영 데이터에 포함하지 않습니다.

## 공식 문서

- [공공데이터포털: 차세대 온비드 부동산 물건목록](https://www.data.go.kr/data/15157207/openapi.do)
- [경기부동산포털 지도서비스](https://gris.gg.go.kr/map/main/grisMapView.do)\n- [VWorld 공식 코드 샘플](https://github.com/V-world/V-world_API_sample)
- [Nominatim 사용 정책](https://operations.osmfoundation.org/policies/nominatim/)
