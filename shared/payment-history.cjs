'use strict';

// Personal reimbursement references only. Policies and native field mappings
// are fixed by each workflow; this module never expands a query or persists data.
const {check,digest}=require('../scripts/lib/common.cjs');
const Association=require('./process-association.cjs');
const {projectRoster}=require('./employee-roster.cjs');
const INPUT_FIELDS=Object.freeze(['bank_history_action','bank_history_query','bank_history_choice']);
const BANK_FIELDS=Object.freeze(['bank_account','bank_name','bank_city','bank_branch','account_name']);
const SOURCE_ALIASES=Object.freeze(['personal_history_expense','personal_history_trip','personal_history_medical','personal_history_meal']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const present=value=>typeof value==='string'&&value.trim().length>0;
const normalized=value=>value.normalize('NFKC').trim().toLocaleLowerCase('en-US');
const own=(value,key)=>Object.hasOwn(value,key);
const identity=actor=>({corp_id:actor.corp_id,userid:actor.userid});
const sameIdentity=(left,right)=>left?.userid===right.userid&&left?.corp_id===right.corp_id;

function validateInput(input) {
  check(object(input),'PAYMENT_HISTORY_INPUT_INVALID');
  for(const key of INPUT_FIELDS) if(own(input,key))
    check(typeof input[key]==='string'&&input[key].length<=(key==='bank_history_query'?100:320),'PAYMENT_HISTORY_INPUT_INVALID');
  check(input.bank_history_action===undefined||['search','manual'].includes(input.bank_history_action),'PAYMENT_HISTORY_INPUT_INVALID');
  check(input.bank_history_action!==undefined||!INPUT_FIELDS.slice(1).some(key=>own(input,key)),'PAYMENT_HISTORY_EXPLICIT_ACTION_REQUIRED');
}

function policySources(sources) {
  check(object(sources),'PAYMENT_HISTORY_POLICY_INVALID');
  return SOURCE_ALIASES.map(alias=>{
    const source=sources[alias];
    check(object(source)&&present(source.form)&&present(source.label)&&source.label.length<=80
      &&source.scope==='applicant'&&present(source.applicantField)
      &&JSON.stringify(source.statuses)==='["COMPLETED"]'&&JSON.stringify(source.approvedResults)==='["agree"]'
      &&object(source.paymentFields)&&Object.keys(source.paymentFields).length===BANK_FIELDS.length
      &&BANK_FIELDS.every(key=>present(source.paymentFields[key])),'PAYMENT_HISTORY_POLICY_INVALID');
    const fields=Association.sourceConstraints(source).fields;
    check(fields?.length===BANK_FIELDS.length&&BANK_FIELDS.every(key=>fields.includes(source.paymentFields[key]))
      &&new Set(Object.values(source.paymentFields)).size===BANK_FIELDS.length,'PAYMENT_HISTORY_POLICY_INVALID');
    return {alias,source};
  });
}

function previousState(previous,actor) {
  if(previous===undefined||previous===null)return null;
  check(object(previous)&&previous.version===1&&sameIdentity(previous.actor,actor)
    &&['search','manual'].includes(previous.action)&&typeof previous.managed==='boolean'
    &&object(previous.overrides)&&Object.keys(previous.overrides).every(key=>BANK_FIELDS.includes(key)&&typeof previous.overrides[key]==='string')
    &&Array.isArray(previous.candidateChoices)&&previous.candidateChoices.length<=10
    &&previous.candidateChoices.every(value=>typeof value==='string')
    &&(previous.choice===null||typeof previous.choice==='string')
    &&(previous.sourceDigest===null||/^[a-f0-9]{64}$/.test(previous.sourceDigest))
    &&(previous.confirmedAccountName===null||present(previous.confirmedAccountName)), 'PAYMENT_HISTORY_STATE_INVALID');
  return previous;
}

function holderReference({actor,roster,rosterAccountNameField,input,updated,previous}) {
  check(present(rosterAccountNameField),'PAYMENT_HISTORY_POLICY_INVALID');
  const projected=projectRoster({result:[roster]},{subject:actor.userid,corpId:actor.corp_id,fields:[rosterAccountNameField]});
  const entries=projected.field_data_list.find(row=>row.field_code===rosterAccountNameField)?.field_value_list||[];
  const names=[];
  for(const entry of entries){
    const value=present(entry.value)?entry.value:entry.label;
    if(value===undefined||value===null||value==='')continue;
    if(!present(value))return null;
    if(!names.some(name=>normalized(name)===normalized(value)))names.push(value.trim());
  }
  check(names.length<=1,'PAYMENT_HISTORY_HOLDER_AMBIGUOUS');
  if(names.length)return names[0];
  // A missing roster holder may be clarified for this business draft only.
  // A nickname or a stored personal preference is never used as bank ownership.
  if(updated.has('account_name')&&own(input,'account_name'))return present(input.account_name)?input.account_name.trim():null;
  return present(previous?.confirmedAccountName)?previous.confirmedAccountName:null;
}

function stateFor(actor,previous,changes={}) {
  return {version:1,actor:identity(actor),action:'search',managed:previous?.managed||false,
    choice:null,sourceDigest:null,overrides:{},candidateChoices:[],confirmedAccountName:previous?.confirmedAccountName||null,...changes};
}
function manualNeed(code,message,choices=[]) {
  return {code,needsInput:[{field:choices.length?'bank_history_choice':'bank_history_action',message,
    choices:choices.length?choices:[{value:'manual',label:'自行提供本次收款资料'}]}]};
}
function safeDate(value) {
  const number=typeof value==='number'?value:Number(value);
  if(Number.isFinite(number))return number;
  const parsed=typeof value==='string'?Date.parse(value):NaN;return Number.isFinite(parsed)?parsed:0;
}

async function resolvePaymentHistory({input,ctx,actor=ctx?.actor,subject=actor,roster,rosterAccountNameField,
  sources,appType,requiredFields=[],previous,inputUpdateKeys=ctx?.inputUpdateKeys}={}) {
  validateInput(input);
  if(input.bank_history_action===undefined)return {input,state:null,needsInput:[]};
  check(object(actor)&&present(actor.userid)&&present(actor.corp_id)&&sameIdentity(ctx?.actor,actor),'CURRENT_IDENTITY_MISSING');
  const prior=previousState(previous,actor),updated=new Set(inputUpdateKeys??Object.keys(input));
  const baseState=stateFor(actor,prior);
  if(!sameIdentity(subject,actor)||subject.delegated) {
    if(input.bank_history_action==='manual')return {input,state:null,needsInput:[]};
    return {input,state:baseState,...manualNeed('PAYMENT_HISTORY_SELF_ONLY',
      '首版历史收款只供本人查询；代办请提供本次报销人的收款资料，不查询或沿用发起人的卡。')};
  }
  if(input.bank_history_action==='manual') {
    // Cancelling a previously selected card clears its entire group, rather
    // than leaking its bank/branch into a separately supplied new card.
    if(!prior?.managed)return {input,state:null,needsInput:[]};
    const values=prior.action==='manual'?{...prior.overrides}:Object.fromEntries(BANK_FIELDS.map(key=>[key,'']));
    for(const key of BANK_FIELDS)if(updated.has(key)&&own(input,key)){
      check(typeof input[key]==='string','PAYMENT_HISTORY_INPUT_INVALID');values[key]=input[key];
    }
    return {input:{...input,...values},state:{...baseState,action:'manual',managed:true,overrides:values},needsInput:[]};
  }
  check(present(appType)&&Array.isArray(requiredFields)&&requiredFields.every(key=>BANK_FIELDS.includes(key)), 'PAYMENT_HISTORY_POLICY_INVALID');
  const configured=policySources(sources);
  const holder=holderReference({actor,roster,rosterAccountNameField,input,updated,previous:prior});
  if(!holder)return {input,state:baseState,code:'PAYMENT_HISTORY_HOLDER_REQUIRED',needsInput:[
    {field:'account_name',message:'花名册缺少收款户名，请先确认本人本次收款户名；也可以改为自行提供本次资料。'},
    {field:'bank_history_action',message:'不检索历史时可自行提供本次收款资料。',choices:[{value:'manual',label:'自行提供本次收款资料'}]}]};
  baseState.confirmedAccountName=holder;
  const rejected={holder:0,fields:0},failures=[];
  const groups=await Promise.all(configured.map(async({alias,source})=>{
    try {
      check(typeof ctx.related==='function','PAYMENT_HISTORY_UNAVAILABLE');
      const rows=Association.validateCandidates(await ctx.related(alias),{...Association.sourceConstraints(source),
        appType,formUuid:source.form,actorId:actor.userid,corpId:actor.corp_id});
      const candidates=[];
      for(const row of rows){
        const values={};let valid=true;
        for(const key of BANK_FIELDS){
          const raw=row.data[source.paymentFields[key]];
          if(raw===undefined||raw===null||raw==='')values[key]='';
          else if(typeof raw==='string')values[key]=raw.trim();else{valid=false;break;}
        }
        if(!valid||['bank_account','account_name',...requiredFields].some(key=>!values[key])){rejected.fields++;continue;}
        if(normalized(values.account_name)!==normalized(holder)){rejected.holder++;continue;}
        candidates.push({choice:alias+':'+row.instance_id,values,source:source.label,createdAt:safeDate(row.created_at)});
      }
      return candidates;
    } catch(error){
      // A permission/read outage may offer manual input. Identity, source
      // boundary and malformed-response failures must remain visible errors.
      const code=String(error?.code||'');
      if(/IDENTITY|COMPANY|AUTH|LOGIN/.test(code)||code.startsWith('RELATED_SOURCE_')&&code!=='RELATED_SOURCE_UNAVAILABLE')throw error;
      failures.push(alias);return [];
    }
  }));
  const keyword=normalized(input.bank_history_query||'');
  const all=groups.flat().filter(item=>!keyword||[item.source,...Object.values(item.values)].some(value=>normalized(value).includes(keyword)))
    .sort((left,right)=>right.createdAt-left.createdAt||left.choice.localeCompare(right.choice));
  const unique=new Map();for(const candidate of all){const tuple=JSON.stringify(BANK_FIELDS.map(key=>candidate.values[key]));if(!unique.has(tuple))unique.set(tuple,candidate);}
  const available=[...unique.values()].slice(0,10),choices=available.map(candidate=>({value:candidate.choice,
    label:candidate.values.bank_name||candidate.source,accountHint:'尾号 '+candidate.values.bank_account.slice(-4),
    city:candidate.values.bank_city,branch:candidate.values.bank_branch,source:candidate.source,status:'COMPLETED',approvedResult:'agree'}));
  baseState.candidateChoices=choices.map(choice=>choice.value);
  const choice=updated.has('bank_history_query')&&!updated.has('bank_history_choice')?'':input.bank_history_choice;
  const allowed=prior?.choice===choice||updated.has('bank_history_choice')&&prior?.candidateChoices.includes(choice);
  const selected=allowed?all.find(candidate=>candidate.choice===choice):undefined;
  if(!selected)return {input,state:baseState,...manualNeed(failures.length?'PAYMENT_HISTORY_UNAVAILABLE':rejected.holder?'PAYMENT_HISTORY_HOLDER_MISMATCH':
    rejected.fields?'PAYMENT_HISTORY_FIELDS_MISSING':'PAYMENT_HISTORY_SELECTION_REQUIRED',
    choices.length?'请选择本次使用的历史收款资料；也可将 bank_history_action 改为 manual 自行提供。':
      failures.length?'部分或全部历史来源未能读取，可自行提供本次完整收款资料；不会扩大查询范围。':
      rejected.holder?'历史收款户名与本次核对资料不一致，未作为可用候选；请核实或自行提供本次资料。':
      rejected.fields?'历史记录缺少本次必要收款字段或账号原文不可靠，请自行提供本次资料。':
      '没有找到本人已完成且同意的可用收款记录，可更换关键词或自行提供本次资料。',choices)};
  const sourceDigest=digest(selected.values),sameChoice=prior?.choice===choice;
  if(sameChoice&&prior.sourceDigest!==sourceDigest&&!updated.has('bank_history_choice'))return {input,state:baseState,
    ...manualNeed('PAYMENT_HISTORY_CHANGED','选中的历史收款资料已变化，请重新选择并核对本次整组资料，或自行提供。',choices)};
  const continued=sameChoice&&prior.sourceDigest===sourceDigest;
  const overrides=continued?{...prior.overrides}:{};
  if(continued)for(const key of BANK_FIELDS)if(updated.has(key)&&own(input,key)){
    check(typeof input[key]==='string','PAYMENT_HISTORY_INPUT_INVALID');overrides[key]=input[key];
  }
  return {input:{...input,...selected.values,...overrides},needsInput:[],
    state:{...baseState,managed:true,choice,sourceDigest,overrides},
    preview:{来源:selected.source,账号提示:'尾号 '+selected.values.bank_account.slice(-4),
      说明:'仅参考本人已完成且同意的历史报销；完整收款资料仍按本次申请核对，不代表银行卡当前有效或默认资料已变更。'},
    ...(!continued&&BANK_FIELDS.some(key=>updated.has(key)&&own(input,key))?{
      notice:'已整组采用所选历史资料；如需另行调整，请在同一草稿明确修改对应收款字段。'}:{})};
}

module.exports={INPUT_FIELDS,BANK_FIELDS,SOURCE_ALIASES,validateInput,resolvePaymentHistory};
