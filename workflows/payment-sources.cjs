'use strict';
const {APP,TABLES,RELATIONS,F,fail,text,required,unique,same,choose,rows,memberIds}=require('./payment-core.cjs');
const C=require('./leave-trip-common.cjs');

async function targetRequired(ctx,fieldId){
  const field=C.fields(await ctx.schema()).get(fieldId);
  if(!field?.props)fail('FW-PAY-TARGET-SCHEMA');
  const p=field.props;
  return p.required===true||p.behavior==='REQUIRED'||(Array.isArray(p.validation)&&p.validation.some(v=>v?.type==='required'||v?.required===true||v?.rule==='required'));
}

async function department(ctx, id, managerField=F.manager) {
  const response=await ctx.invoke('department',{'Content-Type':'application/json',Body:{dept_id:id}});
  if (!response || typeof response!=='object' || (response.errcode!==undefined&&String(response.errcode)!=='0') || response.success===false) fail('FW-PAY-DEPARTMENT');
  const d=response.result || response;
  if (d && ((d.errcode!==undefined&&String(d.errcode)!=='0') || d.success===false || d.error || d.errorCode || d.errorMsg)) fail('FW-PAY-DEPARTMENT');
  if (!d || typeof d!=='object' || (d.dept_id!==undefined&&String(d.dept_id)!==id) || (d.deptId!==undefined&&String(d.deptId)!==id)) fail('FW-PAY-DEPARTMENT-MISMATCH');
  const name=required(d.name,'FW-PAY-DEPARTMENT-NAME'), managers=d.dept_manager_userid_list;
  if (managers!==undefined && (!Array.isArray(managers)||managers.some(v=>typeof v!=='string'||!v.trim()))) fail('FW-PAY-MANAGER-FORMAT');
  const manager=Array.isArray(managers)&&managers.length?managers[0]:null;
  if(!manager&&managerField){
    // The native page leaves this field empty when its successful department
    // lookup contains no manager. Only a real schema requirement can block it.
    if(await targetRequired(ctx,managerField))fail('FW-PAY-MANAGER-REQUIRED','办理所需的部门主管资料缺失，请联系 HR 核查。');
  }
  return {id,name,manager};
}

async function structure(ctx, prefix, id) {
  const [,idField,...sourceFields]=TABLES.structures;
  const targetFields=prefix==='application'?F.applicationStructure:F.projectStructure;
  const requiredFields=await Promise.all(targetFields.map(field=>targetRequired(ctx,field)));
  const source=await rows(ctx,'structures',{[idField]:id});
  const candidates=source.filter(r=>text(r[idField])===id).map(row=>sourceFields.map(field=>{
    const raw=row[field];
    if(raw===undefined||raw===null||raw===''||(Array.isArray(raw)&&raw.length===0))return '';
    // A multi-value/malformed source is not an optional blank.
    const value=text(raw);if(!value)fail('FW-PAY-STRUCTURE-FORMAT');return value;
  }));
  const distinct=[...new Map(candidates.map(values=>[JSON.stringify(values),values])).values()];
  if(distinct.length>1)fail('FW-PAY-STRUCTURE-AMBIGUOUS','部门的业务归属资料不唯一，请联系 Finance 核查。');
  const selected=distinct[0]||['','',''];
  if(selected.some((value,i)=>!value&&requiredFields[i]))fail('FW-PAY-STRUCTURE-MISSING','办理所需的业务归属资料缺失，请联系 Finance 补充。');
  return {values:selected,optionalEmptyFields:targetFields.filter((field,i)=>!selected[i]&&!requiredFields[i])};
}

async function project(ctx,input,needs) {
  const [,nameField,codeField,statusField]=TABLES.projects;
  let catalog=await rows(ctx,'projects',{[statusField]:'生效',...(input.project_name?{[nameField]:input.project_name}:{})});
  catalog=catalog.filter(r=>text(r[statusField])==='生效');
  if(!catalog.length&&input.project_name)catalog=(await rows(ctx,'projects',{[statusField]:'生效'})).filter(r=>text(r[statusField])==='生效');
  const name=choose(needs,'project_name',input.project_name,catalog.map(r=>required(r[nameField],'FW-PAY-PROJECT')));
  if(!name)return null;
  const record=unique(catalog,r=>text(r[nameField])===name,'FW-PAY-PROJECT-AMBIGUOUS');
  const code=text(record[codeField]);
  const [,pn,pc,pid,pname,category,native,nativeId]=TABLES.projectDepartments;
  const entries=(await rows(ctx,'projectDepartments',{[pn]:name})).filter(r=>same(r[pn],name)).map(r=>{
    const id=required(r[pid]??r[nativeId],'FW-PAY-PROJECT-DEPARTMENT');
    if(r[pid]!==undefined&&r[nativeId]!==undefined&&text(r[pid])!==text(r[nativeId]))fail('FW-PAY-PROJECT-DEPARTMENT-MISMATCH');
    const actualCode=text(r[pc]);if(code&&actualCode&&code!==actualCode)fail('FW-PAY-PROJECT-CODE-MISMATCH');
    return {id,name:required(r[pname]??r[native],'FW-PAY-PROJECT-DEPARTMENT-NAME'),category:required(r[category],'FW-PAY-PROJECT-CATEGORY')};
  });
  const id=choose(needs,'project_department_id',input.project_department_id,entries.map(r=>r.id));
  if(!id){const item=needs.at(-1);item.choices=item.choices.map(c=>({...c,label:entries.find(e=>e.id===c.value).name}));return null;}
  const selected=entries.filter(r=>r.id===id);
  const expense=choose(needs,'project_expense_category',input.project_expense_category,selected.map(r=>r.category));
  if(!expense)return null;
  const manager=await department(ctx,id,F.projectManager);
  return {name,code,department:manager,category:expense};
}

async function contacts(ctx,company) {
  const [,companyField,finance,cashier]=TABLES.contacts;
  const raw=await rows(ctx,'contacts',{[companyField]:company},[companyField,finance,finance+'_id',cashier,cashier+'_id']);
  const matching=raw.filter(r=>same(r[companyField],company));
  if(matching.length>1)fail('FW-PAY-CONTACTS','支付公司的财务联系人配置不唯一，请联系 Finance 核查。');
  const row=matching[0]||{},result={finance:memberIds(row,finance),cashier:memberIds(row,cashier)};
  for(const [role,field]of[['finance',F.finance],['cashier',F.cashier]]){
    if(!result[role].length&&await targetRequired(ctx,field))fail('FW-PAY-CONTACTS-REQUIRED','办理所需的财务联系人资料缺失，请联系 Finance 补充。');
  }
  return result;
}

async function relations(ctx,input,needs) {
  const formData={},preview={};
  for(const [key,config] of Object.entries(RELATIONS)){
    const selected=input[key+'_instance_id'],include=input['include_'+key];
    if(include===false&&selected)fail('FW-PAY-RELATION-CONFLICT','取消关联与关联实例选择冲突。');
    if(!selected&&include!==true)continue;
    if(typeof ctx.related!=='function')fail('FW-PAY-RELATION-UNAVAILABLE','当前环境暂不能核验本人关联流程，请取消本次关联或联系维护人员。');
    const candidates=await ctx.related(key);
    if(!Array.isArray(candidates))fail('FW-PAY-RELATION-SHAPE');
    const ids=new Set();
    for(const c of candidates){
      if(!c||c.app_type!==APP||c.form_uuid!==config.form||c.form_type!=='process'||c.originator_userid!==ctx.actor.userid||!['RUNNING','COMPLETED'].includes(c.instance_status)||typeof c.instance_id!=='string'||!c.instance_id||ids.has(c.instance_id)||typeof c.title!=='string'||typeof c.sub_title!=='string')fail('FW-PAY-RELATION-BOUNDARY');
      ids.add(c.instance_id);
    }
    const found=candidates.find(c=>c.instance_id===selected);
    if(!found){needs.push({field:key+'_instance_id',message:candidates.length?'请选择本人可用的关联流程，或取消关联。':'本人当前没有可用的关联流程，请取消本次关联。',choices:candidates.map(c=>({value:c.instance_id,label:c.title||c.sub_title||'关联审批',subtitle:c.sub_title,status:c.instance_status}))});continue;}
    formData[config.field]=[{appType:APP,formUuid:config.form,formType:'process',instanceId:found.instance_id,title:found.title,subTitle:found.sub_title}];
    preview[key]={title:found.title,subtitle:found.sub_title,status:found.instance_status};
  }
  return {formData,preview};
}

module.exports={department,structure,project,contacts,relations};
