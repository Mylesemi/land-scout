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
