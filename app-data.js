(function(root) {
  'use strict';
  const DAY=86400000;
  const KST=9*3600000;
  function bidTimestamp(value) {
    const text=String(value || '');
    if (!/^\d{12}(?:\d{2})?$/.test(text)) return NaN;
    const [year,month,day,hour,minute,second]=[text.slice(0,4),text.slice(4,6),text.slice(6,8),text.slice(8,10),text.slice(10,12),text.slice(12,14) || '0'].map(Number);
    const time=Date.UTC(year,month-1,day,hour,minute,second);
    const date=new Date(time);
    // Date.UTC normalizes impossible dates; reject them rather than shifting a bid.
    if (date.getUTCFullYear()!==year || date.getUTCMonth()!==month-1 || date.getUTCDate()!==day || date.getUTCHours()!==hour || date.getUTCMinutes()!==minute || date.getUTCSeconds()!==second) return NaN;
    return time-KST;
  }
  function kstDate(now=Date.now()) {
    return new Date(now+KST).toISOString().slice(0,10);
  }
  function dateTimestamp(value) {
    return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? bidTimestamp(value.replaceAll('-','')+'0000') : NaN;
  }
  function validScheduleRange(from='',to='') {
    return (!from || Number.isFinite(dateTimestamp(from))) && (!to || Number.isFinite(dateTimestamp(to))) && (!from || !to || from<=to);
  }
  const isClosed = lot => /취소|중지|완료|낙찰|유찰/.test(lot.status || '');
  function bidPhase(lot,now=Date.now()) {
    if (isClosed(lot)) return 'ended';
    if (/수의/.test(lot.status || '')) return 'private';
    const start=bidTimestamp(lot.bid_start),end=bidTimestamp(lot.bid_end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start>end) return 'unknown';
    if (now<start) return 'upcoming';
    return now<=end ? 'active' : 'ended';
  }
  function matchesSchedule(lot,{phase='all',basis='end',from='',to=''}={},now=Date.now()) {
    const state=bidPhase(lot,now);
    if (phase!=='all' && phase!==state) return false;
    if (!validScheduleRange(from,to)) return false;
    if (!from && !to) return true;
    // A private contract's old auction dates do not establish a current deadline.
    if (state==='private' || state==='unknown') return false;
    const time=bidTimestamp(basis==='start' ? lot.bid_start : lot.bid_end);
    return Number.isFinite(time) && (!from || time>=dateTimestamp(from)) && (!to || time<dateTimestamp(to)+DAY);
  }
  function filterLotsBySchedule(lots,filters={},now=Date.now(),maxPrice=Infinity) {
    if ((!filters.phase || filters.phase==='all') && !filters.from && !filters.to) return lots;
    return lots.flatMap(lot=>{
      const rounds=Array.isArray(lot.rounds) && lot.rounds.length ? lot.rounds : [lot];
      const matching=rounds.filter(round=>round.min_price<=maxPrice && matchesSchedule(round,filters,now));
      if (!matching.length) return [];
      const chosen=groupLots(matching,now)[0];
      const location={};
      ['pnu','lat','lng','location_precision'].forEach(field=>{if (lot[field]!=null) location[field]=lot[field];});
      return [{...chosen,...location,rounds,matching_round_count:matching.length}];
    });
  }
  function groupLots(items, now=Date.now()) {
    const groups=new Map();
    items.forEach(lot=>{
      if (!groups.has(lot.lot_id)) groups.set(lot.lot_id,[]);
      groups.get(lot.lot_id).push(lot);
    });
    return [...groups.values()].map(rounds=>{
      const active=rounds.filter(round=>!isClosed(round) && (/수의/.test(round.status || '') || !Number.isFinite(bidTimestamp(round.bid_end)) || bidTimestamp(round.bid_end)>=now));
      const eligible=active.length ? active : rounds;
      eligible.sort((a,b)=>{
        // A private-contract record can carry an old deadline from a previous round.
        const aPrivate=/수의/.test(a.status || ''), bPrivate=/수의/.test(b.status || '');
        if (aPrivate!==bPrivate) return aPrivate ? 1 : -1;
        if (aPrivate) return a.min_price-b.min_price;
        const aTime=bidTimestamp(a.bid_end),bTime=bidTimestamp(b.bid_end);
        return (Number.isFinite(aTime)?aTime:Infinity)-(Number.isFinite(bTime)?bTime:Infinity) || a.min_price-b.min_price;
      });
      const chosen=eligible[0];
      // Geometry/location can be confirmed on another round of the same object.
      const located=rounds.find(round=>round.location_precision==='parcel') || rounds.find(round=>round.location_precision==='exact') || rounds.find(round=>round.lat!=null && round.lng!=null);
      return {...chosen,...(located?{pnu:located.pnu,lat:located.lat,lng:located.lng,location_precision:located.location_precision}:{}),rounds:eligible};
    });
  }
  function routeEstimate(lot,routes,now=Date.now()) {
    if (lot.property_type!=='토지' || lot.multiple_parcels || lot.location_precision!=='parcel') return null;
    const entry=Object.hasOwn(routes,lot.pnu) ? routes[lot.pnu] : null;
    if (!entry || !Number.isInteger(entry.seconds) || entry.seconds<0 ||
        !Array.isArray(entry.point) || entry.point.length!==2 || !entry.point.every(Number.isFinite) ||
        !Number.isFinite(lot.lat) || !Number.isFinite(lot.lng) ||
        Math.abs(entry.point[0]-lot.lat)>0.000001 || Math.abs(entry.point[1]-lot.lng)>0.000001) return null;
    const age=now-Date.parse(entry.checked_at);
    return Number.isFinite(age) && age>=0 && age<=30*DAY ? entry : null;
  }
  const api={bidTimestamp,groupLots,kstDate,validScheduleRange,bidPhase,matchesSchedule,filterLotsBySchedule,routeEstimate};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  else root.LandScoutData=api;
})(typeof window==='undefined'?globalThis:window);
