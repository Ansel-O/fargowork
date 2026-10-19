'use strict';
const {check} = require('../scripts/lib/common.cjs');
const normalized = value => String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
function values(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return value.flatMap(values);
  if (typeof value === 'object') return ['label','name','value','key'].flatMap(key=>values(value[key]));
  check(typeof value === 'string' || typeof value === 'number', 'CATALOG_VALUE_INVALID');
  return [String(value).trim()].filter(Boolean);
}

// Fixed sources and projected columns come from workflow configuration.
// Always reapply exact equality: upstream searches may use partial matching.
function emptyValue(value) {
  return value===undefined || value===null || typeof value==='string'&&value.trim()===''
    || Array.isArray(value)&&value.length===0;
}
async function matchingRows(ctx, formUuid, filters, columns) {
  const rows=await ctx.query(formUuid, filters, [...new Set([...Object.keys(filters),...columns])]);
  check(Array.isArray(rows),'CATALOG_RESPONSE_INVALID');
  return rows.filter(row=>Object.entries(filters).every(([field,wanted])=>
    emptyValue(wanted)?emptyValue(row[field]):values(row[field]).some(value=>normalized(value)===normalized(wanted))));
}
function distinctValues(rows, field) {
  const distinct=new Map();
  for(const row of rows) for(const value of values(row[field])) {
    const key=normalized(value);if(!distinct.has(key)) distinct.set(key,value);
  }
  return [...distinct.values()];
}
module.exports={matchingRows,distinctValues};
