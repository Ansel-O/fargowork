'use strict';

const C=require('../leave-trip-common.cjs');
const config=require('../../config/workflows/finance/default_bank_change.json');
const sources=require('../../config/sources.json');
const companyConfig=require('../../config/company.json');
const {personalPaymentDefaults}=require('../../shared/reimbursement-info.cjs');
const {key,title,target,fields:F,roster:R,policy,rules}=config;
const bank=[
  ['new_bank_account','bankAccount','oldBankAccount','newBankAccount','收款账号'],
  ['new_bank_name','bankName','oldBankName','newBankName','开户银行'],
  ['new_bank_city','bankCity','oldBankCity','newBankCity','开户城市'],
  ['new_bank_branch','bankBranch','oldBankBranch','newBankBranch','开户支行'],
  ['new_account_name','accountName','oldAccountName','newAccountName','账户名称']
];
const requirements={required:[],optional:bank.map(row=>row[0]),
  attachments:{required:false,supported:false},
  notes:['仅办理本人默认收款资料；原资料为空也可以补录，不要求先提供旧银行卡。',
    '新资料首次沿用现有值；只填写要修改的项目，明确留空与未提供不同，同一草稿保留修改。',
    '收款账号必须使用完整字符串，不转为数字或猜测。没有实际变化时先核对需要修改的内容。',
    '展示原、新五项资料对照后等待本人新确认，再提交一次。提交成功不代表默认资料已经生效。']};

function text(value,field,fields) {
  C.check(value===undefined||value===null||typeof value==='string','BANK_CHANGE_INPUT_INVALID');
  const out=value?.trim()||'',max=Number(fields.get(field).props.maxLength);
  C.check(!Number.isFinite(max)||max<=0||out.length<=max,'BANK_CHANGE_INPUT_INVALID');
  return out;
}
function oneRosterValue(map,field) {
  const values=[...new Set((map.get(field)||[]).flatMap(entry=>C.values(entry.value??entry.label)))];
  C.check(values.length<=1,'ROSTER_FIELD_AMBIGUOUS');
  return values[0]||'';
}
function assertSchema(schema) {
  const fields=C.assertFields(schema,F);
  C.check(fields.get(F.applicant).props.complexValue?.formula===rules.applicantFormula
    &&fields.get(F.applicationDate).props.complexValue?.formula===rules.applicationDateFormula
    &&fields.get(F.applicantId).props.formula===rules.applicantIdFormula,'WORKFLOW_SCHEMA_CHANGED');
  const linkage=fields.get(F.cashier).props.linkage?.data,source=sources[config.cashierSource];
  const conditions=linkage?.conditions;
  C.check(linkage?.appType===companyConfig.appType&&linkage.formId===source.formUuid
    &&linkage.innerLinkageFieldId===F.cashier&&linkage.otherLinkageFieldId===source.cashierField
    &&linkage.deduplication===true&&conditions?.condition==='AND'&&conditions.rules?.length===1
    &&conditions.rules[0].op==='eq'&&conditions.rules[0].otherFieldId===source.companyField
    &&conditions.rules[0].innerFieldId===F.contractCompany,'WORKFLOW_SCHEMA_CHANGED');
  return fields;
}
async function prepare(input,ctx) {
  C.inputKeys(input,requirements.optional);
  const actor=C.identity(ctx),fields=assertSchema(await ctx.schema());
  // Validate explicit account/text values before any personal-data read.
  for(const [inputKey,,,newField]of bank) if(Object.hasOwn(input,inputKey)) text(input[inputKey],F[newField],fields);
  const raw=await ctx.roster(policy.rosterFields),map=C.rosterFields(raw,actor),dept=C.department(map);
  // Numeric account sources cannot safely represent leading zeros or long IDs.
  for(const entry of map.get(R.bankAccount)||[]) {
    const value=C.absent(entry.value)?entry.label:entry.value;
    C.check(C.absent(value)||typeof value==='string','BANK_ACCOUNT_SOURCE_INVALID');
  }
  const bindings=Object.fromEntries(bank.map(([inputKey,rosterKey])=>[inputKey,R[rosterKey]]));
  const original=personalPaymentDefaults({actor,input:{},roster:raw,fields:bindings,stringFields:['new_bank_account']});
  const updated=personalPaymentDefaults({actor,input,roster:raw,previous:ctx.workflowState?.bankDefaults,
    fields:bindings,stringFields:['new_bank_account']});
  const workflowState={bankDefaults:updated.state},needsInput=[],oldPreview={},newPreview={},changes=[];
  const formData={[F.applicant]:[actor.userid],[F.applicationDate]:ctx.todayMs,[F.applicantId]:actor.userid};
  for(const [inputKey,,oldField,newField,label]of bank) {
    const before=text(original.values[inputKey],F[oldField],fields),after=text(updated.values[inputKey],F[newField],fields);
    formData[F[oldField]]=before;formData[F[newField]]=after;
    oldPreview[label]=before;newPreview[label]=after;
    if(before!==after) changes.push({项目:label,原值:before,新值:after});
    if(!after&&C.required(fields,F[newField])) needsInput.push({field:inputKey,message:`请补充新${label}。`});
  }
  if(!changes.length) needsInput.push({field:'change',message:'当前资料没有变化，请说明需要补录或修改哪项收款信息。'});
  if(needsInput.length) return {needsInput,workflowState};
  const company=oneRosterValue(map,R.contractCompany),source=sources[config.cashierSource];
  formData[F.contractCompany]=text(company,F.contractCompany,fields);
  const contacts=company?await C.contacts(ctx,{form:source.formUuid,key:source.companyField,admin:source.cashierField},company):{ids:[]};
  C.check((company||!C.required(fields,F.contractCompany))
    &&(contacts.ids.length||!C.required(fields,F.cashier)),'BANK_CHANGE_ROUTING_MISSING');
  formData[F.cashier]=contacts.ids;
  return {formData,departmentId:dept.id,workflowState,
    verification:{optionalEmptyFields:Object.entries(formData).filter(([id,value])=>!C.required(fields,id)
      &&(value===''||Array.isArray(value)&&!value.length)).map(([id])=>id)},
    preview:{流程:title,申请人:actor.name||actor.userid,申请日期:ctx.today,
      原收款资料:oldPreview,新收款资料:newPreview,本次变更:changes,
      生效说明:'提交的是资料变更申请；默认收款资料是否生效，以审批和后续维护结果为准。'}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,prepare,partialUpdates:true};
