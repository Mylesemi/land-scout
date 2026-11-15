(function(root) {
  'use strict';
  function bidTimestamp(value) {
    const text=String(value || '');
    if (!/^\d{12}(?:\d{2})?$/.test(text)) return NaN;
    return Date.parse(text.slice(0,4)+'-'+text.slice(4,6)+'-'+text.slice(6,8)+'T'+text.slice(8,10)+':'+text.slice(10,12)+':00+09:00');
  }
  function groupLots(items, now=Date.now()) {
    const groups=new Map();
    items.forEach(lot=>{
      if (!groups.has(lot.lot_id)) groups.set(lot.lot_id,[]);
      groups.get(lot.lot_id).push(lot);
    });
    return [...groups.values()].map(rounds=>{
      const active=rounds.filter(round=>/수의/.test(round.status || '') || !Number.isFinite(bidTimestamp(round.bid_end)) || bidTimestamp(round.bid_end)>=now);
      const eligible=active.length ? active : rounds;
      eligible.sort((a,b)=>{
        const aTime=bidTimestamp(a.bid_end),bTime=bidTimestamp(b.bid_end);
        return (Number.isFinite(aTime)?aTime:Infinity)-(Number.isFinite(bTime)?bTime:Infinity) || a.min_price-b.min_price;
      });
      const chosen=eligible[0];
      // Geometry/location can be confirmed on another round of the same object.
      const located=rounds.find(round=>round.location_precision==='parcel') || rounds.find(round=>round.location_precision==='exact') || rounds.find(round=>round.lat!=null && round.lng!=null);
      return {...chosen,...(located?{pnu:located.pnu,lat:located.lat,lng:located.lng,location_precision:located.location_precision}:{}),rounds:eligible};
    });
  }
  const api={bidTimestamp,groupLots};
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  else root.LandScoutData=api;
})(typeof window==='undefined'?globalThis:window);
