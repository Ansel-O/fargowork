'use strict';

// Local presentation only. Workflows remain responsible for source lookups,
// calculation, validation and the existing confirmation/submission contract.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {check,digest}=require('../scripts/lib/common.cjs');
const object=value=>value!==null&&typeof value==='object'&&Object.getPrototypeOf(value)===Object.prototype;
const copy=value=>JSON.parse(JSON.stringify(value));
const own=(value,key)=>Object.hasOwn(value,key);
const field=(key,label,type='text',extra={})=>({key,label,type,...extra});
const select=(key,label,extra={})=>field(key,label,'select',extra);
const number=(key,label,extra={})=>field(key,label,'number',extra);
const project=[field('is_project','是否项目','boolean'),select('project_name','项目',{project:true}),
  select('project_expense_category','项目费用类别',{project:true})];
const allocation=[select('project_department_name','项目部门',{project:true}),
  select('business_structure','项目业务总架构',{project:true}),select('business_line','项目业务线',{project:true}),
  select('business_subline','项目子业务线',{project:true})];
const bank=[field('bank_account','收款账号'),field('bank_name','开户银行'),field('bank_city','开户城市'),
  field('bank_branch','开户支行'),field('account_name','账户名称')];
const bankHistory=[select('bank_history_action','更换收款卡的方式'),
  field('bank_history_query','查找历史收款卡（可填尾号）'),select('bank_history_choice','已核对的历史收款卡')];
const application=[select('department_id','申请部门'),field('same_bearing_company','承担公司与支付公司相同','boolean'),
  select('bearing_company','承担公司'),select('business_structure','业务总架构'),
  select('business_line','业务线'),select('business_subline','子业务线'),field('description','说明','textarea')];
const costs=[number('airfare','飞机、车船票款'),number('accommodation','住宿费'),
  number('local_transport','市内交通费'),number('other_expenses','其他费用')];
const ordinaryRows=[select('expense_category','费用类别'),select('account','会计科目'),
  field('description','内容详情','textarea'),number('amount','原币金额'),select('original_currency','原币种'),
  field('remarks','备注','textarea'),field('classification_reason','分类建议说明','textarea')];
const paymentRows=ordinaryRows.filter(item=>item.key!=='original_currency').map(item=>
  item.key==='amount'?{...item,label:'本次付款额'}:item);
const relations=[field('include_contract','关联合同','boolean'),select('contract_instance_id','合同'),
  field('include_seal','关联用印','boolean'),select('seal_instance_id','用印')];
const personalMain=[select('payment_company','支付公司'),select('reimbursement_currency','报销币种')];
const definitions=Object.freeze({
  expense_reimbursement:{title:'费用报销',main:[...personalMain,...project],application:[...application,...bank,...bankHistory],
    rows:[...ordinaryRows,...allocation],maxRows:50},
  trip_expense_reimbursement:{title:'出差费用报销',main:[...personalMain,
    field('claimant_query','查找报销人（授权代办）'),select('claimant_user_id','报销人'),...project],
    application:[...application,...bank,...bankHistory],
    rows:[field('departure','出发地'),field('destination','目的地'),select('region','出差地区'),
      field('start_date','开始日期','date'),field('end_date','结束日期','date'),
      select('trip_instance_id','关联出差流程'),...costs,select('original_currency','原币种'),
      number('allowance_amount','餐补金额'),field('remarks','备注','textarea'),...allocation,
      select('account','项目会计科目',{project:true}),field('classification_reason','分类建议说明','textarea',{project:true})],maxRows:50},
  external_expense_application:{title:'对外付款',main:[select('payment_company','支付公司'),select('currency','付款币种'),...project],
    application:[...application,field('contract_company','合同公司'),field('bank_name','开户银行'),
      field('bank_account','收款账号'),field('latest_payment_date','最晚付款日期','date'),
      ...relations,field('include_expense','关联费用申请','boolean'),select('expense_instance_id','费用申请'),
      field('payment_reference_query','历史收款资料查询'),select('payment_reference_instance_id','历史收款资料'),
      field('payment_details_text','付款明细补充','textarea')],rows:[...paymentRows,...allocation],maxRows:50},
  meal_transport:{title:'餐费交通补贴',main:personalMain,application:[...application,...bank,...bankHistory],
    rows:[field('start_time','开始时间','datetime-local'),field('end_time','结束时间','datetime-local'),
      field('reason','加班事由','textarea'),number('transport_amount','交通费'),field('remarks','备注','textarea')],maxRows:50},
  medical_checkup_reimbursement:{title:'体检报销',main:[select('payment_company','支付公司'),number('amount','原申请金额')],
    application:[...bank,...bankHistory],rows:null},
  default_bank_change:{title:'默认银行卡变更',main:bank.map(item=>({...item,key:`new_${item.key}`,label:`新${item.label}`})),
    application:[],rows:null},
  external_expense_request:{title:'对外付款 · Demo',demo:true,
    main:[select('payment_company','支付公司'),select('currency','付款币种'),...project],
    application:[field('description','说明','textarea'),select('department_id','申请部门'),
      select('project_department_id','项目部门',{project:true}),select('supplier_name','收款方'),
      select('supplier_expense_category','收款方费用类别'),select('supplier_account','收款方会计科目'),
      field('bank_account','收款账号'),field('bank_name','开户银行'),field('latest_payment_date','最晚付款日期','date'),...relations],
    rows:paymentRows.filter(item=>item.key!=='classification_reason'),maxRows:100}
});
const rowPreviewKeys={expense_category:'category',description:'description',amount:'amount',original_currency:'originalCurrency',
  remarks:'remarks',account:'account',departure:'departure',destination:'destination',region:'region',
  start_date:'startDate',end_date:'endDate',trip_instance_id:'trip',airfare:'airfare',accommodation:'accommodation',
  local_transport:'local_transport',other_expenses:'other_expenses',allowance_amount:'allowanceAmount',
  project_department_name:'projectDepartment',business_structure:'structure',business_line:'line',business_subline:'subline',
  start_time:'startTime',end_time:'endTime',reason:'reason',transport_amount:'transportAmount'};
const scalarPreviewKeys={payment_company:'支付公司',currency:'付款币种',reimbursement_currency:'报销币种',project_name:'项目',project_expense_category:'项目费用类别',
  description:'说明',department_id:'申请部门',contract_company:'合同公司',latest_payment_date:'最晚付款日期',amount:'原申请金额',
  bank_account:'收款账号',bank_name:'开户银行',bank_city:'开户城市',bank_branch:'开户支行',account_name:'账户名称',
  bearing_company:'承担公司',business_structure:'业务总架构',business_line:'业务线',business_subline:'子业务线',
  supplier_name:'供应商',supplier_expense_category:'供应商费用类别',supplier_account:'供应商科目',
  project_department_id:'项目部门',claimant_user_id:'报销人'};
const idPattern=/^row-[a-f0-9-]{16,64}$/;
const newRowId=()=>`row-${crypto.randomUUID()}`;
const normalizedPath=value=>value.replace(/\.(\d+)(?=\.|$)/g,'[$1]').replace(/^input\./,'');
function revision({workflow,draftId,input={},review,prepared,materials=[]}) {
  return digest({kind:'fargowork-finance-editor-v1',workflow,draftId,input,materials,
    reviewSha256:review?.reviewSha256??null,preview:review?.preview??prepared?.preview??null});
}
function rowIdsFor(items,previous,previousDocument) {
  check(Array.isArray(items),'DETAIL_EDITOR_INPUT_INVALID');
  if(Array.isArray(previous)&&previous.length===items.length&&previous.every(id=>idPattern.test(id))
    &&new Set(previous).size===previous.length)return [...previous];
  if(previousDocument?.baseInput?.items&&previousDocument.rows?.length===previousDocument.baseInput.items.length) {
    const oldItems=previousDocument.baseInput.items,used=new Set();
    const ids=items.map(item=>{
      const index=oldItems.findIndex((old,i)=>!used.has(i)&&digest(old)===digest(item));
      if(index<0)return null;used.add(index);return previousDocument.rows[index].id;
    });
    return ids.map((id,index)=>{
      if(id)return id;
      if(items.length===oldItems.length&&!used.has(index)){used.add(index);return previousDocument.rows[index].id;}
      return newRowId();
    });
  }
  return items.map(()=>newRowId());
}
function addChoices(out,key,values) {
  if(typeof key!=='string'||!Array.isArray(values))return;
  const name=normalizedPath(key),existing=out[name]||[];
  for(const value of values) {
    const candidate=object(value)?{value:value.value??value.instanceId??value.id??value.name,
      label:value.label??value.title??value.name??value.value??value.instanceId??value.id}:{value,label:value};
    if(!['string','boolean','number'].includes(typeof candidate.value)||!Number.isFinite(candidate.value)&&typeof candidate.value==='number')continue;
    candidate.label=String(candidate.label??candidate.value);
    if(!existing.some(item=>item.value===candidate.value))existing.push(candidate);
  }
  out[name]=existing;
}
function collectChoices(...results) {
  const out={};
  for(const result of results.filter(Boolean)) {
    for(const [key,values]of Object.entries(result.editorChoices||{}))addChoices(out,key,values);
    for(const need of result.needsInput||[])addChoices(out,need.field,need.choices);
    const contexts=[...(result.recommendationContexts||[]),...(result.needsInput||[]).flatMap(need=>
      [...(need.recommendationContexts||[]),...(need.recommendationContext?[need.recommendationContext]:[])])];
    for(const context of contexts) {
      addChoices(out,context.categoryInputKey,context.allowedPairs?.map(pair=>pair.category));
      addChoices(out,context.accountInputKey,context.allowedPairs?.map(pair=>pair.account));
    }
  }
  return out;
}
function resolveChoices(choices,key,index,value,label) {
  const exact=index===undefined?key:`items[${index}].${key}`;
  const result=copy(choices[exact]||choices[`items[*].${key}`]||[]);
  if(value!==undefined&&value!==null&&value!==''&&!result.some(item=>item.value===value))
    result.unshift({value,label:String(label??value),existing:true});
  return result;
}
function presentFields(fields,input,preview,choices,index) {
  return fields.map(definition=>{
    const key=definition.key,previewKey=index===undefined?scalarPreviewKeys[key.replace(/^new_/,'')]:rowPreviewKeys[key];
    const display=preview?.[previewKey],present=own(input,key);
    const options=definition.type==='select'?resolveChoices(choices,key,index,present?input[key]:undefined,display):[];
    // Association labels are display-only. Never substitute a label for its ID.
    let value=present?input[key]:definition.type==='select'
      ?options.find(item=>item.value===display||item.label===display)?.value:display;
    if(definition.type==='boolean'&&!present)value=undefined;
    if(definition.type==='datetime-local'&&typeof value==='string')value=value.replace(' ','T');
    return {...definition,value:value??null,present,
      ...(definition.type==='select'?{choices:options,
        choicesMissing:!(choices[index===undefined?key:`items[${index}].${key}`]||choices[`items[*].${key}`])?.length}:{}),
      ...(display!==undefined?{display}:{} )};
  });
}
function readOnlyRow(row,contract,editable) {
  const mapped=new Set(editable.map(item=>rowPreviewKeys[item.key]));
  const labels={category:'费用类别',account:'会计科目',description:'付款内容',amount:'本次付款金额',
    remarks:'备注',amount_hkd:'港币金额'};
  const columns=contract?.columns||Object.keys(row).map(key=>[key,labels[key]||key,false]);
  return columns.filter(([key])=>!mapped.has(key)).map(([key,label])=>({key,label,value:row[key]??null}));
}
function previewText(value) {
  if(value===null||value===undefined||value==='')return '未填写';
  if(Array.isArray(value))return value.map(previewText).join('、');
  if(object(value))return Object.entries(value).map(([key,item])=>`${key}：${previewText(item)}`).join('；');
  return String(value);
}
function createEditor({workflow,draftId,input={},review,prepared,materials=review?.materials||[],
  revision:providedRevision,rowIds,previousDocument,choices={},stage='details'}) {
  const definition=definitions[workflow];
  check(definition&&typeof draftId==='string'&&draftId.trim()&&object(input)
    &&['details','application'].includes(stage),'DETAIL_EDITOR_INPUT_INVALID');
  const combined=collectChoices(review,prepared,{editorChoices:choices}),preview=stage==='application'
    ?prepared?.preview||review?.preview||{}:review?.preview||prepared?.preview||{};
  if(definition.application.some(field=>field.key==='bank_history_action'))
    addChoices(combined,'bank_history_action',[{value:'manual',label:'本次自行填写收款资料'},
      {value:'search',label:'明确换卡：检索本人已完成且同意的历史记录'}]);
  const ids=rowIdsFor(input.items||[],rowIds,previousDocument),rows=review?.rows||prepared?.detailReviewRows
    ||(workflow==='external_expense_request'?preview.明细?.map(row=>({category:row.expense_category,account:row.account,
      description:row.description,amount:row.amount,amount_hkd:row.amount_hkd,remarks:row.remarks})):[])||[];
  const contract=review?.detailReviewContract||prepared?.detailReviewContract;
  const rowsPreviewKey=contract?.rowsPreviewKey||(workflow==='external_expense_request'?'明细':null);
  const fields=[...definition.main,...(stage==='application'?definition.application:[])];
  // Non-project trip classification is fixed by its workflow, not editable.
  const labels=new Map(contract?.columns?.map(([key,label])=>[key,label])||[]);
  const rowFields=(definition.rows||[]).filter(item=>!(workflow==='trip_expense_reimbursement'&&input.is_project!==true&&item.project))
    .filter(item=>!(input.is_project===true&&item.key==='expense_category'))
    .map(item=>({...item,label:labels.get(rowPreviewKeys[item.key])||item.label}));
  const mainPreview={...preview,...(preview.收款资料||{}),...(preview.新收款资料||{})};
  if(preview.币种!==undefined)mainPreview.付款币种=preview.币种;
  if(workflow==='external_expense_request')Object.assign(mainPreview,{付款币种:preview.币种,
    说明:preview.付款说明,申请部门:preview.发起部门,收款账号:preview.银行账户,开户银行:preview.开户行,
    项目:preview.项目?.名称,项目部门:preview.项目?.部门,项目费用类别:preview.项目?.费用类别});
  const visibleMain=presentFields(fields,input,mainPreview,combined);
  const baseRevision=providedRevision||revision({workflow,draftId,input,review,prepared,materials});
  check(/^[a-f0-9]{64}$/.test(baseRevision),'DETAIL_EDITOR_REVISION_INVALID');
  const document={schemaVersion:1,workflow,draftId,baseRevision,stage,title:definition.title,demo:!!definition.demo,
    maxRows:definition.maxRows??0,hasRows:!!definition.rows,mainFields:visibleMain,
    rowFields:copy(rowFields),mainValues:Object.fromEntries(fields.filter(item=>own(input,item.key)).map(item=>[item.key,input[item.key]])),
    rows:(input.items||[]).map((item,index)=>({id:ids[index],
      values:Object.fromEntries(rowFields.filter(field=>own(item,field.key)).map(field=>[field.key,item[field.key]])),
      fields:presentFields(rowFields,item,rows[index]||{},combined,index),
      readonly:readOnlyRow(rows[index]||{},contract,rowFields)})),
    summary:Object.entries(preview).filter(([key,value])=>!Array.isArray(value)&&value!==undefined
      &&!visibleMain.some(field=>scalarPreviewKeys[field.key]===key)).map(([label,value])=>({label,value})),
    // Use only the canonical business preview. Final uploads can differ from
    // source materials and may be object arrays (name/size), not just strings.
    // The main detail array is already rendered as editable rows.
    notes:Object.entries(preview).filter(([key,value])=>Array.isArray(value)&&key!==rowsPreviewKey)
      .flatMap(([label,value])=>value.map(item=>({label,text:previewText(item)}))),
    needsInput:copy([...(review?.needsInput||[]),...(prepared?.needsInput||[])]).map(({message})=>String(message||'')),
    materialRoles:copy(contract?.materialRoles||[]),materials:materials.map(material=>({
      id:material.id,name:material.name,status:material.status,note:material.note??'',
      rowIds:(material.itemIndexes||[]).map(index=>ids[index]).filter(Boolean),
      ...(material.role!==undefined?{role:material.role}:{})})),
    baseInput:copy(input),baseMaterials:copy(materials),choices:combined};
  return {document,html:renderHtml(document),rowIds:ids,baseRevision};
}
function renderHtml(document) {
  const template=fs.readFileSync(path.join(__dirname,'../assets/finance-detail-editor.html'),'utf8');
  // User text cannot close the inert JSON script or inject HTML/JavaScript.
  const encoded=JSON.stringify(document).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')
    .replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  // Keep local paths and unseen business inputs out of the HTML.
  const publicDocument=JSON.parse(encoded);
  delete publicDocument.baseInput;delete publicDocument.baseMaterials;
  return template.replace('<!--FARGOWORK_EDITOR_DATA-->',`<script type="application/json" id="editor-data">${
    JSON.stringify(publicDocument).replace(/</g,'\\u003c').replace(/>/g,'\\u003e').replace(/&/g,'\\u0026')
      .replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029')}</script>`);
}
function validateValue(field,value,choices,current) {
  check(value===null||['string','number','boolean'].includes(typeof value),'DETAIL_EDITOR_VALUE_INVALID');
  check(typeof value!=='string'||value.length<=20000,'DETAIL_EDITOR_VALUE_INVALID');
  check(typeof value!=='number'||Number.isFinite(value),'DETAIL_EDITOR_VALUE_INVALID');
  if(field.type==='boolean')check(typeof value==='boolean','DETAIL_EDITOR_VALUE_INVALID');
  else if(field.type==='select')check(value===''||value===null||value===current||choices.some(item=>item.value===value),
    'DETAIL_EDITOR_CHOICE_INVALID',`请从当前有效候选中选择${field.label}，或让 Agent 刷新候选。`);
  else if(field.type==='number')check(value===null||value===''||typeof value==='number'
    ||typeof value==='string'&&/^-?\d+(\.\d+)?$/.test(value),'DETAIL_EDITOR_VALUE_INVALID');
  else check(value===null||typeof value==='string','DETAIL_EDITOR_VALUE_INVALID');
}
function applyEdit({document,edit,currentRevision,input=document?.baseInput,materials=document?.baseMaterials||[]}) {
  check(object(document)&&document.schemaVersion===1&&definitions[document.workflow]&&object(edit),'DETAIL_EDITOR_EDIT_INVALID');
  check(Object.keys(edit).every(key=>['schemaVersion','workflow','draftId','baseRevision','main','rows','materials'].includes(key))
    &&edit.schemaVersion===1&&edit.workflow===document.workflow&&edit.draftId===document.draftId,
  'DETAIL_EDITOR_TARGET_MISMATCH');
  check(edit.baseRevision===document.baseRevision&&currentRevision===document.baseRevision,
    'DETAIL_EDITOR_REVISION_CONFLICT','草稿已更新。请打开新版明细，再应用修改，避免覆盖刚刚的更改。');
  check(object(input)&&object(edit.main)&&Array.isArray(edit.rows)&&Array.isArray(edit.materials),'DETAIL_EDITOR_EDIT_INVALID');
  const output=copy(input),mainByKey=new Map(document.mainFields.map(field=>[field.key,field]));
  for(const [key,value]of Object.entries(edit.main)) {
    const field=mainByKey.get(key);check(field,'DETAIL_EDITOR_FIELD_READONLY');
    validateValue(field,value,field.choices||[],input[key]);output[key]=value;
  }
  const definition=definitions[document.workflow],ids=new Set(),baseById=new Map(document.rows.map((row,index)=>[row.id,{row,index}]));
  if(!definition.rows)check(edit.rows.length===0,'DETAIL_EDITOR_ROWS_INVALID');
  else {
    // An incomplete local draft may only contain the company/currency choice.
    // Its workflow still requires detail rows before confirmation/submission.
    check(edit.rows.length<=definition.maxRows,'DETAIL_EDITOR_ROWS_INVALID');
    output.items=edit.rows.map(row=>{
      check(object(row)&&Object.keys(row).length===2&&idPattern.test(row.id)&&object(row.values)&&!ids.has(row.id),
        'DETAIL_EDITOR_ROWS_INVALID');ids.add(row.id);
      const base=baseById.get(row.id),result=base?copy(input.items[base.index]):{};
      const permitted=new Map(document.rowFields.map(field=>[field.key,field]));
      for(const [key,value]of Object.entries(row.values)) {
        const field=permitted.get(key);check(field,'DETAIL_EDITOR_FIELD_READONLY');
        const options=base?.row.fields.find(item=>item.key===key)?.choices
          ||[...resolveChoices(document.choices,key,undefined,undefined),
            ...document.rows.flatMap(item=>item.fields.find(candidate=>candidate.key===key)?.choices||[])];
        validateValue(field,value,options||[],base?input.items[base.index]?.[key]:undefined);
        result[key]=value;
      }
      return result;
    });
  }
  // Switching business scope invalidates the old scope's dependent choices.
  // The page explains this handoff; the original workflow selects/recommends
  // again instead of silently submitting project accounting as non-project.
  if(own(edit.main,'is_project')&&edit.main.is_project!==input.is_project) {
    if(edit.main.is_project===false) {
      for(const key of ['project_name','project_expense_category','project_department_id'])delete output[key];
    }
    for(const row of output.items||[]) {
      for(const key of ['expense_category','account','classification_reason'])delete row[key];
      if(edit.main.is_project===false)
        for(const key of ['project_department_name','business_structure','business_line','business_subline'])delete row[key];
    }
  }
  const rowIdList=edit.rows.map(row=>row.id),materialById=new Map(materials.map(material=>[material.id,material])),seenMaterials=new Set();
  check(edit.materials.length===materials.length,'DETAIL_EDITOR_MATERIAL_INVALID');
  const outputMaterials=edit.materials.map(material=>{
    check(object(material),'DETAIL_EDITOR_MATERIAL_INVALID');
    const original=materialById.get(material.id);
    check(Object.keys(material).every(key=>['id','status','rowIds','note','role'].includes(key))
      &&original&&!seenMaterials.has(material.id)&&['included','excluded','unresolved'].includes(material.status)
      &&Array.isArray(material.rowIds)&&new Set(material.rowIds).size===material.rowIds.length
      &&material.rowIds.every(id=>rowIdList.includes(id))
      &&typeof material.note==='string'&&material.note.length<=2000,'DETAIL_EDITOR_MATERIAL_INVALID');
    seenMaterials.add(material.id);
    check(material.status!=='included'||material.rowIds.length>0||!definition.rows,'DETAIL_EDITOR_MATERIAL_INVALID');
    check(material.status!=='excluded'||material.rowIds.length===0&&material.note.trim(),'DETAIL_EDITOR_MATERIAL_INVALID');
    if(document.materialRoles.length)check(material.role===null||material.role===undefined
      ||document.materialRoles.some(role=>role.role===material.role),'DETAIL_EDITOR_MATERIAL_INVALID');
    else check(material.role===undefined||material.role===original.role,'DETAIL_EDITOR_MATERIAL_INVALID');
    return {...original,status:material.status,note:material.note,
      itemIndexes:material.rowIds.map(id=>rowIdList.indexOf(id)).sort((a,b)=>a-b),
      ...(document.materialRoles.length?{role:material.role??null}:{})};
  });
  return {input:output,materials:outputMaterials,rowIds:rowIdList};
}
module.exports={definitions,revision,rowIdsFor,collectChoices,createEditor,renderHtml,applyEdit};
