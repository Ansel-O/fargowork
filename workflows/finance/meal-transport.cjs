'use strict';
const C=require('../leave-trip-common.cjs');
const config=require('../../config/workflows/finance/meal_transport.json');
const sources=require('../../config/sources.json');
const companyConfig=require('../../config/company.json');
const PaymentHistory=require('../../shared/payment-history.cjs');
const Department=require('../../shared/department-details.cjs');
const {rounded,mealAmount,sumAmounts}=require('../../shared/finance-calculations.cjs');
const {createRateResolver,convertAmount}=require('../../shared/exchange-rates.cjs');
const {localMinute}=require('../../shared/local-datetime.cjs');
const {resolveReimbursementContext,personalPaymentDefaults}=require('../../shared/reimbursement-info.cjs');
const {matchingRows,distinctValues}=require('../../shared/scoped-catalog.cjs');
const {key,title,target,fields:F,roster:R,policy,rules}=config;
const bankFields={bank_account:'bankAccount',bank_name:'bankName',bank_city:'bankCity',
  bank_branch:'bankBranch',account_name:'accountName'};
const labels={bank_account:'收款账号',bank_name:'开户银行',bank_city:'开户城市',bank_branch:'开户支行',account_name:'账户名称'};
const requirements={required:['items','attendance_attachments'],
  optional:['department_id','payment_company','reimbursement_currency','same_bearing_company','bearing_company','business_structure',
    'business_line','business_subline',...Object.keys(bankFields),'description','expense_attachments',...PaymentHistory.INPUT_FIELDS],
  item:{required:['reason'],optional:['start_time','end_time','transport_amount','remarks'],minimumRows:1,maximumRows:50},
  attachments:{fields:config.attachments.fields.map(f=>({...f,required:f.inputField==='attendance_attachments',maximumCount:20,maximumMiB:100}))},
  notes:['原表开始和结束是含日期/小时/分钟的原生时间组件；业务输入用完整YYYY-MM-DD HH:mm，不截成仅日期或小时。跨零点保留真实次日日期，例如10月21日18:30至10月22日00:25。',
    '未明确开始时间时默认加班当天18:30，可改实际分钟，保留员工明确修改或清空。日期不清先询问，不能拿申请日期代替加班日期；仅有凌晨结束时间时确认跨日的加班日期。结束时间仍默认等于开始时间。',
    '先确定本人支付公司及收款币种：唯一合法组合自动采用，多项询问；再review默认生成MD明细、口述或保存回读后本地重算并确认，不新增项目或科目选择。确认后补主表及两个附件栏，完整申请仍为MD，首轮确认不授权提交。',
    '口述修改回写同一草稿，或保存原MD后告知改好了并用read-edit回读；交通费为员工输入，餐费补贴由原公式计算，不采纳手改公式结果、汇率或合计，用已有公司来源代码重算回写，不要求导出上传。',
    '打卡证明attendance_attachments必填，expense_attachments可选；材料role与materialUploads转换来源独立保留，不混附件栏或用途。',
    '个人收款资料首次带入后可以修改。支付公司只能从本人映射中选择。餐费补贴及后台港币金额自动计算；汇率、固定科目和港币计算隐藏，完整MD预览后等待新的员工确认，24小时内不因普通编辑全量重查。']};
const inputFields=['items','department_id','payment_company','reimbursement_currency','same_bearing_company','bearing_company',
  'business_structure','business_line','business_subline',...Object.keys(bankFields),
  'description','attendance_attachments','expense_attachments',...PaymentHistory.INPUT_FIELDS];

function optionalRoster(map,field,prefer='value') {
  const rows=map.get(field);
  if(!rows?.length || rows.every(row=>C.absent(row.value)&&C.absent(row.label))) return '';
  return C.rosterValue(map,field,prefer);
}
function textInput(value,field,fields) {
  const result=C.absent(value)?'':C.text(value,'MEAL_INPUT_INVALID');
  const max=Number(fields.get(field).props.maxLength);
  C.check(!Number.isFinite(max)||max<=0||result.length<=max,'MEAL_INPUT_INVALID');
  return result;
}
function choice(needs,field,label,value,choices,required=true) {
  if(!choices.length) {
    C.check(!required,field==='payment_company'?'PAYMENT_COMPANY_NOT_FOUND':'MEAL_SOURCE_MISSING',
      '当前账号暂时未能核对所需的财务资料，请维护者检查读取权限和匹配条件。');
    C.check(C.absent(value),'MEAL_SOURCE_MISSING');return '';
  }
  if(value===undefined && choices.length===1) return choices[0];
  if(value!==undefined && !C.absent(value)) {
    C.check(typeof value==='string','MEAL_INPUT_INVALID');
    const found=choices.find(item=>C.normalized(item)===C.normalized(value));if(found) return found;
  }
  if(!required && value==='') return '';
  needs.push({field,message:`请选择${label}。`,choices});return '';
}
function binding(name) { return sources[config.sources[name]]; }
async function catalog(ctx,name,filters,columns) {
  const source=binding(name);
  return matchingRows(ctx,source.formUuid,filters,columns);
}
function amount(value) { return rounded(value,rules.precision); }
function hkd(value,rate) {return convertAmount(value,rate,rules.precision);}
function sum(values) {return sumAmounts(values,rules.precision);}

function schemaFields(schema) {
  const fields=C.assertFields(schema,F);
  for(const [field,formula] of Object.entries(rules.formulas))
    C.check(fields.get(field).props.formula===formula,'WORKFLOW_SCHEMA_CHANGED');
  for(const [field,expected] of Object.entries(rules.defaults)) {
    const value=fields.get(field).props.value;
    C.check((typeof value==='object'?value?.zh_CN:value)===expected,'WORKFLOW_SCHEMA_CHANGED');
  }
  return fields;
}
function reviewContract(actor,company) {
  return {...config.detailReview,context:{claimantUserId:actor.userid,paymentCompany:company||null}};
}
function visibleRows(rows,contract) {
  return rows.map(row=>Object.fromEntries(contract.columns.map(([key,label])=>[label,row[key]])));
}
async function buildDetails(input,ctx,fields) {
  const actor=ctx.actor,needs=[];
  C.check(typeof actor?.userid==='string'&&actor.userid.trim()
    &&typeof actor?.corp_id==='string'&&actor.corp_id.trim(),'CURRENT_IDENTITY_MISSING');
  const table=fields.get(F.items).props;
  const payment=await resolveReimbursementContext({input,ctx,needs,companySource:binding('employeePaymentCompanies'),
    currencySource:binding('reimbursementCurrencies')}),{company,currency}=payment;
  const editorChoices={payment_company:payment.companyChoices,reimbursement_currency:payment.currencyChoices};
  const empty=()=>({rows:[],nativeRows:[],needsInput:needs,company,currency,editorChoices,
    detailReviewContract:reviewContract(actor,company),preview:{支付公司:company||'',报销币种:currency,加班明细:[],餐补总额:null,交通费总额:null}});
  if(!Array.isArray(input.items)||!input.items.length) {
    needs.push({field:'items',message:'请提供加班起止时间、原因及需要报销的交通费。'});return empty();
  }
  C.check(input.items.length>=(table.minItems??1)&&input.items.length<=(table.maxItems??50),'MEAL_INPUT_INVALID');
  const rows=[],nativeRows=[];
  for(const [index,item]of input.items.entries()) {
    C.inputKeys(item,['start_time','end_time','reason','transport_amount','remarks']);
    const native={},row={startTime:'',endTime:'',reason:textInput(item.reason,F.reason,fields),
      mealAmount:mealAmount(currency,rules.mealAmounts,rules.otherCurrencyMealAmount),
      transportAmount:C.absent(item.transport_amount)?'':amount(item.transport_amount),
      remarks:textInput(item.remarks,F.remark,fields)};
    let start=item.start_time;
    if(!Object.hasOwn(item,'start_time')&&!C.absent(item.end_time)) {
      const end=localMinute(item.end_time,rules.offsetMinutes);
      const candidate=item.end_time.slice(0,10)+' '+rules.defaultStartTime;
      if(localMinute(candidate,rules.offsetMinutes)<=end)start=candidate;
      else needs.push({field:`items[${index}].start_time`,
        message:`请确认第 ${index+1} 行的加班日期；开始时间默认该日18:30，只有凌晨结束时间时无法确定是否属于前一天。`});
    }
    if(!C.absent(start)) {
      native[F.startTime]=localMinute(start,rules.offsetMinutes);row.startTime=start.replace('T',' ');
    }
    const end=item.end_time===undefined?start:item.end_time;
    if(C.absent(end)) needs.push({field:`items[${index}].end_time`,message:`请补充第 ${index+1} 行结束时间（到分钟）。`});
    else {native[F.endTime]=localMinute(end,rules.offsetMinutes);row.endTime=end.replace('T',' ');}
    if(!row.reason)needs.push({field:`items[${index}].reason`,message:`请补充第 ${index+1} 行加班原因。`});
    Object.assign(native,{[F.reason]:row.reason,[F.remark]:row.remarks,[F.mealAmount]:row.mealAmount});
    if(row.transportAmount!=='')native[F.transportAmount]=row.transportAmount;
    nativeRows.push(native);rows.push(row);
  }
  const detailReviewContract=reviewContract(actor,company);
  return {rows,nativeRows,needsInput:needs,company,currency,detailReviewContract,editorChoices,
    preview:{支付公司:company,报销币种:currency,加班明细:visibleRows(rows,detailReviewContract),
      餐补总额:currency===null?null:sum(rows.map(row=>row.mealAmount)),交通费总额:sum(rows.map(row=>row.transportAmount===''?0:row.transportAmount))}};
}
async function details(input,ctx) {
  C.inputKeys(input,inputFields);
  PaymentHistory.validateInput(input);
  const result=await buildDetails(input,ctx,schemaFields(await ctx.schema()));
  return {rows:result.rows,needsInput:result.needsInput,preview:result.preview,detailReviewContract:result.detailReviewContract,editorChoices:result.editorChoices};
}
async function prepare(input,ctx) {
  C.inputKeys(input,inputFields);
  PaymentHistory.validateInput(input);
  const actor=C.identity(ctx),fields=schemaFields(await ctx.schema()),detail=await buildDetails(input,ctx,fields);
  if(detail.needsInput.length)return {needsInput:detail.needsInput,preview:detail.preview,editorChoices:detail.editorChoices};
  const needs=[],{company,currency}=detail;
  const rosterResponse=await ctx.roster(policy.rosterFields);
  const roster=C.rosterFields(rosterResponse,actor);
  const dept=C.department(roster,input.department_id);
  const response=await ctx.invoke('departmentDetails',{'Content-Type':'application/json',Body:{dept_id:Number(dept.id)}});
  const details=Department.normalizeDepartmentDetails(response,{departmentId:dept.id});
  const manager=Department.departmentManagerAt(details,rules.managerIndex);
  const departmentIds=C.rosterDepartmentIds(roster);
  const departmentNames=(roster.get(R.departmentNames)||[]).flatMap(row=>C.values(row.label??row.value))
    .flatMap(value=>value.split(/[,，|]/)).map(v=>v.trim());
  if(departmentIds.length===departmentNames.length&&departmentNames.every(Boolean))
    detail.editorChoices.department_id=departmentIds.map((value,index)=>({value,label:departmentNames[index]}));
  const deptName=typeof response.result.name==='string'&&response.result.name.trim()
    ?response.result.name.trim():departmentIds.length===departmentNames.length?departmentNames[departmentIds.indexOf(dept.id)]:'';
  C.check(deptName,'ROSTER_FIELD_MISSING');
  const name=optionalRoster(roster,R.name)||actor.name||'本人';
  const formData={...rules.defaults,[F.applicant]:[actor.userid],[F.applicantId]:actor.userid,[F.initiatorId]:actor.userid,
    [F.departmentId]:dept.id,[F.departmentName]:deptName,[F.departmentTransition]:dept.id,[F.businessDepartment]:dept.id,
    [F.applicationDate]:ctx.todayMs,[F.manager]:manager?[manager]:[],[F.applicantIsManager]:String(manager===actor.userid),
    [F.contractCompany]:optionalRoster(roster,R.contractCompany),[F.office]:optionalRoster(roster,R.office),
    [F.positionLevel]:optionalRoster(roster,R.positionLevel,'label')};
  if(!manager && C.required(fields,F.manager)) C.fail('DEPARTMENT_MANAGER_MISSING');
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
  for(const [inputKey,fieldKey] of Object.entries(bankFields)) {
    const value=payment.values[inputKey];
    formData[F[fieldKey]]=textInput(value,F[fieldKey],fields);
    if(!value && C.required(fields,F[fieldKey])) needs.push({field:inputKey,message:`请补充${labels[inputKey]}。`});
  }
  const state=()=>({bankDefaults:payment.state,...historyState});
  formData[F.paymentCompany]=company;formData[F.paymentCompanyMirror]=company;
  const same=input.same_bearing_company===undefined?true:input.same_bearing_company;
  C.check(typeof same==='boolean','MEAL_INPUT_INVALID');
  C.option(fields,F.sameBearing,same?'HIDDEN':'NORMAL',['HIDDEN','NORMAL']);
  formData[F.sameBearing]=same?'HIDDEN':'NORMAL';
  const bearing=binding('costBearingCompanies');
  const bearingRows=await catalog(ctx,'costBearingCompanies',same?{[bearing.companyField]:company}:{},[bearing.companyField]);
  detail.editorChoices.bearing_company=distinctValues(bearingRows,bearing.companyField);
  if(same) {
    C.check(input.bearing_company===undefined||C.normalized(input.bearing_company)===C.normalized(company),'MEAL_INPUT_CONFLICT');
    const found=distinctValues(bearingRows,bearing.companyField);formData[F.bearingCompany]=found.length?C.single(found):'';
  } else formData[F.bearingCompany]=choice(needs,'bearing_company','承担公司',input.bearing_company,distinctValues(bearingRows,bearing.companyField),C.required(fields,F.bearingCompany));
  formData[F.currency]=currency;
  const structure=binding('departmentBusinessLines'), filters={[structure.departmentField]:dept.id};
  for(const [inputKey,fieldKey,sourceField,label] of [
    ['business_structure','structure',structure.structureField,'业务总架构'],
    ['business_line','line',structure.lineField,'业务线'],
    ['business_subline','subline',structure.sublineField,'子业务线']]) {
    const rows=await catalog(ctx,'departmentBusinessLines',filters,[sourceField]);
    detail.editorChoices[inputKey]=distinctValues(rows,sourceField);
    const before=needs.length;
    const value=choice(needs,inputKey,label,input[inputKey],distinctValues(rows,sourceField),C.required(fields,F[fieldKey]));
    formData[F[fieldKey]]=value;filters[sourceField]=value;
    if(needs.length>before) return {needsInput:needs,workflowState:state()};
  }
  const exchangeRate=createRateResolver({ctx,source:binding('exchangeRates'),errorCode:'MEAL_RATE_INVALID',
    errorMessage:'报销汇率未唯一配置，请联系 Finance。'});
  const rate=await exchangeRate(currency,rules.defaults[F.hkd]);formData[F.rate]=rate;
  const rows=detail.nativeRows.map(row=>({...row,[F.mealHkd]:hkd(row[F.mealAmount],rate),[F.transportHkd]:hkd(row[F.transportAmount]??0,rate)}));
  if(needs.length) return {needsInput:needs,workflowState:state()};
  formData[F.items]=rows;formData[F.mealTotal]=sum(rows.map(r=>r[F.mealAmount]));
  formData[F.transportTotal]=sum(rows.map(r=>r[F.transportAmount]??0));
  formData[F.mealHkdTotal]=sum(rows.map(r=>r[F.mealHkd]));formData[F.transportHkdTotal]=sum(rows.map(r=>r[F.transportHkd]));
  formData[F.description]=textInput(input.description,F.description,fields);
  const hrSource=binding('companyExecutors'),contactSource=binding('paymentContacts');
  for(const [targetField,source,keyField,valueField,value] of [
    [F.hr,hrSource,hrSource.companyField,hrSource.annualLeaveAdministratorField,formData[F.contractCompany]],
    [F.finance,contactSource,contactSource.companyField,contactSource.financeField,company],
    [F.cashier,contactSource,contactSource.companyField,contactSource.cashierField,company]]) {
    const contacts=value?await C.contacts(ctx,{form:source.formUuid,key:keyField,admin:valueField},value,{required:C.required(fields,targetField)}):{ids:[]};
    formData[targetField]=contacts.ids;
    C.check(contacts.ids.length||!C.required(fields,targetField),'CONTACTS_NOT_FOUND');
  }
  return {formData,departmentId:dept.id,attachmentFields:config.attachments.fields,workflowState:state(),
    editorChoices:detail.editorChoices,
    detailReviewContract:detail.detailReviewContract,detailReviewRows:detail.rows,
    verification:{optionalEmptyFields:Object.entries(formData).filter(([field,value])=>
      !C.required(fields,field)&&(value===''||Array.isArray(value)&&value.length===0)).map(([field])=>field),
      enumLabels:{[F.sameBearing]:{HIDDEN:'是',NORMAL:'否'}}},
    preview:{流程:title,报销人:name,申请部门:deptName,申请日期:ctx.today,支付公司:company,
      承担公司:formData[F.bearingCompany],报销币种:currency,
      业务总架构:formData[F.structure],业务线:formData[F.line],子业务线:formData[F.subline],
      收款资料:Object.fromEntries(Object.entries(bankFields).map(([key,field])=>[labels[key],formData[F[field]]])),
      ...(reference.preview?{收款历史参考:reference.preview}:{}),...(reference.notice?{收款资料提示:reference.notice}:{}),
      加班明细:detail.preview.加班明细,餐补总额:formData[F.mealTotal],交通费总额:formData[F.transportTotal],说明:formData[F.description]}};
}
module.exports={key,title,formUuid:target.formUuid,policy,requirements,detailReview:true,
  materialRoles:config.detailReview.materialRoles,details,prepare};
