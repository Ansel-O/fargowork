'use strict';

// Read a delimited JSON value from the fixed, published company page. Never
// execute remote JavaScript or accept a user-selected URL, source or target.
const {check} = require('./common.cjs');
const {APP,CORP,workflowKeys,workflowAvailability,workflowCategory,workflowGroup} = require('./policy.cjs');
const config = require('../../config/workflow-versions.json');
const VERSION = require('../../package.json').version;
const BEGIN = '/* FARGOWORK_DIRECTORY_V1_BEGIN */';
const END = '/* FARGOWORK_DIRECTORY_V1_END */';
const object = value => value && typeof value === 'object' && !Array.isArray(value);
function semver(value) {
  check(typeof value === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value), 'DIRECTORY_DATA_INVALID');
  const parts=value.split('.').map(Number);
  check(parts.every(Number.isSafeInteger),'DIRECTORY_DATA_INVALID');
  return parts;
}
function compare(a,b) {
  const aa=semver(a),bb=semver(b);
  for(let i=0;i<3;i++) if(aa[i]!==bb[i]) return aa[i]<bb[i]?-1:1;
  return 0;
}
function validate(value) {
  check(object(value) && value.schemaVersion===1 && value.corpId===CORP && value.appType===APP
    && typeof value.catalogRevision==='string' && /^[A-Za-z0-9._-]{1,80}$/.test(value.catalogRevision)
    && typeof value.publishedAt==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value.publishedAt)
    && Number.isFinite(Date.parse(value.publishedAt)) && Array.isArray(value.records)
    && value.records.length>0 && value.records.length<=1000,'DIRECTORY_DATA_INVALID');
  semver(value.packageSnapshotVersion);
  check(new Date(value.publishedAt).toISOString()===value.publishedAt.replace('Z','.000Z'),'DIRECTORY_DATA_INVALID');
  const keys=new Set();
  for(const record of value.records) {
    check(object(record) && typeof record.key==='string' && /^[a-z][a-z0-9_]{0,99}$/.test(record.key)
      && !keys.has(record.key) && typeof record.name==='string' && record.name.trim()
      && record.name.length<=150 && !/[\x00-\x1f\x7f]/.test(record.name)
      && ['finance','leave','assets','business','hr'].includes(record.category)
      && ['formal','demo','moka'].includes(record.group)
      && ['active','disabled','migrated'].includes(record.status),'DIRECTORY_DATA_INVALID');
    keys.add(record.key); semver(record.ruleVersion); semver(record.minimumClientVersion);
    if(workflowKeys.includes(record.key)) check(record.category===workflowCategory(record.key)
      &&record.group===workflowGroup(record.key),'DIRECTORY_DATA_INVALID');
  }
  return value;
}
function extract(response) {
  check(response?.success===true,'DIRECTORY_UNAVAILABLE');
  let schema=response.content;
  try {if(typeof schema==='string') schema=JSON.parse(schema);} catch {check(false,'DIRECTORY_DATA_INVALID');}
  check(object(schema) && schema.status==='ONLINE' && Array.isArray(schema.pages),'DIRECTORY_DATA_INVALID');
  const sources=[];
  function walk(node) {
    if(!object(node)) return;
    if(node.componentName==='YidaCodeCanvas' && typeof node.props?.code==='string') sources.push(node.props.code);
    for(const key of ['pages','componentsTree','children']) if(Array.isArray(node[key])) node[key].forEach(walk);
  }
  walk(schema);
  check(sources.length===1,'DIRECTORY_DATA_INVALID');
  const source=sources[0];
  check(source.split(BEGIN).length===2 && source.split(END).length===2,'DIRECTORY_DATA_INVALID');
  const start=source.indexOf(BEGIN)+BEGIN.length, end=source.indexOf(END);
  check(end>start && end-start<=256*1024,'DIRECTORY_DATA_INVALID');
  let value;
  try {value=JSON.parse(source.slice(start,end));} catch {check(false,'DIRECTORY_DATA_INVALID');}
  return validate(value);
}
function assess(directory,key,{version=VERSION,rules=config.rules}={}) {
  const base={catalogRevision:directory.catalogRevision,publishedAt:directory.publishedAt};
  if(!workflowKeys.includes(key)) return {...base,status:'blocked',code:'WORKFLOW_CLIENT_UPDATE_REQUIRED'};
  if(!workflowAvailability(key).canStart) return {...base,status:'blocked',code:'WORKFLOW_UNAVAILABLE'};
  const row=directory.records.find(record=>record.key===key);
  if(!row) return {...base,status:'blocked',code:'DIRECTORY_WORKFLOW_MISSING'};
  const details={...base,ruleVersion:row.ruleVersion,minimumClientVersion:row.minimumClientVersion};
  if(row.status!=='active') return {...details,status:'blocked',code:'DIRECTORY_WORKFLOW_UNAVAILABLE',workflowStatus:row.status};
  if(semver(rules[key])[0]!==semver(row.ruleVersion)[0] || compare(version,row.minimumClientVersion)<0)
    return {...details,status:'blocked',code:'WORKFLOW_CLIENT_UPDATE_REQUIRED'};
  return {...details,status:'allowed'};
}
function createDirectoryClient({auth=require('./auth.cjs')}={}) {
  async function fetchDirectory() {
    const before=auth.actor();
    check(before.corp_id===CORP,'COMPANY_MISMATCH');
    const result=await auth.command(['get-schema',APP,config.directory.formUuid]);
    const after=auth.actor();
    check(after.corp_id===before.corp_id && after.userid===before.userid,'IDENTITY_CHANGED');
    return extract(result);
  }
  async function safe(operation) {
    try {return operation(await fetchDirectory());}
    catch(error) {
      if(['IDENTITY_CHANGED','COMPANY_MISMATCH'].includes(error.code)) throw error;
      return {status:'blocked',code:['DIRECTORY_DATA_INVALID','DIRECTORY_UNAVAILABLE'].includes(error.code)
        ?error.code:'DIRECTORY_UNAVAILABLE',message:'暂时不能核对公司流程目录。保留材料和草稿，暂停提交；恢复核对后继续。'};
    }
  }
  return {
    check:key=>safe(directory=>assess(directory,key)),
    list:()=>safe(directory=>({status:'ready',catalogRevision:directory.catalogRevision,
      publishedAt:directory.publishedAt,records:directory.records.map(row=>({...row,locallySupported:workflowKeys.includes(row.key)}))}))
  };
}
function blocked(directory,draftId) {
  return {status:'directory_blocked',code:directory.code,directory,...(draftId?{draftId}:{}),
    submissionBlocked:true,requiresConfirmation:false,localDraftOnly:true,mayRetry:false,
    message:directory.code==='WORKFLOW_CLIENT_UPDATE_REQUIRED'
      ?'这个流程要求更新 FargoWork。材料和草稿已保留；升级后重新准备并确认。'
      :directory.code==='DIRECTORY_WORKFLOW_UNAVAILABLE'?'公司目录已停用或迁移这个流程。草稿已保留，请按公司指引办理。'
        :'暂时不能完成流程目录核对。材料和草稿已保留，暂停提交；恢复核对后继续。'};
}
module.exports={BEGIN,END,semver,compare,validate,extract,assess,createDirectoryClient,blocked};
