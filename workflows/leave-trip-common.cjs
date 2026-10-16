'use strict';

// Shared pure rules for these two workflows. Network access belongs to ctx;
// this module never accepts a URL, form UUID, token, or query subject as input.
const DAY = 86400000;
const OFFSET = 8 * 3600000;
const OFFICE = Object.freeze({form: 'FORM-644A41735FC1422394A3C8197FADD2ACZ7UA', key: 'selectField_m0aq0jqm', admin: 'employeeField_m0aq0jqo'});
const COMPANY = Object.freeze({form: 'FORM-CD63264343264CA9ADB92306F442CCE9NOZ0', key: 'selectField_m0aqkj9x', admin: 'employeeField_m2jtwu7t'});
const ROSTER = Object.freeze({name: 'sys00-name', office: 'sys00-workPlace', main: 'sys00-mainDeptId', departments: 'sys00-deptIds', company: 'sys05-contractCompanyName', status: 'sys01-employeeStatus', group: '78cd4e42-794a-4c1d-9f8a-8c3be8803e55'});
const ROSTER_CONNECTOR = Object.freeze({connectorId: 'Http_5c72b42d47f14a1983767932f6c1d4f1', actionId: 'getUserMessage', type: 'httpConnector', connection: 15597});

function fail(code, message) { throw Object.assign(new Error(message || code), {code}); }
function check(condition, code, message) { if (!condition) fail(code, message); }
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }
function inputKeys(input, allowed) {
  check(object(input), 'INPUT_INVALID', '请提供业务信息对象。');
  check(Object.keys(input).every(key => allowed.includes(key)), 'INPUT_FIELD_NOT_ALLOWED', '输入中包含本流程不接受的字段，请只提供业务信息。');
}
function absent(value) { return value === undefined || value === null || value === ''; }
function text(value, code = 'SOURCE_TEXT_INVALID') {
  check(typeof value === 'string' && value.trim(), code, '必要的文字信息缺失或格式不正确。');
  return value.trim();
}
function optionalText(value, code = 'INPUT_TEXT_INVALID') { return absent(value) ? '' : text(value, code); }
function normalized(value) { return String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US'); }
function values(value) {
  if (absent(value)) return [];
  if (Array.isArray(value)) return value.flatMap(values);
  if (object(value)) return ['label', 'name', 'value', 'key'].flatMap(key => absent(value[key]) ? [] : values(value[key]));
  check(typeof value === 'string' || typeof value === 'number', 'SOURCE_VALUE_INVALID');
  return [String(value).trim()].filter(Boolean);
}
function exact(value, wanted) { return values(value).some(item => normalized(item) === normalized(wanted)); }
function single(value, code = 'SOURCE_TEXT_INVALID') {
  const texts = [...new Set(values(value))];
  check(texts.length === 1, code, '资料来源未返回唯一有效值，请联系管理员。');
  return texts[0];
}
function number(value, {nonnegative = false, code = 'SOURCE_NUMBER_INVALID'} = {}) {
  if (object(value)) value = value.value ?? value.key;
  if (Array.isArray(value)) { check(value.length === 1, code); value = value[0]; }
  check((typeof value === 'number' || (typeof value === 'string' && value.trim())) && Number.isFinite(Number(value)), code, '数值缺失或无效。');
  const result = Number(value);
  check(!nonnegative || result >= 0, code, '数值不能小于零。');
  return result;
}
function date(value, code = 'DATE_INVALID') {
  check(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value), code, '日期须使用 YYYY-MM-DD。');
  const ms = Date.parse(value + 'T00:00:00+08:00');
  check(Number.isFinite(ms) && ms > 0 && new Date(ms + OFFSET).toISOString().slice(0, 10) === value, code, '日期无效。');
  return ms;
}
function sourceDate(value, code = 'SOURCE_DATE_INVALID') {
  if (object(value)) value = value.value ?? value.key;
  if (Array.isArray(value)) { check(value.length === 1, code); value = value[0]; }
  const n = number(value, {code});
  check(Number.isSafeInteger(n) && n >= 1e12, code, '资料来源日期无效，请联系管理员。');
  return n;
}
function dateText(ms) { return new Date(ms + OFFSET).toISOString().slice(0, 10); }
function dayOfWeek(ms) { return new Date(ms + OFFSET).getUTCDay(); }
function inputRange(input) {
  const start = date(input.start_date), end = date(input.end_date);
  check(end >= start, 'DATE_RANGE_INVALID', '结束日期不能早于开始日期。');
  return {start, end};
}
function identity(ctx) {
  check(object(ctx.actor) && typeof ctx.actor.userid === 'string' && ctx.actor.userid.trim() && typeof ctx.actor.corp_id === 'string' && ctx.actor.corp_id, 'CURRENT_IDENTITY_MISSING', '请先完成公司账号登录。');
  check(ctx.todayMs === date(ctx.today), 'CURRENT_DATE_INVALID', '当前业务日期不一致，请重新准备。');
  return ctx.actor;
}
function fields(schema) {
  const result = new Map();
  function walk(value) {
    if (!value || typeof value !== 'object') return;
    if (value.props?.fieldId) result.set(value.props.fieldId, value);
    for (const child of Object.values(value)) walk(child);
  }
  walk(schema);
  return result;
}
function assertFields(schema, fieldMap) {
  const found = fields(schema);
  for (const id of Object.values(fieldMap)) {
    const prefix = id.split('_')[0];
    const expected = prefix[0].toUpperCase() + prefix.slice(1);
    check(found.get(id)?.componentName === expected, 'WORKFLOW_SCHEMA_CHANGED', '流程字段发生变化，请停止提交并更新技能包。');
  }
  return found;
}
function option(found, fieldId, value, expected) {
  check(expected.includes(value), 'INPUT_OPTION_INVALID', '请选择流程允许的选项。');
  const rows = found.get(fieldId)?.props?.dataSource;
  check(Array.isArray(rows) && rows.some(row => row.value === value && row.status !== 'inactive'), 'WORKFLOW_OPTIONS_CHANGED', '流程选项发生变化，请更新技能包。');
}
function rosterFields(raw, actor) {
  check(object(raw) && (raw.userid ?? raw.userId) === actor.userid, 'ROSTER_IDENTITY_MISMATCH', '花名册结果与登录账号不一致。');
  if (raw.corp_id || raw.corpId) check((raw.corp_id ?? raw.corpId) === actor.corp_id, 'ROSTER_COMPANY_MISMATCH');
  const rows = raw.field_data_list ?? raw.fieldDataList;
  check(Array.isArray(rows), 'ROSTER_FORMAT_INVALID', '花名册响应格式异常。');
  const map = new Map();
  for (const row of rows) {
    const key = row.field_code ?? row.fieldCode;
    check(typeof key === 'string' && !map.has(key), 'ROSTER_FIELD_AMBIGUOUS');
    const entries = row.field_value_list ?? row.fieldValueList;
    check(Array.isArray(entries), 'ROSTER_FORMAT_INVALID');
    map.set(key, entries);
  }
  return map;
}
function rosterValue(map, key, prefer = 'label') {
  const fallback = prefer === 'label' ? 'value' : 'label';
  const entries = map.get(key);
  check(Array.isArray(entries) && entries.length, 'ROSTER_FIELD_MISSING', '本人花名册缺少办理所需信息，请联系 HR。');
  const entry = entries[0];
  return single(!absent(entry[prefer]) ? entry[prefer] : entry[fallback], 'ROSTER_FIELD_MISSING');
}
function rosterDepartmentIds(map) {
  const entries = map.get(ROSTER.departments);
  check(Array.isArray(entries) && entries.length, 'DEPARTMENT_MEMBERSHIP_MISSING');
  function expand(value) {
    if (Array.isArray(value)) return value.flatMap(expand);
    if (typeof value === 'string' && value.trim().startsWith('[')) {
      try { const parsed = JSON.parse(value); if (Array.isArray(parsed)) return expand(parsed); } catch {}
    }
    check(typeof value === 'string' || typeof value === 'number', 'DEPARTMENT_MEMBERSHIP_INVALID');
    return String(value).split(/[|,;，；]/).map(v => v.trim()).filter(Boolean);
  }
  const result = [...new Set(entries.flatMap(e => expand(!absent(e.value) ? e.value : e.label)))];
  check(result.length && result.every(id => /^\d+$/.test(id)), 'DEPARTMENT_MEMBERSHIP_INVALID');
  return result;
}
function department(map, requested) {
  const main = rosterValue(map, ROSTER.main, 'value'), all = rosterDepartmentIds(map);
  check(all.includes(main), 'MAIN_DEPARTMENT_NOT_ASSIGNED', '主部门与任职部门不一致，请联系 HR。');
  const selected = absent(requested) ? main : text(requested, 'DEPARTMENT_SELECTION_INVALID');
  check(all.includes(selected), 'DEPARTMENT_NOT_ASSIGNED', '发起部门必须是本人当前任职部门。');
  return {id: selected, main, alternatives: all.filter(id => id !== selected), defaulted: absent(requested)};
}
function required(found, fieldId) {
  const props = found.get(fieldId)?.props;
  check(object(props), 'WORKFLOW_SCHEMA_CHANGED');
  return props.required === true || props.behavior === 'REQUIRED' || (Array.isArray(props.validation) && props.validation.some(rule => rule?.type === 'required' || rule?.required === true || rule?.rule === 'required'));
}
async function contacts(ctx, source, sourceValue, {required = false} = {}) {
  const candidates = await ctx.query(source.form, {[source.key]: sourceValue}, [source.key, source.admin, source.admin + '_id']);
  check(Array.isArray(candidates), 'CONTACTS_INVALID');
  // The published field uses QUERYEQ. searchFormDatas can return partial
  // matches, so discard those instead of binding their contacts or imposing
  // a new mandatory-field rule on an optional native linkage.
  const rows = candidates.filter(row => exact(row[source.key], sourceValue));
  const byId = new Map();
  for (const row of rows) {
    const ids = row[source.admin + '_id'] ?? [], names = row[source.admin] ?? [];
    check(Array.isArray(ids) && Array.isArray(names) && names.length === ids.length, 'CONTACTS_INVALID', '管理员账号配置不完整。');
    ids.forEach((id, index) => {
      text(id, 'CONTACTS_INVALID');
      text(names[index], 'CONTACTS_INVALID');
      check(!byId.has(id) || byId.get(id) === names[index], 'CONTACTS_AMBIGUOUS');
      byId.set(id, names[index]);
    });
  }
  check(!required || byId.size > 0, 'CONTACTS_NOT_FOUND', '办理所需的人员资料缺失，请联系 HR 核查。');
  return {ids: [...byId.keys()], names: [...byId.values()]};
}
module.exports = {DAY, OFFSET, OFFICE, COMPANY, ROSTER, ROSTER_CONNECTOR, fail, check, object, inputKeys, absent, text, optionalText, normalized, values, exact, single, number, date, sourceDate, dateText, dayOfWeek, inputRange, identity, fields, assertFields, option, rosterFields, rosterValue, department, required, contacts};
