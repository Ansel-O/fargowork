'use strict';
const {FORM,TABLES,RELATIONS,F,fail,text,required,unique,same,choose,choosePair,rows,rosterValues,date,decimal,calculations}=require('./payment-core.cjs');
const sources=require('./payment-sources.cjs');
const rosterFields=['sys00-workPlace','sys00-mainDeptId','sys00-deptIds','sys05-contractCompanyName'];
const policy={dataForms:Object.values(TABLES).map(t=>t[0]),rosterFields,connectors:{department:{connectorId:'Http_75b8f8aef03c4b40815462052ba21a13',actionId:'operation-1',type:'httpConnector',connection:15624}}};
const requirements={
  required:['is_project','latest_payment_date','items'],
  choices:['payment_company','currency','supplier_name','supplier_expense_category','supplier_account'],
  optional:['description','department_id','bank_account','bank_name','include_contract','contract_instance_id','include_seal','seal_instance_id'],
  project:['project_name','project_department_id','project_expense_category'],
  items:{required:['description','amount'],optional:['expense_category','account','remarks']},
  attachments:{required:true,input:'attachments: [绝对文件路径]',maxFiles:9,maxFileSizeMiB:20,extensions:['.pdf','.png','.jpg','.docx','.xlsx']},
  note:'公司、币种、供应商、科目、项目和关联流程由当前维护数据提供候选。合同公司及主部门可作为预览中的默认建议；不自动替换员工明确提供的选择。',
};
const allowed=new Set([...requirements.required,...requirements.choices,...requirements.optional,...requirements.project,
  ...['application','project'].flatMap(p=>['business_architecture','business_line','sub_business_line'].map(k=>p+'_'+k))]);
function validate(input){
  if(!input||typeof input!=='object'||Array.isArray(input))fail('FW-PAY-INPUT','付款输入须为对象。');
  for(const [k,v]of Object.entries(input)){
    if(!allowed.has(k))fail('FW-PAY-INPUT-FIELD','仅接受已声明的付款业务输入，不能指定身份、表单或原始字段。');
    if(v===null)fail('FW-PAY-INPUT-TYPE','付款输入不接受 null，请省略未提供的字段。');
    if(['is_project','include_contract','include_seal'].includes(k)){if(typeof v!=='boolean')fail('FW-PAY-INPUT-TYPE');}
    else if(k==='items'){if(!Array.isArray(v)||v.length>100)fail('FW-PAY-ITEMS','付款明细须为不超过 100 行的数组。');}
    else if(typeof v!=='string')fail('FW-PAY-INPUT-TYPE');
  }
  for(const row of input.items||[]){
    if(!row||typeof row!=='object'||Array.isArray(row)||Object.keys(row).some(k=>!['description','amount','expense_category','account','remarks'].includes(k)))fail('FW-PAY-ITEM-FIELD');
    for(const k of ['description','expense_category','account','remarks'])if(row[k]!==undefined&&typeof row[k]!=='string')fail('FW-PAY-ITEM-TYPE');
    if(row.amount!==undefined&&row.amount!=='')decimal(row.amount);
  }
}

async function prepare(input,ctx){
  validate(input);
  const needs=[];
  if(typeof input.is_project!=='boolean')needs.push({field:'is_project',message:'这笔付款是否属于项目？'});
  const paymentDate=date(input.latest_payment_date);
  if(paymentDate===null)needs.push({field:'latest_payment_date',message:'请提供有效的最晚付款日期（YYYY-MM-DD）。'});
  if(!input.items?.length)needs.push({field:'items',message:'请提供至少一行付款明细。'});
  for(const [i,row]of(input.items||[]).entries()){
    if(!text(row.description))needs.push({field:`items[${i}].description`,message:'请提供本行付款内容。'});
    if(row.amount===undefined||row.amount==='')needs.push({field:`items[${i}].amount`,message:'请提供本行付款金额。'});
  }
  if(needs.length)return {needsInput:needs};
  if(!ctx.actor?.userid||!ctx.actor?.corp_id||!Number.isSafeInteger(ctx.todayMs)||ctx.todayMs<=0)fail('FW-PAY-IDENTITY');
  const roster=await ctx.roster(rosterFields);
  if(!roster||String(roster.userid??roster.userId)!==ctx.actor.userid)fail('FW-PAY-IDENTITY');
  const workplace=rosterValues(roster,'sys00-workPlace',true)[0],main=rosterValues(roster,'sys00-mainDeptId')[0],departments=rosterValues(roster,'sys00-deptIds'),contractCompany=rosterValues(roster,'sys05-contractCompanyName',true)[0];
  if(!workplace||!main||!departments.includes(main))fail('FW-PAY-PROFILE');
  const departmentId=input.department_id||main;
  if(!departments.includes(departmentId))fail('FW-PAY-DEPARTMENT-NOT-ASSIGNED','发起部门必须是本人当前任职部门。');
  const dept=await sources.department(ctx,departmentId,F.manager);
  const formData={[F.applicant]:[ctx.actor.userid],[F.applicantId]:ctx.actor.userid,[F.applyDate]:ctx.todayMs,[F.workplace]:workplace,[F.bankFlag]:'是',[F.departmentId]:departmentId,[F.department]:dept.name,[F.isProject]:input.is_project?'NORMAL':'HIDDEN',[F.latestDate]:paymentDate,[F.latestDateText]:input.latest_payment_date};
  if(input.description!==undefined)formData[F.description]=input.description;
  const resolved={...input,department_id:departmentId};
  const [,companyName,bankFlag]=TABLES.companies;
  const companyOptions=(await rows(ctx,'companies',{[bankFlag]:'是'})).filter(r=>text(r[bankFlag])==='是').map(r=>required(r[companyName],'FW-PAY-COMPANY'));
  const defaults=companyOptions.filter(v=>contractCompany&&same(v,contractCompany));
  const company=choose(needs,'payment_company',input.payment_company||([...new Set(defaults)].length===1?defaults[0]:undefined),companyOptions,true);
  let currency=null;
  if(company){
    const [,cf,currencyField]=TABLES.currencies;
    currency=choose(needs,'currency',input.currency,(await rows(ctx,'currencies',{[cf]:company})).filter(r=>same(r[cf],company)).map(r=>required(r[currencyField],'FW-PAY-CURRENCY')),true);
    Object.assign(formData,{[F.company]:company,[F.companyMirror]:company,[F.bearing]:company,[F.bearingMatch]:'HIDDEN'});resolved.payment_company=company;
    if(currency){formData[F.currency]=currency;resolved.currency=currency;}
  }
  const [,supplierName,bankAccount,bankName]=TABLES.suppliers;
  const supplier=choose(needs,'supplier_name',input.supplier_name,(await rows(ctx,'suppliers',{},[supplierName])).map(r=>required(r[supplierName],'FW-PAY-SUPPLIER')),true);
  if(supplier){
    const profile=unique(await rows(ctx,'suppliers',{[supplierName]:supplier}),r=>same(r[supplierName],supplier),'FW-PAY-SUPPLIER-AMBIGUOUS');
    formData[F.supplier]=supplier;resolved.supplier_name=supplier;
    for(const [key,source,field]of[['bank_account',bankAccount,F.bankAccount],['bank_name',bankName,F.bankName]]){
      const value=input[key]!==undefined?input[key]:profile[source];
      if(value!==undefined&&value!==null){if(typeof value!=='string')fail('FW-PAY-BANK-SOURCE');formData[field]=value;}
    }
    const [,sf,cat,acc]=TABLES.supplierPairs;
    const pairs=(await rows(ctx,'supplierPairs',{[sf]:supplier})).filter(r=>same(r[sf],supplier)).map(r=>[required(r[cat]),required(r[acc])]);
    const selected=choosePair(needs,'supplier_expense_category','supplier_account',input.supplier_expense_category,input.supplier_account,pairs);
    if(selected){formData[F.supplierCategory]=selected[0];formData[F.supplierAccount]=selected[1];resolved.supplier_expense_category=selected[0];resolved.supplier_account=selected[1];}
  }
  let project=null;
  if(input.is_project){project=await sources.project(ctx,input,needs);if(project){Object.assign(formData,{[F.project]:project.name,[F.projectDepartment]:project.department.name,[F.projectDepartmentId]:project.department.id,[F.projectCategory]:project.category});if(project.department.manager)formData[F.projectManager]=[project.department.manager];Object.assign(resolved,{project_name:project.name,project_department_id:project.department.id,project_expense_category:project.category});}}
  if(dept.manager)formData[F.manager]=[dept.manager];
  let itemPairs=[];
  if(!input.is_project||project){
    const [,category,account]=TABLES.accounts;
    const catalog=(await rows(ctx,'accounts',project?{[category]:project.category}:{})).filter(r=>!project||text(r[category])===project.category).map(r=>[required(r[category]),required(r[account])]);
    itemPairs=input.items.map((r,i)=>choosePair(needs,`items[${i}].expense_category`,`items[${i}].account`,r.expense_category,r.account,catalog,project?.category));
  }
  if(needs.length)return {needsInput:needs};
  const contexts=[['application',departmentId,F.applicationStructure],...(project?[['project',project.department.id,F.projectStructure]]:[])];
  const structures={};
  for(const [prefix,id,fields]of contexts){const s=await sources.structure(ctx,input,prefix,id,needs);if(s){fields.forEach((field,i)=>{formData[field]=s[i];});structures[prefix]=s;['business_architecture','business_line','sub_business_line'].forEach((k,i)=>{resolved[prefix+'_'+k]=s[i];});}}
  const associated=await sources.relations(ctx,input,needs);
  if(needs.length)return {needsInput:needs};
  Object.assign(formData,associated.formData);
  const contacts=await sources.contacts(ctx,company),warnings=[];
  if(!dept.manager)warnings.push('申请部门连接器未返回主管，按当前表单规则保持为空。');
  if(project&&!project.department.manager)warnings.push('项目部门连接器未返回主管，按当前表单规则保持为空。');
  for(const [role,field,label]of[['finance',F.finance,'财务'],['cashier',F.cashier,'出纳']]){if(contacts[role].length)formData[field]=contacts[role];else warnings.push(`该支付公司未配置${label}，本次未填。`);}
  const [,from,to,value]=TABLES.rates;
  const rate=unique(await rows(ctx,'rates',{[from]:currency,[to]:'HKD'}),r=>same(r[from],currency)&&text(r[to])==='HKD','FW-PAY-RATE-AMBIGUOUS');
  const calc=calculations(input.items.map(r=>r.amount),rate[value]);
  formData[F.items]=input.items.map((row,i)=>{
    const out={[F.itemDescription]:row.description,[F.itemAmount]:calc.amounts[i],[F.itemHKD]:'HKD',[F.itemRate]:calc.rate,[F.itemHKDAmount]:calc.converted[i]};
    if(row.remarks!==undefined)out[F.itemRemarks]=row.remarks;
    if(project)out[F.itemProjectAccount]=itemPairs[i][1];else{out[F.itemCategory]=itemPairs[i][0];out[F.itemAccount]=itemPairs[i][1];}
    return out;
  });
  formData[F.total]=calc.total;formData[F.hkdTotal]=calc.hkdTotal;
  resolved.items=input.items.map((r,i)=>({...r,expense_category:itemPairs[i][0],account:itemPairs[i][1]}));
  return {formData,departmentId,attachmentField:F.attachment,resolvedInputs:resolved,preview:{
    流程:'对外付款申请',申请人:ctx.actor.name||ctx.actor.userid,申请日期:ctx.today,发起部门:dept.name,办公场所:workplace,
    支付公司:company,承担公司:company,币种:currency,供应商:supplier,银行账户:formData[F.bankAccount]||'',开户行:formData[F.bankName]||'',供应商费用类别:formData[F.supplierCategory],供应商科目:formData[F.supplierAccount],
    是否项目:input.is_project,项目:project?{名称:project.name,部门:project.department.name,费用类别:project.category}:null,
    最晚付款日期:input.latest_payment_date,付款说明:input.description||'',明细:resolved.items.map((r,i)=>({...r,amount:calc.amounts[i],amount_hkd:calc.converted[i]})),原币合计:calc.total,港币合计:calc.hkdTotal,汇率:calc.rate,
    业务架构:structures,关联流程:associated.preview,提示:warnings,计算方式:'每行港币金额按金额×汇率四舍五入至两位，再汇总；原币金额汇总后保留两位。',
  }};
}
module.exports={key:'external_expense_request',title:'对外付款申请',formUuid:FORM,policy,requirements,prepare};
