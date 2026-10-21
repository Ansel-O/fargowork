'use strict';

const C=require('../leave-trip-common.cjs');
const config=require('../../config/workflows/finance/medical_checkup_reimbursement.json');
const sources=require('../../config/sources.json');
const companyConfig=require('../../config/company.json');
const PaymentHistory=require('../../shared/payment-history.cjs');
const {medicalAmount}=require('../../shared/finance-calculations.cjs');
const {personalPaymentDefaults}=require('../../shared/reimbursement-info.cjs');
const {matchingRows,distinctValues}=require('../../shared/scoped-catalog.cjs');
const {key,title,target,fields:F,roster:R,policy,rules}=config;
const bankFields={bank_account:'bankAccount',bank_name:'bankName',bank_city:'bankCity',
  bank_branch:'bankBranch',account_name:'accountName'};
const labels={bank_account:'收款账号',bank_name:'开户银行',bank_city:'开户城市',bank_branch:'开户支行',account_name:'账户名称'};
const requirements={required:['amount','attachments'],optional:['payment_company',...Object.keys(bankFields),...PaymentHistory.INPUT_FIELDS],
  attachments:{required:true,maximumCount:config.attachments.maximumCount,maximumMiB:config.attachments.maximumMiB},
  notes:['仅为当前登录员工办理人民币体检报销；超过1500元自动按1500元准备，并在预览说明。',
    '正式员工及每年一次由原表提交校验，不额外查询年度报销或增加资格判断。',
    '收款资料首次带入后可修改，账号用字符串；完整申请预览后等待新的提交确认。']};

function text(value,field,fields) {
  C.check(value===undefined||value===null||typeof value==='string','MEDICAL_INPUT_INVALID');
  const result=value?.trim()||'',max=Number(fields.get(field).props.maxLength);
  C.check(!Number.isFinite(max)||max<=0||result.length<=max,'MEDICAL_INPUT_INVALID');
  return result;
}
function optionalRoster(map,field,prefer='value') {
  const entries=map.get(field)||[];
  const values=[...new Set(entries.flatMap(entry=>C.values(C.absent(entry[prefer])?
    entry[prefer==='value'?'label':'value']:entry[prefer])))];
  C.check(values.length<=1,'ROSTER_FIELD_AMBIGUOUS');
  return values[0]||'';
}
function amount(value) {
  return medicalAmount(value,rules.maximumAmount,rules.precision);
}
function assertSchema(schema) {
  const fields=C.assertFields(schema,F);
  C.check(fields.get(F.applicant).props.complexValue?.formula===rules.applicantFormula
    &&fields.get(F.applicationDate).props.complexValue?.formula===rules.applicationDateFormula,'WORKFLOW_SCHEMA_CHANGED');
  for(const [field,formula] of Object.entries(rules.formulas))
    C.check(fields.get(field).props.formula===formula,'WORKFLOW_SCHEMA_CHANGED');
  for(const [field,value] of Object.entries(rules.defaults)) {
    const original=fields.get(field).props.value;
    C.check((typeof original==='object'?original?.zh_CN:original)===value,'WORKFLOW_SCHEMA_CHANGED');
  }
  for(const [field,expected] of Object.entries(rules.linkages)) {
    const p=fields.get(field).props,data=p.linkage?.data||p.dataSourceLinkage?.data;
    C.check(data?.appType===companyConfig.appType&&data.formId===expected.formId
      &&data.innerLinkageFieldId===expected.innerLinkageFieldId&&data.otherLinkageFieldId===expected.otherLinkageFieldId
      &&data.deduplication===expected.deduplication&&data.conditions?.condition==='AND'
      &&data.conditions.rules?.length===expected.conditions.length
      &&expected.conditions.every((wanted,i)=>Object.entries(wanted).every(([k,v])=>data.conditions.rules[i][k]===v)),
    'WORKFLOW_SCHEMA_CHANGED');
  }
  const money=fields.get(F.amount).props,attachment=fields.get(F.attachment).props;
  C.check(money.precision===rules.precision&&money.validation?.some(v=>v.type==='maxValue'&&Number(v.param)===rules.maximumAmount)
    &&C.required(fields,F.amount)&&C.required(fields,F.attachment)
    &&attachment.limit===config.attachments.maximumCount&&attachment.maxFileSize===config.attachments.maximumMiB
    &&attachment.accept==='','WORKFLOW_SCHEMA_CHANGED');
  return fields;
}
async function prepare(input,ctx) {
  C.inputKeys(input,[...requirements.required,...requirements.optional]);
  PaymentHistory.validateInput(input);
  // Reject malformed explicit input before any personal-data lookup.
  const money=C.absent(input.amount)?null:amount(input.amount);
  const actor=C.identity(ctx),fields=assertSchema(await ctx.schema()),needs=[];
  for(const [inputKey,fieldKey] of Object.entries(bankFields))
    if(Object.hasOwn(input,inputKey)) text(input[inputKey],F[fieldKey],fields);
  if(Object.hasOwn(input,'payment_company')) text(input.payment_company,F.paymentCompany,fields);

  const raw=await ctx.roster(policy.rosterFields),roster=C.rosterFields(raw,actor),dept=C.department(roster);
  const reference=await PaymentHistory.resolvePaymentHistory({input,ctx,actor,roster:raw,
    rosterAccountNameField:R.accountName,sources:policy.relatedSources,appType:companyConfig.appType,
    requiredFields:Object.entries(bankFields).filter(([,field])=>C.required(fields,F[field])).map(([name])=>name),
    previous:ctx.workflowState?.paymentHistory});
  if(reference.needsInput.length)return {needsInput:reference.needsInput,code:reference.code,
    workflowState:{...(ctx.workflowState||{}),paymentHistory:reference.state}};
  input=reference.input;
  const historyState=reference.state===null&&!ctx.workflowState?.paymentHistory?{}:{paymentHistory:reference.state};
  const defaults=personalPaymentDefaults({actor,input,roster:raw,previous:ctx.workflowState?.bankDefaults,
    fields:{...Object.fromEntries(Object.entries(bankFields).map(([inputKey,fieldKey])=>[inputKey,R[fieldKey]])),
      payment_company:R.contractCompany},stringFields:['bank_account']});
  const workflowState={bankDefaults:defaults.state,...historyState},formData={...rules.defaults,
    [F.applicant]:[actor.userid],[F.applicantId]:actor.userid,[F.applicationDate]:ctx.todayMs,
    [F.applicationYear]:ctx.today.slice(0,4),[F.contractCompany]:optionalRoster(roster,R.contractCompany),
    // Populate the native validator's input without judging eligibility here.
    [F.employeeStatus]:optionalRoster(roster,R.employeeStatus,'label'),[F.currency]:rules.currency,[F.amount]:money?.value};
  for(const [inputKey,fieldKey] of Object.entries(bankFields)) {
    const value=text(defaults.values[inputKey],F[fieldKey],fields);formData[F[fieldKey]]=value;
    if(!value&&C.required(fields,F[fieldKey])) needs.push({field:inputKey,message:`请补充${labels[inputKey]}。`});
  }

  // This form's company list is bank-enabled payment contacts. Its JS defaults
  // to contract company; the reimbursement employee-company mapping is unrelated.
  const companySource=config.sources.paymentCompanies;
  const companyRows=await matchingRows(ctx,companySource.formUuid,
    {[companySource.hasBankAccountField]:rules.defaults[F.hasBankAccount]},[companySource.companyField]);
  const choices=distinctValues(companyRows,companySource.companyField);
  const candidate=defaults.values.payment_company;
  let company='';
  if(candidate) {
    company=choices.find(value=>C.normalized(value)===C.normalized(candidate))||'';
    if(!company&&choices.length) needs.push({field:'payment_company',message:'请选择本次支付公司，也可明确留空。',choices});
    else C.check(company||!Object.hasOwn(input,'payment_company'),'MEDICAL_PAYMENT_COMPANY_INVALID');
  } else if(C.required(fields,F.paymentCompany)) needs.push({field:'payment_company',message:'请选择本次支付公司。',choices});
  formData[F.paymentCompany]=company;formData[F.paymentCompanyMirror]=company;
  if(needs.length) return {needsInput:needs,workflowState,
    preview:{支付公司:company,报销币种:rules.currency},editorChoices:{payment_company:choices}};
  if(company) {
    const cs=sources[config.sources.currencies];
    const currencies=distinctValues(await matchingRows(ctx,cs.formUuid,{[cs.companyField]:company},[cs.currencyField]),cs.currencyField);
    C.check(currencies.length<=1&&(!currencies.length||currencies[0]===rules.currency),
      'MEDICAL_CURRENCY_CONFLICT','体检报销仅支持人民币，当前支付公司的币种配置不一致，请联系 Finance。');
  }
  if(!money)return {needsInput:[{field:'amount',message:'请提供本次人民币体检报销金额。'}],workflowState,
    preview:{支付公司:company,报销币种:rules.currency},editorChoices:{payment_company:choices}};
  const hr=sources[config.sources.hr],contacts=sources[config.sources.contacts];
  for(const [field,source,column,value] of [
    [F.hr,hr,hr.annualLeaveAdministratorField,formData[F.contractCompany]],
    [F.finance,contacts,contacts.financeField,company],
    [F.cashier,contacts,contacts.cashierField,company]]) {
    const people=value?await C.contacts(ctx,{form:source.formUuid,key:source.companyField,admin:column},value,
      {required:C.required(fields,field)}):{ids:[]};
    C.check(people.ids.length||!C.required(fields,field),'CONTACTS_NOT_FOUND');formData[field]=people.ids;
  }
  return {formData,departmentId:dept.id,attachmentField:F.attachment,attachmentPreviewField:config.attachments.previewField,workflowState,
    editorChoices:{payment_company:choices},
    verification:{optionalEmptyFields:Object.entries(formData).filter(([field,value])=>!C.required(fields,field)
      &&(value===''||Array.isArray(value)&&!value.length)).map(([field])=>field)},
    preview:{流程:title,申请人:actor.name||actor.userid,申请日期:ctx.today,支付公司:company,报销币种:rules.currency,
      原申请金额:money.requested,报销金额:money.value,
      ...(reference.preview?{收款历史参考:reference.preview}:{}),...(reference.notice?{收款资料提示:reference.notice}:{}),
      ...(money.capped?{金额调整说明:`原金额${money.requested}元，超过体检报销上限，已调整为${rules.maximumAmount}元。`}:{}),
      收款资料:Object.fromEntries(Object.entries(bankFields).map(([inputKey,fieldKey])=>[labels[inputKey],formData[F[fieldKey]]]))}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,prepare,partialUpdates:true};
