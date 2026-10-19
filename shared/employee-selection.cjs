'use strict';

const crypto = require('node:crypto');

// Resolves only results returned by the caller's scoped employee directory.
// It does not query a roster, accept a userid override, or grant a new scope.
const SEARCH_LIMIT = 50;
const absent = value => value === undefined || value === null || value === '';
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const normalized = value => String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
function check(condition, code, message) {
  if (!condition) throw Object.assign(new Error(message || code), {code});
}
const DEFAULT_CODES = Object.freeze({
  sourceInvalid: 'EMPLOYEE_SOURCE_INVALID',
  searchTooBroad: 'EMPLOYEE_SEARCH_TOO_BROAD',
  sourceAmbiguous: 'EMPLOYEE_SOURCE_AMBIGUOUS',
  matchUnresolvable: 'EMPLOYEE_MATCH_UNRESOLVABLE',
  nameInvalid: 'EMPLOYEE_NAME_INVALID',
  selectionInvalid: 'EMPLOYEE_SELECTION_INVALID',
  departmentInvalid: 'DEPARTMENT_ID_INVALID'
});
const DEFAULT_MESSAGES = Object.freeze({
  namePrompt: '请输入员工姓名。',
  noMatch: '没有找到匹配的员工，请核对姓名后再试。',
  changed: '员工或部门资料已变化，请重新选择员工及部门。',
  choose: '请按姓名和部门确认员工。'
});

function requiredDepartmentId(value, code = DEFAULT_CODES.departmentInvalid) {
  const raw = typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
  const numeric = /^\d+$/.test(raw) ? Number(raw) : NaN;
  check(Number.isSafeInteger(numeric) && numeric > 0, code,
    '员工目录中的部门资料无法识别，请联系 HR 核查。');
  return raw;
}

function displayDepartment(value) {
  if (typeof value !== 'string') return '';
  const name = value.trim();
  if (!name || /^\d+$/.test(name) || /[\x00-\x1f\x7f]/.test(name)) return '';
  return name.slice(0, 240);
}

function displayName(value, code) {
  check(typeof value === 'string', code, '员工目录未返回可展示的姓名。');
  const name = value.trim();
  check(name.length > 0 && name.length <= 160 && !/[\x00-\x1f\x7f]/.test(name), code);
  return name;
}

function settings(options, ctx) {
  check(object(options) && typeof options.workflowKey === 'string' && /^[a-z][a-z0-9_]*$/.test(options.workflowKey)
    && typeof options.appType === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(options.appType)
    && ['nameField', 'selectionField'].every(key => typeof options[key] === 'string'
      && /^[a-z][a-z0-9_]*$/.test(options[key]))
    && options.nameField !== options.selectionField
    && [undefined, true, false].includes(options.defaultToSelf), 'EMPLOYEE_SELECTION_CONFIG_INVALID');
  const actor = options.actor ?? ctx?.actor;
  check(object(actor) && ['userid', 'corp_id'].every(key => typeof actor[key] === 'string'
    && actor[key].trim() && actor[key].length <= 256 && !/[\x00-\x1f\x7f]/.test(actor[key])),
  'CURRENT_IDENTITY_MISSING');
  const errorCodes = options.errorCodes ?? {}, messages = options.messages ?? {};
  check(object(errorCodes) && Object.entries(errorCodes).every(([key, value]) => Object.hasOwn(DEFAULT_CODES, key)
    && typeof value === 'string' && /^[A-Z][A-Z0-9_-]{0,99}$/.test(value)), 'EMPLOYEE_SELECTION_CONFIG_INVALID');
  check(object(messages) && Object.entries(messages).every(([key, value]) => Object.hasOwn(DEFAULT_MESSAGES, key)
    && typeof value === 'string' && value.trim() && value.length <= 1000 && !/[\x00-\x1f\x7f]/.test(value)),
  'EMPLOYEE_SELECTION_CONFIG_INVALID');
  return {...options, actor: {userid: actor.userid, corp_id: actor.corp_id},
    codes: {...DEFAULT_CODES, ...errorCodes}, messages: {...DEFAULT_MESSAGES, ...messages}};
}

function selectionKey(config, search, userId, departments) {
  return crypto.createHash('sha256').update(JSON.stringify({
    workflow: config.workflowKey, app: config.appType, actor: config.actor.userid, corp: config.actor.corp_id,
    search: normalized(search), userId, departments
  })).digest('hex').slice(0, 32);
}

function employeeChoices(result, config, search) {
  const codes = config.codes;
  check(object(result) && result.success === true && Array.isArray(result.users),
    codes.sourceInvalid, '当前员工选择器资料暂时无法读取。');
  check(result.users.length < SEARCH_LIMIT, codes.searchTooBroad,
    '匹配到的员工较多，请提供更完整的姓名后再选择。');
  const found = new Map();
  for (const row of result.users) {
    check(object(row), codes.sourceInvalid);
    const userId = row.userId;
    check(typeof userId === 'string' && /^[A-Za-z0-9_.@-]{1,160}$/.test(userId),
      codes.sourceInvalid, '员工目录未返回稳定人员标识。');
    const name = displayName(row.userName, codes.sourceInvalid);
    check(Array.isArray(row.departments) && Array.isArray(row.departmentIds),
      codes.sourceInvalid, '员工目录部门资料格式异常。');
    const departments = row.departments.map(dept => {
      check(object(dept), codes.sourceInvalid);
      const id = requiredDepartmentId(dept.id, codes.departmentInvalid);
      const path = displayDepartment(dept.path) || displayDepartment(dept.name);
      check(path, codes.sourceInvalid, '员工部门缺少可展示的名称。');
      return {id, path};
    }).sort((a, b) => a.id.localeCompare(b.id) || a.path.localeCompare(b.path));
    const idSet = [...new Set(row.departmentIds.map(value => requiredDepartmentId(value, codes.departmentInvalid)))].sort();
    const deptSet = [...new Set(departments.map(dept => dept.id))].sort();
    check(JSON.stringify(idSet) === JSON.stringify(deptSet), codes.sourceInvalid,
      '员工目录部门 ID 与名称资料不一致。');
    const token = selectionKey(config, search, userId, departments);
    if (!found.has(userId)) found.set(userId, {userId, name, departments, selection: token,
      label: `${name} · ${departments.map(dept => dept.path).join(' / ') || '部门未提供'}`});
    else {
      const existing = found.get(userId);
      check(existing.name === name && existing.selection === token, codes.sourceAmbiguous,
        '员工目录返回了冲突的姓名或部门资料。');
    }
  }
  const candidates = [...found.values()].sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN')
    || a.selection.localeCompare(b.selection));
  const labels = new Set();
  for (const candidate of candidates) {
    check(!labels.has(candidate.label), codes.matchUnresolvable,
      '员工目录中存在姓名和部门都相同的记录，当前选择结果无法区分，请联系 IT 核查员工目录。');
    labels.add(candidate.label);
  }
  return candidates;
}

function choiceInput(field, message, candidates = []) {
  return {needsInput: [{field, message,
    choices: candidates.map(candidate => ({value: candidate.selection, label: candidate.label}))}]};
}

async function resolveEmployee(input, ctx, options) {
  const config = settings(options, ctx), {codes, messages, nameField, selectionField} = config;
  check(object(input), 'INPUT_INVALID');
  if (absent(input[nameField])) {
    check(absent(input[selectionField]), codes.selectionInvalid);
    if (config.defaultToSelf === true) return {userId: config.actor.userid,
      name: displayName(config.selfName, codes.sourceInvalid), departments: []};
    return choiceInput(nameField, messages.namePrompt);
  }
  check(typeof input[nameField] === 'string' && input[nameField].trim().length > 0
    && input[nameField].trim().length <= 100 && !/[\x00-\x1f\x7f]/.test(input[nameField]),
  codes.nameInvalid, messages.namePrompt);
  check(ctx && typeof ctx.searchEmployees === 'function', codes.sourceInvalid);
  const search = input[nameField].trim();
  const candidates = employeeChoices(await ctx.searchEmployees(search), config, search);
  if (!candidates.length) return choiceInput(nameField, messages.noMatch);
  if (!absent(input[selectionField])) {
    check(typeof input[selectionField] === 'string' && /^[a-f0-9]{32}$/.test(input[selectionField]),
      codes.selectionInvalid);
    const selected = candidates.find(candidate => candidate.selection === input[selectionField]);
    return selected || choiceInput(selectionField, messages.changed, candidates);
  }
  const exact = candidates.filter(candidate => normalized(candidate.name) === normalized(search));
  if (exact.length === 1 && new Set(exact.map(candidate => candidate.userId)).size === 1) return exact[0];
  return choiceInput(selectionField, messages.choose, exact.length ? exact : candidates);
}

module.exports = {resolveEmployee, requiredDepartmentId, displayDepartment};
