'use strict';

// A detail review is a content checkpoint inside the existing local draft. It
// records what must be shown, not proof that a human has actually consented.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {check,digest,canonical}=require('../scripts/lib/common.cjs');
const defaultContract={columns:[['category','费用类别',true],['account','会计科目',true],['description','内容详情',true],
  ['amount','原币金额',true],['originalCurrency','原币种',true],['rate','汇率',true],
  ['reimbursedAmount','报销金额',true],['remarks','备注',false]],
currencyPreviewKey:'报销币种',rowsPreviewKey:'报销明细',context:{}};
const object=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const safeKey=value=>typeof value==='string'&&value.trim()&&value.length<=100
  &&!['__proto__','prototype','constructor'].includes(value);

// Only a workflow's static contract can declare material destinations. User
// material records choose one role; they never provide a native field ID.
function materialRoles(value) {
  if(value===undefined) return undefined;
  check(Array.isArray(value)&&value.length>0&&value.length<=20,'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  const roles=new Set(),inputs=new Set();
  return value.map(item=>{
    check(object(item)&&Object.getPrototypeOf(item)===Object.prototype
      &&Object.keys(item).length===3&&['role','label','inputField'].every(key=>Object.hasOwn(item,key))
      &&safeKey(item.role)&&/^[A-Za-z][A-Za-z0-9_]*$/.test(item.role)&&safeKey(item.label)
      &&safeKey(item.inputField)&&/^[A-Za-z][A-Za-z0-9_]*$/.test(item.inputField)
      &&!roles.has(item.role)&&!inputs.has(item.inputField),'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
    roles.add(item.role);inputs.add(item.inputField);return {...item};
  });
}

// Workflows own their visible columns and identity dependencies. Context must
// contain the real business identities (not only their display names), but no
// unrelated main-form defaults such as a bank account.
function contract(value) {
  if(value===undefined) return defaultContract;
  check(object(value)&&Object.getPrototypeOf(value)===Object.prototype
    &&Object.keys(value).every(key=>['columns','currencyPreviewKey','rowsPreviewKey','context','materialRoles'].includes(key))
    &&Array.isArray(value.columns)&&value.columns.length>0&&value.columns.length<=100,
  'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  const keys=new Set(),labels=new Set();
  const columns=value.columns.map(column=>{
    check(Array.isArray(column)&&column.length===3&&safeKey(column[0])&&safeKey(column[1])
      &&typeof column[2]==='boolean'&&!keys.has(column[0])&&!labels.has(column[1]),
    'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
    keys.add(column[0]);labels.add(column[1]);return [...column];
  });
  check(safeKey(value.currencyPreviewKey)&&safeKey(value.rowsPreviewKey)
    &&value.currencyPreviewKey!==value.rowsPreviewKey
    &&![value.currencyPreviewKey,value.rowsPreviewKey].includes('材料范围'),
  'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  const context=value.context===undefined?{}:value.context;
  check(object(context)&&Object.getPrototypeOf(context)===Object.prototype,'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  let copy;
  try {copy=JSON.parse(canonical(context));}
  catch {check(false,'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');}
  const roles=materialRoles(value.materialRoles);
  return {columns,currencyPreviewKey:value.currencyPreviewKey,rowsPreviewKey:value.rowsPreviewKey,context:copy,
    ...(roles===undefined?{}:{materialRoles:roles})};
}

function normalizeMaterials(value,rowCount,roleDefinitions) {
  check(Array.isArray(value),'DETAIL_MATERIALS_INVALID');
  const roles=materialRoles(roleDefinitions),allowed=new Set(roles?.map(item=>item.role)||[]);
  const ids=new Set();
  return value.map(material=>{
    check(object(material)&&Object.keys(material).every(k=>['id','name','path','status','itemIndexes','note',...(roles?['role']:[])].includes(k)),
      'DETAIL_MATERIALS_INVALID');
    check(typeof material.id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(material.id)
      &&!ids.has(material.id),'DETAIL_MATERIALS_INVALID');ids.add(material.id);
    check(typeof material.name==='string'&&material.name.trim()&&material.name.length<=500
      &&['included','excluded','unresolved'].includes(material.status)
      &&Array.isArray(material.itemIndexes)&&new Set(material.itemIndexes).size===material.itemIndexes.length
      &&material.itemIndexes.every(i=>Number.isSafeInteger(i)&&i>=0&&i<rowCount)
      &&(material.note===undefined||typeof material.note==='string'&&material.note.length<=2000),
    'DETAIL_MATERIALS_INVALID');
    check(material.status!=='included'||material.itemIndexes.length>0,'DETAIL_MATERIALS_INVALID');
    check(material.status!=='excluded'||material.itemIndexes.length===0&&material.note?.trim(),'DETAIL_MATERIALS_INVALID');
    const out={id:material.id,name:material.name.trim(),status:material.status,
      itemIndexes:[...material.itemIndexes].sort((a,b)=>a-b),note:material.note?.trim()||''};
    if(roles) {
      check(material.role===undefined||material.role===null||allowed.has(material.role),'DETAIL_MATERIAL_ROLE_INVALID');
      out.role=material.role??null;
    }
    if(material.path!==undefined) {
      check(typeof material.path==='string'&&path.isAbsolute(material.path),'DETAIL_MATERIAL_PATH_INVALID');
      check(fs.existsSync(material.path)&&fs.statSync(material.path).isFile(),'DETAIL_MATERIAL_FILE_MISSING');
      out.path=path.resolve(material.path);
      // Content, rather than the original location, binds a source document.
      out.sha256=crypto.createHash('sha256').update(fs.readFileSync(out.path)).digest('hex');
    }
    return out;
  });
}

function normalizeMaterialUploads(value,roleDefinitions) {
  const roles=materialRoles(roleDefinitions);
  check(roles&&Array.isArray(value)&&value.length<=1000,'DETAIL_MATERIAL_UPLOADS_INVALID');
  const paths=new Set();
  return value.map(item=>{
    check(object(item)&&Object.keys(item).length===2&&typeof item.path==='string'&&path.isAbsolute(item.path)
      &&Array.isArray(item.materialIds)&&item.materialIds.length>0&&item.materialIds.length<=1000
      &&new Set(item.materialIds).size===item.materialIds.length
      &&item.materialIds.every(id=>typeof id==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(id)),
    'DETAIL_MATERIAL_UPLOADS_INVALID');
    const resolved=path.resolve(item.path),key=process.platform==='win32'?resolved.toLowerCase():resolved;
    check(!paths.has(key),'DETAIL_MATERIAL_UPLOADS_INVALID');paths.add(key);
    return {path:resolved,materialIds:[...item.materialIds]};
  });
}

// Original sources match by bytes, so renaming cannot swap evidence roles.
// Converted/merged outputs explicitly name their included source materials;
// output selection stays in final confirmation, not the source checkpoint.
function assertMaterialUploadScope(review,prepared,jobs,uploads=[]) {
  const roles=review.detailReviewContract?.materialRoles;
  if(roles===undefined) return;
  const definitions=materialRoles(roles),fields=prepared.attachmentFields;
  check(Array.isArray(fields)&&definitions.every(role=>fields.some(field=>field.inputField===role.inputField)),
    'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  const byField=new Map(definitions.map(role=>[fields.find(field=>field.inputField===role.inputField).field,role.role]));
  check(byField.size===definitions.length,'WORKFLOW_DETAIL_REVIEW_CONTRACT_INVALID');
  const materials=review.materials,byId=new Map(materials.map(material=>[material.id,material]));
  const bindings=normalizeMaterialUploads(uploads,definitions);
  const pathKey=value=>process.platform==='win32'?path.resolve(value).toLowerCase():path.resolve(value);
  const byPath=new Map(bindings.map(binding=>[pathKey(binding.path),binding]));
  const summary=[],snapshot=[];
  for(const job of jobs) {
    const role=byField.get(job.field);
    check(role&&job.rowIndex===undefined,'DETAIL_MATERIAL_UPLOAD_SCOPE_INVALID');
    const hash=crypto.createHash('sha256').update(fs.readFileSync(job.filePath)).digest('hex');
    const originals=materials.filter(material=>material.sha256===hash);
    let selected;
    if(originals.length) {
      selected=originals.filter(material=>material.status==='included'&&material.role===role);
      check(selected.length>0,'DETAIL_MATERIAL_UPLOAD_SCOPE_INVALID');
    } else {
      const binding=byPath.get(pathKey(job.filePath));
      check(binding&&binding.materialIds.every(id=>{
        const source=byId.get(id);return source?.status==='included'&&source.role===role;
      }),'DETAIL_MATERIAL_UPLOAD_SCOPE_INVALID');
      selected=binding.materialIds.map(id=>byId.get(id));
    }
    selected.sort((a,b)=>a.id.localeCompare(b.id));
    summary.push({用途:definitions.find(item=>item.role===role).label,附件:path.basename(job.filePath),
      来源材料:selected.map(material=>material.name)});
    snapshot.push({field:job.field,sha256:hash,materialIds:selected.map(material=>material.id)});
  }
  return {summary,digest:digest(snapshot),files:snapshot.map((item,index)=>({...item,filePath:jobs[index].filePath}))};
}
function visibleRows(rows,definition,legacy=false) {
  check(Array.isArray(rows),'WORKFLOW_DETAILS_RESULT_INVALID');
  return rows.map(row=>{
    check(object(row),'WORKFLOW_DETAILS_RESULT_INVALID');
    return Object.fromEntries(definition.columns.map(([key])=>{
      const value=row[key]??(legacy&&key==='remarks'?'':null);
      check(value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value)
        ||!legacy&&typeof value==='boolean',
        'WORKFLOW_DETAILS_RESULT_INVALID');
      return [key,value];
    }));
  });
}
function checkpoint({workflow,actor,result,materials,previous}) {
  check(object(result)&&Array.isArray(result.rows)
    &&(result.needsInput===undefined||Array.isArray(result.needsInput)),'WORKFLOW_DETAILS_RESULT_INVALID');
  const explicit=result.detailReviewContract!==undefined,definition=contract(result.detailReviewContract);
  const rows=visibleRows(result.rows,definition,!explicit),currency=result.preview?.[definition.currencyPreviewKey]??null;
  check(currency===null||typeof currency==='string','WORKFLOW_DETAILS_RESULT_INVALID');
  const needsInput=[...(result.needsInput||[])];
  const roles=definition.materialRoles;
  if(roles) for(const material of materials) if(material.status==='included'&&!material.role) needsInput.push({
    field:`materials.${material.id}.role`,message:`请明确“${material.name}”的附件用途。`,
    choices:roles.map(({role,label})=>({value:role,label}))});
  for(const material of materials) if(material.status==='unresolved') needsInput.push({
    field:`materials.${material.id}`,message:`请核对“${material.name}”是否纳入本次明细及其对应行。`});
  const snapshot={workflow,actor:{userid:actor.userid,corp_id:actor.corp_id},reimbursementCurrency:currency,rows,
    ...(explicit?{detailReviewContract:definition}:{}),
    materials:materials.map(({path:localPath,...material})=>material)};
  const reviewSha256=digest({kind:'fargowork-detail-review-v1',snapshot});
  const ready=rows.length>0&&currency!==null&&currency!==''&&needsInput.length===0
    &&rows.every(row=>definition.columns.every(([key,,required])=>!required||row[key]!==null&&row[key]!==''));
  if(!ready&&!needsInput.length) needsInput.push({field:'items',message:explicit
    ?'请补齐本流程必需的明细和币种，再确认本次明细。':'请补齐八列明细和报销币种，再确认本次明细。'});
  return {status:'ready',snapshot,reviewSha256,rows,materials,needsInput,
    ...(result.recommendationContexts?{recommendationContexts:result.recommendationContexts}:{}),
    ...(explicit?{detailReviewContract:definition}:{}),
    preview:{...result.preview,[definition.currencyPreviewKey]:currency,
      [definition.rowsPreviewKey]:rows.map(row=>Object.fromEntries(definition.columns.map(([key,label])=>[label,row[key]]))),
      ...(materials.length?{材料范围:materials.map(({path:localPath,sha256,...material})=>material)}:{})},
    confirmedSha256:ready&&previous?.status==='ready'&&previous.confirmedSha256===reviewSha256?reviewSha256:null};
}
function response(review,draftId) {
  const confirmed=review.status==='ready'&&!review.needsInput.length&&review.confirmedSha256===review.reviewSha256;
  const needs=review.needsInput.length>0;
  return {status:needs?'needs_input':confirmed?'details_confirmed':'awaiting_detail_confirmation',
    draftId,reviewSha256:review.reviewSha256,preview:review.preview,rows:review.rows,needsInput:review.needsInput,
    ...(review.recommendationContexts?{recommendationContexts:review.recommendationContexts}:{}),
    requiresConfirmation:!needs&&!confirmed,localDraftOnly:true,
    nextAction:needs?review.needsInput.some(n=>n.resolver==='agent_recommendation')?'agent_recommendation':'clarify_details'
      :confirmed?'complete_application':'wait_for_detail_confirmation',
    message:needs?'请先补齐本次明细。':confirmed?'明细已确认，可以继续补齐申请信息；尚未授权提交。'
      :review.detailReviewContract?'请展示本流程明细和材料范围，等待员工确认或修改；此确认只允许继续准备申请。'
        :'请展示八列明细和材料范围，等待员工确认或修改；此确认只允许继续准备申请。'};
}
function preparedMatches(review,prepared) {
  const preview=prepared.preview,explicit=review.detailReviewContract!==undefined;
  if(explicit!==(prepared.detailReviewContract!==undefined)) return false;
  const definition=contract(review.detailReviewContract);
  if(!object(preview)||!Array.isArray(preview[definition.rowsPreviewKey])) return false;
  let rows;
  if(explicit) {
    if(digest(contract(prepared.detailReviewContract))!==digest(definition)
      ||!Array.isArray(prepared.detailReviewRows)) return false;
    rows=prepared.detailReviewRows;
    if(rows.length!==preview[definition.rowsPreviewKey].length) return false;
  } else rows=preview[definition.rowsPreviewKey].map(row=>Object.fromEntries(definition.columns.map(([key,label])=>
    [key,row[label]??(key==='category'?preview.项目费用类别:undefined)??(key==='remarks'?'':null)])));
  return digest({rows:visibleRows(rows,definition,!explicit),currency:preview[definition.currencyPreviewKey]??null})
    ===digest({rows:review.snapshot.rows,currency:review.snapshot.reimbursementCurrency});
}
module.exports={normalizeMaterials,normalizeMaterialUploads,assertMaterialUploadScope,checkpoint,response,preparedMatches};
