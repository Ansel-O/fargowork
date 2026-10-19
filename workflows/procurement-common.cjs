'use strict';

// Shared procurement business rules; each workflow supplies its own fixed binding.
const sources = require('../config/sources.json');
const company = require('../config/company.json');
function createProcurementWorkflow(workflowConfig) {
const {key,title,target,fields,options,sources:bindings} = workflowConfig;
const formUuid=target.formUuid, F=Object.freeze({...fields});
const currencySource=sources[bindings.currency], rateSource=sources[bindings.rate], officeSource=sources[bindings.office];
const CURRENCY=currencySource.formUuid, RATE=rateSource.formUuid, OFFICE=officeSource.formUuid;
const METHODS=options.methods, TYPES=options.types;
const policy=Object.freeze({dataForms:[CURRENCY,RATE,OFFICE],
  rosterFields:Object.freeze([...workflowConfig.policy.rosterFields]), connectors:{roster:{...company.roster}}});
const requirements = {
  required:['reason','purchase_method','purchase_type','currency','items'],
  optional:['other_description','remarks','expected_delivery_date','department_id'],
  choices:{purchase_method:METHODS,purchase_type:TYPES},
  item:{required:['name','quantity','unit_price'],optional:['specification'],maximumRows:50},
  attachments:{optional:true,maximumCount:9,maximumBytes:20*1024*1024},
  notes:['申请人、任职部门和办公地点从当前登录账号核实。','币种、兑港币汇率与联系人使用公司维护的固定数据源。','金额按明细逐行四舍五入两位后汇总。'],
};
function check(value, code) { if (!value) { const e = new Error(code); e.code = code; throw e; } }
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function clean(value, max=4000) { return typeof value==='string' && value.trim().length>0 && value.trim().length<=max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value); }
function missing(value) { return value===undefined || value===null || value==='' || (typeof value==='string'&&!value.trim()); }
function decimal(value) {
  check((typeof value==='string'||typeof value==='number') && typeof value!=='boolean','PROCUREMENT_NUMBER_INVALID');
  const s=String(value).trim();
  check(/^(?:0|[1-9]\d{0,11})(?:\.\d{1,8})?$/.test(s),'PROCUREMENT_NUMBER_INVALID');
  const [integer,fraction='']=s.split('.');
  const n=BigInt(integer+fraction),numberValue=Number(s);
  const rendered=String(numberValue);check(/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(rendered),'PROCUREMENT_NUMBER_NOT_REPRESENTABLE');
  const [ri,rf='']=rendered.split('.');
  check(BigInt(ri+rf)*10n**BigInt(fraction.length)===n*10n**BigInt(rf.length),'PROCUREMENT_NUMBER_NOT_REPRESENTABLE');
  return {n,scale:fraction.length,value:numberValue};
}
function cents(a,b) {
  const n=a.n*b.n,scale=a.scale+b.scale;
  const out=scale<=2?n*10n**BigInt(2-scale):(n+5n*10n**BigInt(scale-3))/(10n**BigInt(scale-2));
  check(out<=9007199254740991n,'PROCUREMENT_AMOUNT_TOO_LARGE');
  return out;
}
function money(n) { check(n<=9007199254740991n,'PROCUREMENT_AMOUNT_TOO_LARGE'); const value=Number(n)/100; check(BigInt(Math.round(value*100))===n,'PROCUREMENT_AMOUNT_NOT_REPRESENTABLE'); return value; }
function dateMs(value) {
  check(typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value),'PROCUREMENT_DELIVERY_DATE_INVALID');
  const ms=Date.parse(value+'T00:00:00+08:00');
  check(Number.isFinite(ms)&&new Date(ms+8*3600000).toISOString().slice(0,10)===value,'PROCUREMENT_DELIVERY_DATE_INVALID');
  return ms;
}
function schemaFields(schema) {
  const out={};
  function visit(node){if(!node||typeof node!=='object')return;if(node.props?.fieldId){check(!out[node.props.fieldId],'PROCUREMENT_SCHEMA_DUPLICATE_FIELD');out[node.props.fieldId]=node;}for(const child of Object.values(node))visit(child);}
  visit(schema); return out;
}
function rosterValues(row,code,labelFirst=false) {
  const fields=row.field_data_list?.filter(f=>f.field_code===code);
  check(fields?.length===1&&Array.isArray(fields[0].field_value_list),'PROCUREMENT_PROFILE_INCOMPLETE');
  return fields[0].field_value_list.map(x=>labelFirst?(!missing(x.label)?x.label:x.value):(!missing(x.value)?x.value:x.label)).flatMap(x=>Array.isArray(x)?x:[x]);
}
function contacts(rows,key) {
  const found=new Map();
  for(const row of rows){
    const ids=row[key+'_id']??[],names=row[key]??[];
    check(Array.isArray(ids)&&Array.isArray(names)&&ids.length===names.length,'PROCUREMENT_CONTACTS_INVALID');
    for(let i=0;i<ids.length;i++){
      check(clean(ids[i],160)&&clean(names[i],160),'PROCUREMENT_CONTACTS_INVALID');
      check(!found.has(ids[i])||found.get(ids[i])===names[i],'PROCUREMENT_CONTACTS_CONFLICT');found.set(ids[i],names[i]);
    }
  }
  return [...found].map(([id,name])=>({id,name}));
}
function optionalContact(node) {
  const p=node?.props;
  check(node?.componentName==='EmployeeField'&&p&&Array.isArray(p.validation),'PROCUREMENT_CONTACT_SCHEMA_INVALID');
  check(p.validation.every(rule=>isObject(rule)),'PROCUREMENT_CONTACT_SCHEMA_INVALID');
  return p.required!==true&&p.behavior!=='REQUIRED'&&!p.validation.some(rule=>rule.type==='required'||rule.required===true||rule.rule==='required');
}
async function prepare(input,ctx) {
  check(isObject(input),'PROCUREMENT_INPUT_INVALID');
  const allowed=new Set([...requirements.required,...requirements.optional]);
  check(Object.keys(input).every(k=>allowed.has(k)),'PROCUREMENT_UNKNOWN_INPUT');
  const needsInput=[];
  const labels={reason:'申请事由',purchase_method:'采购方式',purchase_type:'采购类型',currency:'付款币种',items:'采购明细'};
  for(const name of requirements.required){if(missing(input[name])||(name==='items'&&Array.isArray(input.items)&&!input.items.length))needsInput.push({field:name,message:'请补充'+labels[name]+'。',...(requirements.choices[name]?{choices:requirements.choices[name]}:{})});}
  if(needsInput.length)return {needsInput};
  for(const name of ['reason','purchase_method','purchase_type','currency','other_description','remarks'])if(!missing(input[name]))check(clean(input[name]),'PROCUREMENT_TEXT_INVALID');
  const requested={...input};for(const name of Object.keys(requested))if(typeof requested[name]==='string')requested[name]=requested[name].trim();
  check(METHODS.includes(requested.purchase_method)&&TYPES.includes(requested.purchase_type),'PROCUREMENT_OPTION_INVALID');
  check(Array.isArray(input.items)&&input.items.length>0&&input.items.length<=50,'PROCUREMENT_ITEMS_INVALID');
  let totalCents=0n;
  const rows=[];const itemPreview=[];
  input.items.forEach((item,index)=>{
    check(isObject(item)&&Object.keys(item).every(k=>['name','specification','quantity','unit_price'].includes(k)),'PROCUREMENT_ITEM_INVALID');
    for(const field of ['name','quantity','unit_price'])if(missing(item[field]))needsInput.push({field:`items[${index}].${field}`,message:'请补充第 '+(index+1)+' 项的名称、数量和单价。'});
    if(['name','quantity','unit_price'].some(k=>missing(item[k])))return;
    check(clean(item.name,500)&&(missing(item.specification)||clean(item.specification,1000)),'PROCUREMENT_ITEM_TEXT_INVALID');
    const quantity=decimal(item.quantity),price=decimal(item.unit_price);check(quantity.n>0n,'PROCUREMENT_QUANTITY_INVALID');
    const subtotal=cents(quantity,price);totalCents+=subtotal;
    const row={[F.name]:item.name.trim(),[F.quantity]:quantity.value,[F.price]:price.value,[F.subtotal]:money(subtotal)};
    if(!missing(item.specification))row[F.spec]=item.specification.trim();rows.push(row);
    itemPreview.push({name:row[F.name],specification:row[F.spec]||'',quantity:quantity.value,unit_price:price.value,subtotal:money(subtotal)});
  });
  if(needsInput.length)return {needsInput};
  const total=money(totalCents);
  const delivery=missing(requested.expected_delivery_date)?undefined:dateMs(requested.expected_delivery_date);
  check(ctx&&clean(ctx.actor?.userid,160)&&clean(ctx.actor?.corp_id,160)&&dateMs(ctx.today)===ctx.todayMs,'PROCUREMENT_IDENTITY_OR_DATE_INVALID');
  const fields=schemaFields(await ctx.schema());
  for(const id of Object.values(F))check(fields[id],'PROCUREMENT_SCHEMA_FIELD_MISSING');
  check(fields[F.attachment].componentName==='AttachmentField','PROCUREMENT_NATIVE_ATTACHMENT_UNAVAILABLE');
  for(const [id,values] of [[F.method,METHODS],[F.type,TYPES]]){
    const live=fields[id].props.dataSource?.map(x=>x.value);
    check(Array.isArray(live)&&live.length===values.length&&values.every(v=>live.includes(v)),'PROCUREMENT_SCHEMA_OPTIONS_CHANGED');
  }
  check(fields[F.items].props.maxItems>=input.items.length,'PROCUREMENT_ITEM_COUNT_EXCEEDED');
  const self=await ctx.roster(policy.rosterFields);
  check(self?.userid===ctx.actor.userid,'PROCUREMENT_PROFILE_IDENTITY_MISMATCH');
  const name=rosterValues(self,'sys00-name')[0];
  const office=rosterValues(self,'sys00-workPlace',true)[0];
  const main=String(rosterValues(self,'sys00-mainDeptId')[0]??'');
  const departments=[...new Set(rosterValues(self,'sys00-deptIds').flatMap(x=>String(x).split(',')).map(x=>x.trim()))];
  check(clean(name,160)&&clean(office,160)&&/^\d+$/.test(main)&&departments.every(x=>/^\d+$/.test(x))&&departments.includes(main),'PROCUREMENT_PROFILE_INCOMPLETE');
  const departmentId=missing(requested.department_id)?main:String(requested.department_id);
  check(departments.includes(departmentId),'PROCUREMENT_DEPARTMENT_NOT_ASSIGNED');
  const catalog=await ctx.query(CURRENCY,null,[currencySource.currencyField]);
  check(Array.isArray(catalog)&&catalog.every(r=>isObject(r)&&clean(r[currencySource.currencyField],80)),'PROCUREMENT_CURRENCY_SOURCE_INVALID');
  check(catalog.length>0,'PROCUREMENT_CURRENCY_SOURCE_EMPTY');
  const normalized=v=>v.normalize('NFKC').trim().toLowerCase();
  const options=catalog.map(r=>r[currencySource.currencyField]);
  check(new Set(options.map(normalized)).size===options.length,'PROCUREMENT_CURRENCY_SOURCE_AMBIGUOUS');
  const currency=options.find(v=>normalized(v)===normalized(requested.currency));
  if(!currency)return {needsInput:[{field:'currency',message:'请选择公司目录中的付款币种。',choices:options}]};
  const rateRows=await ctx.query(RATE,{[rateSource.currencyField]:currency,[rateSource.targetCurrencyField]:rateSource.targetCurrency},[rateSource.currencyField,rateSource.targetCurrencyField,rateSource.rateField]);
  check(Array.isArray(rateRows)&&rateRows.length===1&&rateRows[0][rateSource.currencyField]===currency&&rateRows[0][rateSource.targetCurrencyField]===rateSource.targetCurrency,'PROCUREMENT_RATE_NOT_UNIQUE');
  const rate=decimal(rateRows[0][rateSource.rateField]);check(rate.n>0n,'PROCUREMENT_RATE_INVALID');
  const hkd=money(cents({n:totalCents,scale:2},rate));
  const officeRows=await ctx.query(OFFICE,{[officeSource.officeField]:office},[officeSource.officeField,officeSource.administratorsField,officeSource.administratorsField+'_id',officeSource.itField,officeSource.itField+'_id']);
  check(Array.isArray(officeRows)&&officeRows.every(r=>isObject(r)&&clean(r[officeSource.officeField],160)),'PROCUREMENT_OFFICE_SOURCE_INVALID');
  // The form's linkage uses QUERYEQ. The REST search can return approximate
  // matches; keep only the exact office and never borrow another office's staff.
  const exactOfficeRows=officeRows.filter(r=>r[officeSource.officeField]===office);
  const admin=contacts(exactOfficeRows,officeSource.administratorsField),it=contacts(exactOfficeRows,officeSource.itField);
  if(!admin.length)check(optionalContact(fields[F.admin]),'PROCUREMENT_REQUIRED_CONTACT_MISSING');
  if(!it.length)check(optionalContact(fields[F.it]),'PROCUREMENT_REQUIRED_CONTACT_MISSING');
  const formData={
    [F.applicant]:[ctx.actor.userid],[F.dept]:[departmentId],[F.date]:ctx.todayMs,[F.reason]:requested.reason,
    [F.method]:requested.purchase_method,[F.type]:requested.purchase_type,[F.currency]:currency,[F.items]:rows,
    [F.total]:total,[F.rate]:rate.value,[F.hkd]:hkd,[F.target]:rateSource.targetCurrency,[F.office]:office,
  };
  if(!missing(requested.other_description))formData[F.description]=requested.other_description;
  if(!missing(requested.remarks))formData[F.remarks]=requested.remarks;
  if(delivery!==undefined)formData[F.delivery]=delivery;
  formData[F.admin]=admin.map(x=>x.id);formData[F.it]=it.map(x=>x.id);
  // Department display names are official roster labels; raw department IDs
  // remain internal if a legacy roster does not supply a name.
  const labelValues=code=>(self.field_data_list.find(f=>f.field_code===code)?.field_value_list||[]).flatMap(v=>String(v.label||v.value||'').split(/[,|，]/u).map(x=>x.trim()).filter(Boolean));
  const mainNames=labelValues('sys00-mainDept'),departmentNames=labelValues('sys00-dept');
  const departmentName=departmentId===main&&mainNames.length===1?mainNames[0]:departmentNames.length===departments.length?departmentNames[departments.indexOf(departmentId)]:'';
  return {formData,departmentId,attachmentField:F.attachment,
    verification:{optionalEmptyFields:[...(!admin.length ? [F.admin] : []),...(!it.length ? [F.it] : [])]},
    resolvedInputs:{...requested,currency,department_id:departmentId},
    preview:{title:'采购申请预览',applicant:name,...(departmentName&&!/^\d+$/.test(departmentName)?{department:departmentName}:{}),application_date:ctx.today,
      reason:requested.reason,purchase_method:requested.purchase_method,purchase_type:requested.purchase_type,currency,items:itemPreview,
      total,exchange_rate:rate.value,total_hkd:hkd,other_description:requested.other_description||'',remarks:requested.remarks||'',
      expected_delivery_date:requested.expected_delivery_date||''}};
}
return {key,title,formUuid,policy,requirements,prepare};
}
module.exports = {createProcurementWorkflow};
