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
let scope = 'all', saved = new Set(), toastTimer, priceBeforeEdit='100000000', mapNeedsFit=false;
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
  $('mobilePreview').querySelector('.preview-eyebrow').textContent=lot ? (lot.property_type || '공매') + ' · ' + locationLabel[locationType(lot)] : '지도로 먼저 둘러보세요';
  const hasMapped=visibleLots.some(lot=>locationType(lot)!=='unknown');
  $('previewPrice').textContent=lot ? compactMoney(lot.min_price) : !visibleLots.length ? '조건에 맞는 매물이 없어요' : hasMapped ? '나에게 맞는 땅, 어디에 있을까요?' : '검색한 매물은 목록에서 확인하세요';
  $('previewAddress').textContent=lot ? shortAddress(lot) : !visibleLots.length ? '검색 조건을 바꾸거나 관심 매물을 확인해 보세요.' : hasMapped ? '가격 마커를 누르면 매물 정보를 볼 수 있어요.' : '위치 미확인 '+visibleLots.length+'건 · 지번으로 지도 검색이 가능해요.';
  $('previewOpen').innerHTML=(lot ? '선택한 매물 보기 ' : '매물 목록 보기 ') + icon('chevron');
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
let selectedKey = null, loading = false, map = null, layer = null, markerLayer = null;
let featureLayers = new Map(), cardNodes = new Map(), mapEntries = [], markerGroups = [], allBounds = null;
let loadFailed = false, parcelLoadFailed = false, page = 1;
const PAGE_SIZE = 24;

if (window.L) {
  try {
    map = L.map('map', {scrollWheelZoom:true,zoomControl:false}).setView([37.237,127.072],10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom:19,maxZoom:21, attribution:'© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    L.control.zoom({position:'topright'}).addTo(map);
    map.on('zoomend',drawMarkers);
    L.circleMarker([37.237,127.072], {radius:5,color:'#6f7f9b',weight:2,fillColor:'#fff',fillOpacity:1}).addTo(map).bindPopup('서천동 근사 기준점 · 출입구 위치 미확인');
  } catch (error) {
    map = null;
  }
}
const locationType = lot => parcelShapes.has(String(lot.pnu)) ? 'parcel' : !point(lot) ? 'unknown' : lot.location_precision === 'exact' ? 'exact' : 'area';
const locationLabel = {parcel:'필지 경계 확인',exact:'지번 위치 확인',area:'지역 참고 위치',unknown:'위치 미확인'};

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
  return '<span class="popup-heading">'+esc(locationLabel[type] || '주변 매물')+' · '+rows.length+'건</span>'+
    (type==='area' ? '<p>행정구역의 참고 위치입니다.<br>실제 매물 위치는 지번으로 확인하세요.</p>' : '')+
    '<div class="popup-items">'+rows.map(row=>'<button type="button" class="popup-lot" data-record="'+esc(row.key)+'"><b>'+compactMoney(row.lot.min_price)+'</b>'+esc(shortAddress(row.lot))+'<br><small>'+esc(row.lot.property_type)+' · '+esc(areaText(row.lot.area))+(row.lot.share ? ' · 지분 매각' : '')+'</small></button>').join('')+'</div>';
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
  if (entry.outline) map.fitBounds(entry.outline.getBounds().pad(.35),{maxZoom:21,paddingTopLeft:[35,75],paddingBottomRight:[65,window.matchMedia('(max-width:640px)').matches ? 245 : 65],animate:false});
  else map.setView(entry.coords,entry.type==='area' ? 13 : 17,{animate:false});
  drawMarkers();
  if (entry.marker && (entry.rows.length>1 || !window.matchMedia('(max-width:640px)').matches)) entry.marker.openPopup();else map.closePopup();
  const row=entry.rows.find(row=>row.key===key);
  $('mapNotice').textContent=locationLabel[entry.type]+' · '+row.lot.address+(row.lot.share ? ' · 필지 전체 중 지분 매각' : '');
}
function fitAll() {
  const mapVisible=map && map.getContainer().clientWidth>0;
  mapNeedsFit=Boolean(map && !mapVisible);
  if (mapVisible) {map.closePopup();map.invalidateSize();if (allBounds?.isValid()) map.fitBounds(allBounds.pad(.12),{maxZoom:16,animate:false});}
  const mapped=visibleLots.filter(lot=>locationType(lot)!=='unknown').length;
  $('mapCount').textContent='지도 '+mapped+'건';
  $('mapNotice').textContent=!map ? '지도를 불러오지 못했습니다. 매물의 지도 검색 링크를 이용하세요.' : !mapped ? '이 조건에서 위치가 확인된 매물이 없습니다. 목록에서 지번으로 검색하세요.' : '지도 '+mapped+'건 · 위치 미확인 '+(visibleLots.length-mapped)+'건은 목록에서 확인';
  drawMarkers();
}
function drawMarkers() {
  if (!map || !markerLayer) return;
  markerLayer.clearLayers(); markerGroups=[];
  const zoom=map.getZoom(), radius=zoom<13 ? 85 : zoom<16 ? 58 : 0;
  mapEntries.forEach(entry=>{
    const projected=map.project(entry.coords,zoom);
    let group=radius && markerGroups.find(g=>projected.distanceTo(g.projected)<radius);
    if (!group) {
      group={type:entry.type,coords:entry.coords,projected,rows:[],entries:[]};
      markerGroups.push(group);
    }
    group.rows.push(...entry.rows); group.entries.push(entry);
    if (group.type!==entry.type) group.type='mixed';
  });
  markerGroups.forEach(group=>{
    const clustered=group.entries.length>1;
    const selected=group.rows.some(row=>row.key===selectedKey);
    const title=(clustered ? '주변 매물'+(group.rows.some(row=>locationType(row.lot)==='area') ? ' (지역 참고 포함)' : '') : locationLabel[group.type])+' '+group.rows.length+'건 · '+compactMoney(Math.min(...group.rows.map(row=>row.lot.min_price)))+(group.rows.length>1 ? '부터' : '');
    group.marker=L.marker(group.coords,{icon:markerIcon(group,selected),title,alt:title,zIndexOffset:selected ? 1000 : 0}).addTo(markerLayer);
    group.entries.forEach(entry=>entry.marker=group.marker);
    group.marker.bindTooltip(clustered ? '확대하여 '+group.rows.length+'건 보기' : locationLabel[group.type],{direction:'top',offset:[0,-33],className:'lot-tooltip'});
    if (!clustered) group.marker.bindPopup(popupContent(group.rows,group.type),{maxWidth:300,autoPanPaddingTopLeft:[20,80],autoPanPaddingBottomRight:[20,window.matchMedia('(max-width:640px)').matches ? 220 : 40]});
    group.marker.on('click',()=>{
      if (clustered) {
        const bounds=L.latLngBounds(group.entries.map(entry=>entry.coords));
        map.fitBounds(bounds.pad(.15),{maxZoom:Math.min(18,zoom+2),animate:false});
        return;
      }
      focusLot(group.rows[0].key,true);
    });
  });
}
function renderMap(rows) {
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
  fitAll();
}
function compactSchedule(lot) {
  const start=bidTimestamp(lot.bid_start),end=bidTimestamp(lot.bid_end),now=Date.now();
  const date=value=>new Intl.DateTimeFormat('ko-KR',{timeZone:'Asia/Seoul',year:'numeric',month:'numeric',day:'numeric'}).format(value);
  if (String(lot.status).includes('수의')) return ['수의계약 가능','일정은 원문에서 확인'];
  if (Number.isFinite(start) && start>now) return [date(start)+' 입찰 시작',lot.status || '입찰 예정'];
  if (Number.isFinite(end) && end>=now) return [date(end)+' 입찰 마감',lot.status || '입찰 진행'];
  return ['입찰 일정 확인',lot.status || '상태 미확인'];
}
function createCard(lot) {
  const type=locationType(lot),key=recordKey(lot),[schedule,status]=compactSchedule(lot);
  const category=String(lot.category || '').replace(/^부동산\s*/, '').replace(/^(토지|주거용건물)\s*/, '');
  const card=document.createElement('article');card.className='lot';card.dataset.record=key;
  card.setAttribute('aria-label',shortAddress(lot)+' · '+money(lot.min_price));
  card.innerHTML='<div class="lot-top"><span class="property-kind">'+esc(lot.property_type || '공매')+'<em>·</em>'+esc(category || '종류 미확인')+'</span><button class="favorite-button" type="button" aria-label="'+esc(shortAddress(lot))+' 관심 매물 '+(savedLot(lot) ? '해제' : '저장')+'" aria-pressed="'+savedLot(lot)+'">'+icon('heart')+'</button></div>'+
    '<div class="price-row"><strong class="price" title="'+money(lot.min_price)+'">'+compactMoney(lot.min_price)+'</strong><span class="price-label">최저입찰가</span></div>'+
    '<h3>'+esc(shortAddress(lot))+'</h3><p class="property-meta"><b>'+esc(areaText(lot.area))+'</b> · '+(lot.property_type==='주택' ? '건물 면적' : '토지 면적')+'</p>'+
    '<div class="badges"><span class="badge '+type+'">'+locationLabel[type]+'</span>'+(lot.share ? '<span class="badge share">지분 매각</span>' : '')+(lot.multiple_parcels ? '<span class="badge">여러 필지 · 대표 경계</span>' : '')+'</div>'+
    '<div class="card-bottom"><p class="schedule"><b>'+esc(schedule)+'</b>'+esc(status)+'</p><button class="map-button" type="button" aria-pressed="false"'+(type==='unknown' || !map ? ' disabled' : '')+'>'+icon('pin')+(type==='parcel' ? '필지 보기' : type==='unknown' ? '위치 미확인' : '지도 보기')+'</button></div>'+
    '<details class="lot-details"><summary>입찰·상세 정보</summary><div class="lot-details-content"><p class="full-name">'+esc(lot.name || lot.address)+'</p><p class="schedule-full">표시 일정의 최저입찰가 <b>'+money(lot.min_price)+'</b><br>시작 '+fmtBid(lot.bid_start)+'<br>종료 '+fmtBid(lot.bid_end)+'</p><div class="lot-actions"></div><dl></dl></div></details>';
  card.querySelector('.favorite-button').addEventListener('click',()=>toggleSaved(lot));
  const select=()=>{setView('map');focusLot(key,false);};
  card.querySelector('.map-button').addEventListener('click',select);
  card.addEventListener('click',event=>{if (!event.target.closest('button,a,details,input,select') && type!=='unknown' && map) select();});
  const content=card.querySelector('.lot-details-content'),actions=card.querySelector('.lot-actions');
  if (lot.rounds?.length>1) {
    const rounds=document.createElement('details');rounds.className='round-details';
    rounds.innerHTML='<summary>같은 물건의 입찰 일정 '+lot.rounds.length+'건</summary><table><thead><tr><th scope="col">입찰 종료</th><th scope="col">최저입찰가</th></tr></thead><tbody>'+lot.rounds.map(round=>'<tr><td>'+fmtBid(round.bid_end)+'</td><td>'+money(round.min_price)+'</td></tr>').join('')+'</tbody></table><p>후속 일정은 앞선 회차의 진행 결과에 따라 달라질 수 있습니다.</p>';
    content.insertBefore(rounds,actions);
  }
  const appendLink=(url,label)=>{const a=document.createElement('a');a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.textContent=label;actions.append(a);};
  appendLink('https://map.naver.com/p/search/'+encodeURIComponent(lot.address),'네이버 지도 ↗');
  const sourceURL=parcelShapes.get(String(lot.pnu))?.properties?.source_url;
  if (typeof sourceURL==='string' && sourceURL.startsWith('https://gris.gg.go.kr/map/main/grisMapView.do?')) appendLink(sourceURL,'공식 지적도 ↗');
  if (typeof lot.url==='string' && /^https:\/\//.test(lot.url)) appendLink(lot.url,'온비드 공고 ↗');
  const fields=[['물건번호',lot.lot_id],['면적 기준',lot.property_type==='주택' ? '건물 면적 · 지분 여부 확인' : '토지 면적 · 지분 여부 확인'],['실주행 시간',lot.drive_min==null ? '미확인' : lot.drive_min+'분'],['진입도로',lot.road],['상수도 / 하수도',(lot.water || '미확인')+' / '+(lot.sewer || '미확인')],['전력계통 / 일조',(lot.grid || '미확인')+' / '+(lot.sunlight || '미확인')]];
  const dl=card.querySelector('dl');
  fields.forEach(([label,value])=>{const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value ?? '미확인';dl.append(dt,dd);});
  return card;
}
function render({preserveMap=false}={}) {
  const filtered=chooseRows();
  visibleLots=filtered.filter(lot=>scope==='all' || scope==='mapped' && locationType(lot)!=='unknown' || scope==='saved' && savedLot(lot));
  const mapped=filtered.filter(lot=>locationType(lot)!=='unknown').length;
  const savedCount=lots.filter(savedLot).length;
  $('count').textContent=visibleLots.length;
  $('allCount').textContent=filtered.length; $('mappedCount').textContent=mapped;
  $('savedTabCount').textContent=filtered.filter(savedLot).length; $('savedCount').textContent=savedCount;
  $('mobileCount').textContent=visibleLots.length;
  $('scopeLabel').textContent={all:'전체 매물',mapped:'지도에 표시된 매물',saved:'관심 매물'}[scope];
  $('listHint').textContent=scope==='saved' ? '관심 매물은 이 브라우저에 저장돼요.' : '전체 '+filtered.length+'건 중 지도 '+mapped+'건 · 위치 미확인 매물은 목록에서 확인';
  $('savedButton').setAttribute('aria-pressed',String(scope==='saved'));
  document.querySelectorAll('[data-scope]').forEach(button=>{button.classList.toggle('active',button.dataset.scope===scope);button.setAttribute('aria-pressed',String(button.dataset.scope===scope));});
  const cap=$('price').value==='' ? 100000000 : Math.max(0,Math.min(100000000,Number($('price').value)||0));
  const priceText=compactMoney(cap);
  $('priceFilterLabel').textContent=priceText+(priceText.endsWith('원') ? '' : '원')+' 이하';
  const pages=Math.max(1,Math.ceil(visibleLots.length/PAGE_SIZE));page=Math.min(page,pages);
  $('pageInfo').textContent=page+' / '+pages+'페이지';$('previous').disabled=page<=1;$('next').disabled=page>=pages;
  const list=$('list');list.replaceChildren();list.setAttribute('aria-busy',String(loading));cardNodes.clear();
  if (!visibleLots.some(lot=>recordKey(lot)===selectedKey)) selectedKey=null;
  if (!visibleLots.length) {
    const message=document.createElement('div');message.className='empty';
    const title=loading ? '매물을 불러오고 있어요.' : loadFailed && !lots.length ? '데이터를 불러오지 못했어요.' : scope==='saved' && !savedCount ? '마음에 드는 매물을 모아보세요.' : '조건에 맞는 매물이 없어요.';
    const copy=scope==='saved' && !savedCount ? '매물의 하트를 누르면 여기에 저장돼요.' : loadFailed && !lots.length ? '수집 현황에서 새로고침해 주세요.' : '검색어나 필터를 조금 바꿔보세요.';
    message.innerHTML=icon(scope==='saved' ? 'heart' : 'search')+'<strong>'+title+'</strong>'+copy;
    if (lots.length) {const reset=document.createElement('button');reset.type='button';reset.textContent=scope==='saved' ? '전체 매물 보기' : '조건 초기화';reset.addEventListener('click',resetFilters);message.append(document.createElement('br'),reset);}
    list.append(message);
  }
  visibleLots.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE).forEach(lot=>{const card=createCard(lot);list.append(card);cardNodes.set(recordKey(lot),card);});
  if (!preserveMap) {renderMap(visibleLots);if (selectedKey) focusLot(selectedKey,false);}
  updateSelection();
}

function resetFilters() {
  $('search').value=''; $('price').value='100000000'; $('kind').value='all';
  $('location').value='all'; $('sort').value='location'; $('excludeShares').checked=false;
  scope='all';selectedKey=null;page=1;render();
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
document.querySelector('.skip-link').addEventListener('click',event=>{event.preventDefault();setView('list');$('resultsHeading').focus();});
$('refresh').addEventListener('click',load);
$('reset').addEventListener('click',resetFilters);
$('fitAll').addEventListener('click',()=>{selectedKey=null;updateSelection();fitAll();});
$('baseLocation').addEventListener('click',()=>{if (map) {map.setView([37.237,127.072],13,{animate:false});$('mapNotice').textContent='서천동 근사 기준점 · 출입구 위치와 실주행 시간은 미확인';}});
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
$('filterButton').addEventListener('click',()=>{priceBeforeEdit=$('price').value;$('filterDialog').returnValue='';$('filterDialog').showModal();$('price').focus();updatePricePresets();});
document.querySelectorAll('[data-close]').forEach(button=>button.addEventListener('click',()=>button.closest('dialog').close()));
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if (event.target===dialog) {const rect=dialog.getBoundingClientRect();if (event.clientX<rect.left || event.clientX>rect.right || event.clientY<rect.top || event.clientY>rect.bottom) dialog.close();}}));
function updatePricePresets() {document.querySelectorAll('[data-price]').forEach(button=>button.classList.toggle('active',button.dataset.price===$('price').value));}
document.querySelectorAll('[data-price]').forEach(button=>button.addEventListener('click',()=>{$('price').value=button.dataset.price;updatePricePresets();}));
$('price').addEventListener('input',updatePricePresets);
function applyPrice() {
  const input=$('price');
  if (input.value==='') input.value='100000000';
  input.value=String(Math.max(0,Math.min(100000000,Number(input.value)||0)));
  selectedKey=null;page=1;render();updatePricePresets();$('filterDialog').close('applied');$('listScroll').scrollTop=0;
}
$('applyPrice').addEventListener('click',applyPrice);
$('price').addEventListener('keydown',event=>{if (event.key==='Enter') {event.preventDefault();applyPrice();}});
$('filterDialog').addEventListener('close',()=>{if ($('filterDialog').returnValue!=='applied') $('price').value=priceBeforeEdit;updatePricePresets();});
window.addEventListener('resize',()=>{if (map && (document.body.dataset.view!=='list' || !window.matchMedia('(max-width:640px)').matches)) {map.invalidateSize();drawMarkers();}});
load();
