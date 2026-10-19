'use strict';

const APP = 'APP_GITLRTH76PM6J4M29F5D';
const FORM = require('../config/workflows/finance/external_expense_request.json').target.formUuid;
const TABLES = Object.freeze({
  companies: ['FORM-FB1F218B6F6B4BB4AA54B60087F8265DIB6X', 'textField_m0apuch7', 'radioField_m8g0bxo6'],
  currencies: ['FORM-7D97B6BF8C88482ABECE6D1AA9C2454B21S8', 'selectField_m0g613r7', 'selectField_m0g613r8'],
  contacts: ['FORM-70411F65EF7B412C84FD5A61760DF4BCZU6C', 'selectField_m8g1cqwr', 'employeeField_m8g1cqwu', 'employeeField_m8g1cqwv'],
  suppliers: ['FORM-9C3040D5F165492C9558FE9F0128D6A8PWU5', 'textField_a3vxwlt', 'textField_q94nymh', 'textField_7lpx0ge'],
  supplierPairs: ['FORM-344EDBF6A6BB4F5A9F17C4A97353A67F5VR7', 'selectField_mipekpjy', 'selectField_mipekpjz', 'selectField_mipekpk0'],
  accounts: ['FORM-09190A7BD4FA473383608B2784A409A8WH1S', 'textField_m4aoqtkh', 'textField_m4aoqtki'],
  structures: ['FORM-5902374F6C2C462AB826C0EB5B6F73CB9JBQ', 'textField_m8ijmeko', 'selectField_m8l4p5wo', 'selectField_m8l4p5wp', 'selectField_m8ik5hcg'],
  projects: ['FORM-B33628F4E05E47FBACD7EF29902BE12EPJKR', 'textField_m40odatb', 'textField_m8wrvwm2', 'textField_m4222ivk'],
  projectDepartments: ['FORM-C702478E872E41C6B35993ABD41B1B90H6O6', 'selectField_m40oe3nj', 'textField_m8wsspqp', 'textField_m40ym365', 'textField_m40pmzwx', 'selectField_m8obmi4m', 'departmentSelectField_m40neq61', 'departmentSelectField_m40neq61_id'],
  rates: ['FORM-0E81A1BBF9C24779B3087C10A32489E26UDW', 'textField_m3lpjlno', 'selectField_m3lpjlnt', 'numberField_m3lpjlnu'],
});
const RELATIONS = Object.freeze({
  contract: {form: 'FORM-3DB996CA240D4F3FAB0CC8C9E72A092BUJGU', field: 'associationFormField_m7a8veso', title: 'textField_m0ezwbjl', subtitle: 'serialNumberField_m0ewp8f9'},
  seal: {form: 'FORM-ABF68B75000543F4A34EFCB284AC13FAZL8E', field: 'associationFormField_ma3cqw2z', title: 'serialNumberField_m0yw02li', subtitle: 'selectField_m9ur9e78'},
});
const F = Object.freeze({
  applicant:'employeeField_m41da53i', applicantId:'textField_m41cj95b', applyDate:'dateField_m41cj93y', department:'selectField_m4labieb', departmentId:'textField_m8ln5a2e', manager:'employeeField_m4labied',
  company:'selectField_m41cj946', companyMirror:'textField_m41cj956', bearing:'selectField_m8g46rue', bearingMatch:'radioField_m88g5767', supplier:'selectField_mjqx84j3', bankAccount:'textField_mjqx84j6', bankName:'textField_mjqx84j7', supplierCategory:'selectField_mjqx84j4', supplierAccount:'selectField_mjqx84j5', currency:'selectField_m453obgj',
  isProject:'radioField_m41da53k', project:'selectField_m41da53l', projectDepartment:'selectField_m41cj94d', projectDepartmentId:'textField_m41cj94e', projectManager:'employeeField_m41cj95f', projectCategory:'selectField_m8oc9psq',
  description:'textareaField_m41cj94b', latestDate:'dateField_m453obgk', latestDateText:'textField_m52173tq', workplace:'textField_m41cj957', bankFlag:'textField_m8g2zuug', finance:'employeeField_m453obgl', cashier:'employeeField_m453obgn',
  items:'tableField_m41cj94c', itemDescription:'textField_m41cj94g', itemAmount:'numberField_m41cj94j', itemRemarks:'textField_m41cj94q', itemCategory:'selectField_m41cj94f', itemAccount:'selectField_m4aq5ht9', itemProjectAccount:'selectField_m8oc9psr', itemHKD:'textField_m41cj958', itemRate:'numberField_m41cj959', itemHKDAmount:'numberField_m41cj94o', total:'numberField_m41cj94a', hkdTotal:'numberField_m41cj95d', attachment:'attachmentField_m41cj94r',
  applicationStructure:['selectField_m8ln5a2o','selectField_m8ln5a2q','selectField_m8ln5a2r'], projectStructure:['selectField_m8ln5a2s','selectField_m8ln5a2t','selectField_m8ln5a2u'],
});
function fail(code, message = '付款来源无法可靠核实，请联系维护人员。') { const e = new Error(message); e.code = code; throw e; }
function text(v) {
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) { const a = [...new Set(v.map(text).filter(Boolean))]; return a.length === 1 ? a[0] : ''; }
  if (v && typeof v === 'object') return text(v.label ?? v.name ?? v.value ?? v.key);
  return '';
}
function required(v, code = 'FW-PAY-SOURCE') { const s = text(v); if (!s) fail(code); return s; }
function unique(rows, predicate, code) { const found = rows.filter(predicate); if (found.length !== 1) fail(code); return found[0]; }
function same(a,b) { return text(a).normalize('NFKC').toLocaleLowerCase('en') === text(b).normalize('NFKC').toLocaleLowerCase('en'); }
function choose(needs, field, value, options, explicit = false) {
  const choices = [...new Set(options.map(v=>required(v)))];
  if (!choices.length) fail('FW-PAY-EMPTY-CATALOG');
  if (choices.includes(value)) return value;
  if ((value === undefined || value === '') && choices.length === 1 && !explicit) return choices[0];
  needs.push({field, message:'请从当前可用选项中选择；已提供的值不会自动替换。',choices:choices.map(value=>({value,label:value}))});
  return null;
}
function choosePair(needs, categoryKey, accountKey, category, account, pairs, fixedCategory) {
  if (!pairs.length) fail('FW-PAY-EMPTY-ACCOUNT-CATALOG');
  const categories = [...new Set(pairs.map(p=>required(p[0])))];
  if (fixedCategory && category && category !== fixedCategory) {
    needs.push({field:categoryKey,message:'明细类别必须与本次项目费用类别一致。',choices:[{value:fixedCategory,label:fixedCategory}]}); return null;
  }
  let filtered = pairs;
  if (category && categories.includes(category)) filtered = filtered.filter(p=>p[0]===category);
  if (account && filtered.some(p=>p[1]===account) && (!category || categories.includes(category))) filtered = filtered.filter(p=>p[1]===account);
  const c = choose(needs,categoryKey,category || fixedCategory,[...new Set(filtered.map(p=>p[0]))]);
  if (!c) return null;
  const a = choose(needs,accountKey,account,filtered.filter(p=>p[0]===c).map(p=>p[1]));
  return a ? [c,a] : null;
}
async function rows(ctx, name, search = {}, selectedFields) {
  const [form,...fields] = TABLES[name];
  const result = await ctx.query(form, search, selectedFields || fields);
  if (!Array.isArray(result) || result.some(r=>!r || typeof r!=='object' || Array.isArray(r))) fail('FW-PAY-CATALOG-SHAPE');
  return result;
}
function rosterValues(roster, code, labelFirst=false) {
  const fields = roster.field_data_list || roster.fieldDataList || [];
  const matches = fields.filter(f=>(f.field_code || f.fieldCode)===code);
  if (matches.length!==1) return [];
  const values = matches[0].field_value_list || matches[0].fieldValueList || [];
  function expand(v) { if (Array.isArray(v)) return v.flatMap(expand); const s=text(v); if (!s) return []; if (s.startsWith('[')) {try {const a=JSON.parse(s);if(Array.isArray(a))return a.flatMap(expand);}catch{}} return s.split(/[|,;，；]+/u).map(x=>x.trim()).filter(Boolean); }
  return [...new Set(values.flatMap(v=>expand(labelFirst ? v.label || v.value : v.value || v.label)))];
}
function memberIds(row, field) {
  const idValue = row[field+'_id'];
  const authoritative = idValue!==undefined && idValue!==null && idValue!=='' && (!Array.isArray(idValue)||idValue.length) ? idValue : undefined;
  const raw = authoritative ?? row[field];
  if (raw===undefined || raw===null || raw==='' || (Array.isArray(raw)&&!raw.length)) return [];
  const list=Array.isArray(raw)?raw:[raw];
  return [...new Set(list.map(v=>{
    if (typeof v==='string') {if(authoritative===undefined)fail('FW-PAY-CONTACT-ID'); return required(v);}
    if (!v || typeof v!=='object') fail('FW-PAY-CONTACT-ID');
    return required(v.userId ?? v.userid ?? v.value ?? v.id ?? v.key,'FW-PAY-CONTACT-ID');
  }))];
}
function date(value) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ms=Date.parse(value+'T00:00:00+08:00');
  return Number.isFinite(ms) && new Date(ms+8*3600000).toISOString().slice(0,10)===value ? ms : null;
}
// Decimal integer arithmetic keeps line HALF_UP rounding independent of IEEE-754.
function decimal(value) {
  if (!['number','string'].includes(typeof value) || (typeof value==='number'&&!Number.isFinite(value))) fail('FW-PAY-AMOUNT','金额或汇率须为有效数字。');
  const s=String(value).trim(), m=/^(-?)(\d{1,16})(?:\.(\d{1,12}))?$/.exec(s);
  if (!m) fail('FW-PAY-AMOUNT','金额或汇率格式无效或精度超出范围。');
  return {n:BigInt((m[1]||'')+m[2]+(m[3]||'')),s:(m[3]||'').length};
}
function cents(d) { if(d.s<=2)return d.n*10n**BigInt(2-d.s);const divisor=10n**BigInt(d.s-2), sign=d.n<0n?-1n:1n,n=d.n*sign; return sign*(n/divisor+(n%divisor*2n>=divisor?1n:0n)); }
function money(n) { if(n>9007199254740991n || n < -9007199254740991n) fail('FW-PAY-AMOUNT-RANGE');return Number(n)/100; }
function sum(ds) { const scale=Math.max(...ds.map(d=>d.s),0); return {s:scale,n:ds.reduce((n,d)=>n+d.n*10n**BigInt(scale-d.s),0n)}; }
function calculations(amounts, rateValue) { const rate=decimal(rateValue);if(rate.n<=0n)fail('FW-PAY-RATE');const raw=amounts.map(decimal), converted=raw.map(a=>cents({n:a.n*rate.n,s:a.s+rate.s}));return {rate:Number(rateValue),amounts:amounts.map(v=>Number(v)),converted:converted.map(money),total:money(cents(sum(raw))),hkdTotal:money(converted.reduce((a,b)=>a+b,0n))}; }
module.exports={APP,FORM,TABLES,RELATIONS,F,fail,text,required,unique,same,choose,choosePair,rows,rosterValues,memberIds,date,decimal,calculations};
