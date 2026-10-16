'use strict';
const {APP,TABLES,RELATIONS,F,fail,text,required,unique,same,choose,rows,memberIds}=require('./payment-core.cjs');

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
    const schema=await ctx.schema();let field;
    function walk(v){if(!v||typeof v!=='object')return;if(v.props?.fieldId===managerField)field=v;for(const x of Object.values(v))if(x&&typeof x==='object')walk(x);}
    walk(schema);if(!field)fail('FW-PAY-MANAGER-FIELD');
    const p=field.props;if(p.required===true||(Array.isArray(p.validation)&&p.validation.some(v=>v?.type==='required')))fail('FW-PAY-MANAGER-REQUIRED','此表要求部门主管，但部门连接器未返回主管信息。');
  }
  return {id,name,manager};
}

async function structure(ctx, input, prefix, id, needs) {
  const [,idField,...fields]=TABLES.structures;
  const source=await rows(ctx,'structures',{[idField]:id});
  let candidates=source.filter(r=>text(r[idField])===id).map(r=>fields.map(f=>required(r[f],'FW-PAY-STRUCTURE')));
  if (!candidates.length) fail('FW-PAY-STRUCTURE');
  const keys=['business_architecture','business_line','sub_business_line'], selected=[];
  for(let i=0;i<keys.length;i++) {
    const value=choose(needs,prefix+'_'+keys[i],input[prefix+'_'+keys[i]],candidates.map(r=>r[i]));
    if(!value)return null;
    selected.push(value);candidates=candidates.filter(r=>r[i]===value);
  }
  return selected;
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
  const row=unique(raw,r=>same(r[companyField],company),'FW-PAY-CONTACTS');
  return {finance:memberIds(row,finance),cashier:memberIds(row,cashier)};
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
