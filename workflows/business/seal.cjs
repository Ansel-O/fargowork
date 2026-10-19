'use strict';

const C = require('../leave-trip-common.cjs');
const config = require('../../config/workflows/business/seal.json');
const sources = require('../../config/sources.json');
const APP = require('../../config/company.json').appType;
const {validateCandidates,processReference} = require('../../shared/process-association.cjs');

const {key, title, target, fields:F, options, policy:policyConfig} = config;
const formUuid = target.formUuid;
const attachments = config.attachments;
const companySource = sources.companyDirectory;
const executorSource = sources.companyExecutors;
const policy = Object.freeze({
  dataForms:[...policyConfig.dataForms], rosterFields:[...policyConfig.rosterFields], connectors:{},
  relatedSources:{...policyConfig.relatedSources}
});
const requirements = Object.freeze({
  required:[
    {field:'company', label:'用印公司', source:'公司目录候选'},
    {field:'items', label:'用印清单', minimumRows:1, maximumRows:50,
      items:{attachments:'可选文件列表', copies:'可选整数', seals:options.sealTypes, remark:'可选'}}
  ],
  optional:[
    {field:'include_contract', label:'是否关联本人合同', type:'boolean'},
    {field:'contract_instance_id', label:'關聯合同流程', source:'本人发起且处于进行中或已完成的合同'},
    {field:'reason', label:'用印事由', type:'text'},
    {field:'recipient', label:'收件人', type:'text'},
    {field:'recipient_phone', label:'收件人电话', type:'text'},
    {field:'recipient_address', label:'收件地址', type:'text'}
  ],
  attachments:{input:'items[].attachments', maximumPerRow:9, maximumMiB:100},
  notes:['印章类型为多选；每行单独绑定自己的文件。','用印对应执行人按公司维护表自动填充；空值按原页面可空规则处理。','审批人隐藏字段保持原空值语义，申请提交仍由宜搭流程执行。']
});
const INPUTS = ['company','include_contract','contract_instance_id','reason','recipient','recipient_phone','recipient_address','items'];

function optionalText(input, field) {
  return C.absent(input[field]) ? '' : C.text(input[field], 'SEAL_INPUT_INVALID');
}
function values(rows, field) {
  const result = [];
  for (const row of rows) for (const value of C.values(row[field] ?? [])) {
    const text = String(value).trim();
    if (text && !result.includes(text)) result.push(text);
  }
  return result;
}
function sourceChoices(rows, field) {
  const result = new Map();
  for (const row of rows) for (const value of C.values(row[field] ?? [])) {
    const text = String(value).trim();
    if (text && !result.has(C.normalized(text))) result.set(C.normalized(text), text);
  }
  return [...result.values()];
}
function currentMainDepartment(map) {
  const id = C.rosterValue(map, C.ROSTER.main, 'value');
  C.check(/^\d+$/.test(id), 'SEAL_ORIGINATOR_DEPARTMENT_UNAVAILABLE');
  return id;
}
async function prepare(input, ctx) {
  C.inputKeys(input, INPUTS);
  const schema = C.assertFields(await ctx.schema(), F);
  C.check(C.required(schema, F.company), 'SEAL_SCHEMA_CHANGED');
  C.check(C.required(schema, F.itemSeals), 'SEAL_SCHEMA_CHANGED');
  const actor = C.identity(ctx);
  const roster = C.rosterFields(await ctx.roster(policy.rosterFields), actor);
  const departmentId = currentMainDepartment(roster);
  const applicantName = (() => { try { return C.rosterValue(roster, C.ROSTER.name, 'value'); } catch { return actor.userid; } })();

  const companyRows = await ctx.query(companySource.formUuid, null, [companySource.companyField]);
  const companies = sourceChoices(companyRows, companySource.companyField);
  C.check(companies.length > 0, 'SEAL_COMPANY_DIRECTORY_EMPTY', '公司目录暂时没有可用候选，请联系 Finance。');
  if (C.absent(input.company)) return {needsInput:[{field:'company', message:'请选择本次用印所属公司。', choices:companies}]};
  const company = companies.find(value => C.normalized(value) === C.normalized(input.company));
  if (!company) return {needsInput:[{field:'company', message:'请选择公司目录中的用印公司。', choices:companies}]};

  C.check(Array.isArray(input.items) && input.items.length >= 1 && input.items.length <= 50,
    'SEAL_ITEMS_INVALID', '请提供 1 到 50 行用印清单。');
  const itemRows = [];
  const itemPreview = [];
  const missing = [];
  input.items.forEach((item, index) => {
    C.check(item && typeof item === 'object' && !Array.isArray(item), 'SEAL_ITEM_INVALID');
    C.inputKeys(item, ['attachments','copies','seals','remark']);
    C.check(item.attachments === undefined || Array.isArray(item.attachments), 'SEAL_ATTACHMENTS_INVALID', '每行文件应为路径列表。');
    if (!Array.isArray(item.seals) || item.seals.length === 0) missing.push({field:`items[${index}].seals`, message:`请为第 ${index + 1} 行选择印章类别。`});
    if (!Array.isArray(item.seals) || item.seals.length === 0) return;
    const copies = C.absent(item.copies) ? undefined : C.number(item.copies, {code:'SEAL_COPIES_INVALID'});
    C.check(copies === undefined || Number.isSafeInteger(copies), 'SEAL_COPIES_INVALID', '用印份数须为整数。');
    C.check(item.seals.every(value => typeof value === 'string' && options.sealTypes.includes(value)), 'SEAL_TYPE_INVALID', '请选择页面允许的印章类别。');
    C.check(new Set(item.seals).size === item.seals.length, 'SEAL_TYPE_DUPLICATE');
    for (const sealType of item.seals) C.option(schema, F.itemSeals, sealType, options.sealTypes);
    const remark = C.absent(item.remark) ? '' : C.text(item.remark, 'SEAL_REMARK_INVALID');
    itemRows.push({[F.itemAttachment]:[], ...(copies === undefined ? {} : {[F.itemCopies]:copies}), [F.itemSeals]:[...item.seals], ...(remark?{[F.itemRemark]:remark}:{})});
    itemPreview.push({用印文件:[], 用印份数:copies ?? '', 印章类别:[...item.seals], 备注:remark});
  });
  if (missing.length) return {needsInput:missing};

  C.check(C.absent(input.include_contract) || typeof input.include_contract === 'boolean', 'SEAL_ASSOCIATION_INVALID');
  C.check(input.include_contract !== false || C.absent(input.contract_instance_id), 'SEAL_ASSOCIATION_CONFLICT');
  let association = [];
  let contractLabel = '';
  const wantsContract = input.include_contract === true || !C.absent(input.contract_instance_id);
  if (wantsContract) {
    const candidates = validateCandidates(await ctx.related('contract'), {
      appType:APP,formUuid:policy.relatedSources.contract.form,actorId:actor.userid
    });
    const selected = candidates.find(item => item.instance_id === input.contract_instance_id);
    if (!selected) return {needsInput:[{field:'contract_instance_id', message:candidates.length ? '请选择要关联的本人合同；如不需要关联，请选择不关联。' : '本人当前没有可关联的合同流程，请取消关联。',
      choices:candidates.map(item => ({value:item.instance_id, label:[item.title,item.sub_title].filter(Boolean).join(' · ') || item.instance_id}))}]};
    association = [processReference(selected)];
    contractLabel = [selected.title, selected.sub_title].filter(Boolean).join(' · ') || selected.instance_id;
  }

  const executorRows = await ctx.query(executorSource.formUuid,
    {[executorSource.companyField]:company},
    [executorSource.companyField, executorSource.sealExecutorField, executorSource.sealExecutorField + '_id']);
  const exactExecutors = executorRows.filter(row => C.exact(row[executorSource.companyField], company));
  const executorIds = values(exactExecutors, executorSource.sealExecutorField + '_id');
  const executorNames = values(exactExecutors, executorSource.sealExecutorField);
  C.check(!executorNames.length || executorNames.length === executorIds.length, 'SEAL_EXECUTOR_SOURCE_INVALID');

  const formData = {
    [F.applicant]:[actor.userid],
    [F.department]:[departmentId],
    [F.applicationDate]:ctx.todayMs,
    [F.relatedContract]:association,
    [F.relatedContractText]:JSON.stringify(association),
    [F.company]:company,
    [F.items]:itemRows,
    [F.executor]:executorIds
  };
  const reason = optionalText(input, 'reason');
  const recipient = optionalText(input, 'recipient');
  const recipientPhone = optionalText(input, 'recipient_phone');
  const recipientAddress = optionalText(input, 'recipient_address');
  if (reason) formData[F.reason] = reason;
  if (recipient) formData[F.recipient] = recipient;
  if (recipientPhone) formData[F.recipientPhone] = recipientPhone;
  if (recipientAddress) formData[F.recipientAddress] = recipientAddress;

  return {
    formData, departmentId,
    attachmentInputs:{rowArrayField:attachments.rowArrayField, tableField:attachments.tableField,
      rowFileInputField:attachments.rowFileInputField, rowAttachmentField:attachments.rowAttachmentField,
      previewRowsField:'用印清单', previewFilesField:'用印文件'},
    preview:{流程:title, 申请人:applicantName, 申请日期:ctx.today, 用印公司:company, 用印事由:reason,
      关联合同:contractLabel, 收件人:recipient,
      收件人电话:recipientPhone, 收件地址:recipientAddress, 用印清单:itemPreview},
    verification:{optionalEmptyFields:[...(!executorIds.length?[F.executor]:[]),...(!association.length?[F.relatedContract]:[])],
      associationTextMirrors:{[F.relatedContractText]:F.relatedContract}},
    resolvedInputs:{...input, company}
  };
}

module.exports = {key,title,formUuid,policy,requirements,prepare,attachmentInputs:attachments};
