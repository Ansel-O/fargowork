'use strict';

const C=require('../leave-trip-common.cjs');
const config=require('../../config/workflows/finance/external_expense_application.json');
const sources=require('../../config/sources.json');
const companyConfig=require('../../config/company.json');
const Department=require('../../shared/department-details.cjs');
const {createRateResolver,convertAmount}=require('../../shared/exchange-rates.cjs');
const {rounded:roundAmount,sumAmounts}=require('../../shared/finance-calculations.cjs');
const Association=require('../../shared/process-association.cjs');
const {buildRecommendationContext}=require('../../shared/account-recommendation.cjs');
const {matchingRows,distinctValues}=require('../../shared/scoped-catalog.cjs');
const Finance=require('../../shared/finance-catalog.cjs');
const {choice,accountPairs,canonicalConstraints,accountSelections}=Finance;
const {key,title,target,fields:F,roster:R,policy,rules}=config;
const requirements={
  required:['contract_company','bank_name','bank_account','latest_payment_date','items'],
  choices:['payment_company','currency'],
  optional:['department_id','department_name','is_project','same_bearing_company','bearing_company','business_structure','business_line',
    'business_subline','description','include_contract','contract_instance_id','include_seal','seal_instance_id','include_expense','expense_instance_id',
    'payment_reference_query','payment_reference_instance_id','payment_details_text'],
  project:['project_name','project_expense_category'],
  items:{required:['description','amount'],optional:['expense_category','account','classification_reason','remarks','project_department_name',
    'business_structure','business_line','business_subline'],minimumRows:1,maximumRows:50},
  attachments:{required:true,input:'attachments: [绝对文件路径]',maxFiles:30,maxFileSizeMiB:100,
    extensions:['.pdf','.jpeg','.png','.doc','.docx','.xls','.xlsx','.jpg']},
  notes:['先确定支付公司和付款币种，再明确是否项目；不能将未回答默认为非项目。承担公司默认与支付公司相同，也可以选择不同公司。',
    '项目部门按每条付款明细选择。合同公司、开户银行和收款账号由员工提供。',
    '本人有多个任职部门时必须选择；费用类别和科目结合本次用途在合法候选中给建议。',
    '可按收款方或单号查本人历史付款，再由员工选择；仅带入收款方、开户行和字符串账号，仍需最终核对。',
    '先review默认生成紧凑五列HTML付款明细，逐行给首选、简短理由及最多两个合理备选，保留全部合法科目入口和完整原文；MD为同草稿兜底。员工确认后confirm-details，再在同一草稿补外部收款、主表和附件，最终完整申请在对话核对并等待新的提交确认。',
    '允许口述修改或保存原MD后告知改好了并用read-edit回读；保留材料归属和行身份，用已有公司汇率代码重算回写，不采纳手改汇率/后台港币计算/合计，不要求导出上传。',
    '本单各行使用统一付款币种，amount只填本次付款额；合同总额、历史已付和本次付款不可重复相加。MD不展示汇率及后台港币金额，项目仍保留原逐行分配字段。']
};
const allowed=[...requirements.required,...requirements.choices,...requirements.optional,...requirements.project];
const itemAllowed=[...requirements.items.required,...requirements.items.optional];
const source=name=>sources[config.sources[name]];
const query=(ctx,name,filters,columns)=>matchingRows(ctx,source(name).formUuid,filters,columns);
const rounded=value=>roundAmount(value,rules.precision);
const sum=values=>sumAmounts(values,rules.precision);

function textValue(value,field,fields) {
  const text=C.optionalText(value),limit=Number(fields.get(field).props.maxLength);
  C.check(!Number.isFinite(limit)||limit<=0||text.length<=limit,'PAYMENT_INPUT_INVALID');return text;
}
function optionalRoster(roster,field) {
  const rows=roster.get(field);
  return !rows?.length||rows.every(row=>C.absent(row.label)&&C.absent(row.value))?'':C.rosterValue(roster,field);
}
function validateInput(input) {
  C.inputKeys(input,allowed);
  for(const [name,value] of Object.entries(input)) {
    if(['is_project','same_bearing_company','include_contract','include_seal','include_expense'].includes(name))
      C.check(typeof value==='boolean','PAYMENT_INPUT_INVALID');
    else if(name!=='items') C.check(typeof value==='string','PAYMENT_INPUT_INVALID');
  }
  if(input.items!==undefined) {
    C.check(Array.isArray(input.items)&&input.items.length<=50,'PAYMENT_INPUT_INVALID');
    for(const item of input.items) {
      C.inputKeys(item,itemAllowed);
      for(const [name,value] of Object.entries(item)) if(name!=='amount') C.check(typeof value==='string','PAYMENT_INPUT_INVALID');
      C.check(item.classification_reason===undefined||item.classification_reason.length<=300,'PAYMENT_INPUT_INVALID');
    }
  }
}
async function businessLines(ctx,fields,needs,input,departmentId,fieldKeys,prefix='',editorChoices) {
  const S=source('businessLines');
  const steps=[
    ['business_structure',fieldKeys[0],S.structureField,'业务总架构'],
    ['business_line',fieldKeys[1],S.lineField,'业务线'],
    ['business_subline',fieldKeys[2],S.sublineField,'子业务线']
  ].map(([inputKey,key,sourceField,label])=>({inputKey,field:F[key],sourceField,label,required:C.required(fields,F[key])}));
  return Finance.businessLines({ctx,source:S,input,departmentId,steps,needs,prefix,editorChoices});
}
function assertSchema(schema) {
  const fields=C.assertFields(schema,F);
  for(const [field,formula] of Object.entries(rules.formulas)) C.check(fields.get(field).props.formula===formula,'WORKFLOW_SCHEMA_CHANGED');
  for(const [field,value] of Object.entries(rules.defaults)) {
    const raw=fields.get(field).props.value;C.check((typeof raw==='object'?raw?.zh_CN:raw)===value,'WORKFLOW_SCHEMA_CHANGED');
  }
  return fields;
}
function detailContract(project,company,currency,scope,rows,fields) {
  const columns=config.detailReview.columns.map(column=>[...column]);
  if(project) columns.splice(1,0,...config.detailReview.projectColumns.map(([key,label,required])=>
    [key,label,['structure','line'].includes(key)?C.required(fields,F[key==='structure'?'projectStructure':'projectLine']):required]));
  return {columns,currencyPreviewKey:config.detailReview.currencyPreviewKey,rowsPreviewKey:config.detailReview.rowsPreviewKey,
    context:{paymentCompany:company||null,project:project??null,projectName:scope.projectName||null,
      projectCategory:scope.category||null,paymentCurrency:currency||null,
      projectDepartmentIds:project?rows.map(row=>row.projectDepartmentId??null):[]}};
}
async function classificationScope(input,ctx,needs,project,editorChoices) {
  const pairs=await accountPairs(ctx,source('accounts'));
  if(!project) return {pairs,projectRows:[],ready:true};
  const projects=source('projects'),PD=source('projectDepartments');
  const projectChoices=distinctValues(await query(ctx,'projects',{[projects.statusField]:rules.defaults[F.projectActive]},[projects.nameField]),projects.nameField);
  editorChoices.project_name=projectChoices;
  const projectName=choice(needs,'project_name','项目',input.project_name,projectChoices);
  if(!projectName) return {pairs:[],projectRows:[],ready:false};
  const projectRows=await query(ctx,'projectDepartments',{[PD.projectField]:projectName},[PD.nameField,PD.departmentIdField,PD.categoryField]);
  const categories=distinctValues(projectRows,PD.categoryField);
  editorChoices.project_expense_category=categories;
  editorChoices['items[*].project_department_name']=distinctValues(projectRows,PD.nameField);
  const category=choice(needs,'project_expense_category','项目费用类别',input.project_expense_category,categories);
  if(!category) {
    const allowed=pairs.filter(pair=>categories.some(value=>C.normalized(value)===C.normalized(pair.category)));
    C.check(allowed.length,'PAYMENT_SOURCE_MISSING','项目费用类别尚未配置会计科目，请联系 Finance。');
    Object.assign(needs.at(-1),{resolver:'agent_recommendation',
      recommendationContexts:input.items.map((item,index)=>buildRecommendationContext({
        scope:'project',description:item.description||'',pairs:allowed,categoryInputKey:'project_expense_category',
        accountInputKey:`items[${index}].account`,...canonicalConstraints(allowed,input.project_expense_category,item.account)}))});
  }
  return {pairs,projectRows,projectName,category,ready:!!category};
}
// The same bounded facts build both the editable first review and the final
// native rows. Recipient/history, applicant roster and unrelated main-form
// choices intentionally belong to the later preparation stage.
async function buildDetails(input,ctx,fields) {
  C.check(typeof ctx.actor?.userid==='string'&&ctx.actor.userid.trim()
    &&typeof ctx.actor?.corp_id==='string'&&ctx.actor.corp_id.trim(),'CURRENT_IDENTITY_MISSING');
  const needs=[],project=input.is_project,editorChoices={};
  C.check(project!==false||requirements.project.every(name=>C.absent(input[name])),'PAYMENT_INPUT_CONFLICT');
  const items=input.items||[];
  C.check(items.length<=(fields.get(F.items).props.maxItems??50),'PAYMENT_INPUT_INVALID');
  if(!items.length) needs.push({field:'items',message:'请提供至少一行付款明细。'});
  for(const item of items) C.check(project===undefined|| (project?C.absent(item.expense_category):
    ['project_department_name','business_structure','business_line','business_subline'].every(name=>C.absent(item[name]))),
  'PAYMENT_INPUT_CONFLICT');
  const companies=source('companies');
  editorChoices.payment_company=distinctValues(
    await query(ctx,'companies',{[companies.hasBankAccountField]:rules.defaults[F.bankFlag]},[companies.companyField]),companies.companyField);
  const paymentCompany=choice(needs,'payment_company','支付公司',input.payment_company,editorChoices.payment_company);
  const currencies=source('currencies');
  editorChoices.currency=paymentCompany?distinctValues(
    await query(ctx,'currencies',{[currencies.companyField]:paymentCompany},[currencies.currencyField]),currencies.currencyField):[];
  const currency=paymentCompany?choice(needs,'currency','付款币种',input.currency,editorChoices.currency):null;
  if(project===undefined)needs.push({field:'is_project',message:'这笔付款是否属于项目？如是，请说明项目名称。',choices:[{value:false,label:'非项目'},{value:true,label:'项目'}]});
  const scope=currency&&project!==undefined&&items.length
    ?await classificationScope({...input,items},ctx,needs,project,editorChoices):{ready:false,pairs:[],projectRows:[]},PD=source('projectDepartments');
  const recommendationContexts=[];
  const selections=scope.ready?accountSelections({items:items.map(item=>({...item,description:item.description||''}))},
    scope.pairs,needs,project?scope.category:undefined,recommendationContexts):items.map(()=>({}));
  for(const [index,item]of items.entries()) {
    editorChoices[`items[${index}].expense_category`]=[...new Set(scope.pairs.map(pair=>pair.category))];
    const selected=selections[index].category||scope.category||item.expense_category;
    editorChoices[`items[${index}].account`]=[...new Set(scope.pairs.filter(pair=>!selected||C.normalized(pair.category)===C.normalized(selected)).map(pair=>pair.account))];
  }
  const hkd=rules.defaults[F.hkd],resolveRate=createRateResolver({ctx,source:source('rates'),errorCode:'PAYMENT_RATE_INVALID',
    errorMessage:'付款汇率未唯一配置，请联系 Finance。'});
  const rate=currency&&project!==undefined&&items.length?await resolveRate(currency,hkd):null,rows=[];
  for(const [index,item] of items.entries()) {
    const prefix=`items[${index}].`,row={category:selections[index].category||scope.category||item.expense_category||null,
      account:selections[index].account||item.account||null,description:textValue(item.description,F.itemDescription,fields),
      amount:C.absent(item.amount)?null:rounded(item.amount),remarks:textValue(item.remarks,F.remarks,fields)};
    if(!row.description) needs.push({field:prefix+'description',message:`请补充第 ${index+1} 行付款内容。`});
    if(row.amount===null) needs.push({field:prefix+'amount',message:`请补充第 ${index+1} 行本次付款金额。`});
    row.rate=rate;row.hkdAmount=row.amount===null||rate===null?null:convertAmount(row.amount,rate,rules.precision);
    if(project) {
      Object.assign(row,{projectDepartment:null,projectDepartmentId:null,structure:null,line:null,subline:null});
      if(scope.ready) {
        row.projectDepartment=choice(needs,prefix+'project_department_name','本行项目部门',item.project_department_name,distinctValues(scope.projectRows,PD.nameField))||null;
        if(row.projectDepartment) {
          const ids=distinctValues(scope.projectRows.filter(record=>C.exact(record[PD.nameField],row.projectDepartment)),PD.departmentIdField);
          C.check(ids.length===1&&/^\d+$/.test(ids[0]),'PAYMENT_PROJECT_DEPARTMENT_AMBIGUOUS','项目部门资料不唯一，请联系 Finance。');
          row.projectDepartmentId=ids[0];
          const values=await businessLines(ctx,fields,needs,item,ids[0],['projectStructure','projectLine','projectSubline'],prefix,editorChoices);
          row.structure=values[F.projectStructure]??null;row.line=values[F.projectLine]??null;row.subline=values[F.projectSubline]??null;
        }
      }
    }
    if(item.classification_reason?.trim()) row.classificationReason=item.classification_reason.trim();
    rows.push(row);
  }
  const detailReviewContract=detailContract(project,paymentCompany,currency,scope,rows,fields);
  const previewRows=rows.map(row=>({...Object.fromEntries(detailReviewContract.columns.map(([key,label])=>[label,row[key]])),
    ...(row.classificationReason?{分类建议依据:row.classificationReason}:{})}));
  return {rows,needsInput:needs,detailReviewContract,recommendationContexts,paymentCompany,currency,scope,rate,editorChoices,
    preview:{支付公司:paymentCompany||'',币种:currency,是否项目款项:project===undefined?'待确认':project?'是':'否',
      ...(project?{项目:scope.projectName||'',项目费用类别:scope.category||''}:{}),付款明细:previewRows,
      付款总额:rows.length&&rows.every(row=>row.amount!==null)?sum(rows.map(row=>row.amount)):null}};
}
async function details(input,ctx) {
  validateInput(input);
  const result=await buildDetails(input,ctx,assertSchema(await ctx.schema()));
  return {rows:result.rows.map(({projectDepartmentId,...row})=>row),preview:result.preview,
    needsInput:result.needsInput,detailReviewContract:result.detailReviewContract,recommendationContexts:result.recommendationContexts,editorChoices:result.editorChoices};
}
async function relations(ctx,input,needs,editorChoices={}) {
  const formData={},preview={},labels={contract:'关联合同',seal:'关联用印',expense:'关联对外费用'};
  for(const kind of ['contract','seal','expense']) {
    const spec=policy.relatedSources[kind];
    const selected=input[kind+'_instance_id'],include=input['include_'+kind];
    C.check(!(include===false&&selected),'PAYMENT_RELATION_CONFLICT');
    if(!selected&&include!==true) continue;
    const candidates=Association.validateCandidates(await ctx.related(kind),{
      ...Association.sourceConstraints(spec),appType:companyConfig.appType,formUuid:spec.form,
      actorId:ctx.actor.userid,corpId:ctx.actor.corp_id});
    editorChoices[kind+'_instance_id']=candidates.map(row=>({value:row.instance_id,label:row.title||row.sub_title||labels[kind]}));
    const found=candidates.find(row=>row.instance_id===selected);
    if(!found) {needs.push({field:kind+'_instance_id',message:candidates.length?`请选择${labels[kind]}，或取消关联。`:'没有可用的关联单，请取消关联。',
      choices:candidates.map(row=>({value:row.instance_id,label:row.title,subtitle:row.sub_title,status:row.instance_status}))});continue;}
    formData[F[kind]]=[Association.processReference(found)];
    preview[labels[kind]]={标题:found.title,说明:found.sub_title,状态:found.instance_status};
  }
  return {formData,preview};
}

// A prior payment is an editable reference, never an authoritative bank
// directory or an implicit association with this application.
async function paymentReference(input,ctx) {
  if(input.payment_reference_query===undefined&&!input.payment_reference_instance_id
    ||input.payment_reference_query===''&&input.payment_reference_instance_id==='')
    return {input,workflowState:{paymentReference:null}};
  const keyword=input.payment_reference_query??'';
  C.check(keyword.length<=100,'PAYMENT_INPUT_INVALID');
  const spec=policy.relatedSources.payment_history;
  const records=Association.validateCandidates(await ctx.related('payment_history'),{
    ...Association.sourceConstraints(spec),appType:companyConfig.appType,formUuid:spec.form,
    actorId:ctx.actor.userid,corpId:ctx.actor.corp_id});
  const fields={contract_company:F.contractCompany,bank_name:F.bankName,bank_account:F.bankAccount};
  const matches=records.filter(row=>[row.title,row.data[F.contractCompany]].some(value=>
    typeof value==='string'&&C.normalized(value).includes(C.normalized(keyword))));
  // Do not convert a numeric historical account: its leading zeros or long
  // digits may already be lost. The employee can provide the original text.
  const usable=matches.filter(row=>Object.values(fields).every(field=>typeof row.data[field]==='string'&&row.data[field].trim()));
  const selected=usable.find(row=>row.instance_id===input.payment_reference_instance_id);
  if(!selected) {
    const ordered=[...usable].sort((a,b)=>(Number(b.created_at)||0)-(Number(a.created_at)||0));
    const distinct=new Map();
    for(const row of ordered) {
      const tuple=JSON.stringify(Object.values(fields).map(field=>row.data[field].trim()));
      if(!distinct.has(tuple)) distinct.set(tuple,row);
    }
    const choices=[...distinct.values()].slice(0,10).map(row=>({value:row.instance_id,
      label:row.data[F.contractCompany].trim(),bank:row.data[F.bankName].trim(),
      accountHint:'尾号 '+row.data[F.bankAccount].trim().slice(-4),source:row.title,status:row.instance_status}));
    return {needsInput:[{field:'payment_reference_instance_id',
      message:choices.length?'请选择本次要参考的历史收款资料，确认完整账号后再提交。最多显示10组，可补充收款名称或单号缩小范围。':
        '没有找到可直接引用的收款资料。可更换关键词，或清除历史查询选项并提供本次完整收款信息。',choices}]};
  }
  const defaults=Object.fromEntries(Object.entries(fields).map(([name,field])=>[name,selected.data[field].trim()]));
  const prior=ctx.workflowState?.paymentReference,effective={...input},ignored={...(prior?.ignored||{})};
  const updated=new Set(ctx.inputUpdateKeys??Object.keys(input));
  if(prior&&prior.instanceId!==selected.instance_id) {
    for(const name of [...Object.keys(fields),'payment_details_text'])
      if(Object.hasOwn(input,name)&&!updated.has(name)) ignored[name]=input[name];
  }
  for(const [name,value] of Object.entries(ignored)) {
    if(updated.has(name)||input[name]!==value) delete ignored[name];else delete effective[name];
  }
  return {input:{...defaults,...effective},workflowState:{paymentReference:{instanceId:selected.instance_id,ignored}},
    source:{来源单号:selected.title,收款方:defaults.contract_company,
    说明:'仅参考本人历史资料；请确认本次收款方、开户行及完整账号。'}};
}

function verifyAccountText(input) {
  if(input.payment_details_text===undefined||C.absent(input.bank_account)) return;
  C.check(input.payment_details_text.length<=20000,'PAYMENT_INPUT_INVALID');
  const original=input.payment_details_text,account=input.bank_account.replace(/\s/g,'');
  C.check(account.length>0&&account.length<=200,'PAYMENT_ACCOUNT_SOURCE_MISMATCH');
  // Whitespace grouping may change; digit order, leading zeros and all other
  // account characters must occur literally in the supplied original text.
  const literal=[...account].map(char=>char.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*');
  const found=new RegExp('(^|[^A-Za-z0-9])'+literal+'(?=$|[^A-Za-z0-9])','u').test(original);
  C.check(found,'PAYMENT_ACCOUNT_SOURCE_MISMATCH','收款账号与提供的原文不一致，请逐字核对，不要补猜数字。');
}

async function prepare(input,ctx) {
  validateInput(input);
  const actor=C.identity(ctx),fields=assertSchema(await ctx.schema()),needs=[];
  const detail=await buildDetails(input,ctx,fields);
  if(detail.needsInput.length)return {needsInput:detail.needsInput,preview:detail.preview,
    recommendationContexts:detail.recommendationContexts,editorChoices:detail.editorChoices};
  const reference=await paymentReference(input,ctx);
  if(reference.needsInput) return reference;
  input=reference.input;verifyAccountText(input);
  const workflowState={...(ctx.workflowState||{}),...(reference.workflowState||{})};
  const pause=()=>({needsInput:needs,workflowState,editorChoices:detail.editorChoices});
  const project=input.is_project,same=input.same_bearing_company??rules.defaultSameBearingCompany;
  for(const [field,code] of [[F.isProject,project?'NORMAL':'HIDDEN'],[F.sameBearing,same?'HIDDEN':'NORMAL']])
    C.option(fields,field,code,['HIDDEN','NORMAL']);
  C.check(project||requirements.project.every(name=>C.absent(input[name])),'PAYMENT_INPUT_CONFLICT');
  for(const [name,label] of [['contract_company','合同公司名称'],['bank_name','开户银行'],['bank_account','收款账号'],['latest_payment_date','最晚付款日期']])
    if(C.absent(input[name])) needs.push({field:name,message:`请补充${label}。`});
  if(!input.items?.length) needs.push({field:'items',message:'请提供至少一行付款明细。'});
  for(const [index,item] of (input.items||[]).entries()) {
    for(const [name,label] of [['description','付款内容'],['amount','付款金额']])
      if(C.absent(item[name])) needs.push({field:`items[${index}].${name}`,message:`请补充第 ${index+1} 行${label}。`});
    C.check(project?C.absent(item.expense_category):['project_department_name','business_structure','business_line','business_subline'].every(k=>C.absent(item[k])),
      'PAYMENT_INPUT_CONFLICT');
  }
  if(needs.length) return pause();
  C.check(input.items.length>=(fields.get(F.items).props.minItems??1)&&input.items.length<=(fields.get(F.items).props.maxItems??50),'PAYMENT_INPUT_INVALID');
  const latestDate=C.date(input.latest_payment_date);
  const roster=C.rosterFields(await ctx.roster(policy.rosterFields),actor),ids=C.rosterDepartmentIds(roster);
  const names=(roster.get(R.departmentNames)||[]).flatMap(row=>C.values(row.label??row.value)).flatMap(v=>v.split(/[,，|]/)).map(v=>v.trim());
  if(names.length===ids.length&&names.every(Boolean)) {
    detail.editorChoices.department_name=names;
    detail.editorChoices.department_id=ids.map((value,index)=>({value,label:names[index]}));
  }
  let selectedDepartment=input.department_id;
  if(input.department_name!==undefined) {
    C.check(names.length===ids.length&&names.every(Boolean),'ROSTER_FIELD_MISSING','本人部门资料不完整，请联系 HR。');
    const candidates=ids.map((value,index)=>({value,label:names[index]}));
    const matches=candidates.filter(item=>C.normalized(item.label)===C.normalized(input.department_name));
    if(selectedDepartment) C.check(input.department_name===''||matches.some(item=>item.value===selectedDepartment),'PAYMENT_INPUT_CONFLICT');
    else if(matches.length===1) selectedDepartment=matches[0].value;
    else {needs.push({field:'department_id',message:'请选择本人当前任职部门。',choices:matches.length?matches:candidates});return pause();}
  }
  if(!selectedDepartment&&ids.length>1) {
    C.check(names.length===ids.length&&names.every(Boolean),'ROSTER_FIELD_MISSING','本人部门资料不完整，请联系 HR。');
    needs.push({field:'department_id',message:'你有多个任职部门，请选择本次申请部门。',
      choices:ids.map((value,index)=>({value,label:names[index]}))});return pause();
  }
  const dept=C.department(roster,selectedDepartment);
  const departmentCache=new Map();
  async function department(id) {
    if(departmentCache.has(id)) return departmentCache.get(id);
    C.check(/^\d+$/.test(id)&&Number.isSafeInteger(Number(id)),'DEPARTMENT_ID_INVALID');
    const raw=await ctx.invoke('departmentDetails',{'Content-Type':'application/json',Body:{dept_id:Number(id)}});
    const details=Department.normalizeDepartmentDetails(raw,{departmentId:id});
    const result={manager:Department.departmentManagerAt(details,rules.managerIndex),name:raw.result.name};
    departmentCache.set(id,result);return result;
  }
  const currentDepartment=await department(dept.id);
  const departmentName=typeof currentDepartment.name==='string'&&currentDepartment.name.trim()?currentDepartment.name.trim():
    names.length===ids.length?names[ids.indexOf(dept.id)]:'';
  C.check(departmentName,'ROSTER_FIELD_MISSING','本人部门资料不完整，请联系 HR。');
  C.check(currentDepartment.manager||!C.required(fields,F.manager),'DEPARTMENT_MANAGER_MISSING','部门主管缺失，请联系 HR。');
  const formData={
    [F.applicant]:[actor.userid],[F.applicantId]:actor.userid,[F.applicationDate]:ctx.todayMs,
    [F.departmentId]:dept.id,[F.departmentName]:departmentName,[F.departmentTransition]:dept.id,[F.businessDepartment]:dept.id,
    [F.office]:optionalRoster(roster,R.office),[F.positionLevel]:optionalRoster(roster,R.positionLevel),
    [F.manager]:currentDepartment.manager?[currentDepartment.manager]:[],[F.bankFlag]:rules.defaults[F.bankFlag],
    [F.projectActive]:rules.defaults[F.projectActive],[F.isProject]:project?'NORMAL':'HIDDEN',[F.sameBearing]:same?'HIDDEN':'NORMAL',
    [F.latestDate]:latestDate,[F.latestDateText]:input.latest_payment_date,
    [F.contractCompany]:textValue(input.contract_company,F.contractCompany,fields),
    [F.bankName]:textValue(input.bank_name,F.bankName,fields),[F.bankAccount]:textValue(input.bank_account,F.bankAccount,fields),
    [F.description]:textValue(input.description,F.description,fields)
  };
  const {paymentCompany,currency,scope,rate}=detail;
  formData[F.paymentCompany]=paymentCompany;formData[F.paymentCompanyMirror]=paymentCompany;formData[F.currency]=currency;
  if(same) {
    C.check(input.bearing_company===undefined||C.normalized(input.bearing_company)===C.normalized(paymentCompany),'PAYMENT_INPUT_CONFLICT');
    formData[F.bearingCompany]=paymentCompany;
  } else {
    const companies=source('companies');
    detail.editorChoices.bearing_company=distinctValues(await query(ctx,'companies',{},[companies.companyField]),companies.companyField);
    formData[F.bearingCompany]=choice(needs,'bearing_company','承担公司',input.bearing_company,detail.editorChoices.bearing_company,C.required(fields,F.bearingCompany));
  }
  Object.assign(formData,await businessLines(ctx,fields,needs,input,dept.id,['structure','line','subline'],'',detail.editorChoices));
  if(needs.length)return pause();
  if(project) {formData[F.project]=scope.projectName;formData[F.projectCategory]=scope.category;}
  const hkd=rules.defaults[F.hkd],rows=[],previewRows=detail.preview.付款明细,projectDepartmentIds=[],projectManagers=[];
  for(const value of detail.rows) {
    const row={};
    if(project) {
      const id=value.projectDepartmentId,manager=(await department(id)).manager;projectDepartmentIds.push(id);
      if(manager&&!projectManagers.includes(manager))projectManagers.push(manager);
      Object.assign(row,{[F.projectDepartmentName]:value.projectDepartment,[F.projectDepartmentId]:id,
        [F.projectStructure]:value.structure,[F.projectLine]:value.line,[F.projectSubline]:value.subline,[F.projectAccount]:value.account});
    } else Object.assign(row,{[F.expenseCategory]:value.category,[F.account]:value.account});
    Object.assign(row,{[F.itemDescription]:value.description,[F.amount]:value.amount,[F.remarks]:value.remarks,
      [F.hkd]:hkd,[F.rate]:rate,[F.hkdAmount]:value.hkdAmount});
    for(const field of Object.keys(row))if(row[field]===''&&!C.required(fields,field))delete row[field];
    rows.push(row);
  }
  C.check(!project||projectManagers.length||!C.required(fields,F.projectManagers),'DEPARTMENT_MANAGER_MISSING','项目部门主管缺失，请联系 HR。');
  formData[F.items]=rows;formData[F.total]=sum(rows.map(row=>row[F.amount]));formData[F.hkdTotal]=sum(rows.map(row=>row[F.hkdAmount]));
  formData[F.projectManagers]=projectManagers;formData[F.projectDepartmentAggregate]=project?JSON.stringify(projectDepartmentIds):'';
  const contactSource=source('contacts');
  for(const [field,sourceField] of [[F.finance,contactSource.financeField],[F.cashier,contactSource.cashierField]]) {
    const contacts=await C.contacts(ctx,{form:contactSource.formUuid,key:contactSource.companyField,admin:sourceField},paymentCompany);
    C.check(contacts.ids.length||!C.required(fields,field),'PAYMENT_CONTACT_MISSING','支付公司的财务人员配置缺失，请联系 Finance。');
    formData[field]=contacts.ids;
  }
  const associated=await relations(ctx,input,needs,detail.editorChoices);if(needs.length) return pause();
  Object.assign(formData,associated.formData);
  return {formData,departmentId:dept.id,attachmentField:F.attachment,workflowState,
    editorChoices:detail.editorChoices,
    detailReviewContract:detail.detailReviewContract,detailReviewRows:detail.rows,recommendationContexts:detail.recommendationContexts,
    verification:{optionalEmptyFields:Object.entries(formData).filter(([field,value])=>!C.required(fields,field)&&(value===''||Array.isArray(value)&&value.length===0)).map(([field])=>field),
      enumLabels:{[F.isProject]:{HIDDEN:'否',NORMAL:'是'},[F.sameBearing]:{HIDDEN:'是',NORMAL:'否'}}},
    preview:{流程:title,申请人:actor.name||actor.userid,申请部门:departmentName,申请日期:ctx.today,
      支付公司:paymentCompany,承担公司:formData[F.bearingCompany],币种:currency,
      业务总架构:formData[F.structure],业务线:formData[F.line],子业务线:formData[F.subline],
      合同公司:formData[F.contractCompany],开户银行:formData[F.bankName],收款账号:formData[F.bankAccount],是否项目款项:project?'是':'否',
      ...(project?{项目:formData[F.project],项目费用类别:formData[F.projectCategory]}:{}),
      最晚付款日期:input.latest_payment_date,付款明细:previewRows,付款总额:formData[F.total],支付港币总额:formData[F.hkdTotal],说明:formData[F.description],
      ...(reference.source?{收款资料来源:reference.source}:{}),...associated.preview}}
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,detailReview:true,details,prepare};
