'use strict';

const Decimal=require('./decimal-arithmetic.cjs');
const {matchingRows,distinctValues}=require('./scoped-catalog.cjs');
const text=value=>typeof value==='string'&&value.trim().length>0;
const normalized=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
function check(condition,code,message) {
  if(!condition) throw Object.assign(new Error(message||code),{code});
}

// A resolver belongs to one preparation/validation run. The workflow supplies
// its fixed source, direction and optional rate precision; no global cache or
// same-currency, reciprocal, cross-rate or market-rate fallback is allowed.
function createRateResolver({ctx,source,ratePrecision,errorCode='EXCHANGE_RATE_INVALID',errorMessage}={}) {
  check(ctx&&typeof ctx.query==='function'&&source&&typeof source==='object', 'EXCHANGE_RATE_CONFIG_INVALID');
  const {formUuid,currencyField,targetCurrencyField,rateField}=source;
  check([formUuid,currencyField,targetCurrencyField,rateField].every(text)
    &&new Set([currencyField,targetCurrencyField,rateField]).size===3
    &&text(errorCode)&&(errorMessage===undefined||typeof errorMessage==='string'),'EXCHANGE_RATE_CONFIG_INVALID');
  if(ratePrecision!==undefined) Decimal.round(Decimal.decimal(0),ratePrecision);
  const cache=new Map();
  async function read(from,to) {
    const rows=await matchingRows(ctx,formUuid,{[currencyField]:from,[targetCurrencyField]:to},[rateField]);
    const values=distinctValues(rows,rateField);
    check(values.length===1,errorCode,errorMessage);
    let rate;
    try {
      const value=Decimal.decimal(values[0]);
      rate=Decimal.number(ratePrecision===undefined?value:Decimal.round(value,ratePrecision));
    } catch(error) {
      if(!['DECIMAL_INVALID','DECIMAL_NOT_REPRESENTABLE'].includes(error.code)) throw error;
      check(false,errorCode,errorMessage);
    }
    check(rate>0,errorCode,errorMessage);
    return rate;
  }
  return async function rate(from,to) {
    check(text(from)&&text(to),errorCode,errorMessage);
    // Normalize comparison/cache keys only; upstream receives the original text.
    const key=JSON.stringify([normalized(from),normalized(to)]);
    if(!cache.has(key)) {
      const pending=read(from,to).catch(error=>{cache.delete(key);throw error;});
      cache.set(key,pending);
    }
    return cache.get(key);
  };
}

// Callers choose every rounding boundary, including whether conversion is per
// line or after summing. These helpers do not select currencies or rate chains.
function convertAmount(amount,rate,precision) {
  return Decimal.number(Decimal.round(Decimal.multiply(Decimal.decimal(amount),Decimal.decimal(rate)),precision));
}
function sumAmounts(values,precision) {
  check(Array.isArray(values),'DECIMAL_INVALID');
  const total=values.reduce((sum,value)=>Decimal.add(sum,Decimal.decimal(value)),Decimal.decimal(0));
  return Decimal.number(Decimal.round(total,precision));
}

module.exports={createRateResolver,convertAmount,sumAmounts};
