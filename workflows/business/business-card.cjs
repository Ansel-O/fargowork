'use strict';

const C = require('../leave-trip-common.cjs');
const config = require('../../config/workflows/business/business_card.json');
const sources = require('../../config/sources.json');
const {initialValues} = require('../../shared/initial-values.cjs');

const {key, title, target, fields:F, options, policy:policyConfig} = config;
const formUuid = target.formUuid;
const attachmentField = config.attachments.field;
const templateSource = sources[config.sources.templates];
const executorSource = sources[config.sources.companyExecutors];
const policy = Object.freeze({
  dataForms:[...policyConfig.dataForms],
  rosterFields:[...policyConfig.rosterFields],
  connectors:{}
});

const requirements = Object.freeze({
  required:[],
  optional:[
    {field:'quantity',label:'名片数量',choices:options.quantities},
    {field:'template',label:'名片模板',source:'businessCardTemplates'},
    {field:'print_method',label:'打印方式',choices:options.printMethods},
    {field:'office',label:'办公场所',source:'按所选模板筛选'},
    {field:'purpose',label:'用途',type:'text'},
    {field:'mailing_address',label:'邮寄地址',type:'text'},
    {field:'company_name_english',label:'英文公司名称',type:'text'},
    {field:'name_english',label:'英文姓名',type:'text'},
    {field:'title_english',label:'英文职位',type:'text'},
    {field:'email_english',label:'英文电邮',type:'text'},
    {field:'mobile_english',label:'英文名片手机',type:'text'},
    {field:'landline_english',label:'英文固定电话',type:'text'},
    {field:'address_english',label:'英文地址',type:'text'},
    {field:'company_name_chinese',label:'中文公司名称',type:'text'},
    {field:'name_chinese',label:'中文姓名',type:'text'},
    {field:'title_chinese',label:'中文职位',type:'text'},
    {field:'email_chinese',label:'中文电邮',type:'text'},
    {field:'mobile_chinese',label:'中文名片手机',type:'text'},
    {field:'landline_chinese',label:'中文固定电话',type:'text'},
    {field:'address_chinese',label:'中文地址',type:'text'},
    {field:'remarks',label:'备注',type:'text'},
    {field:'sheung_wan_address',label:'上环地址选择',choices:['keep','alternate']}
  ],
  attachments:{required:false,field:'PDF文件'},
  notes:[
    '模板筛选非空办公场所；唯一选项自动带入，多选项先问员工。模板及场所只为尚未手改的文字提供初始值。',
    '使用同一草稿修改：手填文字（含明确清空）保留；修改地址不触发整组重新赋值。更换模板或场所只更新受影响的自动字段。',
    '上环办公室另有 Room 4309-4310/09-10室，首次遇到时问一次是否替换；只改房间号，保留地址其他部分。',
    '审批用公司仅取当前申请人花名册合同公司；模板品牌公司不替换该值。HR链接按该合同公司自动查找，允许为空。',
    'PDF附件可选。隐藏的HR制作后名片附件由后续流程处理，不要求发起人提供。'
  ]
});

const INPUTS = [
  'quantity','template','print_method','office','purpose','mailing_address',
  'company_name_english','name_english','title_english','email_english','mobile_english',
  'landline_english','address_english','company_name_chinese','name_chinese','title_chinese',
  'email_chinese','mobile_chinese','landline_chinese','address_chinese','remarks','sheung_wan_address'
];

const R = sources.rosterFields;
const ROSTER = Object.freeze({
  name:R.name,
  mainDepartment:R.mainDepartment,
  contractCompany:R.contractCompany,
  mobile:R.mobile,
  email:R.email,
  title:R.businessCardTitle,
  chineseName:R.businessCardChineseName
});
const TEXT_FIELDS = Object.freeze({
  purpose:['purpose',F.purpose],
  mailing_address:['mailingAddress',F.mailingAddress],
  company_name_english:['companyNameEnglish',F.companyNameEnglish],
  name_english:['nameEnglish',F.nameEnglish],
  title_english:['titleEnglish',F.titleEnglish],
  email_english:['emailEnglish',F.emailEnglish],
  mobile_english:['mobileEnglish',F.mobileEnglish],
  landline_english:['landlineEnglish',F.landlineEnglish],
  address_english:['addressEnglish',F.addressEnglish],
  company_name_chinese:['companyNameChinese',F.companyNameChinese],
  name_chinese:['nameChinese',F.nameChinese],
  title_chinese:['titleChinese',F.titleChinese],
  email_chinese:['emailChinese',F.emailChinese],
  mobile_chinese:['mobileChinese',F.mobileChinese],
  landline_chinese:['landlineChinese',F.landlineChinese],
  address_chinese:['addressChinese',F.addressChinese],
  remarks:['remarks',F.remarks]
});

function optionalRosterText(roster, field) {
  const entries = roster.get(field);
  if (!Array.isArray(entries) || !entries.length) return '';
  return C.rosterValue(roster, field, 'value');
}

function sourceValues(rows, field) {
  const byNormalized = new Map();
  for (const row of rows) {
    for (const raw of C.values(row[field] ?? [])) {
      const value = raw.trim();
      if (value && !byNormalized.has(C.normalized(value))) byNormalized.set(C.normalized(value), value);
    }
  }
  return [...byNormalized.values()];
}

function rowHas(row, field, wanted) {
  return C.values(row[field] ?? []).some(value => C.normalized(value) === C.normalized(wanted));
}

function canonicalChoice(value, choices) {
  const key = C.normalized(value);
  return choices.find(choice => C.normalized(choice) === key) || '';
}

function selectedText(input, field, label, choices, needsInput) {
  if (C.absent(input[field])) return '';
  const raw = typeof input[field] === 'number' && Number.isFinite(input[field])
    ? String(input[field]) : input[field];
  const requested = C.text(raw, 'BUSINESS_CARD_CHOICE_INVALID');
  const chosen = canonicalChoice(requested, choices);
  if (!chosen) {
    needsInput.push({field,message:`请选择有效的${label}。`,choices});
    return '';
  }
  return chosen;
}

function optionValue(schema, field, value, choices) {
  if (value) C.option(schema, field, value, choices);
}

function defaultFromSource(rows, sourceField, inputField, label, needsInput) {
  const choices = sourceValues(rows, sourceField);
  if (choices.length > 1) {
    needsInput.push({field:inputField,message:`${label}有多个匹配值，请选择要印在名片上的文字。`,choices});
    return undefined;
  }
  return choices[0] || '';
}

function employeeIds(rows, source, company) {
  const exactRows = rows.filter(row => rowHas(row, source.companyField, company));
  const byId = new Map();
  for (const row of exactRows) {
    const names = C.values(row[source.hrBusinessCardField] ?? []);
    const ids = C.values(row[source.hrBusinessCardField + '_id'] ?? []);
    C.check(names.length === ids.length, 'BUSINESS_CARD_HR_SOURCE_INVALID', '公司HR人员来源格式不完整，请联系 HR 核查。');
    names.forEach((name, index) => {
      C.text(name, 'BUSINESS_CARD_HR_SOURCE_INVALID');
      const id = C.text(ids[index], 'BUSINESS_CARD_HR_SOURCE_INVALID');
      C.check(!byId.has(id) || byId.get(id) === name, 'BUSINESS_CARD_HR_SOURCE_AMBIGUOUS', '公司HR人员来源不唯一，请联系 HR 核查。');
      byId.set(id, name);
    });
  }
  return [...byId.keys()];
}

async function prepare(input, ctx) {
  C.inputKeys(input, INPUTS);
  const previous = ctx.workflowState || {version:1,selections:{},addressChoice:''};
  C.check(previous.version === 1 && previous.selections && typeof previous.selections === 'object'
    && !Array.isArray(previous.selections), 'BUSINESS_CARD_STATE_INVALID');
  // The visible confirmation control belongs to a later process stage.
  const selections = Object.fromEntries(['quantity','template','office','print_method']
    .filter(field => Object.hasOwn(previous.selections,field)).map(field => [field,previous.selections[field]]));
  for (const [field,value] of Object.entries(config.defaults)) {
    if (!Object.hasOwn(selections,field)) selections[field] = value;
  }
  for (const field of ['quantity','template','office','print_method']) {
    if (Object.hasOwn(input,field)) selections[field] = input[field] ?? '';
  }
  if (Object.hasOwn(input,'template') && C.normalized(input.template || '') !== C.normalized(previous.selections.template || '')
    && !Object.hasOwn(input,'office')) delete selections.office;
  const fills = initialValues(previous.initialValues, Object.keys(TEXT_FIELDS));
  // Preserve explicit edits even when a selector still needs an answer.
  for (const key of Object.keys(TEXT_FIELDS)) if (Object.hasOwn(input,key)) fills.resolve(input,key,'explicit',()=>'');
  let addressChoice = previous.addressChoice || '';
  C.check(['','keep','alternate','custom'].includes(addressChoice), 'BUSINESS_CARD_STATE_INVALID');
  const workflowState = () => ({version:1,selections:{...selections},initialValues:fills.snapshot(),addressChoice});
  const schema = C.assertFields(await ctx.schema(), F);
  const actor = C.identity(ctx);
  const roster = C.rosterFields(await ctx.roster(policy.rosterFields), actor);
  const departmentId = optionalRosterText(roster, ROSTER.mainDepartment);
  C.check(/^\d+$/.test(departmentId), 'BUSINESS_CARD_ORIGINATOR_DEPARTMENT_UNAVAILABLE', '当前账号主部门资料暂不可用，请联系 IT 核查。');

  const needsInput = [];
  const quantity = selectedText(selections,'quantity','名片数量',options.quantities,needsInput);
  const printMethod = selectedText(selections,'print_method','打印方式',options.printMethods,needsInput);
  optionValue(schema,F.quantity,quantity,options.quantities);
  optionValue(schema,F.printMethod,printMethod,options.printMethods);

  const sourceNeeded = !C.absent(selections.template) || !C.absent(selections.office);
  let templateRows = [];
  let template = '', office = '';
  if (sourceNeeded) {
    const sourceFields = [
      templateSource.templateField,templateSource.officeField,
      templateSource.companyNameEnglishField,templateSource.companyNameChineseField,
      templateSource.officeAddressEnglishField,templateSource.officeAddressChineseField
    ];
    templateRows = await ctx.query(templateSource.formUuid,null,sourceFields);
    C.check(Array.isArray(templateRows), 'BUSINESS_CARD_TEMPLATE_SOURCE_INVALID', '名片模板来源暂不可用。');
    const templateChoices = sourceValues(templateRows,templateSource.templateField);
    C.check(templateChoices.length > 0, 'BUSINESS_CARD_TEMPLATE_SOURCE_EMPTY', '名片模板目录暂时没有可用选项，请联系行政核查。');
    if (!C.absent(selections.office) && C.absent(selections.template)) {
      needsInput.push({field:'template',message:'请先选择名片模板，再选择该模板对应的办公场所。',choices:templateChoices});
    } else if (!C.absent(selections.template)) {
      template = canonicalChoice(C.text(selections.template,'BUSINESS_CARD_TEMPLATE_INVALID'),templateChoices);
      if (!template) needsInput.push({field:'template',message:'请选择模板目录中的名片模板。',choices:templateChoices});
    }
    if (template) {
      const matchingTemplateRows = templateRows.filter(row => rowHas(row,templateSource.templateField,template));
      const officeChoices = sourceValues(matchingTemplateRows,templateSource.officeField);
      if (!C.absent(selections.office)) {
        office = canonicalChoice(C.text(selections.office,'BUSINESS_CARD_OFFICE_INVALID'),officeChoices);
        if (!office) needsInput.push({field:'office',message:'请选择该模板对应的办公场所。',choices:officeChoices});
      } else if (!Object.hasOwn(selections,'office')) {
        if (officeChoices.length === 1) office = officeChoices[0];
        else if (officeChoices.length > 1) needsInput.push({field:'office',message:'请选择名片的办公场所，也可明确留空。',choices:officeChoices,allowEmpty:true});
      }
    }
  }
  if (needsInput.length) return {needsInput,workflowState:workflowState()};
  Object.assign(selections,{quantity,template,office,print_method:printMethod});

  const applicantName = optionalRosterText(roster,ROSTER.name) || actor.name || actor.userid;
  const contractCompany = optionalRosterText(roster,ROSTER.contractCompany);
  const rosterPrintValues = {
    [F.nameEnglish]:optionalRosterText(roster,ROSTER.name),
    [F.titleEnglish]:optionalRosterText(roster,ROSTER.title),
    [F.emailEnglish]:optionalRosterText(roster,ROSTER.email),
    [F.mobileEnglish]:optionalRosterText(roster,ROSTER.mobile),
    [F.nameChinese]:optionalRosterText(roster,ROSTER.chineseName),
    [F.titleChinese]:optionalRosterText(roster,ROSTER.title),
    [F.emailChinese]:optionalRosterText(roster,ROSTER.email),
    [F.mobileChinese]:optionalRosterText(roster,ROSTER.mobile)
  };

  const textValues = {};
  const matchingTemplateRows = templateRows.filter(row => rowHas(row,templateSource.templateField,template));
  const matchingOfficeRows = matchingTemplateRows.filter(row => rowHas(row,templateSource.officeField,office));
  const sourceDefaults = {
    company_name_english:[`template:${template}`,matchingTemplateRows,templateSource.companyNameEnglishField,'英文公司名称'],
    company_name_chinese:[`template:${template}`,matchingTemplateRows,templateSource.companyNameChineseField,'中文公司名称'],
    address_english:[`office:${template}:${office}`,matchingOfficeRows,templateSource.officeAddressEnglishField,'英文地址'],
    address_chinese:[`office:${template}:${office}`,matchingOfficeRows,templateSource.officeAddressChineseField,'中文地址']
  };
  for (const [inputField,[,formField]] of Object.entries(TEXT_FIELDS)) {
    const source = sourceDefaults[inputField];
    textValues[formField] = fills.resolve(input,inputField,source?.[0] || `person:${actor.userid}`,
      () => source ? defaultFromSource(source[1],source[2],inputField,source[3],needsInput)
        : rosterPrintValues[formField] || '');
  }
  if (needsInput.length) return {needsInput,workflowState:workflowState()};

  if (office === '上环办公室') {
    const requested = input.sheung_wan_address;
    C.check(requested === undefined || ['keep','alternate'].includes(requested), 'BUSINESS_CARD_ADDRESS_CHOICE_INVALID');
    if (!addressChoice && (Object.hasOwn(input,'address_english') || Object.hasOwn(input,'address_chinese'))) addressChoice = 'custom';
    if (!addressChoice && requested === undefined) {
      return {needsInput:[{field:'sheung_wan_address',message:'上环办公室有两个地址，另一个为 Room 4309-4310/09-10室，是否替换房间号？',
        choices:[{value:'keep',label:'保留当前地址'},{value:'alternate',label:'改用另一个房间号'}]}],workflowState:workflowState()};
    }
    // Reapplying the same room replacement is intentional: submit revalidates
    // the original explicit input against the saved state as well.
    if (requested === 'alternate') {
      for (const [inputField,formField,pattern,replacement] of [
        ['address_english',F.addressEnglish,/\bRooms?\s+\d+[A-Za-z]?(?:\s*[-–/]\s*\d+[A-Za-z]?)*\b/i,'Room 4309-4310'],
        ['address_chinese',F.addressChinese,/\d+[A-Za-z]?(?:\s*[-–/]\s*\d+[A-Za-z]?)*\s*室/,'09-10室']
      ]) {
        const value = textValues[formField];
        if (!value) continue;
        if (!pattern.test(value)) {
          needsInput.push({field:inputField,message:'当前地址无法明确识别房间号，请补充替换后的完整地址；其他名片内容保持不变。'});
        } else {
          textValues[formField] = fills.resolve({[inputField]:value.replace(pattern,replacement)},inputField,
            sourceDefaults[inputField][0],()=>'');
        }
      }
      if (needsInput.length) return {needsInput,workflowState:workflowState()};
    }
    if (requested !== undefined) addressChoice = requested;
  }

  let hrIds = [];
  if (contractCompany) {
    const hrRows = await ctx.query(executorSource.formUuid,
      {[executorSource.companyField]:contractCompany},
      [executorSource.companyField,executorSource.hrBusinessCardField,executorSource.hrBusinessCardField + '_id']);
    C.check(Array.isArray(hrRows), 'BUSINESS_CARD_HR_SOURCE_INVALID', '公司HR人员来源暂不可用。');
    hrIds = employeeIds(hrRows,executorSource,contractCompany);
  }

  const formData = {
    [F.applicant]:[actor.userid],
    [F.applicantId]:actor.userid,
    [F.department]:[departmentId],
    [F.applicationDate]:ctx.todayMs,
    [F.quantity]:quantity,
    [F.template]:template,
    [F.printMethod]:printMethod,
    [F.office]:office,
    [F.approvalCompany]:contractCompany,
    [F.hr]:hrIds,
    ...textValues
  };
  const verification = hrIds.length ? {} : {optionalEmptyFields:[F.hr]};
  const manualResolved = {...input};
  if (quantity) manualResolved.quantity = quantity;
  if (template) manualResolved.template = template;
  if (printMethod) manualResolved.print_method = printMethod;
  if (office) manualResolved.office = office;

  return {
    formData,departmentId,attachmentField,attachmentPreviewField:'PDF文件',verification,
    preview:{
      流程:title,申请人:applicantName,申请日期:ctx.today,名片数量:quantity,
      名片模板:template,打印方式:printMethod,办公场所:office,用途:textValues[F.purpose],
      邮寄地址:textValues[F.mailingAddress],
      英文名片:{公司:textValues[F.companyNameEnglish],姓名:textValues[F.nameEnglish],职位:textValues[F.titleEnglish],
        电邮:textValues[F.emailEnglish],手机:textValues[F.mobileEnglish],固定电话:textValues[F.landlineEnglish],地址:textValues[F.addressEnglish]},
      中文名片:{公司:textValues[F.companyNameChinese],姓名:textValues[F.nameChinese],职位:textValues[F.titleChinese],
        电邮:textValues[F.emailChinese],手机:textValues[F.mobileChinese],固定电话:textValues[F.landlineChinese],地址:textValues[F.addressChinese]},
      备注:textValues[F.remarks]
    },
    // Editable defaults are persisted separately from explicit input and from
    // continuously refreshed identity/department/HR facts.
    resolvedInputs:manualResolved,
    workflowState:workflowState()
  };
}

module.exports = {key,title,formUuid,attachmentField,policy,requirements,prepare,partialUpdates:true};
