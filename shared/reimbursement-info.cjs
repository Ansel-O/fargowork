'use strict';

// Reusable reimbursement sources. Workflows supply fixed source/field bindings;
// this module has no company IDs, bank field IDs, amount rules or required rules.
const {check} = require('../scripts/lib/common.cjs');
const {initialValues} = require('./initial-values.cjs');
const {projectRoster, fieldList} = require('./employee-roster.cjs');
const {matchingRows, distinctValues} = require('./scoped-catalog.cjs');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const absent = value => value === undefined || value === null || value === '';
const safeKey = value => typeof value === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)
  && !['__proto__', 'prototype', 'constructor'].includes(value);

function currentActor(actor) {
  check(object(actor) && typeof actor.userid === 'string' && actor.userid.trim()
    && typeof actor.corp_id === 'string' && actor.corp_id, 'CURRENT_IDENTITY_MISSING');
  return actor;
}
function texts(value) {
  if (absent(value)) return [];
  if (Array.isArray(value)) return value.flatMap(texts);
  if (object(value)) return ['label', 'name', 'value', 'key'].flatMap(key => texts(value[key]));
  check(typeof value === 'string' || typeof value === 'number', 'SOURCE_VALUE_INVALID');
  return [String(value).trim()].filter(Boolean);
}

async function paymentCompanyChoices(ctx, source) {
  const actor = currentActor(ctx?.subject ?? ctx?.actor);
  check(object(source) && typeof source.formUuid === 'string' && source.formUuid
    && safeKey(source.employeeIdField) && safeKey(source.companyField), 'REIMBURSEMENT_SOURCE_INVALID');
  const rows = await matchingRows(ctx, source.formUuid, {[source.employeeIdField]: actor.userid}, [source.companyField]);
  // User IDs are exact identifiers: catalog display normalization is not enough.
  // Never fall back to a global company list when this employee has no mapping.
  return distinctValues(rows.filter(row => texts(row[source.employeeIdField]).includes(actor.userid)), source.companyField);
}

function personalPaymentDefaults({actor, input, roster, previous, fields, stringFields = []}) {
  currentActor(actor);
  check(object(input) && object(fields) && Object.keys(fields).length > 0
    && Object.keys(fields).every(safeKey), 'REIMBURSEMENT_FIELDS_INVALID');
  const requested = fieldList(Object.values(fields), 'REIMBURSEMENT_FIELDS_INVALID');
  check(Array.isArray(stringFields) && stringFields.every(key => Object.hasOwn(fields, key)), 'REIMBURSEMENT_FIELDS_INVALID');
  // Consume the existing bounded roster response; never issue a second query or
  // broaden its fields. Reject another employee/company before using any value.
  const ownRoster = projectRoster({result: [roster]}, {subject: actor.userid, corpId: actor.corp_id, fields: requested});
  const byField = new Map(ownRoster.field_data_list.map(row => [row.field_code, row.field_value_list]));
  const defaults = initialValues(previous, Object.keys(fields));
  for (const entry of Object.values(defaults.snapshot().fields)) {
    check(entry.source === actor.userid, 'REIMBURSEMENT_DEFAULT_IDENTITY_MISMATCH');
  }
  function sourceValue(field, strictString) {
    const entries = byField.get(field);
    if (!entries?.length || entries.every(entry => absent(entry.value) && absent(entry.label))) return '';
    const entry = entries[0], raw = !absent(entry.value) ? entry.value : entry.label;
    // A numeric account may already have lost zeros or long digits upstream.
    // Leave that initial value empty so the employee can supply exact text.
    if (strictString && typeof raw !== 'string') return '';
    const values = [...new Set(texts(raw))];
    check(values.length === 1, 'ROSTER_FIELD_MISSING');
    return values[0];
  }
  const values = {};
  for (const [inputField, rosterField] of Object.entries(fields)) {
    values[inputField] = defaults.resolve(input, inputField, actor.userid, () => sourceValue(rosterField, stringFields.includes(inputField)));
  }
  return {values, state: defaults.snapshot()};
}

module.exports = {paymentCompanyChoices, personalPaymentDefaults};
