'use strict';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '미확인').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => Number(value).toLocaleString('ko-KR') + '원';
const compactMoney = value => {
  const n = Number(value);
  if (!Number.isFinite(n)) return '가격 미확인';
  if (n >= 100000000) return Math.floor(n / 100000000) + '억' + (n % 100000000 ? ' ' + Math.round(n % 100000000 / 10000).toLocaleString('ko-KR') + '만' : '');
  return n >= 10000 ? Number((n / 10000).toFixed(1)).toLocaleString('ko-KR') + '만' : n.toLocaleString('ko-KR') + '원';
};
const shortAddress = lot => String(lot.address || lot.name || '').replace(/^경기도\s*/, '');
const areaText = value => Number.isFinite(Number(value)) && value != null && value!=='' ? Number(value).toLocaleString('ko-KR',{maximumFractionDigits:2}) + '㎡' : '면적 미확인';
const icon = name => '<svg class="icon" aria-hidden="true"><use href="#icon-' + name + '"/></svg>';
let scope = 'all', saved = new Set(), toastTimer, priceCap=100000000, mapNeedsFit=false, searchBounds=null;
const mobileLayout=window.matchMedia('(max-width:640px)');
const BASE_ROAD=[37.238128,127.075942];
let driveOnly=false, driveRoutes={};
try {
  const values = JSON.parse(localStorage.getItem('land-scout-saved') || '[]');
  if (Array.isArray(values)) saved = new Set(values.filter(v=>typeof v==='string'));
} catch (_) { /* Reading remains available when browser storage is unavailable. */ }
function toast(message) {
  $('toast').textContent=message; $('toast').classList.add('visible');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),2400);
}
function savedLot(lot) { return saved.has(String(lot.lot_id)); }
function setView(view) {
  document.body.dataset.view=view;
  $('viewToggleLabel').textContent=view==='list' ? '지도 보기' : '목록 보기';
  $('viewToggle').querySelector('use').setAttribute('href',view==='list' ? '#icon-map' : '#icon-list');
  if (view==='map' && map) {map.invalidateSize();if (mapNeedsFit) fitAll();else drawMarkers();}
}
function setScope(value) {
  scope=value; selectedKey=null; page=1; render(); $('listScroll').scrollTop=0;
}
function updatePreview() {
  const lot=visibleLots.find(lot=>recordKey(lot)===selectedKey);
  $('mobilePreview').hidden=!lot;
  $('map').closest('.map-panel').classList.toggle('has-preview',Boolean(lot));
  if (!lot) return;
  const route=driveRoute(lot);
  $('mobilePreview').querySelector('.preview-eyebrow').textContent=(lot.property_type || '공매')+' · '+locationLabel[locationType(lot)];
  $('previewPrice').textContent=compactMoney(lot.min_price);
  $('previewAddress').textContent=(route ? '차량 약 '+driveMinutes(route)+' · ' : '')+shortAddress(lot);
}
function revealCard(key) {
  const index=visibleLots.findIndex(lot=>recordKey(lot)===key);
  if (index<0) return;
  if (!cardNodes.has(key)) { page=Math.floor(index/PAGE_SIZE)+1; render({preserveMap:true}); }
  cardNodes.get(key)?.scrollIntoView({block:'nearest',behavior:'auto'});
}
function toggleSaved(lot) {
  const id=String(lot.lot_id), wasSaved=saved.has(id);
  if (wasSaved) saved.delete(id); else saved.add(id);
  let persisted=true;
  try { localStorage.setItem('land-scout-saved',JSON.stringify([...saved])); } catch (_) { persisted=false; }
  const scroll=$('listScroll').scrollTop;
  render({preserveMap:scope!=='saved'}); $('listScroll').scrollTop=scroll;
  toast(persisted ? wasSaved ? '관심 매물에서 해제했어요.' : '관심 매물에 저장했어요.' : '이번 화면에만 저장돼요. 브라우저 저장소를 사용할 수 없습니다.');
}

const pnuValid = value => /^\d{10}[12]\d{8}$/.test(String(value || ''));
const recordKey = lot => String(lot.lot_id) + ':' + String(lot.condition_id || '');
const point = lot => {
  if (lot.lat == null || lot.lng == null) return null;
  const lat = Number(lot.lat), lng = Number(lot.lng);
  return Number.isFinite(lat) && Number.isFinite(lng) && lat >= 33 && lat <= 39.5 && lng >= 124 && lng <= 132 ? [lat, lng] : null;
};
const {bidTimestamp,bidPhase,groupLots,kstDate,validScheduleRange,filterLotsBySchedule,routeEstimate} = LandScoutData;
const driveRoute=lot=>routeEstimate(lot,driveRoutes);
const driveSeconds=lot=>driveRoute(lot)?.seconds ?? Infinity;
const driveMinutes=route=>Math.max(1,Math.ceil(route.seconds/60))+'분';
const routeTimeFormat=new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const defaultSchedule=()=>({phase:'all',basis:'end',from:'',to:''});
let scheduleFilters=defaultSchedule();
const phaseLabels={all:'전체',upcoming:'입찰 예정',active:'입찰 진행 중',private:'수의계약 가능',ended:'입찰 종료',unknown:'일정 미확인'};
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

let auctionItems = [], lots = [], visibleLots = [], parcelShapes = new Map(), parcelBounds = new Map(), currentData = null;
let selectedKey = null, loading = false, map = null, layer = null, markerLayer = null;
let featureLayers = new Map(), cardNodes = new Map(), mapEntries = [], markerGroups = [], allBounds = null;
let loadFailed = false, parcelLoadFailed = false, page = 1;
let lastScheduleCheck=Date.now();
const PAGE_SIZE = 24;

if (window.L) {
  try {
    map = L.map('map', {scrollWheelZoom:true,zoomControl:false}).setView(BASE_ROAD,10);
    const tiles=L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom:19,maxZoom:21, attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    });
    tiles.on('load',()=>{
      const missing=!map?.getContainer().querySelector('.leaflet-tile-loaded');
      $('map').classList.toggle('tiles-unavailable',missing);
      $('tileStatus').hidden=!missing;
    });
    tiles.addTo(map);
    layer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    L.control.zoom({position:'topright'}).addTo(map);
    map.on('zoomend',drawMarkers);
    L.circleMarker(BASE_ROAD, {radius:5,color:'#6f7f9b',weight:2,fillColor:'#fff',fillOpacity:1}).addTo(map).bindPopup('출발 기준 · 힐스테이트서천 인근 도로');
  } catch (error) {
    map = null;
  }
}
$('mapSearch').hidden=!map;
['fitAll','baseLocation'].forEach(id=>$(id).disabled=!map);
const locationType = lot => parcelShapes.has(String(lot.pnu)) ? 'parcel' : !point(lot) ? 'unknown' : lot.location_precision === 'exact' ? 'exact' : 'area';
const locationLabel = {parcel:'필지 경계 확인',exact:'지번 위치 확인',area:'지역 참고 위치',unknown:'위치 미확인'};

function inSearchArea(lot) {
  if (!searchBounds) return true;
  const bounds=parcelBounds.get(String(lot.pnu));
  if (bounds) return searchBounds.intersects(bounds);
  const coords=point(lot);
  return coords && searchBounds.contains(coords);
}

function chooseRows() {
  const query = $('search').value.trim().toLocaleLowerCase('ko-KR');
  const kind = $('kind').value, precision = $('location').value, sort=$('sort').value;
  const now=Date.now();
  const rows = filterLotsBySchedule(lots,scheduleFilters,now,priceCap).filter(lot => lot.min_price <= priceCap &&
    inSearchArea(lot) && (!driveOnly || driveSeconds(lot)<=1800) &&
    (kind === 'all' || lot.property_type === kind) &&
    (precision === 'all' || precision === 'exact' && ['exact','parcel'].includes(locationType(lot)) || precision === locationType(lot)) &&
    (!$('excludeShares').checked || !lot.share) &&
    (!query || [lot.name,lot.address,lot.lot_id,lot.category].join(' ').toLocaleLowerCase('ko-KR').includes(query))
  );
  const ranks = {parcel:0,exact:1,area:2,unknown:3};
  const deadline=lot=>{
    const phase=bidPhase(lot,now);
    if (phase==='active' || phase==='upcoming' || phase==='ended' && scheduleFilters.phase==='ended') {
      const time=bidTimestamp(lot.bid_end);
      if (Number.isFinite(time)) return time;
    }
    return Infinity;
  };
  return rows.sort((a,b) => {
    if (sort === 'closing') return deadline(a)-deadline(b) || a.min_price-b.min_price;
    if (sort === 'price') return a.min_price - b.min_price;
    if (sort === 'drive') return driveSeconds(a)-driveSeconds(b) || a.min_price-b.min_price;
    return ranks[locationType(a)] - ranks[locationType(b)] || a.min_price - b.min_price;
  });
}
function markerIcon(entry, selected) {
  const group=entry.rows.length>1;
  const approximate=entry.rows.some(row=>locationType(row.lot)==='area');
  const selectedRow=selected && entry.rows.find(row=>row.key===selectedKey);
  const value=selectedRow ? selectedRow.lot.min_price : Math.min(...entry.rows.map(row=>row.lot.min_price));
  const label=compactMoney(value) + (group && !selectedRow ? '~' : '');
  const width=Math.max(68,label.length*8+22+(group ? 22 : 0));
  return L.divIcon({className:'price-marker',
    html:'<div class="lot-pin '+(approximate ? 'approx' : entry.type==='parcel' ? 'parcel' : '')+(selected ? ' selected' : '')+'"><span>'+label+'</span>'+(group ? '<span class="pin-count">'+entry.rows.length+'</span>' : '')+'</div>',
    iconSize:[width,33],iconAnchor:[width/2,38],popupAnchor:[0,-36]
  });
}
function popupContent(rows,type) {
  const approximate=rows.some(row=>locationType(row.lot)==='area');
  return '<span class="popup-heading">'+esc(locationLabel[type] || '주변 매물')+' · '+rows.length+'건</span>'+
    (approximate ? '<p>지역 참고 위치는 지번 검색으로 실제 위치를 확인하세요.</p>' : '')+
    '<div class="popup-items">'+rows.map(row=>'<button type="button" class="popup-lot" data-record="'+esc(row.key)+'"><b>'+compactMoney(row.lot.min_price)+'</b>'+esc(shortAddress(row.lot))+'<br><small>'+esc(row.lot.property_type)+' · '+esc(locationLabel[locationType(row.lot)])+(row.lot.share ? ' · 지분 매각' : '')+'</small></button>').join('')+'</div>';
}
function updateSelection() {
  cardNodes.forEach((node,key)=>{
    node.classList.toggle('active',key===selectedKey);
    node.querySelector('.map-button')?.setAttribute('aria-pressed',String(key===selectedKey));
  });
  markerGroups.forEach(entry=>{
    const selected=entry.rows.some(row=>row.key===selectedKey);
    entry.marker.setIcon(markerIcon(entry,selected));
    entry.marker.setZIndexOffset(selected ? 1000 : 0);
  });
  mapEntries.forEach(entry=>{
    const selected=entry.rows.some(row=>row.key===selectedKey);
    if (entry.outline) entry.outline.setStyle({weight:selected ? 4 : 2,fillOpacity:selected ? .28 : .13,color:selected ? '#107e76' : '#14988b'});
  });
  updatePreview();
}
function focusLot(key,reveal) {
  const entry=featureLayers.get(key);
  selectedKey=key;
  if (reveal) revealCard(key);
  updateSelection();
  if (!map || !entry) return;
  if (entry.outline) map.fitBounds(entry.outline.getBounds().pad(.35),{maxZoom:21,paddingTopLeft:[24,110],paddingBottomRight:[65,mobileLayout.matches ? 202 : 65],animate:false});
  else map.setView(entry.coords,entry.type==='area' ? 13 : 17,{animate:false});
  if (entry.marker?.getPopup() && !mobileLayout.matches) entry.marker.openPopup();
  else map.closePopup();
  const row=entry.rows.find(row=>row.key===key);
  $('mapNotice').textContent=locationLabel[entry.type]+' · '+row.lot.address+(row.lot.share ? ' · 필지 전체 중 지분 매각' : '');
}
function fitAll(recenter=true) {
  const mapVisible=map && map.getContainer().clientWidth>0;
  mapNeedsFit=Boolean(map && !mapVisible);
  if (mapVisible && recenter) {
    map.closePopup();map.invalidateSize();
    if (allBounds?.isValid()) map.fitBounds(allBounds.pad(.08),{maxZoom:16,paddingTopLeft:[24,108],paddingBottomRight:[68,mobileLayout.matches ? 92 : 70],animate:false});
  }
  const mapped=visibleLots.filter(lot=>locationType(lot)!=='unknown').length;
  $('mapCount').textContent='지도 '+mapped+'건';
  $('mapNotice').textContent=!map ? '지도를 불러오지 못했어요. 목록에서 지번으로 검색할 수 있어요.'
    : searchBounds ? '지정한 지도 범위 · 매물 '+mapped+'건'
    : !mapped ? '지도에 표시할 매물이 없어요. 매물 목록이나 검색 조건을 확인하세요.'
    : '지도 '+mapped+'건 · 위치 미확인 '+(visibleLots.length-mapped)+'건은 목록에서 확인';
  drawMarkers();
}
function drawMarkers() {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers(); markerGroups=[];
  const zoom=map.getZoom(), radius=zoom<13 ? 85 : zoom<16 ? 58 : zoom<19 ? 30 : 16;
  mapEntries.forEach(entry=>{
    const projected=map.project(entry.coords,zoom);
    let group=markerGroups.find(g=>projected.distanceTo(g.projected)<radius);
    if (!group) {
      group={type:entry.type,coords:entry.coords,projected,rows:[],entries:[]};
      markerGroups.push(group);
    }
    group.rows.push(...entry.rows); group.entries.push(entry);
    if (group.type!==entry.type) group.type='mixed';
  });
  markerGroups.forEach(group=>{
    const clustered=group.entries.length>1;
    const expand=clustered && zoom<19;
    const pick=group.rows.length>1;
    const selected=group.rows.some(row=>row.key===selectedKey);
    const title=(clustered ? '주변 매물'+(group.rows.some(row=>locationType(row.lot)==='area') ? ' (지역 참고 포함)' : '') : locationLabel[group.type])+' '+group.rows.length+'건 · '+compactMoney(Math.min(...group.rows.map(row=>row.lot.min_price)))+(group.rows.length>1 ? '부터' : '');
    group.marker=L.marker(group.coords,{icon:markerIcon(group,selected),title,alt:title,zIndexOffset:selected ? 1000 : 0}).addTo(markerLayer);
    group.entries.forEach(entry=>entry.marker=group.marker);
    group.marker.bindTooltip(expand ? '확대하여 '+group.rows.length+'건 보기' : pick ? '매물 '+group.rows.length+'건 선택' : locationLabel[group.type],{direction:'top',offset:[0,-33],className:'lot-tooltip'});
    if (!expand && (pick || !mobileLayout.matches)) {
      group.marker.bindPopup(popupContent(group.rows,group.type),{maxWidth:300,autoPanPaddingTopLeft:[20,100],autoPanPaddingBottomRight:[20,mobileLayout.matches ? 95 : 40]});
    }
    if (expand) {
      group.marker.on('click',()=>{
        const bounds=L.latLngBounds(group.entries.map(entry=>entry.coords));
        map.setView(bounds.getCenter(),Math.min(19,zoom+2),{animate:false});
      });
    } else if (!pick) {
      group.marker.on('click',()=>focusLot(group.rows[0].key,true));
    }
  });
}
function renderMap(rows,recenter=true) {
  featureLayers.clear(); mapEntries=[]; allBounds=null;
  if (!map || !layer) { fitAll(); return; }
  layer.clearLayers(); allBounds=L.latLngBounds([]);
  const groups=new Map();
  rows.forEach((lot,index)=>{
    const type=locationType(lot),coords=point(lot);
    if (type==='unknown') return;
    const groupKey=type==='parcel' ? 'pnu:'+lot.pnu : type+':'+coords.map(n=>n.toFixed(6)).join(',');
    if (!groups.has(groupKey)) groups.set(groupKey,{type,coords,pnu:lot.pnu,rows:[]});
    groups.get(groupKey).rows.push({lot,key:recordKey(lot),number:index+1});
  });
  groups.forEach(entry=>{
    if (entry.type==='parcel') {
      try {
        entry.outline=L.geoJSON(parcelShapes.get(String(entry.pnu)),{style:{color:'#14988b',weight:2,fillColor:'#22b7a6',fillOpacity:.13}}).addTo(layer);
        const bounds=entry.outline.getBounds();
        if (!bounds.isValid()) throw new Error('Invalid bounds');
        entry.coords=[bounds.getCenter().lat,bounds.getCenter().lng]; allBounds.extend(bounds);
        entry.outline.on('click',()=>focusLot(entry.rows[0].key,true));
      } catch (_) { return; }
    } else allBounds.extend(entry.coords);
    entry.rows.forEach(row=>featureLayers.set(row.key,entry)); mapEntries.push(entry);
  });
  fitAll(recenter);
}
function compactSchedule(lot) {
  const start=bidTimestamp(lot.bid_start),end=bidTimestamp(lot.bid_end),phase=bidPhase(lot);
  const date=value=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric'}).format(value);
  if (phase==='private') return [phaseLabels[phase],'접수 조건은 온비드에서 확인'];
  if (phase==='upcoming') return [date(start)+' 입찰 시작',phaseLabels[phase]];
  if (phase==='active') return [date(end)+' 입찰 마감',phaseLabels[phase]];
  if (phase==='ended') return [phaseLabels[phase],/취소|중지|완료|낙찰|유찰/.test(lot.status || '') ? lot.status : date(end)+' 마감'];
  return [phaseLabels[phase],'일정은 온비드에서 확인'];
}
function createCard(lot) {
  const type=locationType(lot),key=recordKey(lot),[schedule,status]=compactSchedule(lot);
  const route=driveRoute(lot);
  const naverMapURL='https://map.naver.com/p/search/'+encodeURIComponent(lot.address);
  const canFocus=type!=='unknown' && Boolean(map);
  const mapAction=canFocus
    ? '<button class="map-button" type="button" aria-pressed="false">'+icon('pin')+(type==='parcel' ? '필지 보기' : '지도 보기')+'</button>'
    : '<a class="map-link" href="'+esc(naverMapURL)+'" target="_blank" rel="noopener noreferrer">지번 검색 ↗</a>';
  const category=String(lot.category || '').replace(/^부동산\s*/, '').replace(/^(토지|주거용건물)\s*/, '');
  const card=document.createElement('article');card.className='lot';card.dataset.record=key;
  card.setAttribute('aria-label',shortAddress(lot)+' · '+money(lot.min_price));
  card.innerHTML='<div class="lot-top"><span class="property-kind">'+esc(lot.property_type || '공매')+'<em>·</em>'+esc(category || '종류 미확인')+'</span><button class="favorite-button" type="button" aria-label="'+esc(shortAddress(lot))+' 관심 매물 '+(savedLot(lot) ? '해제' : '저장')+'" aria-pressed="'+savedLot(lot)+'">'+icon('heart')+'</button></div>'+
    '<div class="price-row"><strong class="price" title="'+money(lot.min_price)+'">'+compactMoney(lot.min_price)+'</strong><span class="price-label">'+(lot.matching_round_count ? '선택 일정 입찰가' : '최저입찰가')+'</span></div>'+
    '<h3>'+esc(shortAddress(lot))+'</h3><p class="property-meta"><b>'+esc(areaText(lot.area))+'</b> · '+(lot.property_type==='주택' ? '건물 면적' : '토지 면적')+'</p>'+
    '<div class="badges"><span class="badge '+type+'">'+locationLabel[type]+'</span>'+(route ? '<span class="badge drive-badge">차량 약 '+driveMinutes(route)+'</span>' : '')+(lot.share ? '<span class="badge share">지분 매각</span>' : '')+(lot.multiple_parcels ? '<span class="badge">여러 필지 · 대표 경계</span>' : '')+'</div>'+
    '<div class="card-bottom"><p class="schedule"><b>'+esc(schedule)+'</b>'+esc(status)+'</p>'+mapAction+'</div>'+
    '<details class="lot-details"><summary>입찰·상세 정보</summary><div class="lot-details-content"><p class="full-name">'+esc(lot.name || lot.address)+'</p><p class="schedule-full">표시 일정의 최저입찰가 <b>'+money(lot.min_price)+'</b><br>시작 '+fmtBid(lot.bid_start)+'<br>종료 '+fmtBid(lot.bid_end)+'</p><div class="lot-actions"></div><dl></dl></div></details>';
  card.querySelector('.favorite-button').addEventListener('click',()=>toggleSaved(lot));
  const select=()=>{setView('map');focusLot(key,false);};
  card.querySelector('.map-button')?.addEventListener('click',select);
  card.addEventListener('click',event=>{if (!event.target.closest('button,a,details,input,select') && canFocus) select();});
  const content=card.querySelector('.lot-details-content'),actions=card.querySelector('.lot-actions');
  if (lot.rounds?.length>1) {
    const rounds=document.createElement('details');rounds.className='round-details';
    rounds.innerHTML='<summary>같은 물건의 입찰 일정 '+lot.rounds.length+'건'+(lot.matching_round_count ? ' · 조건 일치 '+lot.matching_round_count+'건' : '')+'</summary><table><thead><tr><th scope="col">입찰 종료</th><th scope="col">최저입찰가</th></tr></thead><tbody>'+lot.rounds.map(round=>'<tr><td>'+fmtBid(round.bid_end)+'</td><td>'+money(round.min_price)+'</td></tr>').join('')+'</tbody></table><p>후속 일정은 앞선 회차의 진행 결과에 따라 달라질 수 있습니다.</p>';
    content.insertBefore(rounds,actions);
  }
  const appendLink=(url,label)=>{const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=label;actions.append(a);};
  if (canFocus) appendLink(naverMapURL,'네이버 지도 ↗');
  const sourceURL=parcelShapes.get(String(lot.pnu))?.properties?.source_url;
  if (typeof sourceURL==='string' && sourceURL.startsWith('https://gris.gg.go.kr/map/main/grisMapView.do?')) appendLink(sourceURL,'공식 지적도 ↗');
  if (typeof lot.url==='string' && /^https:\/\//.test(lot.url)) {
    appendLink(lot.url,'온비드 공고 ↗');
  } else {
    appendLink('https://www.onbid.co.kr/','온비드에서 검색 ↗');
    const copy=document.createElement('button');
    copy.type='button';copy.textContent='물건번호 복사';
    copy.addEventListener('click',async()=>{
      try {
        await navigator.clipboard.writeText(String(lot.lot_id));
        toast('물건번호를 복사했어요. 온비드 검색에 붙여 넣으세요.');
      } catch (_) {
        toast('물건번호 '+lot.lot_id+'를 온비드에서 검색하세요.');
      }
    });
    actions.append(copy);
  }
  const fields=[['물건번호',lot.lot_id],['면적 기준',lot.property_type==='주택' ? '건물 면적 · 지분 여부 확인' : '토지 면적 · 지분 여부 확인'],
    ['예상 운전 시간',route ? '약 '+driveMinutes(route)+' · '+routeTimeFormat.format(Date.parse(route.checked_at))+' 계산 (힐스테이트서천 인근 도로 기준)' : lot.property_type==='토지' ? '미확인' : '토지 시범 적용 중'],
    ['진입도로',lot.road],['상수도 / 하수도',(lot.water || '미확인')+' / '+(lot.sewer || '미확인')],['전력계통 / 일조',(lot.grid || '미확인')+' / '+(lot.sunlight || '미확인')]];
  const dl=card.querySelector('dl');
  fields.forEach(([label,value])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value ?? '미확인';dl.append(dt,dd);});
  return card;
}
function scopeRows(rows) {
  return rows.filter(lot=>scope==='all' || scope==='mapped' && locationType(lot)!=='unknown' || scope==='saved' && savedLot(lot));
}
function render({preserveMap=false,keepMapView=false}={}) {
  const filtered=chooseRows();
  visibleLots=scopeRows(filtered);
  const mapped=filtered.filter(lot=>locationType(lot)!=='unknown').length;
  const savedCount=lots.filter(savedLot).length;
  $('count').textContent=visibleLots.length;
  $('allCount').textContent=filtered.length; $('mappedCount').textContent=mapped;
  $('savedTabCount').textContent=filtered.filter(savedLot).length; $('savedCount').textContent=savedCount;
  $('mobileCount').textContent=visibleLots.length;
  $('scopeLabel').textContent={all:'전체 매물',mapped:'지도에 표시된 매물',saved:'관심 매물'}[scope];
  $('listHint').textContent=driveOnly ? '힐스테이트서천 기준 차량 30분 이내'+(searchBounds ? ' · 지정한 지도 범위' : '') : searchBounds ? '지정한 지도 범위에서 '+filtered.length+'건' : scope==='saved' ? '관심 매물은 이 브라우저에 저장돼요.' : '전체 '+filtered.length+'건 중 지도 '+mapped+'건 · 위치 미확인 매물은 목록에서 확인';
  $('driveFilter').setAttribute('aria-pressed',String(driveOnly));
  document.querySelectorAll('[data-clear-area]').forEach(button=>{button.hidden=!searchBounds;});
  $('searchArea').classList.toggle('active',Boolean(searchBounds));
  $('savedButton').setAttribute('aria-pressed',String(scope==='saved'));
  document.querySelectorAll('[data-scope]').forEach(button=>{button.classList.toggle('active',button.dataset.scope===scope);button.setAttribute('aria-pressed',String(button.dataset.scope===scope));});
  const priceText=compactMoney(priceCap);
  $('priceFilterLabel').textContent=priceText+(priceText.endsWith('원') ? '' : '원')+' 이하';
  updateScheduleLabel();
  const pages=Math.max(1,Math.ceil(visibleLots.length/PAGE_SIZE));page=Math.min(page,pages);
  $('pageInfo').textContent=page+' / '+pages+'페이지';$('previous').disabled=page<=1;$('next').disabled=page>=pages;
  const list=$('list');list.replaceChildren();list.setAttribute('aria-busy',String(loading));cardNodes.clear();
  if (!visibleLots.some(lot=>recordKey(lot)===selectedKey)) selectedKey=null;
  if (!visibleLots.length) {
    const message=document.createElement('div');message.className='empty';
    const title=loading ? '매물을 불러오고 있어요.' : loadFailed && !lots.length ? '데이터를 불러오지 못했어요.' : scope==='saved' && !savedCount ? '마음에 드는 매물을 모아보세요.' : '조건에 맞는 매물이 없어요.';
    const copy=scope==='saved' && !savedCount ? '매물의 하트를 누르면 여기에 저장돼요.' : loadFailed && !lots.length ? '수집 현황에서 새로고침해 주세요.' : driveOnly ? '예상 시간이 계산된 토지만 차량 30분 필터에 표시돼요.' : '검색어나 필터를 조금 바꿔보세요.';
    message.innerHTML=icon(scope==='saved' ? 'heart' : 'search')+'<strong>'+title+'</strong>'+copy;
    if (lots.length) {
      const reset=document.createElement('button');reset.type='button';
      reset.textContent=searchBounds ? '지도 범위 해제' : scope==='saved' ? '전체 매물 보기' : '조건 초기화';
      reset.addEventListener('click',searchBounds ? clearSearchArea : resetFilters);
      message.append(document.createElement('br'),reset);
    }
    list.append(message);
  }
  visibleLots.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).forEach(lot=>{const card=createCard(lot);list.append(card);cardNodes.set(recordKey(lot),card);});
  if (!preserveMap) {
    const recenter=!keepMapView && !searchBounds;
    renderMap(visibleLots,recenter);
    if (selectedKey && recenter) focusLot(selectedKey,false);
  }
  updateSelection();
}

function resetFilters() {
  $('search').value=''; priceCap=100000000; $('kind').value='all';
  $('location').value='all'; $('sort').value='location'; $('excludeShares').checked=false;
  scheduleFilters=defaultSchedule();driveOnly=false;searchBounds=null;scope='all';selectedKey=null;page=1;render();$('listScroll').scrollTop=0;
}
function clearSearchArea() {
  searchBounds=null;selectedKey=null;page=1;render();$('listScroll').scrollTop=0;
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
  const routing=lots.filter(lot=>driveRoute(lot));
  $('geoStatus').textContent='토지 '+lots.filter(lot=>lot.property_type==='토지').length+'건 중 '+routing.length+'건에 예상 운전 시간이 있습니다. 30분 이내 '+routing.filter(lot=>driveSeconds(lot)<=1800).length+'건.';
  const focus=Object.entries(currentData?.collection?.focus_regions || {});
  $('focusCoverage').hidden=!focus.length;
  $('focusSummary').replaceChildren(...focus.map(([city,info])=>{
    const item=document.createElement('li');
    item.textContent=city+' '+info.lots+'건 (지역별 추가 조회 +'+info.added_lots+'건) · '+(info.complete ? '설정한 조회 범위 확인 완료' : '일부 조회');
    return item;
  }));
}
async function load() {
  if (loading) return;
  loading=true; $('refresh').disabled=true; $('refresh').textContent='확인 중…';
  const [auctions,parcels,driving]=await Promise.allSettled([readJSON('./data/auctions.json'),readJSON('./data/parcels.geojson'),readJSON('./data/driving.json')]);
  if (driving.status==='fulfilled' && driving.value?.routes && typeof driving.value.routes==='object') driveRoutes=driving.value.routes;
  if (auctions.status==='fulfilled' && Array.isArray(auctions.value?.items)) {
    currentData=auctions.value;
    auctionItems=currentData.items.filter(lot=>lot && lot.address && Number.isFinite(lot.min_price) && lot.min_price>0 && lot.min_price<=100000000);
    lastScheduleCheck=Date.now();
    lots=groupLots(auctionItems,lastScheduleCheck);
    page=1;
    loadFailed=false;
    parcelLoadFailed=parcels.status==='rejected' || !Array.isArray(parcels.value?.features);
    if (!parcelLoadFailed) {
      parcelShapes=new Map(parcels.value.features.filter(geometryValid).map(feature=>[String(feature.properties.pnu),feature]));
      parcelBounds.clear();
      if (map) parcelShapes.forEach(({geometry},pnu)=>{
        const vertices=geometry.coordinates.flat(geometry.type==='Polygon' ? 1 : 2);
        parcelBounds.set(pnu,L.latLngBounds(vertices.map(([lng,lat])=>[lat,lng])));
      });
    }
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
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();setView('list');$('resultsHeading').focus();});
$('refresh').addEventListener('click',load);
$('reset').addEventListener('click',resetFilters);
$('driveFilter').addEventListener('click',()=>{
  driveOnly=!driveOnly;selectedKey=null;page=1;render();$('listScroll').scrollTop=0;
});
$('fitAll').addEventListener('click',()=>{if (searchBounds) clearSearchArea();else {selectedKey=null;updateSelection();fitAll();}});
$('searchArea').addEventListener('click',()=>{
  searchBounds=map.getBounds();selectedKey=null;page=1;map.closePopup();
  render({keepMapView:true});$('listScroll').scrollTop=0;
});
document.querySelectorAll('[data-clear-area]').forEach(button=>button.addEventListener('click',clearSearchArea));
$('baseLocation').addEventListener('click',()=>{if (map) {map.setView(BASE_ROAD,15,{animate:false});$('mapNotice').textContent='출발 기준 · 힐스테이트서천 인근 도로';}});
$('previous').addEventListener('click',()=>{page=Math.max(1,page-1);render({preserveMap:true});$('listScroll').scrollTop=0;});
$('next').addEventListener('click',()=>{page+=1;render({preserveMap:true});$('listScroll').scrollTop=0;});
let searchTimer;
$('search').addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>{selectedKey=null;page=1;render();$('listScroll').scrollTop=0;},180);});
['kind','location','sort','excludeShares'].forEach(id=>$(id).addEventListener('change',()=>{selectedKey=null;page=1;render();$('listScroll').scrollTop=0;}));
$('map').addEventListener('click',event=>{const button=event.target.closest('button[data-record]');if (button) focusLot(button.dataset.record,true);});
document.querySelectorAll('[data-scope]').forEach(button=>button.addEventListener('click',()=>setScope(button.dataset.scope)));
$('savedButton').addEventListener('click',()=>{setScope(scope==='saved' ? 'all' : 'saved');setView('list');});
$('viewToggle').addEventListener('click',()=>setView(document.body.dataset.view==='map' ? 'list' : 'map'));
$('previewOpen').addEventListener('click',()=>{setView('list');if (selectedKey) revealCard(selectedKey);});
const showInfo=()=>$('infoDialog').showModal();
['infoButton','statusButton','legendInfo'].forEach(id=>$(id).addEventListener('click',showInfo));
$('filterButton').addEventListener('click',()=>{$('price').value=String(priceCap);$('filterDialog').showModal();$('price').focus();updatePricePresets();});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if (event.target===dialog) {const rect=dialog.getBoundingClientRect();if (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) dialog.close();}}));
function updatePricePresets() {document.querySelectorAll('[data-price]').forEach(button=>button.classList.toggle('active',button.dataset.price===$('price').value));}
document.querySelectorAll('[data-price]').forEach(button=>button.addEventListener('click',()=>{$('price').value=button.dataset.price;updatePricePresets();}));
$('price').addEventListener('input',updatePricePresets);
function applyPrice() {
  const input=$('price');
  priceCap=input.value==='' ? 100000000 : Math.max(0,Math.min(100000000,Number(input.value)||0));
  selectedKey=null;page=1;render();updatePricePresets();$('filterDialog').close('applied');$('listScroll').scrollTop=0;
}
$('applyPrice').addEventListener('click',applyPrice);
$('price').addEventListener('keydown',event=>{if (event.key==='Enter') {event.preventDefault();applyPrice();}});
function scheduleFromForm() {
  return {phase:$('bidPhase').value,basis:$('bidDateBasis').value,from:$('bidFrom').value,to:$('bidTo').value};
}
function updateScheduleControls() {
  const noPeriod=['private','unknown'].includes($('bidPhase').value);
  $('bidPeriodControls').disabled=noPeriod;
  if (noPeriod) {$('bidFrom').value='';$('bidTo').value='';}
  $('scheduleHelp').textContent=noPeriod ? '수의계약·일정 미확인 물건에는 기간 조건을 적용하지 않아요.' : '한국 시간 기준 · 종료 날짜의 하루 전체를 포함해요.';
  $('scheduleError').hidden=true;
  const today=kstDate();
  document.querySelectorAll('[data-bid-days]').forEach(button=>{
    const end=kstDate(Date.now()+(Number(button.dataset.bidDays)-1)*86400000);
    button.classList.toggle('active',$('bidFrom').value===today && $('bidTo').value===end);
  });
}
function fillScheduleForm(filters) {
  $('bidPhase').value=filters.phase;$('bidDateBasis').value=filters.basis;
  $('bidFrom').value=filters.from;$('bidTo').value=filters.to;updateScheduleControls();
}
function updateScheduleLabel() {
  const {phase,basis,from,to}=scheduleFilters;
  const active=phase!=='all' || Boolean(from || to);
  $('scheduleButton').classList.toggle('is-active',active);
  const shortDate=value=>value ? value.slice(2).replaceAll('-','.') : '';
  const period=from || to ? (basis==='start' ? '시작 ' : '마감 ')+(from && from===to ? shortDate(from) : shortDate(from)+'~'+shortDate(to)) : '';
  $('scheduleFilterLabel').textContent=[phase!=='all' ? phaseLabels[phase] : '',period].filter(Boolean).join(' · ') || '입찰 일정';
  $('scheduleButton').title=(phase!=='all' ? phaseLabels[phase]+' · ' : '')+(from || to ? (basis==='start' ? '입찰 시작일 ' : '입찰 마감일 ')+(from || '제한 없음')+' ~ '+(to || '제한 없음') : '입찰 일정 필터');
}
$('scheduleButton').addEventListener('click',()=>{fillScheduleForm(scheduleFilters);$('scheduleDialog').showModal();});
$('bidPhase').addEventListener('change',updateScheduleControls);
['bidFrom','bidTo','bidDateBasis'].forEach(id=>$(id).addEventListener('input',updateScheduleControls));
document.querySelectorAll('[data-bid-days]').forEach(button=>button.addEventListener('click',()=>{
  $('bidFrom').value=kstDate();$('bidTo').value=kstDate(Date.now()+(Number(button.dataset.bidDays)-1)*86400000);updateScheduleControls();
}));
$('clearBidDates').addEventListener('click',()=>{$('bidFrom').value='';$('bidTo').value='';updateScheduleControls();});
$('resetSchedule').addEventListener('click',()=>fillScheduleForm(defaultSchedule()));
$('scheduleForm').addEventListener('submit',event=>{
  event.preventDefault();
  if (!$('scheduleForm').reportValidity()) return;
  const draft=scheduleFromForm();
  if (!validScheduleRange(draft.from,draft.to)) {
    $('scheduleError').textContent='종료 날짜를 시작 날짜와 같거나 이후로 선택해 주세요.';$('scheduleError').hidden=false;$('bidTo').focus();return;
  }
  scheduleFilters=draft;selectedKey=null;page=1;render();$('listScroll').scrollTop=0;$('scheduleDialog').close();
});
function refreshScheduleTime() {
  if (document.visibilityState!=='visible') return;
  const now=Date.now(),previous=lastScheduleCheck;
  lastScheduleCheck=now;
  if (auctionItems.some(round=>bidPhase(round,previous)!==bidPhase(round,now))) {
    lots=groupLots(auctionItems,now);
    render({keepMapView:true});
  }
}
setInterval(refreshScheduleTime,60000);
document.addEventListener('visibilitychange',refreshScheduleTime);
window.addEventListener('resize',()=>{if (map && (document.body.dataset.view!=='list' || !mobileLayout.matches)) {map.invalidateSize();if (mapNeedsFit) fitAll();else drawMarkers();}});
if (!map) {
  $('viewToggle').hidden=true;
  if (mobileLayout.matches) setView('list');
}
load();
