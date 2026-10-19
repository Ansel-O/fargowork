'use strict';

// Exact decimal operations without rounding policy, currency or workflow IDs.
const {check}=require('../scripts/lib/common.cjs');
function normalized(coefficient,scale) {
  while(scale>0 && coefficient%10n===0n) { coefficient/=10n;scale--; }
  return {coefficient,scale};
}
function decimal(value) {
  check(typeof value==='string' || typeof value==='number' && Number.isFinite(value),'DECIMAL_INVALID');
  const text=String(value).trim();
  check(text.length>0 && text.length<=100,'DECIMAL_INVALID');
  const match=/^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  check(match && (match[2] || match[3]),'DECIMAL_INVALID');
  let scale=(match[3]||'').length-Number(match[4]||0);
  check(Number.isSafeInteger(scale) && Math.abs(scale)<=100,'DECIMAL_INVALID');
  let coefficient=BigInt((match[1]==='-'?'-':'')+(match[2]||'0')+(match[3]||''));
  if(scale<0) { coefficient*=10n**BigInt(-scale);scale=0; }
  return normalized(coefficient,scale);
}
function number(value) {
  const {coefficient,scale}=value;
  check(typeof coefficient==='bigint' && Number.isSafeInteger(scale) && scale>=0 && scale<=200,'DECIMAL_INVALID');
  const result=Number(`${coefficient}e-${scale}`);
  check(Number.isFinite(result),'DECIMAL_NOT_REPRESENTABLE');
  const back=decimal(result), wanted=normalized(coefficient,scale);
  check(back.coefficient===wanted.coefficient && back.scale===wanted.scale,'DECIMAL_NOT_REPRESENTABLE');
  return result;
}
function multiply(left,right) {
  return normalized(left.coefficient*right.coefficient,left.scale+right.scale);
}
function add(left,right) {
  const scale=Math.max(left.scale,right.scale);
  return normalized(left.coefficient*10n**BigInt(scale-left.scale)
    +right.coefficient*10n**BigInt(scale-right.scale),scale);
}
function round(value, places) {
  check(Number.isInteger(places) && places >= 0 && places <= 100, 'DECIMAL_PRECISION_INVALID');
  if (value.scale <= places) return normalized(value.coefficient,value.scale);
  const divisor=10n**BigInt(value.scale-places), negative=value.coefficient<0n;
  const absolute=negative?-value.coefficient:value.coefficient;
  const coefficient=absolute/divisor+(absolute%divisor*2n>=divisor?1n:0n);
  return normalized(negative?-coefficient:coefficient,places);
}
module.exports={decimal,number,multiply,add,round};
