'use strict';

const C=require('./leave-trip-common.cjs');
const sources=require('../config/sources.json');
const company=require('../config/company.json');
const {validateCandidates,processReference}=require('../shared/process-association.cjs');

// Retained business composition is separate from the retired employee entry.
// No CLI command calls compose; restoring a workflow requires a new integration.
function retainedWorkflow(config,compose,requirements={}) {
  async function prepare() {
    throw Object.assign(new Error('WORKFLOW_UNAVAILABLE'),{code:'WORKFLOW_UNAVAILABLE',
      workflow:config.key,availability:{...config.availability,canStart:false}});
  }
  return {key:config.key,title:config.title,formUuid:config.target.formUuid,
    policy:config.policy,requirements,prepare,...(compose?{compose}:{})};
}

function rosterValue(map,field,{label=false,id=false}={}) {
  const entries=map.get(field)||[];
  const values=[...new Set(entries.flatMap(entry=>{
    const value=id?entry.value:label?(entry.label??entry.value):(entry.value??entry.label);
    return C.values(value);
  }))];
  C.check(values.length<=1,'ROSTER_FIELD_AMBIGUOUS','人员资料不唯一，请联系 HR 核查。');
  const value=values[0]||'';
  if(id && value) C.check(/^[A-Za-z0-9_.@-]{1,160}$/.test(value),'ROSTER_IDENTIFIER_INVALID');
  return value;
}

function rosterDate(map,field) {
  const value=rosterValue(map,field);
  if(!value)return undefined;
  if(/^\d{4}-\d{2}-\d{2}$/.test(value))return C.date(value);
  if(/^\d{13}$/.test(value))return C.date(C.dateText(C.sourceDate(value)));
  C.fail('ROSTER_DATE_INVALID','人员日期资料格式异常，请联系 HR 核查。');
}

function assertSchema(config,schema) {
  const fields=C.assertFields(schema,config.fields);
  for(const [field,formula]of Object.entries(config.schemaFormulas||{}))
    C.check(fields.get(field)?.props.formula===formula,'WORKFLOW_SCHEMA_CHANGED');
  return fields;
}

async function selfContext(config,ctx) {
  const actor=C.identity(ctx),fields=assertSchema(config,await ctx.schema());
  const roster=C.rosterFields(await ctx.roster(config.policy.rosterFields),actor);
  const dept=C.department(roster),F=config.fields,R=config.roster;
  const data={[F.applicant]:[actor.userid],[F.applicationDate]:ctx.todayMs};
  if(F.department)data[F.department]=[dept.id];
  if(F.applicantId)data[F.applicantId]=actor.userid;
  if(F.contractCompany)data[F.contractCompany]=rosterValue(roster,R.contractCompany);
  return {actor,fields,roster,departmentId:dept.id,data,
    name:rosterValue(roster,R.name)||actor.name||'本人'};
}

async function hrContact(config,ctx,state) {
  const source=sources[config.hrSource.source],F=config.fields;
  const company=state.data[F.contractCompany];
  const required=C.required(state.fields,F.hr);
  const result=company?await C.contacts(ctx,{form:source.formUuid,key:source.companyField,
    admin:source[config.hrSource.roleField]},company,{required}):{ids:[]};
  C.check(result.ids.length||!required,'CONTACTS_NOT_FOUND','办理所需的 HR 资料缺失，请联系 HR。');
  state.data[F.hr]=result.ids;
}

function text(input,key,field,state,needs,label) {
  const value=C.optionalText(input[key]);
  const max=Number(state.fields.get(field).props.maxLength);
  C.check(!Number.isFinite(max)||max<=0||value.length<=max,'HR_INPUT_INVALID');
  if(!value&&C.required(state.fields,field))needs.push({field:key,message:`请补充${label}。`});
  state.data[field]=value;return value;
}

function putDate(data,field,value) {if(value!==undefined)data[field]=value;}
function dateText(value) {return value===undefined?'':C.dateText(value);}
async function relatedSelection(ctx,{include,instanceId,source,alias,actor,field,label}) {
  C.check(include===undefined||typeof include==='boolean','RELATED_SELECTION_INVALID');
  C.check(include!==false||C.absent(instanceId),'RELATED_SELECTION_CONFLICT');
  if(include!==true&&C.absent(instanceId))return {reference:[],title:'',subtitle:''};
  C.check(C.absent(instanceId)||typeof instanceId==='string','RELATED_SELECTION_INVALID');
  const rows=validateCandidates(await ctx.related(alias),{appType:company.appType,
    formUuid:source.form,actorId:actor.userid,corpId:actor.corp_id,scope:source.scope,
    statuses:source.statuses,approvedResults:source.approvedResults});
  const selected=rows.find(row=>row.instance_id===instanceId);
  if(!selected)return {needsInput:[{field,message:rows.length?`请选择${label}，或取消关联。`:'当前没有可关联记录，可取消关联。',
    choices:rows.map(row=>({value:row.instance_id,label:[row.title,row.sub_title].filter(Boolean).join(' · ')}))}]};
  return {reference:[processReference(selected)],title:selected.title,subtitle:selected.sub_title};
}
function result(config,state,preview,extra={}) {
  return {formData:state.data,departmentId:state.departmentId,
    preview:{流程:config.title,申请人:state.name,申请日期:dateText(state.data[config.fields.applicationDate]),...preview},
    ...(config.attachments?{attachmentField:config.attachments.field}:{}),...extra};
}

module.exports={retainedWorkflow,rosterValue,rosterDate,assertSchema,selfContext,hrContact,text,putDate,dateText,relatedSelection,result};
