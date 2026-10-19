'use strict';

const {check} = require('../scripts/lib/common.cjs');
const nonempty = value => typeof value === 'string' && value.length > 0;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function projectionFields(fields) {
  check(Array.isArray(fields) && fields.length > 0 && fields.length <= 100
    && fields.every(field => typeof field === 'string' && /^[A-Za-z][A-Za-z0-9]*Field_[A-Za-z0-9_]+$/.test(field))
    && new Set(fields).size === fields.length, 'RELATED_SOURCE_FIELDS_INVALID');
  return [...fields];
}

// Only fixed workflow policy chooses a scope. A caller cannot supply a user ID,
// form or additional query filters through the association-selection input.
function sourceConstraints(source = {}) {
  check(object(source), 'RELATED_SOURCE_POLICY_INVALID');
  const scope = source.scope === undefined ? 'self' : source.scope;
  check(['self','applicant','visible'].includes(scope), 'RELATED_SOURCE_POLICY_INVALID');
  const statuses = source.statuses === undefined && scope === 'self' ? ['RUNNING','COMPLETED'] : source.statuses;
  const approvedResults = source.approvedResults;
  const validList = (values, pattern) => Array.isArray(values) && values.length > 0
    && values.length <= 20 && values.every(value => typeof value === 'string' && pattern.test(value))
    && new Set(values).size === values.length;
  check(statuses === undefined || validList(statuses, /^[A-Z][A-Z_]{0,39}$/), 'RELATED_SOURCE_POLICY_INVALID');
  check(approvedResults === undefined || validList(approvedResults, /^[A-Za-z][A-Za-z0-9_-]{0,39}$/),
    'RELATED_SOURCE_POLICY_INVALID');
  check(source.applicantField === undefined || scope === 'applicant'
    && typeof source.applicantField === 'string' && /^employeeField_[A-Za-z0-9_]+$/.test(source.applicantField),
  'RELATED_SOURCE_POLICY_INVALID');
  return {scope, ...(statuses === undefined ? {} : {statuses: [...statuses]}),
    ...(approvedResults === undefined ? {} : {approvedResults: [...approvedResults]}),
    ...(source.fields === undefined ? {} : {fields: projectionFields(source.fields)}),
    ...(scope === 'applicant' ? {applicantField: source.applicantField} : {})};
}

// Project only declared business fields after the runtime checks the source
// boundary. Missing upstream fields stay missing; workflows decide requirements.
function projectData(data, fields) {
  const allowed = projectionFields(fields);
  check(object(data), 'RELATED_SOURCE_INVALID');
  const projected = {};
  for (const field of allowed) {
    if (Object.hasOwn(data, field)) projected[field] = structuredClone(data[field]);
  }
  return projected;
}

function queryConstraints(source, actorId) {
  const policy = sourceConstraints(source);
  check(policy.scope !== 'applicant' || nonempty(policy.applicantField), 'RELATED_SOURCE_POLICY_INVALID');
  check(nonempty(actorId), 'RELATED_SOURCE_IDENTITY_MISMATCH');
  return {
    ...(policy.scope === 'self' ? {originatorId: actorId} : {}),
    ...(policy.scope === 'applicant' ? {searchFieldJson: JSON.stringify([{
      key: policy.applicantField, value: actorId, type: 'STRING', operator: 'eq', componentName: 'EmployeeField'
    }])} : {}),
    ...(policy.statuses?.length === 1 ? {instanceStatus: policy.statuses[0]} : {}),
    ...(policy.approvedResults?.length === 1 ? {approvedResult: policy.approvedResults[0]} : {})
  };
}

// Readback exposes member IDs separately from display names. Also accept an
// explicit native member object, but never compare display text as identity.
function applicantIds(data, field) {
  check(object(data), 'RELATED_SOURCE_INVALID');
  const raw = Object.hasOwn(data, field + '_id') ? data[field + '_id'] : undefined;
  if (raw !== undefined && raw !== null) {
    check(Array.isArray(raw) && raw.every(nonempty) && new Set(raw).size === raw.length,
      'RELATED_SOURCE_IDENTITY_MISMATCH');
    return [...raw];
  }
  const members = data[field];
  if (!Array.isArray(members) || members.some(member => !object(member))) return [];
  const ids = members.map(member => {
    const values = ['userId','userid','value'].filter(key => Object.hasOwn(member, key)).map(key => member[key]);
    check(values.length > 0 && values.every(nonempty) && values.every(value => value === values[0]),
      'RELATED_SOURCE_IDENTITY_MISMATCH');
    return values[0];
  });
  check(new Set(ids).size === ids.length, 'RELATED_SOURCE_IDENTITY_MISMATCH');
  return ids;
}

function approvedResult(row) {
  const values = ['approvedResult','processApprovedResult']
    .filter(key => Object.hasOwn(row, key) && row[key] !== undefined && row[key] !== null && row[key] !== '')
    .map(key => row[key]);
  check(values.every(nonempty) && values.every(value => value === values[0]), 'RELATED_SOURCE_RESULT_INVALID');
  return values[0];
}

// The runtime supplies an already identity-bound source. Workflows still
// validate its scope before accepting a selection or constructing references.
function validateCandidates(candidates, {appType, formUuid, actorId,
  scope = 'self', statuses, approvedResults, applicantField, corpId, fields,
  shapeCode = 'RELATED_SOURCE_INVALID', boundaryCode = 'RELATED_SOURCE_IDENTITY_MISMATCH'}) {
  const policy = sourceConstraints({scope, statuses, approvedResults, applicantField, fields});
  check(nonempty(actorId) && (scope === 'self' || nonempty(corpId)), boundaryCode);
  check(Array.isArray(candidates), shapeCode);
  const seen = new Set();
  for (const item of candidates) {
    check(item && item.app_type === appType && item.form_uuid === formUuid
      && item.form_type === 'process' && nonempty(item.originator_userid)
      && (scope !== 'self' || item.originator_userid === actorId)
      && (scope !== 'applicant' || item.applicant_userid === actorId)
      && (corpId === undefined || item.originator_corp_id === corpId)
      && nonempty(item.instance_status) && (!policy.statuses || policy.statuses.includes(item.instance_status))
      && (!policy.approvedResults || policy.approvedResults.includes(item.approved_result))
      && nonempty(item.instance_id) && !seen.has(item.instance_id)
      && typeof item.title === 'string' && typeof item.sub_title === 'string', boundaryCode);
    if (policy.fields) check(object(item.data)
      && Object.keys(item.data).every(field => policy.fields.includes(field)), shapeCode);
    seen.add(item.instance_id);
  }
  return candidates;
}

function processReference(item) {
  check(item && nonempty(item.app_type) && nonempty(item.form_uuid)
    && item.form_type === 'process' && nonempty(item.instance_id)
    && typeof item.title === 'string' && typeof item.sub_title === 'string', 'ASSOCIATION_REFERENCE_INVALID');
  return {appType:item.app_type, formUuid:item.form_uuid, formType:'process',
    instanceId:item.instance_id, title:item.title, subTitle:item.sub_title};
}

// Source fields choose the display meaning. Never use employee _id fields or
// normalize an unknown object into the literal string "[object Object]".
function displayText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) return value.map(displayText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    for (const key of ['label','text','userName','name','zh_CN','zh_TW','en_US']) {
      if (Object.hasOwn(value,key) && value[key] !== value) return displayText(value[key]);
    }
  }
  check(false, 'RELATED_SOURCE_DISPLAY_INVALID');
}

module.exports = {validateCandidates, processReference, displayText, sourceConstraints,
  queryConstraints, applicantIds, approvedResult, projectData};
