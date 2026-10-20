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

// Rows belong to one payee and one draft. The caller supplies verified dates,
// standards and segment identities; this tool neither reads history nor chooses
// business currencies. A calendar day belongs to the segment arriving later
// (latest start date, then the later itinerary segment on the same day).
// Currency-split rows share that segment's allocation. Explicit employee amounts
// are retained independently of the default allocation.
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
      segmentKey:row.segmentKey??JSON.stringify([region,start,end]),preferred:row.preferred===true,
      days:(end-start)/DAY+1,eligibleDays:0,suggestedAmount:null,
      amount:explicit?row.amount:null,explicit,nonzero,overlapIndexes:[],sharedDays:[]};
  });
  const conflicts=[];
  const segments=new Map();
  for(const row of work) {
    if(!segments.has(row.segmentKey)) segments.set(row.segmentKey,[]);
    segments.get(row.segmentKey).push(row);
  }
  let allocated=[];
  const ordered=[...segments.values()].sort((a,b)=>b[0].start-a[0].start||b[0].index-a[0].index);
  for(const segment of ordered) {
    const first=segment[0],available=remaining(first.start,first.end,allocated);
    const defaults=segment.filter(row=>!row.explicit).sort((a,b)=>Number(b.preferred)-Number(a.preferred)||a.index-b.index);
    const owner=segment.find(row=>row.nonzero)??defaults[0]??first;
    const sharedDays=allocated.flatMap(range=>{
      const start=Math.max(first.start,range.start),end=Math.min(first.end,range.end);
      return start<=end?[{start,end,index:range.index}]:[];
    });
    for(const row of segment) row.sharedDays=sharedDays;
    const explicitCoverage=merge(segment.filter(row=>row.nonzero));
    for(let i=0;i<segment.length;i++) for(let j=i+1;j<segment.length;j++) {
      const left=segment[i],right=segment[j],start=Math.max(left.start,right.start),end=Math.min(left.end,right.end);
      if(start>end) continue;
      left.overlapIndexes.push(right.index);
      right.overlapIndexes.push(left.index);
      if(left.nonzero && right.nonzero) {
        conflicts.push({code:'EXPLICIT_AMOUNT_OVERLAP',indexes:[left.index,right.index],start,end});
      }
    }
    for(const row of segment.filter(row=>row.explicit)) {
      row.eligibleDays=row.nonzero?count(available):0;
      row.suggestedAmount=product(row.standard,row.eligibleDays,precision);
    }
    let claimed=explicitCoverage;
    for(const row of defaults) {
      const ranges=available.flatMap(range=>remaining(range.start,range.end,claimed));
      row.eligibleDays=count(ranges);
      row.suggestedAmount=product(row.standard,row.eligibleDays,precision);
      row.amount=row.suggestedAmount;
      claimed=merge([...claimed,...ranges]);
    }
    allocated.push(...available.map(range=>({...range,index:owner.index})));
  }
  return {rows:work.map(({days,eligibleDays,suggestedAmount,amount,overlapIndexes,explicit,sharedDays})=>
    ({days,eligibleDays,suggestedAmount,amount,overlapIndexes,explicit,sharedDays})),conflicts};
}

module.exports={suggestAllowances};
