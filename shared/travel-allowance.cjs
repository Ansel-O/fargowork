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
// standards and region identities; this tool neither reads history nor chooses
// business currencies. Only explicitly edited amounts belong in row.amount.
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
    const standard=row.standard==null ? null : Decimal.decimal(row.standard);
    const explicit=Object.hasOwn(row,'amount');
    const nonzero=explicit && row.amount!=='' && row.amount!==null
      && Decimal.decimal(row.amount).coefficient!==0n;
    return {index,start,end,standard,region:normalizedRegion(row.region),preferred:row.preferred===true,
      days:(end-start)/DAY+1,eligibleDays:0,suggestedAmount:null,
      amount:explicit?row.amount:null,explicit,nonzero,overlapIndexes:[]};
  });
  const conflicts=[];
  const explicitCoverage=merge(work.filter(row=>row.nonzero));
  const disputed=[];
  for(let i=0;i<work.length;i++) for(let j=i+1;j<work.length;j++) {
    const left=work[i],right=work[j],start=Math.max(left.start,right.start),end=Math.min(left.end,right.end);
    if(start>end) continue;
    left.overlapIndexes.push(j);
    right.overlapIndexes.push(i);
    if(left.nonzero && right.nonzero) conflicts.push({code:'EXPLICIT_AMOUNT_OVERLAP',indexes:[i,j],start,end});
    // Without an explicit owner of these dates, do not choose between distinct
    // regions silently. The agent resolves the conflict before confirmation.
    if(!left.explicit && !right.explicit && left.region && right.region && left.region!==right.region) {
      for(const range of remaining(start,end,explicitCoverage)) {
        disputed.push(range);
        conflicts.push({code:'REGION_OVERLAP',indexes:[i,j],...range});
      }
    }
  }
  for(const row of work.filter(row=>row.explicit)) {
    row.eligibleDays=row.nonzero?row.days:0;
    row.suggestedAmount=product(row.standard,row.eligibleDays,precision);
  }
  let claimed=merge([...explicitCoverage,...disputed]);
  const defaults=work.filter(row=>!row.explicit).sort((a,b)=>Number(b.preferred)-Number(a.preferred)||a.index-b.index);
  for(const row of defaults) {
    const ranges=remaining(row.start,row.end,claimed);
    row.eligibleDays=count(ranges);
    row.suggestedAmount=product(row.standard,row.eligibleDays,precision);
    row.amount=row.suggestedAmount;
    claimed=merge([...claimed,...ranges]);
  }
  return {rows:work.map(({days,eligibleDays,suggestedAmount,amount,overlapIndexes,explicit})=>
    ({days,eligibleDays,suggestedAmount,amount,overlapIndexes,explicit})),conflicts};
}

module.exports={suggestAllowances};
