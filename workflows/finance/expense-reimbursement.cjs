'use strict';
const C=require('../leave-trip-common.cjs');
const config=require('../../config/workflows/finance/expense_reimbursement.json');
const sources=require('../../config/sources.json');
const companyConfig=require('../../config/company.json');
const PaymentHistory=require('../../shared/payment-history.cjs');
const Department=require('../../shared/department-details.cjs');
const Finance=require('../../shared/finance-catalog.cjs');
const {prepareFinanceDetails}=require('../../shared/finance-details.cjs');
const {createRateResolver,convertAmount,sumAmounts}=require('../../shared/exchange-rates.cjs');
const {buildRecommendationContext}=require('../../shared/account-recommendation.cjs');
const {resolveReimbursementContext,personalPaymentDefaults}=require('../../shared/reimbursement-info.cjs');
const {matchingRows,distinctValues}=require('../../shared/scoped-catalog.cjs');
const {key,title,target,fields:F,roster:R,policy,rules}=config;
const bankFields={bank_account:'bankAccount',bank_name:'bankName',bank_city:'bankCity',bank_branch:'bankBranch',account_name:'accountName'};
const bankLabels={bank_account:'收款账号',bank_name:'开户银行',bank_city:'开户城市',bank_branch:'开户支行',account_name:'账户名称'};
const requirements={required:['items'],
  optional:['department_id','department_name','payment_company','reimbursement_currency','same_bearing_company','bearing_company',
    'business_structure','business_line','business_subline',...Object.keys(bankFields),'description','is_project','project_name','project_expense_category',...PaymentHistory.INPUT_FIELDS],
  items:{required:['description','amount','original_currency'],optional:['expense_category','account','classification_reason','remarks',
    'project_department_name','business_structure','business_line','business_subline'],minimumRows:1,maximumRows:50},
  attachments:{required:true,input:'attachments: [绝对文件路径]',maxFiles:20,maxFileSizeMiB:100},
  notes:['仅为本人报销；支付公司按本人映射确定，收款资料首次带入后可修改或清空。',
    '先用 review 保存和整理明细：Agent 根据内容详情建议类别科目，工具匹配汇率；展示八列供员工修改，收到确认后 confirm-details，再用同一草稿补主表和准备最终申请。',
    '每行可使用不同原币种，按公司维护汇率先折报销币种、再折港币；不能自行填写汇率或计算结果。',
    '多个任职部门或业务线需选择；费用类别与科目结合本行用途从合法配对中推荐。',
    '同一草稿支持主表局部更新；省略 items 保留明细，传入 items 则替换整表。修改后重新预览，最终预览后等待新的本人确认。']};
const allowed=[...requirements.required,...requirements.optional];
const itemAllowed=[...requirements.items.required,...requirements.items.optional];
const source=name=>sources[config.sources[name]];
const query=(ctx,name,filters,columns)=>matchingRows(ctx,source(name).formUuid,filters,columns);
const converted=(value,rate)=>convertAmount(value,rate,rules.precision);
const sum=values=>sumAmounts(values,rules.precision);
const rateOptions={ratePrecision:rules.ratePrecision,errorCode:'REIMBURSEMENT_RATE_INVALID',
  errorMessage:'报销所需汇率未唯一配置，请联系 Finance。'};

function validateInput(input) {
  C.inputKeys(input,allowed);
  PaymentHistory.validateInput(input);
  for(const [name,value] of Object.entries(input)) {
    if(['is_project','same_bearing_company'].includes(name)) C.check(typeof value==='boolean','REIMBURSEMENT_INPUT_INVALID');
    else if(name!=='items') C.check(typeof value==='string','REIMBURSEMENT_INPUT_INVALID');
  }
  if(input.items!==undefined) {
    C.check(Array.isArray(input.items)&&input.items.length<=50,'REIMBURSEMENT_INPUT_INVALID');
    for(const item of input.items) {
      C.inputKeys(item,itemAllowed);
      for(const [name,value] of Object.entries(item)) if(name!=='amount') C.check(typeof value==='string','REIMBURSEMENT_INPUT_INVALID');
      C.check(item.classification_reason===undefined||item.classification_reason.length<=300,'REIMBURSEMENT_INPUT_INVALID');
    }
  }
}
function textValue(value,field,fields) {
  const text=C.optionalText(value),limit=Number(fields.get(field).props.maxLength);
  C.check(!Number.isFinite(limit)||limit<=0||text.length<=limit,'REIMBURSEMENT_INPUT_INVALID');return text;
}
function optionalRoster(map,field,prefer='value') {
  const rows=map.get(field);
  return !rows?.length||rows.every(row=>C.absent(row.value)&&C.absent(row.label))?'':C.rosterValue(map,field,prefer);
}
async function businessLines(ctx,fields,needs,input,departmentId,keys,prefix='',editorChoices) {
  const s=source('businessLines');
  return Finance.businessLines({ctx,source:s,input,departmentId,needs,prefix,editorChoices,steps:[
    {inputKey:'business_structure',field:F[keys[0]],sourceField:s.structureField,label:'业务总架构',required:C.required(fields,F[keys[0]])},
    {inputKey:'business_line',field:F[keys[1]],sourceField:s.lineField,label:'业务线',required:C.required(fields,F[keys[1]])},
    {inputKey:'business_subline',field:F[keys[2]],sourceField:s.sublineField,label:'子业务线',required:C.required(fields,F[keys[2]])}]});
}
function selectDepartment(input,roster,needs,editorChoices) {
  const ids=C.rosterDepartmentIds(roster);
  const names=(roster.get(R.departmentNames)||[]).flatMap(row=>C.values(row.label??row.value))
    .flatMap(value=>value.split(/[,，|]/)).map(value=>value.trim());
  let selected=input.department_id;
  if(editorChoices&&names.length===ids.length&&names.every(Boolean)) {
    editorChoices.department_name=names;
    editorChoices.department_id=ids.map((value,index)=>({value,label:names[index]}));
  }
  if(input.department_name!==undefined||!selected&&ids.length>1) {
    C.check(names.length===ids.length&&names.every(Boolean),'ROSTER_FIELD_MISSING');
    const choices=ids.map((value,index)=>({value,label:names[index]}));
    const matches=choices.filter(row=>C.normalized(row.label)===C.normalized(input.department_name));
    if(selected) C.check(input.department_name===''||matches.some(row=>row.value===selected),'REIMBURSEMENT_INPUT_CONFLICT');
    else if(input.department_name&&matches.length===1) selected=matches[0].value;
    else {needs.push({field:'department_id',message:'请选择本次报销的本人任职部门。',choices:matches.length?matches:choices});return null;}
  }
  const dept=C.department(roster,selected);
  return {id:dept.id,name:ids.length===names.length?names[ids.indexOf(dept.id)]:''};
}

async function classificationScope(input,ctx,needs,editorChoices={}) {
  const pairs=await Finance.accountPairs(ctx,source('accounts'));
  if(!input.is_project) return {pairs,projectRows:[],ready:true};
  const ps=source('projects'),pd=source('projectDepartments');
  editorChoices.project_name=distinctValues(
    await query(ctx,'projects',{[ps.statusField]:rules.defaults[F.projectActive]},[ps.nameField]),ps.nameField);
  const projectName=Finance.choice(needs,'project_name','项目',input.project_name,editorChoices.project_name);
  if(!projectName) return {pairs:[],projectRows:[],ready:false};
  const projectRows=await query(ctx,'projectDepartments',{[pd.projectField]:projectName},[pd.nameField,pd.departmentIdField,pd.categoryField]);
  const categories=distinctValues(projectRows,pd.categoryField);
  editorChoices.project_expense_category=categories;
  editorChoices['items[*].project_department_name']=distinctValues(projectRows,pd.nameField);
  const projectCategory=Finance.choice(needs,'project_expense_category','项目费用类别',input.project_expense_category,categories);
  if(!projectCategory) {
    const allowedPairs=pairs.filter(pair=>categories.some(c=>C.normalized(c)===C.normalized(pair.category)));
    C.check(allowedPairs.length,'PAYMENT_SOURCE_MISSING');
    Object.assign(needs.at(-1),{resolver:'agent_recommendation',
      message:'根据各行内容从本项目允许的配对中建议费用类别和科目，回填后展示明细；明确输入冲突时先澄清。',
      recommendationContexts:input.items.map((item,index)=>buildRecommendationContext({scope:'project',description:item.description||'',
        pairs:allowedPairs,categoryInputKey:'project_expense_category',accountInputKey:`items[${index}].account`,
        ...Finance.canonicalConstraints(allowedPairs,input.project_expense_category,item.account)}))});
  }
  return {pairs,projectRows,projectName,projectCategory,ready:!!projectCategory};
}
function financeDetails(input,ctx,scope,currency,resolveRate) {
  return prepareFinanceDetails({ctx,items:input.items,pairs:scope.pairs,
    originalCurrencySource:source('originalCurrencies'),rateSource:source('rates'),
    reimbursementCurrency:currency,precision:rules.precision,ratePrecision:rules.ratePrecision,
    fixedCategory:scope.projectCategory||undefined,rateErrorCode:rateOptions.errorCode,rateErrorMessage:rateOptions.errorMessage,
    resolveRate,deferClassification:!scope.ready});
}
function detailPreview(rows) {
  return rows.map(row=>({费用类别:row.category,会计科目:row.account,内容详情:row.description,
    原币金额:row.amount,原币种:row.originalCurrency,汇率:row.rate,报销金额:row.reimbursedAmount,备注:row.remarks,
    ...(row.classificationReason?{分类建议依据:row.classificationReason}:{})}));
}
const paymentContext=(input,ctx,needs)=>resolveReimbursementContext({input,ctx,needs,
  companySource:source('employeePaymentCompanies'),currencySource:source('currencies')});
function reviewContract(input,company,scope={}) {
  return {columns:[['category','费用类别',true],['account','会计科目',true],['description','内容详情',true],
    ['amount','原币金额',true],['originalCurrency','原币种',true],['rate','汇率',true],
    ['reimbursedAmount','报销金额',true],['remarks','备注',false]],
    currencyPreviewKey:'报销币种',rowsPreviewKey:'报销明细',context:{paymentCompany:company||null,project:input.is_project??null,
    projectName:scope.projectName||null,projectCategory:scope.projectCategory||null}};
}
// First detail review needs neither bank/department data nor a submission draft.
async function details(input,ctx) {
  validateInput(input);
  C.check(typeof ctx.actor?.userid==='string'&&ctx.actor.userid.trim()
    &&typeof ctx.actor?.corp_id==='string'&&ctx.actor.corp_id.trim(),'CURRENT_IDENTITY_MISSING');
  const needs=[],project=input.is_project;
  const payment=await paymentContext(input,ctx,needs),{company,currency}=payment;
  if(project===undefined)needs.push({field:'is_project',message:'这笔报销是否属于项目？如是，请说明项目名称。',choices:[{value:false,label:'非项目'},{value:true,label:'项目'}]});
  C.check(project!==false||['project_name','project_expense_category'].every(k=>C.absent(input[k])),'REIMBURSEMENT_INPUT_CONFLICT');
  if(!input.items?.length)needs.push({field:'items',message:'请提供费用内容、原币金额和原币种。'});
  const editorChoices={payment_company:payment.companyChoices,reimbursement_currency:payment.currencyChoices};
  if(!input.items?.length||project===undefined||!currency) {
    const rows=(input.items||[]).map(item=>({category:item.expense_category||'',account:item.account||'',
      description:item.description||'',amount:C.absent(item.amount)?null:converted(item.amount,1),
      originalCurrency:item.original_currency||'',rate:null,reimbursedAmount:null,remarks:item.remarks||''}));
    return {rows,needsInput:needs,editorChoices,detailReviewContract:reviewContract(input,company),
      preview:{支付公司:company||'',报销币种:currency,是否项目:project===undefined?'待确认':project?'是':'否',
        报销明细:detailPreview(rows),报销总额:null}};
  }
  for(const item of input.items) C.check(project?C.absent(item.expense_category):
    ['project_department_name','business_structure','business_line','business_subline'].every(k=>C.absent(item[k])),'REIMBURSEMENT_INPUT_CONFLICT');
  const scope=await classificationScope(input,ctx,needs,editorChoices);
  const result=await financeDetails(input,ctx,scope,currency);
  Object.assign(editorChoices,result.editorChoices);
  return {rows:result.rows,needsInput:[...needs,...result.needsInput],recommendationContexts:result.recommendationContexts,
    editorChoices,detailReviewContract:reviewContract(input,company,scope),
    preview:{支付公司:company||'',报销币种:currency,是否项目:project?'是':'否',
      ...(project?{项目:scope.projectName||'',项目费用类别:scope.projectCategory||''}:{}),报销明细:detailPreview(result.rows),
      报销总额:result.rows.every(row=>row.reimbursedAmount!==null)?sum(result.rows.map(row=>row.reimbursedAmount)):null}};
}

async function prepare(input,ctx) {
  validateInput(input);
  const actor=C.identity(ctx),fields=C.assertFields(await ctx.schema(),F),needs=[];
  for(const [field,formula] of Object.entries(rules.formulas)) C.check(fields.get(field).props.formula===formula,'WORKFLOW_SCHEMA_CHANGED');
  for(const [field,value] of Object.entries(rules.defaults)) {
    const raw=fields.get(field).props.value;
    C.check((typeof raw==='object'?raw?.zh_CN:raw)===value,'WORKFLOW_SCHEMA_CHANGED');
  }
  C.check(fields.get(F.applicant).props.variable?.type==='user'&&fields.get(F.applicationDate).props.variable?.type==='today','WORKFLOW_SCHEMA_CHANGED');
  const paymentSource=await paymentContext(input,ctx,needs),{company,currency}=paymentSource;
  const editorChoices={payment_company:paymentSource.companyChoices,reimbursement_currency:paymentSource.currencyChoices};
  const project=input.is_project,same=input.same_bearing_company??rules.defaultSameBearingCompany;
  if(project===undefined)needs.push({field:'is_project',message:'这笔报销是否属于项目？如是，请说明项目名称。',choices:[{value:false,label:'非项目'},{value:true,label:'项目'}]});
  if(needs.length)return {needsInput:needs,editorChoices,preview:{支付公司:company||'',报销币种:currency,是否项目:project===undefined?'待确认':project?'是':'否'}};
  C.option(fields,F.isProject,project?'NORMAL':'HIDDEN',['HIDDEN','NORMAL']);
  C.option(fields,F.sameBearing,same?'HIDDEN':'NORMAL',['HIDDEN','NORMAL']);
  C.check(project||['project_name','project_expense_category'].every(k=>C.absent(input[k])),'REIMBURSEMENT_INPUT_CONFLICT');
  if(!input.items?.length) return {needsInput:[{field:'items',message:'请提供报销内容、原币金额和原币种。'}]};
  const table=fields.get(F.items).props;
  C.check(input.items.length>=(table.minItems??1)&&input.items.length<=(table.maxItems??50),'REIMBURSEMENT_INPUT_INVALID');
  for(const [index,item] of input.items.entries()) {
    for(const [name,label] of [['description','报销内容'],['amount','原币金额']])
      if(C.absent(item[name])) needs.push({field:`items[${index}].${name}`,message:`请补充第 ${index+1} 行${label}。`});
    C.check(project?C.absent(item.expense_category):['project_department_name','business_structure','business_line','business_subline'].every(k=>C.absent(item[k])),
      'REIMBURSEMENT_INPUT_CONFLICT');
  }
  if(needs.length) return {needsInput:needs};

  // Stage 1: identity-bound defaults are editable, and survive every pause.
  const rosterResponse=await ctx.roster(policy.rosterFields),roster=C.rosterFields(rosterResponse,actor);
  const reference=await PaymentHistory.resolvePaymentHistory({input,ctx,actor,roster:rosterResponse,
    rosterAccountNameField:R.accountName,sources:policy.relatedSources,appType:companyConfig.appType,
    requiredFields:Object.entries(bankFields).filter(([,field])=>C.required(fields,F[field])).map(([name])=>name),
    previous:ctx.workflowState?.paymentHistory});
  if(reference.needsInput.length)return {needsInput:reference.needsInput,code:reference.code,
    workflowState:{...(ctx.workflowState||{}),paymentHistory:reference.state}};
  input=reference.input;
  const historyState=reference.state===null&&!ctx.workflowState?.paymentHistory?{}:{paymentHistory:reference.state};
  const payment=personalPaymentDefaults({actor,input,roster:rosterResponse,previous:ctx.workflowState?.bankDefaults,
    fields:Object.fromEntries(Object.entries(bankFields).map(([inputKey,fieldKey])=>[inputKey,R[fieldKey]])),stringFields:['bank_account']});
  const workflowState={bankDefaults:payment.state,...historyState},pause=()=>({needsInput:needs,workflowState,editorChoices});
  const formData={};
  for(const [inputKey,fieldKey] of Object.entries(bankFields)) {
    const value=textValue(payment.values[inputKey],F[fieldKey],fields);formData[F[fieldKey]]=value;
    if(!value&&C.required(fields,F[fieldKey])) needs.push({field:inputKey,message:`请补充${bankLabels[inputKey]}。`});
  }
  const dept=selectDepartment(input,roster,needs,editorChoices);
  if(!dept) return pause();
  const cache=new Map();
  async function department(id) {
    if(cache.has(id)) return cache.get(id);
    C.check(/^\d+$/.test(id)&&Number.isSafeInteger(Number(id)),'DEPARTMENT_ID_INVALID');
    const raw=await ctx.invoke('departmentDetails',{'Content-Type':'application/json',Body:{dept_id:Number(id)}});
    const details=Department.normalizeDepartmentDetails(raw,{departmentId:id});
    const result={manager:Department.departmentManagerAt(details,rules.managerIndex),name:raw.result.name};cache.set(id,result);return result;
  }
  const detail=await department(dept.id),departmentName=typeof detail.name==='string'&&detail.name.trim()?detail.name.trim():dept.name;
  C.check(departmentName,'ROSTER_FIELD_MISSING');
  C.check(detail.manager||!C.required(fields,F.manager),'DEPARTMENT_MANAGER_MISSING');
  Object.assign(formData,{[F.applicant]:[actor.userid],[F.applicantId]:actor.userid,[F.initiatorId]:actor.userid,
    [F.applicationDate]:ctx.todayMs,[F.departmentId]:dept.id,[F.departmentName]:departmentName,
    [F.departmentTransition]:dept.id,[F.businessDepartment]:dept.id,[F.manager]:detail.manager?[detail.manager]:[],
    [F.applicantIsManager]:String(detail.manager===actor.userid),[F.office]:optionalRoster(roster,R.office),
    [F.positionLevel]:optionalRoster(roster,R.positionLevel,'label'),[F.hasBankAccount]:rules.defaults[F.hasBankAccount],
    [F.projectActive]:rules.defaults[F.projectActive],[F.sameBearing]:same?'HIDDEN':'NORMAL',[F.isProject]:project?'NORMAL':'HIDDEN'});

  // Stage 2: reimbursement company/currency, then their dependent choices.
  formData[F.paymentCompany]=company;formData[F.paymentCompanyMirror]=company;
  const companies=source('companies');
  const companyRows=await query(ctx,'companies',same?{[companies.companyField]:company}:{},[companies.companyField]);
  editorChoices.bearing_company=distinctValues(companyRows,companies.companyField);
  if(same) {
    C.check(input.bearing_company===undefined||C.normalized(input.bearing_company)===C.normalized(company),'REIMBURSEMENT_INPUT_CONFLICT');
    const options=distinctValues(companyRows,companies.companyField);
    C.check(options.length||!C.required(fields,F.bearingCompany),'PAYMENT_SOURCE_MISSING');
    formData[F.bearingCompany]=options.length?C.single(options):'';
  } else formData[F.bearingCompany]=Finance.choice(needs,'bearing_company','承担公司',input.bearing_company,
    distinctValues(companyRows,companies.companyField),C.required(fields,F.bearingCompany));
  formData[F.currency]=currency;
  Object.assign(formData,await businessLines(ctx,fields,needs,input,dept.id,['structure','line','subline'],'',editorChoices));
  if(needs.length) return pause();

  // Stage 3: project-bounded classification, gathered for all expense lines.
  const pd=source('projectDepartments'),scope=await classificationScope(input,ctx,needs,editorChoices),{projectRows}=scope;
  if(!scope.ready) return pause();
  if(project) {formData[F.project]=scope.projectName;formData[F.projectCategory]=scope.projectCategory;}
  const exchangeRate=createRateResolver({ctx,source:source('rates'),...rateOptions});
  const detailRows=await financeDetails(input,ctx,scope,currency,exchangeRate);
  Object.assign(editorChoices,detailRows.editorChoices);
  needs.push(...detailRows.needsInput);
  if(needs.length) return pause();

  // Stage 4: per-line project facts and two separate native rounding steps.
  const hkd=rules.defaults[F.hkd],hkdRate=await exchangeRate(currency,hkd),rows=[],previewRows=[],projectIds=[],projectManagers=[];
  for(const [index,item] of input.items.entries()) {
    const row={},visible={},before=needs.length,prefix=`items[${index}].`;
    if(project) {
      const name=Finance.choice(needs,prefix+'project_department_name','本行项目部门',item.project_department_name,distinctValues(projectRows,pd.nameField));
      if(needs.length>before) continue;
      const ids=distinctValues(projectRows.filter(r=>C.exact(r[pd.nameField],name)),pd.departmentIdField);
      C.check(ids.length===1&&/^\d+$/.test(ids[0]),'PAYMENT_PROJECT_DEPARTMENT_AMBIGUOUS');
      const id=ids[0],d=await department(id);projectIds.push(id);
      if(d.manager&&!projectManagers.includes(d.manager)) projectManagers.push(d.manager);
      row[F.projectDepartmentName]=name;row[F.projectDepartmentId]=id;
      Object.assign(row,await businessLines(ctx,fields,needs,item,id,['projectStructure','projectLine','projectSubline'],prefix,editorChoices));
      if(needs.length>before) continue;
      row[F.projectAccount]=detailRows.rows[index].account;
      Object.assign(visible,{项目部门:name,业务总架构:row[F.projectStructure],业务线:row[F.projectLine],子业务线:row[F.projectSubline],会计科目:row[F.projectAccount]});
    } else {
      row[F.expenseCategory]=detailRows.rows[index].category;row[F.account]=detailRows.rows[index].account;
      Object.assign(visible,{费用类别:row[F.expenseCategory],会计科目:row[F.account]});
    }
    row[F.itemDescription]=textValue(item.description,F.itemDescription,fields);row[F.amount]=detailRows.rows[index].amount;
    row[F.originalCurrency]=detailRows.rows[index].originalCurrency;row[F.originalRate]=detailRows.rows[index].rate;
    row[F.reimbursedAmount]=detailRows.rows[index].reimbursedAmount;
    row[F.hkd]=hkd;row[F.hkdRate]=hkdRate;row[F.hkdAmount]=converted(row[F.reimbursedAmount],hkdRate);
    row[F.remark]=textValue(item.remarks,F.remark,fields);
    for(const field of Object.keys(row)) if(row[field]===''&&!C.required(fields,field)) delete row[field];
    Object.assign(visible,{内容详情:row[F.itemDescription],原币金额:row[F.amount],原币种:row[F.originalCurrency],
      汇率:row[F.originalRate],报销金额:row[F.reimbursedAmount],备注:row[F.remark]||''});
    if(item.classification_reason?.trim()) visible.分类建议依据=item.classification_reason.trim();
    rows.push(row);previewRows.push(visible);
  }
  if(needs.length) return pause();
  C.check(!project||projectManagers.length||!C.required(fields,F.projectManagers),'DEPARTMENT_MANAGER_MISSING');
  formData[F.items]=rows;formData[F.total]=sum(rows.map(row=>row[F.reimbursedAmount]));formData[F.hkdTotal]=sum(rows.map(row=>row[F.hkdAmount]));
  formData[F.projectManagers]=projectManagers;formData[F.projectDepartmentAggregate]=project?JSON.stringify(projectIds):'';
  formData[F.description]=textValue(input.description,F.description,fields);
  const contact=source('contacts');
  for(const [field,column] of [[F.finance,contact.financeField],[F.cashier,contact.cashierField]]) {
    const people=await C.contacts(ctx,{form:contact.formUuid,key:contact.companyField,admin:column},company,{required:C.required(fields,field)});
    C.check(people.ids.length||!C.required(fields,field),'PAYMENT_CONTACT_MISSING');formData[field]=people.ids;
  }
  // Native attachments, draft revisions, preview and submit belong to runner.
  return {formData,departmentId:dept.id,attachmentField:F.attachment,attachmentPreviewField:config.attachments.previewField,workflowState,
    detailReviewContract:reviewContract(input,company,scope),detailReviewRows:detailRows.rows,
    editorChoices,
    recommendationContexts:detailRows.recommendationContexts,
    verification:{optionalEmptyFields:Object.entries(formData).filter(([field,value])=>!C.required(fields,field)&&(value===''||Array.isArray(value)&&value.length===0)).map(([field])=>field),
      enumLabels:{[F.isProject]:{HIDDEN:'否',NORMAL:'是'},[F.sameBearing]:{HIDDEN:'是',NORMAL:'否'}}},
    preview:{流程:title,报销人:optionalRoster(roster,R.name)||actor.name||actor.userid,申请日期:ctx.today,申请部门:departmentName,
      支付公司:company,承担公司:formData[F.bearingCompany],报销币种:currency,
      业务总架构:formData[F.structure],业务线:formData[F.line],子业务线:formData[F.subline],
      收款资料:Object.fromEntries(Object.entries(bankFields).map(([inputKey,fieldKey])=>[bankLabels[inputKey],formData[F[fieldKey]]])),
      ...(reference.preview?{收款历史参考:reference.preview}:{}),...(reference.notice?{收款资料提示:reference.notice}:{}),
      是否项目:project?'是':'否',...(project?{项目:formData[F.project],项目费用类别:formData[F.projectCategory]}:{}),
      报销明细:previewRows,报销总额:formData[F.total],说明:formData[F.description]}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,detailReview:true,details,prepare};
