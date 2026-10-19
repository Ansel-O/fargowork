'use strict';
const C = require('./leave-trip-common.cjs');
const SOURCE_CONFIG = require('../config/sources.json');

// Business rules depend only on the caller's fixed formal binding.
function createBusinessTripWorkflow(config) {
const key = config.key;
const title = config.title;
const formUuid = config.target.formUuid;
const F = Object.freeze({...config.fields});
const attachmentField = F.attachment;
const P0 = config.sources.projectDirectory;
const D0 = config.sources.projectDepartments;
const P = Object.freeze({form:P0.formUuid,code:P0.codeField,name:P0.nameField,status:P0.statusField});
const D = Object.freeze({form:D0.formUuid,project:D0.projectField,code:D0.codeField,native:D0.departmentField,name:D0.nameField,id:D0.idField});
const PURPOSES = config.options.purposes;
const policy = Object.freeze({
  dataForms:[C.OFFICE.form,P.form,D.form],
  rosterFields:[...config.policy.rosterFields],
  connectors:{roster:C.ROSTER_CONNECTOR,...Object.fromEntries(Object.entries(config.policy.connectors).map(([alias,name])=>[alias,SOURCE_CONFIG.connectors[name]]))}
});
const requirements = Object.freeze({
  required:[
    {field:'trip_location',label:'出差地点',type:'text'}, {field:'purpose',label:'出差目的',choices:PURPOSES},
    {field:'start_date',label:'开始日期',type:'date',format:'YYYY-MM-DD'}, {field:'end_date',label:'结束日期',type:'date',format:'YYYY-MM-DD'},
    {field:'budget_hkd',label:'预算总金额（港币）',type:'number',minimum:0}, {field:'content',label:'出差内容',type:'text'},
    {field:'is_project',label:'是否为项目出差',type:'boolean'}
  ],
  optional:[
    {field:'itinerary',label:'出差排程',requiredWhen:'多日出差',items:{date:'YYYY-MM-DD',item:'事项',remark:'备注（可选）'}},
    {field:'project_name',label:'准确项目名称',requiredWhen:'项目出差；须属于当前生效项目'},
    {field:'project_query',label:'项目关键词',purpose:'只在固定项目目录中查找候选'},
    {field:'project_department',label:'项目部门',requiredWhen:'项目对应多个部门时，从候选中选择名称或ID'},
    {field:'department_id',label:'发起部门',source:'只能选本人任职部门；默认主部门'}
  ],
  attachments:{required:false,input:'业务 JSON 顶层 attachments 数组',maximumCount:9,maximumMiB:20},
  notes:['当天出差可用地点和内容生成一行排程；多日出差须提供排程。','支持可选原生附件，由统一附件命令上传并绑定。','确认最终预览后才提交；不检索其他流程。']
});
const INPUTS = ['trip_location','purpose','start_date','end_date','budget_hkd','content','is_project','itinerary','project_name','project_query','project_department','department_id'];

function itinerary(input, start, end) {
  let rows = input.itinerary;
  if (C.absent(rows) || (Array.isArray(rows) && !rows.length)) {
    if (start !== end) return {needsInput:[{field:'itinerary',message:'请补充多日出差排程：每行填写日期、事项及可选备注。'}]};
    rows = [{date:input.start_date,item:input.trip_location,remark:input.content}];
  }
  C.check(Array.isArray(rows), 'ITINERARY_INVALID', '出差排程应是行程列表。');
  const needsInput = [], result = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    C.inputKeys(row,['date','item','remark']);
    const rowDate = C.absent(row.date) && start === end ? input.start_date : row.date;
    if (C.absent(rowDate)) { needsInput.push({field:`itinerary[${index}].date`,message:`请补充第${index + 1}项行程的日期。`}); continue; }
    if (C.absent(row.item)) { needsInput.push({field:`itinerary[${index}].item`,message:`请补充第${index + 1}项行程的事项。`}); continue; }
    const ms = C.date(rowDate, 'ITINERARY_DATE_INVALID');
    C.check(ms >= start && ms <= end, 'ITINERARY_OUTSIDE_RANGE', '行程日期必须在出差起止日期范围内。');
    const item = C.text(row.item, 'ITINERARY_ITEM_INVALID'), remark = C.optionalText(row.remark);
    result.push({date:rowDate,item,remark,ms});
  }
  if (needsInput.length) return {needsInput};
  result.sort((a,b) => a.ms - b.ms);
  return {rows:result};
}

async function project(ctx, input) {
  const wanted = C.optionalText(input.project_name), query = C.optionalText(input.project_query) || wanted;
  if (!query) return {needsInput:[{field:'project_query',message:'请提供项目名称或关键词。'}]};
  const raw = await ctx.query(P.form, {[P.status]:'生效'}, [P.name,P.code,P.status]);
  C.check(Array.isArray(raw), 'PROJECT_DIRECTORY_INVALID');
  const directory = raw.map(row => {
    C.check(C.exact(row[P.status],'生效'), 'PROJECT_DIRECTORY_SCOPE_MISMATCH');
    return {name:C.single(row[P.name],'PROJECT_DIRECTORY_INVALID'),code:C.absent(row[P.code]) ? '' : C.single(row[P.code],'PROJECT_DIRECTORY_INVALID')};
  });
  const exactMatches = directory.filter(row => C.normalized(row.name) === C.normalized(wanted || query) || (!wanted && row.code && C.normalized(row.code) === C.normalized(query)));
  if (exactMatches.length > 1) C.fail('PROJECT_AMBIGUOUS','项目名称或编码不唯一，请联系管理员核对。');
  if (!exactMatches.length) {
    const candidates = directory.filter(row => C.normalized(row.name + ' ' + row.code).includes(C.normalized(query)));
    return {needsInput:[{field:'project_name',message:candidates.length ? '请选择准确的生效项目，关键词匹配不会自动代选。' : '未找到生效项目，请提供准确名称。',choices:candidates.map(row => ({value:row.name,label:row.code ? `${row.name}（${row.code}）` : row.name}))}]};
  }
  const selected = exactMatches[0];
  const relations = await ctx.query(D.form, {[D.project]:selected.name}, [D.project,D.code,D.native,D.native+'_id',D.name,D.id]);
  C.check(Array.isArray(relations) && relations.length, 'PROJECT_DEPARTMENT_NOT_FOUND', '项目未配置有效部门，请联系管理员。');
  const byDepartment = new Map();
  for (const row of relations) {
    C.check(C.exact(row[D.project],selected.name), 'PROJECT_RELATION_MISMATCH');
    if (!C.absent(row[D.code]) && selected.code) C.check(C.exact(row[D.code],selected.code), 'PROJECT_RELATION_MISMATCH');
    const explicitId = C.absent(row[D.id]) ? '' : C.single(row[D.id], 'PROJECT_DEPARTMENT_INVALID');
    const rawNativeId = row[D.native + '_id'];
    const nativeId = C.absent(rawNativeId) || (Array.isArray(rawNativeId) && !rawNativeId.length) ? '' : C.single(rawNativeId, 'PROJECT_DEPARTMENT_INVALID');
    C.check(!explicitId || !nativeId || explicitId === nativeId, 'PROJECT_DEPARTMENT_ID_MISMATCH');
    const id = explicitId || nativeId;
    C.check(/^\d+$/.test(id), 'PROJECT_DEPARTMENT_INVALID');
    const nativeName = C.absent(row[D.native]) || (Array.isArray(row[D.native]) && !row[D.native].length) ? '' : C.single(row[D.native], 'PROJECT_DEPARTMENT_INVALID');
    const textName = C.absent(row[D.name]) ? '' : C.single(row[D.name], 'PROJECT_DEPARTMENT_INVALID');
    const name = nativeName || textName;
    C.check(name, 'PROJECT_DEPARTMENT_INVALID');
    C.check(!byDepartment.has(id) || byDepartment.get(id).name === name, 'PROJECT_DEPARTMENT_AMBIGUOUS');
    byDepartment.set(id,{id,name});
  }
  let candidates = [...byDepartment.values()];
  const chosen = C.optionalText(input.project_department);
  if (chosen) candidates = candidates.filter(dep => dep.id === chosen || C.normalized(dep.name) === C.normalized(chosen));
  if (candidates.length !== 1) return {needsInput:[{field:'project_department',message:'请选择该项目对应的准确部门。',choices:[...byDepartment.values()].map(dep => ({value:dep.id,label:dep.name}))}]};
  const dep = candidates[0];
  const idNumber = Number(dep.id);
  C.check(Number.isSafeInteger(idNumber), 'PROJECT_DEPARTMENT_INVALID');
  let response = await ctx.invoke('department', {'Content-Type':'application/json',Body:{dept_id:idNumber}});
  C.check(C.object(response) && response.errcode !== undefined && [0,'0'].includes(response.errcode) && response.success !== false, 'DEPARTMENT_SOURCE_UNAVAILABLE', '项目部门信息暂时无法核验。');
  response = response.result;
  C.check(C.object(response) && String(response.dept_id ?? response.deptId) === dep.id, 'DEPARTMENT_DETAIL_MISMATCH');
  C.check(typeof response.name === 'string' && C.normalized(response.name) === C.normalized(dep.name), 'DEPARTMENT_DETAIL_MISMATCH', '项目部门名称与当前组织信息不一致。');
  const managers = response.dept_manager_userid_list;
  C.check(managers === undefined || Array.isArray(managers) && managers.every(id => typeof id === 'string' && id.trim()), 'DEPARTMENT_SOURCE_UNAVAILABLE', '项目部门主管资料格式异常。');
  // The published page's fetchDeptManager chooses the first source manager.
  // Preserve that ordering; neither sort nor add other configured managers.
  return {name:selected.name,department:dep,managers:managers?.length ? [managers[0]] : []};
}

async function prepare(input, ctx) {
  C.inputKeys(input, INPUTS);
  const needsInput = requirements.required.filter(row => C.absent(input[row.field])).map(row => ({field:row.field,message:`请补充${row.label}。`,...(row.choices ? {choices:row.choices} : {})}));
  if (needsInput.length) return {needsInput};
  const actor = C.identity(ctx), {start,end} = C.inputRange(input);
  const location = C.text(input.trip_location,'TRIP_LOCATION_INVALID'), content = C.text(input.content,'TRIP_CONTENT_INVALID');
  const purpose = C.text(input.purpose,'TRIP_PURPOSE_INVALID');
  C.check(PURPOSES.includes(purpose), 'TRIP_PURPOSE_INVALID', '请选择已发布的出差目的。');
  const budget = C.number(input.budget_hkd,{nonnegative:true,code:'BUDGET_INVALID'});
  C.check(typeof input.is_project === 'boolean', 'PROJECT_INTENT_INVALID', '请明确是否为项目出差（true/false）。');
  C.check(input.is_project || ['project_name','project_query','project_department'].every(field => C.absent(input[field])), 'PROJECT_INPUT_CONFLICT', '非项目出差不应包含项目选择。');
  const schedule = itinerary(input,start,end);
  if (schedule.needsInput) return schedule;
  const schema = C.assertFields(await ctx.schema(),F);
  C.option(schema,F.purpose,purpose,PURPOSES);
  C.option(schema,F.isProject,input.is_project ? 'NORMAL' : 'HIDDEN',['NORMAL','HIDDEN']);
  const roster = C.rosterFields(await ctx.roster(policy.rosterFields),actor);
  const name = C.rosterValue(roster,C.ROSTER.name,'value'), office = C.rosterValue(roster,C.ROSTER.office,'value'), company = C.rosterValue(roster,C.ROSTER.company,'value');
  const dep = C.department(roster,input.department_id);
  const admin = await C.contacts(ctx,C.OFFICE,office,{required:C.required(schema,F.officeAdmin)});
  let linkage;
  if (input.is_project) { linkage = await project(ctx,input); if (linkage.needsInput) return linkage; }
  C.check(!linkage || !C.required(schema,F.manager) || linkage.managers.length, 'DEPARTMENT_MANAGER_MISSING', '办理所需的部门主管资料缺失，请联系 HR 核查。');
  const days = (end - start) / C.DAY + 1;
  const formData = {
    [F.applicant]:[actor.userid], [F.applicantId]:actor.userid, [F.application]:ctx.todayMs,
    [F.days]:days, [F.location]:location, [F.purpose]:purpose, [F.start]:start, [F.end]:end,
    [F.budget]:budget, [F.content]:content, [F.office]:office, [F.officeAdmin]:admin.ids, [F.company]:company,
    [F.isProject]:input.is_project ? 'NORMAL' : 'HIDDEN',
    [F.schedule]:schedule.rows.map(row => ({[F.rowDate]:row.ms,[F.rowItem]:row.item,...(row.remark ? {[F.rowRemark]:row.remark} : {})}))
  };
  if (linkage) Object.assign(formData,{[F.project]:linkage.name,[F.projectDepartment]:linkage.department.name,[F.projectDepartmentId]:linkage.department.id,[F.projectDepartmentTransition]:linkage.department.id,[F.manager]:linkage.managers});
  return {
    formData,departmentId:dep.id,attachmentField,
    preview:{流程:title,申请人:name,申请日期:ctx.today,出差地点:location,出差目的:purpose,开始日期:input.start_date,结束日期:input.end_date,出差天数:days,预算港币:budget,出差内容:content,
      出差排程:schedule.rows.map(({date,item,remark}) => ({日期:date,事项:item,备注:remark})),是否项目出差:input.is_project,
      ...(linkage ? {项目:linkage.name,项目部门:linkage.department.name} : {})},
    verification:{optionalEmptyFields:[...(!admin.ids.length ? [F.officeAdmin] : []),...(linkage && !linkage.managers.length ? [F.manager] : [])]},
    resolvedInputs:{...input,trip_location:location,purpose,content,budget_hkd:budget,department_id:dep.id,itinerary:schedule.rows.map(({date,item,remark})=>({date,item,remark})),...(linkage ? {project_name:linkage.name,project_department:linkage.department.id} : {})}
  };
}
return {key,title,formUuid,attachmentField,policy,requirements,prepare};
}

module.exports = {createBusinessTripWorkflow};

