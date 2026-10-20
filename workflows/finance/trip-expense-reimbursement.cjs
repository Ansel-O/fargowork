'use strict';
const C=require('../leave-trip-common.cjs');
const config=require('../../config/workflows/finance/trip_expense_reimbursement.json');
const sources=require('../../config/sources.json');
const companyConfig=require('../../config/company.json');
const PaymentHistory=require('../../shared/payment-history.cjs');
const Department=require('../../shared/department-details.cjs');
const Finance=require('../../shared/finance-catalog.cjs');
const Association=require('../../shared/process-association.cjs');
const {canDelegate}=require('../../shared/workflow-subject.cjs');
const {resolveReimbursementContext,personalPaymentDefaults}=require('../../shared/reimbursement-info.cjs');
const {matchingRows,distinctValues}=require('../../shared/scoped-catalog.cjs');
const {createRateResolver,convertAmount,sumAmounts}=require('../../shared/exchange-rates.cjs');
const {suggestAllowances}=require('../../shared/travel-allowance.cjs');
const {buildRecommendationContext}=require('../../shared/account-recommendation.cjs');
const {key,title,target,fields:F,roster:R,policy,rules}=config;
const bankFields={bank_account:'bankAccount',bank_name:'bankName',bank_city:'bankCity',bank_branch:'bankBranch',account_name:'accountName'};
const bankLabels={bank_account:'收款账号',bank_name:'开户银行',bank_city:'开户城市',bank_branch:'开户支行',account_name:'账户名称'};
const costs={airfare:'airfare',accommodation:'accommodation',local_transport:'localTransport',other_expenses:'otherExpenses'};
const costLabels={airfare:'飞机、车船票款',accommodation:'住宿费',local_transport:'市内交通费',other_expenses:'其他费用'};
const requirements={required:['items','is_project'],optional:['claimant_query','claimant_user_id','department_id','department_name',
  'payment_company','reimbursement_currency','same_bearing_company','bearing_company','business_structure','business_line','business_subline',
  ...Object.keys(bankFields),'description','project_name','project_expense_category',...PaymentHistory.INPUT_FIELDS],
  items:{required:['departure','destination','region','start_date','original_currency'],
    optional:['end_date','trip_instance_id',...Object.keys(costs),'allowance_amount','remarks','account','classification_reason',
      'project_department_name','business_structure','business_line','business_subline'],minimumRows:1,maximumRows:50},
  attachments:{required:true,input:'attachments: [绝对文件路径]',maxFiles:20,maxFileSizeMiB:100},
  notes:['办理出差费用报销，不是出差申请。默认本人；仅配置中的代办员可按原生员工候选选择其他报销人，实际发起人保持登录账号。',
    '每行只有一种原币种和汇率；同一行程段的不同币种费用分行，餐补只建议一次。收款币种CNY对应CNY餐补，其他收款币种对应HKD餐补。',
    '先确定报销人、合法支付公司与收款币种，并明确是否项目，再计算明细；未明确是否项目时补问，不能默认为非项目。',
    '餐补按自然日只自动建议一次，日期含首尾、同日一天；跨城共享日归到达的下一段，使用该段地区标准。员工可修改、填0或清空，后续不覆盖。',
    '每行关联本报销人已完成且同意的正式出差单；只有报销人为jefferson.sun时可不填，主动关联仍核验。',
    '先整理材料及可修改行程明细并确认，再补主表/附件；完整申请预览后另等新的提交确认。']};
const allowed=[...requirements.required,...requirements.optional];
const itemAllowed=[...requirements.items.required,...requirements.items.optional];
const source=name=>sources[config.sources[name]];
const query=(ctx,name,filters,columns)=>matchingRows(ctx,source(name).formUuid,filters,columns);
const sum=values=>sumAmounts(values,rules.precision);
const money=value=>C.absent(value)?null:sum([value]);
const optionalRoster=(roster,field,prefer='value')=>{
  const entries=roster.get(field);
  return !entries?.length||entries.every(e=>C.absent(e.value)&&C.absent(e.label))?'':C.rosterValue(roster,field,prefer);
};
function validateInput(input) {
  C.inputKeys(input,allowed);
  PaymentHistory.validateInput(input);
  for(const [name,value] of Object.entries(input)) {
    if(['is_project','same_bearing_company'].includes(name)) C.check(typeof value==='boolean','TRIP_REIMBURSEMENT_INPUT_INVALID');
    else if(name!=='items') C.check(typeof value==='string','TRIP_REIMBURSEMENT_INPUT_INVALID');
  }
  if(input.items!==undefined) {
    C.check(Array.isArray(input.items)&&input.items.length<=50,'TRIP_REIMBURSEMENT_INPUT_INVALID');
    for(const item of input.items) {
      C.inputKeys(item,itemAllowed);
      for(const [name,value] of Object.entries(item))
        C.check(Object.hasOwn(costs,name)||name==='allowance_amount'
          ?value===null||typeof value==='string'||typeof value==='number'&&Number.isFinite(value)
          :typeof value==='string','TRIP_REIMBURSEMENT_INPUT_INVALID');
      C.check(item.classification_reason===undefined||item.classification_reason.length<=300,'TRIP_REIMBURSEMENT_INPUT_INVALID');
    }
  }
}
function schemaFields(schema) {
  const fields=C.assertFields(schema,F);
  for(const [field,formula] of Object.entries(rules.formulas))
    C.check((fields.get(field).props.formula||fields.get(field).props.complexValue?.formula)===formula,'WORKFLOW_SCHEMA_CHANGED');
  for(const [field,value] of Object.entries(rules.defaults)) {
    const raw=fields.get(field).props.value;
    C.check((typeof raw==='object'?raw?.zh_CN:raw)===value,'WORKFLOW_SCHEMA_CHANGED');
  }
  C.check(fields.get(F.applicant).props.variable?.type==='user'
    &&fields.get(F.applicationDate).props.variable?.type==='today','WORKFLOW_SCHEMA_CHANGED');
  return fields;
}
function bounded(value,field,fields) {
  const text=C.optionalText(value),max=Number(fields.get(field).props.maxLength);
  C.check(!Number.isFinite(max)||max<=0||text.length<=max,'TRIP_REIMBURSEMENT_INPUT_INVALID');
  return text;
}
async function subjectContext(input,ctx,needs) {
  const actor=ctx.actor;
  C.check(typeof actor?.userid==='string'&&typeof actor?.corp_id==='string','CURRENT_IDENTITY_MISSING');
  const selected=input.claimant_user_id;
  if(input.claimant_query) {
    C.check(canDelegate(actor,policy),'WORKFLOW_DELEGATION_NOT_ALLOWED');
    C.check(typeof ctx.searchEmployees==='function','EMPLOYEE_SELECTION_NOT_ALLOWED');
    const result=await ctx.searchEmployees(input.claimant_query);
    C.check(result?.success===true&&Array.isArray(result.users)&&result.users.length<50,'EMPLOYEE_SOURCE_INVALID');
    if(!selected) {
      needs.push({field:'claimant_user_id',message:'请按姓名和部门确定本次报销人。',
        choices:result.users.map(p=>({value:p.userId,label:p.userName+' · '+p.departments.map(d=>d.path||d.name||'').join(' / ')}))});
      return null;
    }
  } else if(selected&&selected!==actor.userid) {
    C.check(canDelegate(actor,policy),'WORKFLOW_DELEGATION_NOT_ALLOWED');
    needs.push({field:'claimant_query',message:'请先按姓名查询并选择本次报销人。'});return null;
  }
  if(typeof ctx.forSubject==='function') return ctx.forSubject(selected);
  C.check(!selected||selected===actor.userid,'WORKFLOW_DELEGATION_NOT_ALLOWED');
  return {...ctx,subject:{...actor,delegated:false}};
}
function contract(project,subject,rows,currency,fields,context={}) {
  const columns=[['departure','出发地',true],['destination','目的地',true],['region','出差地区',true],
    ['startDate','开始日期',true],['endDate','结束日期',true],['days','天数',true],['trip','关联出差流程',false],
    ...Object.keys(costs).map(k=>[k,costLabels[k],false]),['originalCurrency','原币种',true],['rate','汇率',true],
    ['reimbursedAmount','报销金额',true],['allowanceCurrency','餐补币种',true],['allowanceStandard','每日餐补标准',false],
    ['allowanceDays','餐补建议天数',false],['allowanceAmount','餐补金额',false],['remarks','备注',false]];
  if(project) columns.push(['projectDepartment','项目部门',fields?C.required(fields,F.projectDepartmentName):false],
    ['structure','项目业务总架构',fields?C.required(fields,F.projectStructure):false],
    ['line','项目业务线',fields?C.required(fields,F.projectLine):false],['subline','项目子业务线',true],
    ['category','项目费用类别',true],['account','项目会计科目',true]);
  return {columns,currencyPreviewKey:'报销币种',rowsPreviewKey:'报销明细',
    context:{claimantUserId:subject?.userid??null,allowanceCurrency:currency,
      project:project??null,associations:rows.map(row=>row.tripId??null),...context}};
}
function displayRows(rows,reviewContract) {
  return rows.map(row=>Object.fromEntries(reviewContract.columns.map(([key,label])=>[label,row[key]??null])));
}
async function lines(ctx,fields,needs,input,departmentId,keys,prefix='',editorChoices) {
  const s=source('businessLines');
  return Finance.businessLines({ctx,source:s,input,departmentId,needs,prefix,editorChoices,steps:keys.map((field,index)=>({
    inputKey:['business_structure','business_line','business_subline'][index],field:F[field],
    sourceField:[s.structureField,s.lineField,s.sublineField][index],label:['业务总架构','业务线','子业务线'][index],
    required:C.required(fields,F[field])}))});
}
async function projectScope(input,ctx,needs) {
  if(!input.is_project) return {ready:true,pairs:[],projectRows:[],category:rules.fixedCategory};
  const ps=source('projects'),pd=source('projectDepartments'),pairs=await Finance.accountPairs(ctx,source('accounts'));
  const projectChoices=distinctValues(
    await query(ctx,'projects',{[ps.statusField]:rules.defaults[F.projectActive]},[ps.nameField]),ps.nameField);
  const projectName=Finance.choice(needs,'project_name','项目',input.project_name,projectChoices);
  if(!projectName) return {ready:false,pairs:[],projectRows:[],projectChoices};
  const projectRows=await query(ctx,'projectDepartments',{[pd.projectField]:projectName},[pd.nameField,pd.departmentIdField,pd.categoryField]);
  const categories=distinctValues(projectRows,pd.categoryField);
  const category=Finance.choice(needs,'project_expense_category','项目费用类别',input.project_expense_category,categories);
  if(!category) {
    const allowedPairs=pairs.filter(p=>categories.some(c=>C.normalized(c)===C.normalized(p.category)));
    C.check(allowedPairs.length,'PAYMENT_SOURCE_MISSING');
    Object.assign(needs.at(-1),{resolver:'agent_recommendation',
      recommendationContexts:(input.items||[]).map((item,index)=>buildRecommendationContext({scope:'project',
        description:[item.departure,item.destination,item.region,item.remarks].filter(Boolean).join(' / '),pairs:allowedPairs,
        categoryInputKey:'project_expense_category',accountInputKey:'items['+index+'].account'}))});
  }
  return {ready:!!category,pairs,projectRows,projectName,category,projectChoices,categoryChoices:categories};
}
async function buildDetails(input,ctx,fields) {
  const needs=[],project=input.is_project,scoped=await subjectContext(input,ctx,needs);
  let company=null,currency=null,allowanceCurrency=null,editorChoices={};
  const projectPreview=()=>({是否项目:project===undefined?'待确认':project?'是':'否',
    ...(project?{项目:input.project_name||'',项目费用类别:input.project_expense_category||''}:{})});
  const empty=()=>({rows:[],needsInput:needs,recommendationContexts:[],editorChoices,
    preview:{...(scoped?{报销人:scoped.subject.name||scoped.subject.userid}:{}),
      支付公司:company||'',报销币种:currency,餐补币种:allowanceCurrency,...projectPreview(),报销明细:[]},
    detailReviewContract:contract(project,scoped?.subject,[],allowanceCurrency,fields,{paymentCompany:company})});
  if(!scoped) return empty();
  const subject=scoped.subject;
  const payment=await resolveReimbursementContext({input,ctx:scoped,needs,
    companySource:source('employeePaymentCompanies'),currencySource:source('currencies')});
  ({company,currency}=payment);
  allowanceCurrency=currency?(rules.allowanceCurrency.byReimbursementCurrency[currency]??rules.allowanceCurrency.otherwise):null;
  editorChoices={claimant_user_id:[{value:subject.userid,label:subject.name||subject.userid}],
    payment_company:payment.companyChoices,reimbursement_currency:payment.currencyChoices,
    is_project:[{value:true,label:'项目'},{value:false,label:'非项目'}],
    same_bearing_company:[{value:true,label:'是'},{value:false,label:'否'}]};
  C.check(project!==false||['project_name','project_expense_category'].every(k=>C.absent(input[k])),'TRIP_REIMBURSEMENT_INPUT_CONFLICT');
  if(project===undefined) needs.push({field:'is_project',message:'本次报销是否属于项目？如是，请选择所属项目。',
    choices:editorChoices.is_project});
  if(!input.items?.length) needs.push({field:'items',message:'请提供本次行程及费用材料。'});
  if(!company||!currency||project===undefined||!input.items?.length) return empty();
  const table=fields.get(F.items).props;
  C.check(input.items.length>=(table.minItems??1)&&input.items.length<=(table.maxItems??50),'TRIP_REIMBURSEMENT_INPUT_INVALID');
  const scope=await projectScope(input,scoped,needs),pd=source('projectDepartments');
  const recommendationContexts=[];
  const classifications=project&&scope.ready?Finance.accountSelections(
    {items:input.items.map(item=>({...item,description:[item.departure,item.destination,item.region,item.remarks].filter(Boolean).join(' / ')}))},
    scope.pairs,needs,scope.category,recommendationContexts):[];
  const regionSource=source('regions'),regions=distinctValues(await query(scoped,'regions',{},[regionSource.nameField]),regionSource.nameField);
  const currencySource=source('originalCurrencies'),originalCurrencies=distinctValues(
    await query(scoped,'originalCurrencies',{},[currencySource.currencyField]),currencySource.currencyField);
  const assoc=policy.relatedSources.trip;
  let related=[];
  if(!rules.associationOptionalUsers.includes(subject.userid)||input.items.some(item=>item.trip_instance_id)) {
    related=Association.validateCandidates(await scoped.related('trip'),{...assoc,appType:companyConfig.appType,
      formUuid:assoc.form,actorId:subject.userid,corpId:subject.corp_id});
  }
  Object.assign(editorChoices,{'items[*].region':regions,'items[*].original_currency':originalCurrencies,
    'items[*].trip_instance_id':related.map(candidate=>({value:candidate.instance_id,
      label:[candidate.title,candidate.sub_title].filter(Boolean).join(' · ')})),
    ...(project?{project_name:scope.projectChoices||[],project_expense_category:scope.categoryChoices||[],
      'items[*].project_department_name':distinctValues(scope.projectRows,pd.nameField),
      'items[*].account':scope.pairs.filter(pair=>C.normalized(pair.category)===C.normalized(scope.category))
        .map(pair=>pair.account)}:{})});
  const rate=createRateResolver({ctx:scoped,source:source('rates'),ratePrecision:rules.ratePrecision,
    errorCode:'REIMBURSEMENT_RATE_INVALID',errorMessage:'报销所需汇率未唯一配置，请联系 Finance。'});
  const rows=[],allowanceInputs=[],ranges=[];
  for(const [index,item] of input.items.entries()) {
    const prefix='items['+index+'].',row={category:scope.category??null,account:project?classifications[index]?.account??null:rules.fixedAccount,
      remarks:bounded(item.remarks,F.remark,fields),allowanceCurrency};
    for(const [inputKey,field] of [['departure',F.departure],['destination',F.destination]]) {
      row[inputKey]=bounded(item[inputKey],field,fields);
      if(!row[inputKey]) needs.push({field:prefix+inputKey,message:'请补充第 '+(index+1)+' 行'+(inputKey==='departure'?'出发地':'目的地')+'。'});
    }
    row.region=Finance.choice(needs,prefix+'region','出差地区',item.region,regions)||null;
    row.startDate=item.start_date||null;row.endDate=item.end_date||item.start_date||null;
    let range=null;
    if(row.startDate&&row.endDate) {
      range=C.inputRange({start_date:row.startDate,end_date:row.endDate});
      row.days=(range.end-range.start)/C.DAY+1;
    } else {row.days=null;needs.push({field:prefix+'start_date',message:'请补充第 '+(index+1)+' 行的出差日期。'});}
    ranges.push(range);
    const selected=item.trip_instance_id?related.find(candidate=>candidate.instance_id===item.trip_instance_id):null;
    C.check(!item.trip_instance_id||!!selected,'RELATED_SELECTION_INVALID','所选出差单不属于该报销人，或尚未完成并同意，请重新选择。');
    if(!selected&&!rules.associationOptionalUsers.includes(subject.userid))
      needs.push({field:prefix+'trip_instance_id',message:'请选择该报销人已完成并同意的出差申请。',
        choices:related.map(candidate=>({value:candidate.instance_id,label:[candidate.title,candidate.sub_title].filter(Boolean).join(' · ')}))});
    row.trip=selected?selected.title+(selected.sub_title?' · '+selected.sub_title:''):'';row.tripId=selected?.instance_id??null;
    row.tripReference=selected?Association.processReference(selected):null;row.tripNumber=selected?.title||'';
    for(const name of Object.keys(costs)) row[name]=money(item[name]);
    row.originalCurrency=Finance.choice(needs,prefix+'original_currency','本行费用原币种',item.original_currency,originalCurrencies)||null;
    row.rate=currency&&row.originalCurrency?await rate(row.originalCurrency,currency):null;
    row.reimbursedAmount=row.rate===null?null:convertAmount(sum(Object.keys(costs).map(name=>row[name]??0)),row.rate,rules.precision);
    row.allowanceStandard=null;
    if(allowanceCurrency&&row.region) {
      const as=source('allowances'),standards=distinctValues(await query(scoped,'allowances',
        {[as.regionField]:row.region,[as.currencyField]:allowanceCurrency},[as.standardField]),as.standardField);
      C.check(standards.length<=1,'TRAVEL_ALLOWANCE_SOURCE_INVALID','该地区及餐补币种的餐补标准存在歧义，请联系 Finance。');
      row.allowanceStandard=standards.length?money(standards[0]):null;
    }
    if(project&&scope.ready) {
      row.projectDepartment=Finance.choice(needs,prefix+'project_department_name','本行项目部门',item.project_department_name,distinctValues(scope.projectRows,pd.nameField))||null;
      if(row.projectDepartment) {
        const ids=distinctValues(scope.projectRows.filter(r=>C.exact(r[pd.nameField],row.projectDepartment)),pd.departmentIdField);
        C.check(ids.length===1&&/^\d+$/.test(ids[0]),'PAYMENT_PROJECT_DEPARTMENT_AMBIGUOUS');row.projectDepartmentId=ids[0];
        const values=await lines(scoped,fields,needs,item,ids[0],['projectStructure','projectLine','projectSubline'],prefix,editorChoices);
        row.structure=values[F.projectStructure]??null;row.line=values[F.projectLine]??null;row.subline=values[F.projectSubline]??null;
      } else Object.assign(row,{structure:null,line:null,subline:null});
    } else if(!project) C.check(['project_department_name','business_structure','business_line','business_subline','account']
      .every(name=>C.absent(item[name])),'TRIP_REIMBURSEMENT_INPUT_CONFLICT');
    // Preserve complete real itinerary dates. The allowance planner allocates
    // shared dates to the arriving segment before handling currency-split rows.
    const segmentKey=JSON.stringify([row.tripId,...[row.departure,row.destination,row.region].map(C.normalized),
      range?.start??null,range?.end??null]);
    allowanceInputs.push({...range,segmentKey,region:row.region,standard:row.allowanceStandard,preferred:row.originalCurrency===allowanceCurrency,
      ...(Object.hasOwn(item,'allowance_amount')?{amount:item.allowance_amount}:{})});
    rows.push(row);
  }
  const known=allowanceInputs.map((entry,index)=>({entry,index})).filter(({index})=>ranges[index]);
  const plan=suggestAllowances(known.map(({entry})=>entry),{precision:rules.precision});
  for(const [position,{index}] of known.entries()) {
    const planned=plan.rows[position],row=rows[index];
    row.allowanceDays=planned.eligibleDays;
    row.allowanceAmount=C.absent(planned.amount)?null:money(planned.amount);
    row.allowanceAllocation=planned.sharedDays.map(range=>({
      startDate:C.dateText(range.start),endDate:C.dateText(range.end),itemIndex:known[range.index].index}));
    if(!planned.explicit&&planned.eligibleDays>0&&row.allowanceStandard===null)
      needs.push({field:'items['+index+'].allowance_amount',message:'该地区及餐补币种缺少餐补标准，无法计算建议；请 Finance 核查，或明确本次实际申领金额（可填0）。'});
  }
  rows.forEach(row=>{if(row.allowanceDays===undefined)Object.assign(row,{allowanceDays:null,allowanceAmount:null});});
  for(const conflict of plan.conflicts) {
    const indexes=conflict.indexes.map(position=>known[position].index);
    needs.push({field:'items['+indexes[0]+'].allowance_amount',message:'第 '+indexes.map(i=>i+1).join('、')+
      ' 行属于同一行程段，请保留一处餐补申领，其他币种拆行填0。',
      indexes,resolver:'clarify_allowance_allocation'});
  }
  const reviewContract=contract(project,subject,rows,allowanceCurrency,fields,
    {paymentCompany:company,projectName:scope.projectName??null,projectCategory:project?scope.category??null:null});
  const preview={报销人:subject.name||subject.userid,...(subject.delegated?{实际发起人:ctx.actor.name||ctx.actor.userid}:{}),
    支付公司:company||'',报销币种:currency,餐补币种:allowanceCurrency,...projectPreview(),
    ...(project?{项目:scope.projectName||input.project_name||'',项目费用类别:scope.category||input.project_expense_category||''}:{}),
    报销明细:displayRows(rows,reviewContract),
    餐补分配说明:rows.flatMap((row,index)=>(row.allowanceAllocation||[]).map(range=>'第 '+(index+1)+' 行的 '+
      range.startDate+(range.endDate!==range.startDate?' 至 '+range.endDate:'')+' 餐补归第 '+(range.itemIndex+1)+' 行到达段，按该段地区标准建议。')),
    报销总额:rows.every(row=>row.reimbursedAmount!==null)?sum(rows.map(row=>row.reimbursedAmount)):null,
    餐补总额:rows.some((row,index)=>row.allowanceAmount===null&&!Object.hasOwn(input.items[index],'allowance_amount'))
      ?null:sum(rows.map(row=>row.allowanceAmount??0))};
  return {rows,needsInput:needs,preview,detailReviewContract:reviewContract,recommendationContexts,editorChoices,
    scoped,subject,company,currency,allowanceCurrency,scope,rate,ranges};
}
async function details(input,ctx) {
  validateInput(input);
  const result=await buildDetails(input,ctx,schemaFields(await ctx.schema()));
  return {rows:result.rows,needsInput:result.needsInput,preview:result.preview,detailReviewContract:result.detailReviewContract,
    recommendationContexts:result.recommendationContexts,editorChoices:result.editorChoices};
}
function departmentSelection(input,roster,needs,editorChoices) {
  const ids=C.rosterDepartmentIds(roster);
  const names=(roster.get(R.departmentNames)||[]).flatMap(row=>C.values(row.label??row.value))
    .flatMap(v=>v.split(/[,，|]/)).map(v=>v.trim());
  if(editorChoices&&names.length===ids.length&&names.every(Boolean))
    editorChoices.department_id=ids.map((value,index)=>({value,label:names[index]}));
  let selected=input.department_id;
  if(input.department_name!==undefined||!selected&&ids.length>1) {
    C.check(names.length===ids.length&&names.every(Boolean),'ROSTER_FIELD_MISSING');
    const choices=ids.map((value,index)=>({value,label:names[index]}));
    const matches=choices.filter(d=>C.normalized(d.label)===C.normalized(input.department_name));
    if(selected) C.check(input.department_name===''||matches.some(d=>d.value===selected),'TRIP_REIMBURSEMENT_INPUT_CONFLICT');
    else if(input.department_name&&matches.length===1) selected=matches[0].value;
    else {needs.push({field:'department_id',message:'请选择报销人的任职部门。',choices:matches.length?matches:choices});return null;}
  }
  const department=C.department(roster,selected);
  return {id:department.id,name:names[ids.indexOf(department.id)]||''};
}
function bankInput(input,previous,subjectId) {
  const effective={...input},ignored={...(previous?.ignoredBankInputs||{})};
  if(previous?.claimantUserId&&previous.claimantUserId!==subjectId) {
    for(const name of Object.keys(bankFields)) if(Object.hasOwn(input,name)
      &&input[name]===previous.bankInput?.[name]) ignored[name]=input[name];
  }
  for(const [name,value] of Object.entries(ignored)) {
    if(input[name]===value) delete effective[name];else delete ignored[name];
  }
  return {effective,ignored};
}
async function prepare(input,ctx) {
  validateInput(input);const actor=C.identity(ctx),fields=schemaFields(await ctx.schema()),result=await buildDetails(input,ctx,fields);
  if(result.needsInput.length) return {needsInput:result.needsInput,preview:result.preview,editorChoices:result.editorChoices};
  const {scoped,subject,company,currency,allowanceCurrency,scope,rate,rows}=result,needs=[],project=input.is_project;
  const same=input.same_bearing_company??true;
  C.option(fields,F.isProject,project?'NORMAL':'HIDDEN',['HIDDEN','NORMAL']);
  C.option(fields,F.sameBearing,same?'HIDDEN':'NORMAL',['HIDDEN','NORMAL']);
  const rosterResponse=await scoped.roster(policy.rosterFields),roster=C.rosterFields(rosterResponse,subject);
  const originalBankInput=Object.fromEntries(Object.keys(bankFields).filter(name=>Object.hasOwn(input,name)).map(name=>[name,input[name]]));
  const reference=await PaymentHistory.resolvePaymentHistory({input,ctx,actor,subject,roster:rosterResponse,
    rosterAccountNameField:R.accountName,sources:policy.relatedSources,appType:companyConfig.appType,
    requiredFields:Object.entries(bankFields).filter(([,field])=>C.required(fields,F[field])).map(([name])=>name),
    previous:ctx.workflowState?.paymentHistory});
  if(reference.needsInput.length)return {needsInput:reference.needsInput,code:reference.code,
    workflowState:{...(ctx.workflowState||{}),paymentHistory:reference.state}};
  input=reference.input;
  const historyState=reference.state===null&&!ctx.workflowState?.paymentHistory?{}:{paymentHistory:reference.state};
  const previous=ctx.workflowState,bank=bankInput(input,previous,subject.userid);
  const payment=personalPaymentDefaults({actor:subject,input:bank.effective,roster:rosterResponse,
    previous:previous?.claimantUserId===subject.userid?previous.bankDefaults:undefined,
    fields:Object.fromEntries(Object.entries(bankFields).map(([inputKey,fieldKey])=>[inputKey,R[fieldKey]])),stringFields:['bank_account']});
  const workflowState={claimantUserId:subject.userid,bankDefaults:payment.state,ignoredBankInputs:bank.ignored,
    bankInput:originalBankInput,...historyState};
  const pause=()=>({needsInput:needs,workflowState,editorChoices:result.editorChoices}),formData={};
  for(const [inputKey,fieldKey] of Object.entries(bankFields)) {
    formData[F[fieldKey]]=bounded(payment.values[inputKey],F[fieldKey],fields);
    if(!formData[F[fieldKey]]&&C.required(fields,F[fieldKey])) needs.push({field:inputKey,message:'请补充报销人的'+bankLabels[inputKey]+'。'});
  }
  const dept=departmentSelection(input,roster,needs,result.editorChoices);if(!dept)return pause();
  const cache=new Map();
  async function department(id) {
    if(cache.has(id))return cache.get(id);
    C.check(/^\d+$/.test(id)&&Number.isSafeInteger(Number(id)),'DEPARTMENT_ID_INVALID');
    const response=await scoped.invoke('departmentDetails',{'Content-Type':'application/json',Body:{dept_id:Number(id)}});
    const normalized=Department.normalizeDepartmentDetails(response,{departmentId:id});
    const value={manager:Department.departmentManagerAt(normalized,rules.managerIndex),name:response.result.name};
    cache.set(id,value);return value;
  }
  const selectedDepartment=await department(dept.id);
  Object.assign(formData,{[F.applicant]:[subject.userid],[F.applicantId]:subject.userid,[F.initiatorId]:actor.userid,
    [F.applicationDate]:ctx.todayMs,[F.departmentId]:dept.id,[F.departmentName]:selectedDepartment.name||dept.name,
    [F.departmentTransition]:dept.id,[F.businessDepartment]:dept.id,[F.manager]:selectedDepartment.manager?[selectedDepartment.manager]:[],
    [F.applicantIsManager]:String(selectedDepartment.manager===subject.userid),[F.office]:optionalRoster(roster,R.office),
    [F.positionLevel]:optionalRoster(roster,R.positionLevel,'label'),[F.hasBankAccount]:rules.defaults[F.hasBankAccount],
    [F.projectActive]:rules.defaults[F.projectActive],[F.sameBearing]:same?'HIDDEN':'NORMAL',[F.isProject]:project?'NORMAL':'HIDDEN',
    [F.paymentCompany]:company,[F.paymentCompanyMirror]:company,[F.currency]:currency,[F.allowanceCurrency]:allowanceCurrency});
  C.check(selectedDepartment.manager||!C.required(fields,F.manager),'DEPARTMENT_MANAGER_MISSING');
  const cs=source('companies'),companyRows=await query(scoped,'companies',same?{[cs.companyField]:company}:{},[cs.companyField]);
  result.editorChoices.bearing_company=distinctValues(companyRows,cs.companyField);
  if(same) {
    C.check(input.bearing_company===undefined||C.normalized(input.bearing_company)===C.normalized(company),'TRIP_REIMBURSEMENT_INPUT_CONFLICT');
    const options=distinctValues(companyRows,cs.companyField);
    C.check(options.length||!C.required(fields,F.bearingCompany),'PAYMENT_SOURCE_MISSING');
    formData[F.bearingCompany]=options.length?C.single(options):'';
  } else formData[F.bearingCompany]=Finance.choice(needs,'bearing_company','承担公司',input.bearing_company,
    distinctValues(companyRows,cs.companyField),C.required(fields,F.bearingCompany));
  Object.assign(formData,await lines(scoped,fields,needs,input,dept.id,['structure','line','subline'],'',result.editorChoices));
  if(needs.length)return pause();
  if(project)Object.assign(formData,{[F.project]:scope.projectName,[F.projectCategory]:scope.category});
  const hkd=rules.defaults[F.hkd],hkdRate=await rate(currency,hkd),
    allowanceHkdRate=await rate(allowanceCurrency,hkd),nativeRows=[],departmentIds=[],managers=[];
  for(const [index,row] of rows.entries()) {
    const range=result.ranges[index],native={[F.departure]:row.departure,[F.destination]:row.destination,[F.region]:row.region,
      [F.dateRange]:[range.start,range.end],[F.days]:row.days,[F.originalCurrency]:row.originalCurrency,[F.originalRate]:row.rate,
      [F.reimbursedAmount]:row.reimbursedAmount,[F.hkd]:hkd,[F.hkdRate]:hkdRate,
      [F.hkdAmount]:convertAmount(row.reimbursedAmount,hkdRate,rules.precision),
      [F.allowanceHkdAmount]:convertAmount(row.allowanceAmount??0,allowanceHkdRate,rules.precision),
      [F.tripAssociationText]:row.tripNumber,[F.remark]:row.remarks};
    for(const name of Object.keys(costs)) if(row[name]!==null) native[F[costs[name]]]=row[name];
    if(row.allowanceStandard!==null)native[F.allowanceStandard]=row.allowanceStandard;
    if(row.allowanceAmount!==null)native[F.allowanceAmount]=row.allowanceAmount;
    if(row.tripReference)native[F.tripAssociation]=[row.tripReference];
    if(project) {
      Object.assign(native,{[F.projectDepartmentName]:row.projectDepartment,[F.projectDepartmentId]:row.projectDepartmentId,
        [F.projectStructure]:row.structure,[F.projectLine]:row.line,[F.projectSubline]:row.subline,[F.projectAccount]:row.account});
      departmentIds.push(row.projectDepartmentId);const d=await department(row.projectDepartmentId);
      if(d.manager&&!managers.includes(d.manager))managers.push(d.manager);
    } else Object.assign(native,{[F.expenseCategory]:rules.fixedCategory,[F.account]:rules.fixedAccount});
    nativeRows.push(native);
  }
  Object.assign(formData,{[F.items]:nativeRows,[F.total]:sum(rows.map(row=>row.reimbursedAmount)),
    [F.hkdTotal]:sum(nativeRows.map(row=>row[F.hkdAmount])),[F.allowanceTotal]:sum(rows.map(row=>row.allowanceAmount??0)),
    [F.allowanceHkdTotal]:sum(nativeRows.map(row=>row[F.allowanceHkdAmount])),[F.projectManagers]:managers,
    [F.projectDepartmentAggregate]:project?JSON.stringify(departmentIds):'',[F.description]:bounded(input.description,F.description,fields)});
  C.check(!project||managers.length||!C.required(fields,F.projectManagers),'DEPARTMENT_MANAGER_MISSING');
  const contact=source('contacts');
  for(const [field,column] of [[F.finance,contact.financeField],[F.cashier,contact.cashierField]]) {
    const people=await C.contacts(scoped,{form:contact.formUuid,key:contact.companyField,admin:column},company,{required:C.required(fields,field)});
    formData[field]=people.ids;
  }
  // Native start dept belongs to the authenticated originator, not an impersonated claimant.
  const originatorDepartment=subject.delegated
    ?C.department(C.rosterFields(await ctx.roster([R.mainDepartment,R.departments]),actor)).id:dept.id;
  return {formData,departmentId:originatorDepartment,workflowState,attachmentField:F.attachment,
    attachmentPreviewField:config.attachments.previewField,detailReviewContract:result.detailReviewContract,detailReviewRows:rows,
    recommendationContexts:result.recommendationContexts,editorChoices:result.editorChoices,
    verification:{optionalEmptyFields:Object.entries(formData).filter(([field,value])=>!C.required(fields,field)
      &&(value===''||Array.isArray(value)&&!value.length)).map(([field])=>field),
      enumLabels:{[F.isProject]:{HIDDEN:'否',NORMAL:'是'},[F.sameBearing]:{HIDDEN:'是',NORMAL:'否'}}},
    preview:{流程:title,...result.preview,申请日期:ctx.today,申请部门:formData[F.departmentName],承担公司:formData[F.bearingCompany],
      业务总架构:formData[F.structure],业务线:formData[F.line],子业务线:formData[F.subline],
      收款资料:Object.fromEntries(Object.entries(bankFields).map(([inputKey,fieldKey])=>[bankLabels[inputKey],formData[F[fieldKey]]])),
      ...(reference.preview?{收款历史参考:reference.preview}:{}),...(reference.notice?{收款资料提示:reference.notice}:{}),
      是否项目:project?'是':'否',...(project?{项目:scope.projectName,项目费用类别:scope.category}:{}),说明:formData[F.description]}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,detailReview:true,details,prepare};

