const test=require('node:test');
const assert=require('node:assert/strict');
const {bidTimestamp,groupLots}=require('../app-data.js');
const now=Date.parse('2026-11-15T00:00:00Z');

test('Korean bid dates use Seoul time, regardless of browser timezone',()=>{
  assert.equal(bidTimestamp('202611161000'),Date.parse('2026-11-16T01:00:00Z'));
  assert.ok(Number.isNaN(bidTimestamp('')));
});
test('the next scheduled round is displayed instead of a cheaper future round',()=>{
  const base={lot_id:'A',address:'경기도 군포시 당동 957-2',status:'입찰준비중'};
  const rows=groupLots([
    {...base,condition_id:'later',bid_end:'202704141700',min_price:10000000},
    {...base,condition_id:'next',bid_end:'202611161700',min_price:50000000}
  ],now);
  assert.equal(rows.length,1);
  assert.equal(rows[0].condition_id,'next');
  assert.equal(rows[0].min_price,50000000);
  assert.equal(rows[0].rounds.length,2);
});
test('separate properties on the same parcel remain separate',()=>{
  assert.equal(groupLots([{lot_id:'A',pnu:'same',min_price:1},{lot_id:'B',pnu:'same',min_price:2}],now).length,2);
});
test('expired rounds cannot replace an upcoming round',()=>{
  const rows=groupLots([{lot_id:'A',bid_end:'202601011000',min_price:1},{lot_id:'A',bid_end:'202701011000',min_price:5}],now);
  assert.equal(rows[0].min_price,5);
  assert.equal(rows[0].rounds.length,1);
});
test('private-contract availability survives the original auction end date',()=>{
  const rows=groupLots([{lot_id:'A',bid_end:'202601011000',status:'수의계약가능',min_price:1}],now);
  assert.equal(rows[0].rounds.length,1);
});

const {kstDate,validScheduleRange,bidPhase,matchesSchedule,filterLotsBySchedule}=require('../app-data.js');
const scheduleNow=Date.parse('2026-11-16T01:00:00Z'); // 10:00 KST
const round={lot_id:'schedule',bid_start:'202611161000',bid_end:'202611161700',status:'입찰준비중',min_price:50000000};

test('bid timestamps preserve seconds and reject impossible calendar values',()=>{
  assert.equal(bidTimestamp('20261116235959'),Date.parse('2026-11-16T14:59:59Z'));
  for (const value of ['202602300900','202613010900','202611162400','202611160060','20261116100060']) assert.ok(Number.isNaN(bidTimestamp(value)),value);
  assert.equal(bidTimestamp('202802290900'),Date.parse('2028-02-29T00:00:00Z'));
});
test('schedule state respects both boundaries, cancellations, and missing dates',()=>{
  assert.equal(bidPhase(round,scheduleNow-1),'upcoming');
  assert.equal(bidPhase(round,scheduleNow),'active');
  assert.equal(bidPhase(round,bidTimestamp(round.bid_end)),'active');
  assert.equal(bidPhase(round,bidTimestamp(round.bid_end)+1),'ended');
  assert.equal(bidPhase({...round,status:'입찰취소'},scheduleNow),'ended');
  assert.equal(bidPhase({...round,bid_start:''},scheduleNow),'unknown');
  assert.equal(bidPhase({...round,bid_start:'202611181000'},scheduleNow),'unknown');
});
test('calendar presets and one-day ranges use Korean midnight',()=>{
  const midnight=Date.parse('2026-11-15T15:00:00Z');
  assert.equal(kstDate(midnight-1),'2026-11-15');
  assert.equal(kstDate(midnight),'2026-11-16');
  assert.equal(kstDate(Date.parse('2026-12-31T15:00:00Z')),'2027-01-01');
  const filters={basis:'end',from:'2026-11-16',to:'2026-11-16'};
  assert.equal(matchesSchedule({...round,bid_end:'20261116235959'},filters,scheduleNow),true);
  assert.equal(matchesSchedule({...round,bid_end:'20261117000000'},filters,scheduleNow),false);
});
test('start-date and closing-date filters use the chosen event, with open bounds',()=>{
  const lot={...round,bid_start:'202611151000',bid_end:'202611171700'};
  assert.equal(matchesSchedule(lot,{basis:'start',from:'2026-11-16'},scheduleNow),false);
  assert.equal(matchesSchedule(lot,{basis:'end',from:'2026-11-16'},scheduleNow),true);
  assert.equal(matchesSchedule(lot,{basis:'start',to:'2026-11-16'},scheduleNow),true);
  assert.equal(matchesSchedule(lot,{basis:'end',to:'2026-11-16'},scheduleNow),false);
});
test('invalid or reversed date ranges never silently broaden the result',()=>{
  assert.equal(validScheduleRange(),true);
  assert.equal(validScheduleRange('2026-11-16','2026-11-16'),true);
  assert.equal(validScheduleRange('2026-11-17','2026-11-16'),false);
  assert.equal(validScheduleRange('2026-02-30',''),false);
  assert.equal(matchesSchedule(round,{from:'2026-11-17',to:'2026-11-16'},scheduleNow),false);
});
test('filtering a later round displays its corresponding price and keeps verified geometry',()=>{
  const items=[
    {...round,condition_id:'next',pnu:'verified',lat:37.2,lng:127.1,location_precision:'parcel'},
    {...round,condition_id:'later',bid_start:'202612011000',bid_end:'202612011700',min_price:30000000,pnu:null,lat:null,lng:null,location_precision:'unknown'}
  ];
  const grouped=groupLots(items,scheduleNow);
  const result=filterLotsBySchedule(grouped,{phase:'upcoming',basis:'start',from:'2026-12-01',to:'2026-12-01'},scheduleNow);
  assert.equal(result.length,1);
  assert.equal(result[0].condition_id,'later');
  assert.equal(result[0].min_price,30000000);
  assert.equal(result[0].bid_start,'202612011000');
  assert.equal(result[0].pnu,'verified');
  assert.equal(result[0].location_precision,'parcel');
  assert.equal(result[0].rounds.length,2);
  assert.equal(result[0].matching_round_count,1);
  assert.equal(grouped[0].condition_id,'next');
  assert.equal(filterLotsBySchedule(grouped,{},scheduleNow),grouped);
});
test('running-only filtering selects an active round even if an earlier one ended after load',()=>{
  const grouped=groupLots([
    {...round,condition_id:'first',bid_end:'202611161100'},
    {...round,condition_id:'second',bid_start:'202611161200',bid_end:'202611161700',min_price:40000000}
  ],scheduleNow);
  const result=filterLotsBySchedule(grouped,{phase:'active'},Date.parse('2026-11-16T04:00:00Z'));
  assert.equal(result[0].condition_id,'second');
  assert.equal(result[0].min_price,40000000);
});
test('private contracts remain discoverable without treating old auction dates as deadlines',()=>{
  const lot={...round,status:'수의계약가능',bid_start:'202601011000',bid_end:'202601011700'};
  assert.equal(bidPhase(lot,scheduleNow),'private');
  assert.equal(matchesSchedule(lot,{phase:'private'},scheduleNow),true);
  assert.equal(matchesSchedule(lot,{phase:'active'},scheduleNow),false);
  assert.equal(matchesSchedule(lot,{from:'2026-01-01',to:'2026-01-01'},scheduleNow),false);
  assert.equal(matchesSchedule({...lot,status:'입찰준비중',bid_start:'',bid_end:''},{phase:'unknown'},scheduleNow),true);
});

test('an upcoming auction takes precedence over a retired or private-contract deadline',()=>{
  const upcoming={...round,condition_id:'upcoming',bid_start:'202611171000',bid_end:'202611171700'};
  const cancelled={...round,condition_id:'cancelled',status:'입찰취소'};
  const privateContract={...round,condition_id:'private',status:'수의계약가능',bid_end:'202601011000'};
  assert.equal(groupLots([cancelled,privateContract,upcoming],scheduleNow)[0].condition_id,'upcoming');
  assert.equal(bidPhase({...privateContract,status:'수의계약 완료'},scheduleNow),'ended');
});

test('the price cap and schedule both apply before picking a matching round',()=>{
  const first={...round,condition_id:'first'};
  const later={...round,condition_id:'later',bid_start:'202611171000',bid_end:'202611171700',min_price:30000000};
  const lots=groupLots([first,later],scheduleNow-1);
  const matches=filterLotsBySchedule(lots,{phase:'upcoming',to:'2026-11-17'},scheduleNow-1,40000000);
  assert.equal(matches[0].condition_id,'later');
  assert.equal(matches[0].matching_round_count,1);
  assert.deepEqual(filterLotsBySchedule(lots,{phase:'upcoming',to:'2026-11-16'},scheduleNow-1,40000000),[]);
});

test('driving estimates only match current verified single-parcel land coordinates',()=>{
  const {routeEstimate}=require('../app-data.js');
  const pnu='4146311000108010000', point=[37.238128,127.075942];
  const routes={[pnu]:{seconds:1800,point,checked_at:'2026-11-15T00:00:00Z'}};
  const lot={pnu,property_type:'토지',location_precision:'parcel',lat:point[0],lng:point[1]+0.0000004};
  assert.equal(routeEstimate(lot,routes,now)?.seconds,1800);
  for (const change of [{location_precision:'area'},{lng:127.5},{multiple_parcels:true},{property_type:'주택'}]) {
    assert.equal(routeEstimate({...lot,...change},routes,now),null);
  }
  assert.equal(routeEstimate(lot,routes,now+31*86400000),null);
  assert.equal(routeEstimate(lot,{[pnu]:{...routes[pnu],seconds:null}},now),null);
});
