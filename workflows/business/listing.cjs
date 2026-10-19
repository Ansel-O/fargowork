'use strict';

const C = require('../leave-trip-common.cjs');
const SOURCES = require('../../config/sources.json');
const CONFIG = require('../../config/workflows/business/listing.json');
const {queryDepartmentChain, departmentAt} = require('../../shared/department-hierarchy.cjs');
const {resolveEmployee, requiredDepartmentId, displayDepartment} = require('../../shared/employee-selection.cjs');

const key = CONFIG.key;
const title = CONFIG.title;
const formUuid = CONFIG.target.formUuid;
const F = Object.freeze({...CONFIG.fields});
const R = SOURCES.rosterFields;
const COMPLIANCE = Object.freeze({...SOURCES.listingCompliance});
const APP = require('../../config/company.json').appType;

const policy = Object.freeze({
  employeeSelection: CONFIG.policy.employeeSelection === true,
  selectedEmployeeRosterFields: Object.freeze([...CONFIG.policy.selectedEmployeeRosterFields]),
  dataForms: [COMPLIANCE.formUuid],
  rosterFields: [...CONFIG.policy.rosterFields],
  connectors: Object.freeze(Object.fromEntries(Object.entries(CONFIG.policy.connectors)
    .map(([alias, sourceName]) => [alias, SOURCES.connectors[sourceName]])))
});

const requirements = Object.freeze({
  required: [
    {field: 'license_type', label: '牌照类型（按员工原话填写）', type: 'text', nativeRequired: true}
  ],
  optional: [
    {field: 'owner_name', label: '挂牌人姓名（不填时默认为本人）', type: 'employee-search'},
    {field: 'owner_english_name', label: '挂牌人英文名（可修改）'},
    {field: 'owner_email', label: '挂牌人邮箱'},
    {field: 'owner_chinese_name', label: '挂牌人中文名'},
    {field: 'owner_selection', label: '员工候选选择（按候选值原样传回）', type: 'employee-choice'}
  ],
  notes: [
    '实际提交流程的操作者固定为当前登录账号；挂牌人按原生员工选择器可见的员工结果选择，默认本人。',
    '候选按姓名显示部门路径，不显示 userid 或部门 ID。仅挂牌允许读取所选人员的必要花名册字段，自动填写姓名、中文名、电邮及主部门。',
    '同名或部分匹配时按姓名/部门确认人员；一个人有多个部门时默认取花名册主部门。选择值只用于本地匹配，人员或部门结果变更会使旧选择失效。',
    '牌照类型由员工提供原话；宜搭字段自身为必填，本流程不复刻额外的必填拦截。',
    '挂牌情况说明为隐藏必填字段，不向申请人收集，也不写入。',
    '父部门层级不足时不生成部门编码；合规人员为空时继续，不增加门禁。'
  ]
});

const INPUTS = [
  'owner_name', 'owner_selection', 'owner_english_name', 'owner_email',
  'owner_chinese_name', 'license_type'
];

function boundedText(value, code, max = 200) {
  const result = C.text(value, code);
  C.check(result.length <= max && !/[\x00-\x1f\x7f]/.test(result), code, '文字长度或格式无效。');
  return result;
}

function optionalRosterValue(roster, field) {
  const rows = roster.get(field);
  if (!Array.isArray(rows) || !rows.length) return '';
  const values = [...new Set(rows.flatMap(entry => {
    const primary = entry?.value;
    return C.values(C.absent(primary) ? entry?.label : primary);
  }))];
  C.check(values.length <= 1, 'ROSTER_FIELD_AMBIGUOUS', '花名册字段不唯一，请联系 HR 核查。');
  return values[0] || '';
}

async function resolveOwner(input, actor, applicantName, ctx) {
  return resolveEmployee(input, ctx, {
    workflowKey: key, appType: APP, actor,
    nameField: 'owner_name', selectionField: 'owner_selection',
    defaultToSelf: true, selfName: applicantName,
    messages: {
      namePrompt: '请输入挂牌人姓名。',
      changed: '员工或部门资料已变化，请重新选择挂牌人及部门。',
      choose: '请按姓名和部门确认挂牌人。'
    },
    errorCodes: {
      sourceInvalid: 'LISTING_EMPLOYEE_SOURCE_INVALID', searchTooBroad: 'LISTING_EMPLOYEE_SEARCH_TOO_BROAD',
      sourceAmbiguous: 'LISTING_EMPLOYEE_SOURCE_AMBIGUOUS', matchUnresolvable: 'LISTING_EMPLOYEE_MATCH_UNRESOLVABLE',
      nameInvalid: 'LISTING_OWNER_NAME_INVALID', selectionInvalid: 'LISTING_OWNER_SELECTION_INVALID'
    }
  });
}

function mainDepartment(roster) {
  const id = requiredDepartmentId(C.rosterValue(roster, R.mainDepartment, 'value'));
  // Validate membership when supplied; do not add a new required-field gate
  // solely because the provider omitted an optional department-list field.
  if (roster.get(R.departments)?.some(entry => !C.absent(entry.value) || !C.absent(entry.label))) {
    C.department(roster);
  }
  return id;
}

function departmentName(roster, owner, id) {
  const fromDirectory = owner.departments.find(dept => dept.id === id)?.path;
  if (fromDirectory) return fromDirectory;
  const mainEntry = roster.get(R.mainDepartment)?.[0];
  const mainLabel = displayDepartment(C.values(mainEntry?.label ?? mainEntry?.text ?? '')[0]);
  if (mainLabel) return mainLabel;
  const names = [...new Set((roster.get(R.departmentNames) || []).flatMap(entry =>
    C.values(C.absent(entry.value) ? entry.label : entry.value)).map(displayDepartment).filter(Boolean))];
  return names.length === 1 ? names[0] : '';
}

function memberIds(value) {
  if (C.absent(value) || Array.isArray(value) && !value.length) return [];
  if (Array.isArray(value)) return value.flatMap(memberIds);
  if (C.object(value)) {
    const id = value.userid ?? value.userId ?? value.value ?? value.id ?? value.key;
    C.check(!C.absent(id), 'LISTING_COMPLIANCE_SOURCE_INVALID', '合规人员来源缺少稳定人员 ID。');
    return memberIds(id);
  }
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return memberIds(parsed);
    } catch {}
  }
  C.check(typeof value === 'string' || typeof value === 'number', 'LISTING_COMPLIANCE_SOURCE_INVALID');
  const result = String(value).trim();
  C.check(result.length > 0 && result.length <= 160 && !/\s/.test(result), 'LISTING_COMPLIANCE_SOURCE_INVALID');
  return [result];
}

async function parentDepartmentCode(ctx, deptId) {
  if (!deptId) return '';
  const chain = await queryDepartmentChain(ctx, {
    connector: CONFIG.departmentHierarchy.connector,
    departmentId: deptId
  });
  return departmentAt(chain, CONFIG.departmentHierarchy.index) ?? '';
}

async function compliancePeople(ctx, code) {
  if (!code) return [];
  const searchCode = Number(code);
  const rows = await ctx.query(COMPLIANCE.formUuid,
    {[COMPLIANCE.departmentCodeField]: searchCode},
    [COMPLIANCE.departmentCodeField, COMPLIANCE.peopleField, COMPLIANCE.peopleField + '_id']);
  C.check(Array.isArray(rows), 'LISTING_COMPLIANCE_SOURCE_INVALID', '挂牌合规人员资料暂时无法读取。');
  const exactRows = rows.filter(row => {
    if (!C.object(row) || C.absent(row[COMPLIANCE.departmentCodeField])) return false;
    try { return C.number(row[COMPLIANCE.departmentCodeField]) === searchCode; }
    catch { return false; }
  });
  const ids = [];
  for (const row of exactRows) {
    const values = memberIds(row[COMPLIANCE.peopleField + '_id']);
    ids.push(...values);
  }
  return [...new Set(ids)];
}

async function prepare(input, ctx) {
  C.inputKeys(input, INPUTS);
  const actor = C.identity(ctx);
  const schema = C.assertFields(await ctx.schema(), F);
  const ownerSelector = schema.get(F.applicant);
  C.check(ownerSelector?.componentName === 'EmployeeField'
    && ownerSelector.props?.multiple === false
    && ownerSelector.props?.userRangeType === 'ALL'
    && ownerSelector.props?.complexValue?.formula === 'USER()',
  'LISTING_EMPLOYEE_SELECTOR_CHANGED', '挂牌人原生选人字段发生变化，请更新技能包。');
  const ownerDepartmentField = schema.get(F.ownerDepartment);
  C.check(ownerDepartmentField?.componentName === 'DepartmentSelectField'
    && ownerDepartmentField.props?.mode === 'single'
    && ownerDepartmentField.props?.multiple === false
    && ownerDepartmentField.props?.complexValue?.formula === `DeptBuilder(#{${F.applicant}})`,
  'LISTING_DEPARTMENT_LINKAGE_CHANGED', '挂牌人部门联动发生变化，请更新技能包。');

  const roster = C.rosterFields(await ctx.roster(policy.rosterFields), actor);
  const applicantName = C.rosterValue(roster, R.name, 'value');
  const applicantDepartment = mainDepartment(roster);
  const owner = await resolveOwner(input, actor, applicantName, ctx);
  if (owner.needsInput) return owner;

  const ownerRoster = owner.userId === actor.userid ? roster
    : C.rosterFields(await ctx.rosterForSelectedEmployee(owner.userId),
      {userid:owner.userId, corp_id:actor.corp_id});
  const ownerDepartment = mainDepartment(ownerRoster);
  const ownerName = optionalRosterValue(ownerRoster, R.name) || owner.name;

  const ownerEnglishName = C.absent(input.owner_english_name)
    ? ownerName : boundedText(input.owner_english_name, 'LISTING_OWNER_ENGLISH_NAME_INVALID');
  const ownerEmail = C.absent(input.owner_email)
    ? optionalRosterValue(ownerRoster, R.email)
    : boundedText(input.owner_email, 'LISTING_OWNER_EMAIL_INVALID');
  const ownerChineseName = C.absent(input.owner_chinese_name)
    ? optionalRosterValue(ownerRoster, R.businessCardChineseName)
    : boundedText(input.owner_chinese_name, 'LISTING_OWNER_CHINESE_NAME_INVALID');
  // The native form is already required. Keep employee wording intact and let
  // the platform's own validation remain authoritative.
  const licenseType = C.absent(input.license_type) ? ''
    : boundedText(input.license_type, 'LISTING_LICENSE_TYPE_INVALID');

  const code = await parentDepartmentCode(ctx, ownerDepartment);
  const compliance = await compliancePeople(ctx, code);
  const formData = {
    [F.applicant]: [owner.userId],
    [F.applicationDate]: ctx.todayMs,
    [F.ownerEnglishName]: ownerEnglishName,
    [F.ownerEmail]: ownerEmail,
    [F.ownerChineseName]: ownerChineseName,
    [F.ownerDepartment]: [ownerDepartment],
    [F.licenseType]: licenseType,
    [F.parentDepartmentCode]: code,
    [F.compliance]: compliance
  };
  const optionalEmptyFields = [];
  if (!ownerEmail) optionalEmptyFields.push(F.ownerEmail);
  if (!ownerChineseName) optionalEmptyFields.push(F.ownerChineseName);
  if (!code) optionalEmptyFields.push(F.parentDepartmentCode);
  if (!compliance.length) optionalEmptyFields.push(F.compliance);

  return {
    formData,
    departmentId: applicantDepartment,
    verification: {optionalEmptyFields},
    resolvedInputs: {
      ...input,
      owner_name: input.owner_name || applicantName,
      owner_selection: input.owner_selection || null,
      owner_english_name: ownerEnglishName,
      owner_email: ownerEmail,
      owner_chinese_name: ownerChineseName,
      license_type: licenseType
    },
    preview: {
      流程: title,
      申请人: applicantName,
      申请日期: ctx.today,
      挂牌给: ownerName,
      挂牌人部门: departmentName(ownerRoster, owner, ownerDepartment),
      挂牌人英文名: ownerEnglishName,
      挂牌人邮箱: ownerEmail,
      挂牌人中文名: ownerChineseName,
      牌照类型: licenseType,
      流水号: '由宜搭生成'
    }
  };
}

module.exports = {key, title, formUuid, policy, requirements, prepare};
