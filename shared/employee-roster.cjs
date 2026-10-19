'use strict';

// Pure roster contract. Authentication, connector transport and the current
// employee-picker selection belong to runtime; business defaults stay in flows.
const {check} = require('../scripts/lib/common.cjs');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const own = (value, key) => Object.hasOwn(value, key);

function fieldList(fields, code = 'ROSTER_FIELD_DENIED') {
  check(Array.isArray(fields) && fields.length > 0 && fields.length <= 100, code);
  check(fields.every(field => typeof field === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9_-]{0,159}$/.test(field))
    && new Set(fields).size === fields.length, code);
  return Object.freeze([...fields]);
}

function permittedFields(requested, permitted) {
  const fields = fieldList(requested);
  const allow = fieldList(permitted, 'ROSTER_POLICY_INVALID');
  check(fields.every(field => allow.includes(field)), 'ROSTER_FIELD_DENIED');
  return fields;
}

function rosterPolicy(policy) {
  check(object(policy), 'ROSTER_POLICY_INVALID');
  const self = fieldList(policy.rosterFields, 'ROSTER_POLICY_INVALID');
  let selected = null;
  if (own(policy, 'selectedEmployeeRosterFields')) {
    check(policy.employeeSelection === true, 'ROSTER_POLICY_INVALID');
    selected = fieldList(policy.selectedEmployeeRosterFields, 'ROSTER_POLICY_INVALID');
  }
  return Object.freeze({self, selected});
}

function userId(value) {
  check(typeof value === 'string' && /^[A-Za-z0-9_.@-]{1,160}$/.test(value), 'ROSTER_QUERY_INVALID');
  return value;
}

// Existing page connector uses the legacy snake_case, comma-separated Query
// contract. Never omit the filter, pass an empty list, or expand it on failure.
function connectorQuery({agentId, subject, fields, permitted}) {
  check(/^\d+$/.test(String(agentId)), 'ROSTER_QUERY_INVALID');
  return {Query:{agentid:agentId, userid_list:userId(subject),
    field_filter_list:permittedFields(fields, permitted).join(',')}};
}

function assertConnectorQuery(inputs, {agentId, subject, permitted}) {
  check(object(inputs) && object(inputs.Query)
    && Object.keys(inputs).every(key => ['Content-Type','Query'].includes(key))
    && inputs['Content-Type'] === 'application/json'
    && Object.keys(inputs.Query).every(key => ['agentid','userid_list','field_filter_list'].includes(key)),
  'ROSTER_QUERY_INVALID');
  check(String(inputs.Query.agentid) === String(agentId)
    && inputs.Query.userid_list === userId(subject), 'ROSTER_QUERY_INVALID');
  check(typeof inputs.Query.field_filter_list === 'string', 'ROSTER_FIELD_DENIED');
  return permittedFields(inputs.Query.field_filter_list.split(','), permitted);
}

function alias(row, legacy, modern, code = 'ROSTER_FORMAT_INVALID') {
  if (own(row, legacy) && own(row, modern)) {
    check(JSON.stringify(row[legacy]) === JSON.stringify(row[modern]), code);
  }
  return own(row, legacy) ? row[legacy] : row[modern];
}

// Both documented new API and the existing connector shapes normalize to one
// internal row. Only explicitly requested field/value properties survive.
function projectRoster(response, {subject, corpId, fields}) {
  const requested = new Set(fieldList(fields));
  check(object(response) && response.success !== false
    && [undefined, 0, '0'].includes(response.errcode), 'CONNECTOR_SOURCE_FAILED');
  check(Array.isArray(response.result) && response.result.length === 1
    && object(response.result[0]), 'ROSTER_IDENTITY_MISMATCH');
  const row = response.result[0];
  check(alias(row, 'userid', 'userId', 'ROSTER_IDENTITY_MISMATCH') === userId(subject), 'ROSTER_IDENTITY_MISMATCH');
  check(typeof corpId === 'string' && corpId.length > 0, 'ROSTER_COMPANY_MISMATCH');
  for (const key of ['corp_id','corpId']) {
    if (own(row, key)) check(row[key] === corpId, 'ROSTER_COMPANY_MISMATCH');
  }
  const rows = alias(row, 'field_data_list', 'fieldDataList');
  check(Array.isArray(rows), 'ROSTER_FORMAT_INVALID');
  const seen = new Set(), projected = [];
  for (const field of rows) {
    check(object(field), 'ROSTER_FORMAT_INVALID');
    const code = alias(field, 'field_code', 'fieldCode');
    check(typeof code === 'string', 'ROSTER_FORMAT_INVALID');
    if (!requested.has(code)) continue;
    check(!seen.has(code), 'ROSTER_FIELD_AMBIGUOUS');
    seen.add(code);
    const entries = alias(field, 'field_value_list', 'fieldValueList');
    check(Array.isArray(entries), 'ROSTER_FORMAT_INVALID');
    projected.push({field_code:code, field_value_list:entries.map(entry => {
      check(object(entry), 'ROSTER_FORMAT_INVALID');
      const value = {};
      for (const key of ['value','label']) if (own(entry, key)) value[key] = structuredClone(entry[key]);
      const index = alias(entry, 'item_index', 'itemIndex');
      if (index !== undefined) value.item_index = index;
      return value;
    })});
  }
  // Missing fields remain missing: whether a field is required is a business
  // rule, never a reason to retry the connector without a filter.
  return {userid:subject, corp_id:corpId, field_data_list:projected};
}

// Maintenance-only: consume an already obtained official meta/get response.
// Metadata defines names/groups, not permissions, types or required inputs.
// No runtime metadata fetch and no automatic expansion of workflow fields.
function inspectMetadata(response, fields) {
  const requested = fieldList(fields);
  check(object(response) && [0, '0'].includes(response.errcode)
    && response.success !== false && Array.isArray(response.result), 'ROSTER_METADATA_INVALID');
  const known = new Map();
  for (const group of response.result) {
    check(object(group) && typeof group.group_id === 'string'
      && typeof group.group_name === 'string' && Array.isArray(group.field_meta_info_list), 'ROSTER_METADATA_INVALID');
    for (const field of group.field_meta_info_list) {
      check(object(field) && typeof field.field_code === 'string', 'ROSTER_METADATA_INVALID');
      if (!requested.includes(field.field_code)) continue;
      check(!known.has(field.field_code) && typeof field.field_name === 'string'
        && typeof group.detail === 'boolean' && typeof field.derived === 'boolean', 'ROSTER_METADATA_INVALID');
      known.set(field.field_code, Object.freeze({fieldCode:field.field_code, fieldName:field.field_name,
        groupId:group.group_id, groupName:group.group_name, detail:group.detail, derived:field.derived}));
    }
  }
  const missingFields = requested.filter(field => !known.has(field));
  return {compatible:missingFields.length === 0, missingFields,
    fields:requested.filter(field => known.has(field)).map(field => known.get(field))};
}

module.exports = {fieldList, permittedFields, rosterPolicy, connectorQuery, assertConnectorQuery, projectRoster, inspectMetadata};
