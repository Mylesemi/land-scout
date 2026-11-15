'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '미확인').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => Number(value).toLocaleString('ko-KR') + '원';
const pnuValid = value => /^\d{10}[12]\d{8}$/.test(String(value || ''));
const recordKey = lot => String(lot.lot_id) + ':' + String(lot.condition_id || '');
const point = lot => {
  if (lot.lat == null || lot.lng == null) return null;
  const lat = Number(lot.lat), lng = Number(lot.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132 ? [lat, lng] : null;
};
const {bidTimestamp,groupLots} = LandScoutData;
function fmtBid(value) {
  const time = bidTimestamp(value);
  return Number.isFinite(time) ? new Intl.DateTimeFormat('ko-KR', {timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(time) : '미확인';
}
function geometryValid(feature) {
  if (!feature || !pnuValid(feature.properties?.pnu)) return false;
  const geometry = feature.geometry;
  if (!geometry || !['Polygon','MultiPolygon'].includes(geometry.type)) return false;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return Array.isArray(polygons) && polygons.length > 0 && polygons.every(polygon =>
    Array.isArray(polygon) && polygon.length > 0 && polygon.every(ring =>
      Array.isArray(ring) && ring.length >= 4 && ring.every(p =>
        Array.isArray(p) && p.length >= 2 && p.slice(0,2).every(v => typeof v === 'number' && Number.isFinite(v)) &&
        p[0] >= 124 && p[0] <= 132 && p[1] >= 33 && p[1] <= 39.5
      ) && ring[0][0] === ring[ring.length-1][0] && ring[0][1] === ring[ring.length-1][1]
    )
  );
}

let lots = [], visibleLots = [], parcelShapes = new Map(), currentData = null;
let selectedKey = null, loading = false, map = null, layer = null;
let featureLayers = new Map(), cardNodes = new Map(), mapEntries = [], allBounds = null;
let loadFailed = false, parcelLoadFailed = false, page = 1;
const PAGE_SIZE = 24;

if (window.L) {
  try {
    map = L.map('map', {scrollWheelZoom:false}).setView([37.237,127.072],10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom:19, attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    L.circleMarker([37.237,127.072], {radius:6,color:'#ffcf6e',fillOpacity:.5}).addTo(map).bindPopup('서천동 근사 기준점 · 출입구 위치 미확인');
  } catch (error) {
    map = null;
  }
}
const locationType = lot => parcelShapes.has(String(lot.pnu)) ? 'parcel' : !point(lot) ? 'unknown' : lot.location_precision === 'exact' ? 'exact' : 'area';
const locationLabel = {parcel:'필지 경계 확인',exact:'지번 위치 확인',area:'지역 참고 위치',unknown:'위치 미확인'};

function addTag(parent, text, type) {
  const tag = document.createElement('span');
  tag.className = 'badge ' + (type || '');
  tag.textContent = text;
  parent.append(tag);
}
function chooseRows() {
  const query = $('search').value.trim().toLocaleLowerCase('ko-KR');
  const inputPrice = $('price').value.trim();
  const cap = inputPrice === '' ? 100000000 : Math.max(0, Math.min(100000000, Number(inputPrice) || 0));
  const kind = $('kind').value, precision = $('location').value;
  const rows = lots.filter(lot => lot.min_price <= cap &&
    (kind === 'all' || lot.property_type === kind) &&
    (precision === 'all' || precision === 'exact' && ['exact','parcel'].includes(locationType(lot)) || precision === locationType(lot)) &&
    (!$('excludeShares').checked || !lot.share) &&
    (!query || [lot.name,lot.address,lot.lot_id,lot.category].join(' ').toLocaleLowerCase('ko-KR').includes(query))
  );
  const ranks = {parcel:0,exact:1,area:2,unknown:3};
  return rows.sort((a,b) => {
    if ($('sort').value === 'closing') return (bidTimestamp(a.bid_end) || Infinity) - (bidTimestamp(b.bid_end) || Infinity) || a.min_price - b.min_price;
    if ($('sort').value === 'price') return a.min_price - b.min_price;
    return ranks[locationType(a)] - ranks[locationType(b)] || a.min_price - b.min_price;
  });
}
function markerIcon(entry, selected) {
  const kind = entry.type === 'area' ? 'approx' : entry.type === 'parcel' ? 'parcel' : '';
  const group = entry.rows.length > 1;
  return L.divIcon({
    className:'',
    html:'<div class="lot-pin ' + kind + (group ? ' group' : '') + (selected ? ' selected' : '') + '">' + (group ? entry.rows.length + '건' : entry.rows[0].number) + '</div>',
    iconSize:[group ? 48 : 36,36], iconAnchor:[group ? 24 : 18,18]
  });
}
function popupContent(rows, type) {
  return '<strong>' + locationLabel[type] + '</strong>' + (type === 'area' ? '<p>행정구역의 참고 위치입니다.<br>실제 매물 위치는 지번으로 확인하세요.</p>' : '') +
    rows.map(row => '<button type="button" class="popup-lot" data-record="' + esc(row.key) + '">' + row.number + '. ' + esc(row.lot.address) + '<br>' + money(row.lot.min_price) + '</button>').join('');
}
function updateSelection() {
  cardNodes.forEach((node,key) => {
    node.classList.toggle('active',key === selectedKey);
    node.querySelector('.map-button')?.setAttribute('aria-pressed',String(key === selectedKey));
  });
  mapEntries.forEach(entry => {
    const selected = entry.rows.some(row => row.key === selectedKey);
    if (entry.marker) entry.marker.setIcon(markerIcon(entry,selected));
    if (entry.outline) entry.outline.setStyle({weight:selected ? 5 : 3,fillOpacity:selected ? .34 : .2,color:selected ? '#8affed' : '#35d6c4'});
  });
}
function focusLot(key, reveal) {
  if (reveal && !cardNodes.has(key)) {
    const index=visibleLots.findIndex(lot=>recordKey(lot)===key);
    if (index>=0) { page=Math.floor(index/PAGE_SIZE)+1; render(); }
  }
  const entry = featureLayers.get(key);
  if (!map || !entry) return;
  selectedKey = key;
  updateSelection();
  if (entry.outline) map.fitBounds(entry.outline.getBounds().pad(.35),{maxZoom:18,animate:false});
  else map.setView(entry.marker.getLatLng(),entry.type === 'area' ? 13 : 17,{animate:false});
  (entry.marker || entry.outline).openPopup();
  const row = entry.rows.find(row => row.key === key);
  $('mapNotice').textContent = locationLabel[entry.type] + ' · ' + row.lot.address + (row.lot.share ? ' · 필지 전체 중 지분 매각' : '');
  if (reveal) cardNodes.get(key)?.scrollIntoView({block:'nearest',behavior:'auto'});
}
function fitAll() {
  if (map && allBounds?.isValid()) map.fitBounds(allBounds.pad(.15),{maxZoom:18,animate:false});
  const types = visibleLots.map(locationType);
  $('mapNotice').textContent = !map ? '지도를 불러오지 못했습니다. 매물의 지도 검색 링크를 이용하세요.' :
    '필지 경계 ' + types.filter(x=>x==='parcel').length + ' · 지번 위치 ' + types.filter(x=>x==='exact').length + ' · 지역 참고 ' + types.filter(x=>x==='area').length + ' · 미확인 ' + types.filter(x=>x==='unknown').length;
}
function renderMap(rows) {
  featureLayers.clear();
  mapEntries = [];
  allBounds = null;
  if (!map || !layer) { fitAll(); return; }
  layer.clearLayers();
  allBounds = L.latLngBounds([]);
  const groups = new Map();
  rows.forEach((lot,index) => {
    const type = locationType(lot), coords = point(lot);
    if (type === 'unknown') return;
    const groupKey = type === 'parcel' ? 'pnu:' + lot.pnu : type + ':' + coords.map(n=>n.toFixed(6)).join(',');
    if (!groups.has(groupKey)) groups.set(groupKey,{type,coords,pnu:lot.pnu,rows:[]});
    groups.get(groupKey).rows.push({lot,key:recordKey(lot),number:index+1});
  });
  groups.forEach(entry => {
    if (entry.type === 'parcel') {
      try {
        entry.outline = L.geoJSON(parcelShapes.get(String(entry.pnu)),{
          style:{color:'#35d6c4',weight:3,fillColor:'#5ae3d0',fillOpacity:.2}
        }).addTo(layer);
        const bounds = entry.outline.getBounds();
        if (!bounds.isValid()) throw new Error('Invalid bounds');
        entry.coords = [bounds.getCenter().lat,bounds.getCenter().lng];
        allBounds.extend(bounds);
        entry.outline.bindPopup(popupContent(entry.rows,entry.type));
      } catch (error) { return; }
    } else allBounds.extend(entry.coords);
    entry.marker = L.marker(entry.coords, {icon:markerIcon(entry,false),title:locationLabel[entry.type] + ' · ' + entry.rows.map(row=>row.number).join(', ')}).addTo(layer);
    entry.marker.bindPopup(popupContent(entry.rows,entry.type)).bindTooltip(locationLabel[entry.type] + ' · ' + entry.rows.length + '건',{direction:'top',className:'lot-tooltip'});
    entry.marker.on('click',()=>{
      selectedKey = entry.rows[0].key;
      updateSelection();
    });
    entry.rows.forEach(row=>featureLayers.set(row.key,entry));
    mapEntries.push(entry);
  });
  fitAll();
}
function render() {
  visibleLots = chooseRows();
  $('count').textContent = visibleLots.length + ' / ' + lots.length + '건';
  const pages=Math.max(1,Math.ceil(visibleLots.length/PAGE_SIZE));
  page=Math.min(page,pages);
  $('pageInfo').textContent=page+' / '+pages+'페이지';
  $('previous').disabled=page<=1; $('next').disabled=page>=pages;
  const list = $('list');
  list.replaceChildren();
  cardNodes.clear();
  if (!visibleLots.some(lot=>recordKey(lot)===selectedKey)) selectedKey = null;
  if (!visibleLots.length) {
    const message = document.createElement('p');
    message.className = 'empty';
    message.textContent = loading ? '공매 데이터를 불러오는 중…' : loadFailed && !lots.length ? '데이터를 불러오지 못했습니다. 새로고침을 눌러 다시 확인해 주세요.' : lots.length ? '검색 조건에 맞는 물건이 없습니다.' : '현재 수집 범위에 해당하는 매각 후보가 없습니다.';
    if (lots.length) {
      message.append(document.createElement('br'));
      const reset = document.createElement('button');
      reset.type = 'button'; reset.textContent = '조건 초기화'; reset.addEventListener('click',resetFilters);
      message.append(reset);
    }
    list.append(message);
  }
  visibleLots.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).forEach((lot,offset) => {
    const index=(page-1)*PAGE_SIZE+offset;
    const type = locationType(lot), key = recordKey(lot);
    const card = document.createElement('article');
    card.className = 'lot'; card.dataset.record = key;
    const top = document.createElement('div'); top.className = 'lot-top';
    const tags = document.createElement('div'); tags.className = 'badges';
    addTag(tags,lot.property_type || '종류 미확인');
    addTag(tags,locationLabel[type],type);
    if (lot.share) addTag(tags,'지분 매각','share');
    if (lot.multiple_parcels) addTag(tags,'여러 필지 · 대표필지');
    const number = document.createElement('span'); number.className = 'lot-number'; number.textContent = String(index+1).padStart(2,'0');
    top.append(tags,number); card.append(top);
    const title = document.createElement('h3'); title.textContent = lot.name || lot.address; card.append(title);
    const meta = document.createElement('p'); meta.className = 'property-meta'; meta.textContent = (lot.category || lot.property_type || '') + ' · ' + lot.area + '㎡'; card.append(meta);
    const caption = document.createElement('span'); caption.className='price-label'; caption.textContent='표시 일정의 최저입찰가';
    const price = document.createElement('div'); price.className='price'; price.textContent=money(lot.min_price); card.append(caption,price);
    const schedule = document.createElement('p'); schedule.className='schedule';
    schedule.textContent = (lot.status || '상태 미확인') + ' · ' + fmtBid(lot.bid_start) + ' ~ ' + fmtBid(lot.bid_end);
    card.append(schedule);
    if (lot.rounds?.length>1) {
      const rounds=document.createElement('details'); rounds.className='round-details';
      const heading=document.createElement('summary'); heading.textContent='같은 물건의 입찰 일정 '+lot.rounds.length+'건'; rounds.append(heading);
      const table=document.createElement('table'),thead=document.createElement('thead'),tr=document.createElement('tr');
      ['입찰 종료','최저입찰가'].forEach(text=>{const th=document.createElement('th');th.scope='col';th.textContent=text;tr.append(th)});
      thead.append(tr);table.append(thead);const body=document.createElement('tbody');
      lot.rounds.forEach(round=>{const row=document.createElement('tr'),date=document.createElement('td'),price=document.createElement('td');date.textContent=fmtBid(round.bid_end);price.textContent=money(round.min_price);row.append(date,price);body.append(row)});
      table.append(body);rounds.append(table);const note=document.createElement('p');note.textContent='후속 일정은 앞선 회차의 진행 결과에 따라 달라질 수 있습니다.';rounds.append(note);card.append(rounds);
    }
    const actions = document.createElement('div'); actions.className='lot-actions';
    const focus = document.createElement('button'); focus.type='button'; focus.className='map-button';
    focus.textContent=type==='parcel' ? '필지 경계로 확대' : type==='unknown' ? '위치 미확인' : '지도에서 보기';
    focus.disabled=type==='unknown' || !map; focus.setAttribute('aria-pressed','false');
    focus.addEventListener('click',()=> {
      focusLot(key,false);
      if (window.matchMedia('(max-width:760px)').matches) $('mapHeading').scrollIntoView({block:'start',behavior:'auto'});
    });
    const link = document.createElement('a');
    link.href='https://map.naver.com/p/search/' + encodeURIComponent(lot.address); link.target='_blank'; link.rel='noopener noreferrer'; link.textContent='지번으로 지도 검색 ↗';
    actions.append(focus,link);
    const sourceURL=parcelShapes.get(String(lot.pnu))?.properties?.source_url;
    if (typeof sourceURL==='string' && sourceURL.startsWith('https://gris.gg.go.kr/map/main/grisMapView.do?')) {
      const sourceLink=document.createElement('a');sourceLink.href=sourceURL;sourceLink.target='_blank';sourceLink.rel='noopener noreferrer';sourceLink.textContent='공식 지적도 확인 ↗';actions.append(sourceLink);
    }
    if (typeof lot.url === 'string' && /^https:\/\//.test(lot.url)) {
      const official = document.createElement('a'); official.href=lot.url; official.target='_blank'; official.rel='noopener noreferrer'; official.textContent='공식 공고 ↗'; actions.append(official);
    }
    card.append(actions);
    const details=document.createElement('details'); details.className='lot-details';
    const summary=document.createElement('summary'); summary.textContent='물건번호·토지 활용 정보';
    const dl=document.createElement('dl');
    const fields=[['물건번호',lot.lot_id],['면적 기준',lot.property_type==='주택'?'건물 면적 (지분 여부 확인)':'토지 면적 (지분 여부 확인)'],['실주행 시간',lot.drive_min == null ? '미확인' : lot.drive_min+'분'],['진입도로',lot.road],['상수도 / 하수도',(lot.water || '미확인')+' / '+(lot.sewer || '미확인')],['전력계통 / 일조',(lot.grid || '미확인')+' / '+(lot.sunlight || '미확인')]];
    fields.forEach(([label,value])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value ?? '미확인';dl.append(dt,dd)});
    details.append(summary,dl);card.append(details);list.append(card);cardNodes.set(key,card);
  });
  renderMap(visibleLots);
  const nextKey = selectedKey || visibleLots.find(lot=>locationType(lot)==='parcel') && recordKey(visibleLots.find(lot=>locationType(lot)==='parcel'));
  if (nextKey) focusLot(nextKey,false);
}
function resetFilters() {
  $('search').value=''; $('price').value='100000000'; $('kind').value='all';
  $('location').value='all'; $('sort').value='location'; $('excludeShares').checked=false;
  selectedKey=null;page=1;render();
}
async function readJSON(url) {
  const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),15000);
  try {
    const response = await fetch(url,{cache:'no-store',signal:controller.signal});
    if (!response.ok) throw new Error('HTTP ' + response.status);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
function updateSummary() {
  const types=lots.map(locationType);
  $('statLots').textContent=lots.length;
  $('statParcels').textContent=types.filter(x=>x==='parcel').length;
  $('statAreas').textContent=types.filter(x=>x==='area').length;
  $('statUnknown').textContent=types.filter(x=>x==='unknown').length;
  const partial=currentData?.collection?.partial || currentData?.status==='partial_verified';
  const timestamp=Date.parse(currentData?.updated || '');
  const stale=Number.isFinite(timestamp) && Date.now()-timestamp > 48*3600000;
  $('syncStatus').textContent=loadFailed ? '갱신 실패 · 마지막으로 불러온 데이터를 표시합니다.' :
    stale ? '마지막 수집 데이터 · 새 갱신이 필요합니다.' :
    partial ? '온비드 매각 후보 일부 수집 · 전체 매물 아님' : '온비드 매각 후보 수집 완료';
  $('syncStatus').className=loadFailed || stale ? 'warn' : 'ok';
  $('updated').textContent=Number.isFinite(timestamp) ? '갱신 ' + new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(timestamp) : '갱신 이력 없음';
  const report=currentData?.parcels;
  const count=types.filter(x=>x==='parcel').length;
  let parcelText='필지 경계가 확인된 ' + count + '건은 지도에서 청록색 구획으로 볼 수 있습니다.';
  if (parcelLoadFailed) parcelText='경계 파일을 불러오지 못했습니다. 지역 위치와 지번 검색을 이용하세요.';
  else if (report?.status==='provider_error' || report?.status==='partial') {
    const auth=Object.keys(report.errors || {}).some(code=>/KEY|DOMAIN|AUTH/.test(code));
    parcelText=auth ? '경계 조회 인증 설정 확인이 필요합니다. 확인된 필지만 표시합니다.' :
      '공식 필지 경계 ' + count + '건 확인 · 일부 주소의 추가 조회는 다음 자동 수집 때 재시도합니다.';
  } else if (report?.status==='pending') parcelText='필지 경계를 순차 대조 중입니다. 확인된 '+count+'건부터 표시하며 나머지는 다음 수집에서 이어집니다.';
  else if (report?.status==='not_configured') parcelText='필지 경계 조회 설정 대기 · 확보된 위치와 지번 검색을 이용하세요.';
  else if (!count) parcelText='아직 대조가 완료된 필지 경계가 없습니다. 노란 마커는 지역 참고 위치입니다.';
  $('parcelStatus').textContent=parcelText;
  $('parcelStatus').className='muted' + (report?.status==='provider_error' || parcelLoadFailed ? ' warn' : '');
  const routed=lots.filter(lot=>Number.isFinite(lot.drive_min) && lot.drive_min>=0).length;
  $('geoStatus').textContent='서천 힐스테이트 기준 실주행 시간 ' + routed + '/' + lots.length + '건 확인. ' + (routed ? '미확인 물건은 30분 이내로 판정하지 않습니다.' : '차량 30분 이내 여부는 아직 미확인입니다.');
}
async function load() {
  if (loading) return;
  loading=true; $('refresh').disabled=true; $('refresh').textContent='확인 중…';
  const [auctions,parcels]=await Promise.allSettled([readJSON('./data/auctions.json'),readJSON('./data/parcels.geojson')]);
  if (auctions.status==='fulfilled' && Array.isArray(auctions.value.items)) {
    currentData=auctions.value;
    lots=groupLots(currentData.items.filter(lot=>lot && lot.address && Number.isFinite(lot.min_price) && lot.min_price>0 && lot.min_price<=100000000));
    page=1;
    loadFailed=false;
    parcelLoadFailed=parcels.status==='rejected';
    parcelShapes=new Map(parcels.status==='fulfilled' && Array.isArray(parcels.value.features) ? parcels.value.features.filter(geometryValid).map(f=>[String(f.properties.pnu),f]) : []);
  } else {
    loadFailed=true;
  }
  loading=false; $('refresh').disabled=false; $('refresh').textContent='데이터 새로고침 ↻';
  if (currentData) updateSummary();
  else {
    $('syncStatus').textContent='공매 데이터를 불러오지 못했습니다. 새로고침으로 다시 확인해 주세요.';
    $('syncStatus').className='warn'; $('parcelStatus').textContent='데이터 연결 대기';
    $('updated').textContent=''; ['statLots','statParcels','statAreas','statUnknown'].forEach(id=>$(id).textContent='—');
  }
  render();
}
$('refresh').addEventListener('click',load);
$('reset').addEventListener('click',resetFilters);
$('fitAll').addEventListener('click',fitAll);
$('previous').addEventListener('click',()=>{page=Math.max(1,page-1);render();$('resultsHeading').scrollIntoView({block:'start'})});
$('next').addEventListener('click',()=>{page+=1;render();$('resultsHeading').scrollIntoView({block:'start'})});
['search','price'].forEach(id=>$(id).addEventListener('input',()=>{selectedKey=null;page=1;render()}));
['kind','location','sort','excludeShares'].forEach(id=>$(id).addEventListener('change',()=>{selectedKey=null;page=1;render()}));
$('map').addEventListener('click',event=>{
  const button=event.target.closest('button[data-record]');
  if (button) focusLot(button.dataset.record,true);
});
load();
