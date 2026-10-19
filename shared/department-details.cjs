'use strict';

const {check} = require('../scripts/lib/common.cjs');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function departmentId(value) {
  check(typeof value === 'number'
    || typeof value === 'string' && /^\d+$/.test(value), 'DEPARTMENT_ID_INVALID');
  const id = Number(value);
  check(Number.isSafeInteger(id) && id > 0, 'DEPARTMENT_ID_INVALID');
  return String(id);
}

function managerIds(value) {
  check(Array.isArray(value) && value.every(id => typeof id === 'string'
    && /^[A-Za-z0-9_.@-]{1,160}$/.test(id))
    && new Set(value).size === value.length, 'DEPARTMENT_MANAGERS_INVALID');
  return Object.freeze([...value]);
}

// Preserve the service order. Missing/malformed data is not an empty department,
// and a response for another department must not supply a derived person.
function normalizeDepartmentDetails(response, {departmentId: requested}) {
  const expected = departmentId(requested);
  check(object(response) && [0, '0'].includes(response.errcode)
    && response.success !== false, 'DEPARTMENT_DETAILS_UNAVAILABLE');
  check(object(response.result), 'DEPARTMENT_DETAILS_INVALID');
  // The configured page connector may project just the manager list. Validate
  // an echoed ID when supplied; omission does not change the queried department.
  if (Object.hasOwn(response.result, 'dept_id')) {
    let actual;
    try { actual = departmentId(response.result.dept_id); }
    catch { check(false, 'DEPARTMENT_DETAILS_INVALID'); }
    check(actual === expected, 'DEPARTMENT_ID_MISMATCH');
  }
  return Object.freeze({departmentId:expected,
    managerUserIds:managerIds(response.result.dept_manager_userid_list)});
}

async function queryDepartmentDetails(ctx, {connector, departmentId: requested}) {
  const id = departmentId(requested);
  check(typeof connector === 'string' && connector.length > 0,
    'DEPARTMENT_CONNECTOR_REQUIRED');
  const response = await ctx.invoke(connector, {
    'Content-Type':'application/json', Body:{dept_id:Number(id)}
  });
  return normalizeDepartmentDetails(response, {departmentId:id});
}

// Index selection is a caller's rule; this tool does not choose a default person.
function departmentManagerAt(details, index) {
  check(object(details), 'DEPARTMENT_DETAILS_INVALID');
  departmentId(details.departmentId);
  check(Number.isSafeInteger(index), 'DEPARTMENT_MANAGER_INDEX_INVALID');
  return managerIds(details.managerUserIds).at(index) ?? null;
}

module.exports = {normalizeDepartmentDetails, queryDepartmentDetails, departmentManagerAt};
