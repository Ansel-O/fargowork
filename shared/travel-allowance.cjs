'use strict';

const Decimal=require('./decimal-arithmetic.cjs');
const {check}=require('../scripts/lib/common.cjs');
const DAY=86400000, OFFSET=8*3600000;

function merge(ranges) {
  const result=[];
  for(const range of ranges.map(range=>({...range})).sort((a,b)=>a.start-b.start)) {
    const previous=result[result.length-1];
    if(previous && range.start<=previous.end+DAY) previous.end=Math.max(previous.end,range.end);
    else result.push(range);
  }
  return result;
}
function remaining(start,end,blocked) {
  const result=[];
  let cursor=start;
  for(const range of merge(blocked)) {
    if(range.end<cursor) continue;
    if(range.start>end) break;
    if(range.start>cursor) result.push({start:cursor,end:Math.min(end,range.start-DAY)});
    cursor=Math.max(cursor,range.end+DAY);
    if(cursor>end) break;
  }
  if(cursor<=end) result.push({start:cursor,end});
  return result;
}
function count(ranges) { return ranges.reduce((total,range)=>total+(range.end-range.start)/DAY+1,0); }
function product(standard,days,precision) {
  if(days===0) return 0;
  if(standard===null) return null;
  return Decimal.number(Decimal.round(Decimal.multiply(standard,Decimal.decimal(days)),precision));
}
function normalizedRegion(value) {
  check(value===undefined || value===null || typeof value==='string','TRAVEL_ALLOWANCE_REGION_INVALID');
  return value?.normalize('NFKC').trim().toLocaleLowerCase('en-US') || '';
}

// The supplied order is the employee's itinerary order. Every previous row
// reserves its inclusive dates, even when its employee amount is explicitly 0.
// This supports separate journeys and currency splits without inventing dates.
// Explicit employee amounts are preserved independently of the suggestion.
function suggestAllowances(rows,{precision=2}={}) {
  check(Array.isArray(rows),'TRAVEL_ALLOWANCE_ROWS_INVALID');
  Decimal.round(Decimal.decimal(0),precision);
  const work=rows.map((row,index)=>{
    check(row && typeof row==='object' && !Array.isArray(row),'TRAVEL_ALLOWANCE_ROW_INVALID');
    const {start,end}=row;
    check([start,end].every(value=>Number.isSafeInteger(value)
      && Number.isFinite(new Date(value).getTime()) && (value+OFFSET)%DAY===0)
      && end>=start,'TRAVEL_ALLOWANCE_DATE_INVALID');
    check(row.preferred===undefined || typeof row.preferred==='boolean','TRAVEL_ALLOWANCE_PREFERENCE_INVALID');
    check(row.segmentKey===undefined || typeof row.segmentKey==='string' && row.segmentKey.length>0,
      'TRAVEL_ALLOWANCE_SEGMENT_INVALID');
    const region=normalizedRegion(row.region);
    const standard=row.standard==null ? null : Decimal.decimal(row.standard);
    const explicit=Object.hasOwn(row,'amount');
    const nonzero=explicit && row.amount!=='' && row.amount!==null
      && Decimal.decimal(row.amount).coefficient!==0n;
    return {index,start,end,standard,region,
      segmentKey:row.segmentKey??JSON.stringify([region,start,end]),
      days:(end-start)/DAY+1,eligibleDays:0,suggestedAmount:null,
      amount:explicit?row.amount:null,explicit,nonzero,overlapIndexes:[],sharedDays:[]};
  });
  const conflicts=[];
  let allocated=[];
  for(const row of work) {
    const available=remaining(row.start,row.end,allocated);
    row.sharedDays=allocated.flatMap(range=>{
      const start=Math.max(row.start,range.start),end=Math.min(row.end,range.end);
      return start<=end?[{start,end,index:range.index}]:[];
    });
    for(const previous of work.slice(0,row.index)) {
      const start=Math.max(previous.start,row.start),end=Math.min(previous.end,row.end);
      if(start>end) continue;
      previous.overlapIndexes.push(row.index);row.overlapIndexes.push(previous.index);
      if(previous.segmentKey===row.segmentKey&&previous.nonzero&&row.nonzero) {
        conflicts.push({code:'EXPLICIT_AMOUNT_OVERLAP',indexes:[previous.index,row.index],start,end});
      }
    }
    row.eligibleDays=count(available);
    row.suggestedAmount=product(row.standard,row.eligibleDays,precision);
    if(!row.explicit)row.amount=row.suggestedAmount;
    allocated.push(...available.map(range=>({...range,index:row.index})));
  }
  return {rows:work.map(({days,eligibleDays,suggestedAmount,amount,overlapIndexes,explicit,sharedDays})=>
    ({days,eligibleDays,suggestedAmount,amount,overlapIndexes,explicit,sharedDays})),conflicts};
}

module.exports={suggestAllowances};
