'use strict';

const {check} = require('../scripts/lib/common.cjs');

function departmentId(value) {
  check((typeof value === 'string' && /^\d+$/.test(value))
    || typeof value === 'number', 'DEPARTMENT_ID_INVALID');
  const id = Number(value);
  check(Number.isSafeInteger(id) && id > 0, 'DEPARTMENT_ID_INVALID');
  return String(id);
}

function normalizeChain(value) {
  check(Array.isArray(value), 'DEPARTMENT_CHAIN_INVALID');
  let chain;
  try { chain = value.map(departmentId); }
  catch { check(false, 'DEPARTMENT_CHAIN_INVALID'); }
  check(new Set(chain).size === chain.length, 'DEPARTMENT_CHAIN_INVALID');
  return Object.freeze(chain);
}

// Preserve the provider's leaf-to-root order. Do not insert the queried
// department or assume that every response contains it.
async function queryDepartmentChain(ctx, {connector, departmentId: id}) {
  const normalized = departmentId(id);
  check(typeof connector === 'string' && connector.length > 0,
    'DEPARTMENT_CONNECTOR_REQUIRED');
  const response = await ctx.invoke(connector, {
    'Content-Type': 'application/json',
    Body: {dept_id: Number(normalized)}
  });
  check(response && typeof response === 'object'
    && [0, '0'].includes(response.errcode) && response.success !== false,
  'DEPARTMENT_CHAIN_UNAVAILABLE');
  return normalizeChain(response.result?.parent_id_list);
}

// Negative indexes count from the root end: -1 root, -2 next level, -3 next.
// A missing level is a normal result; its business meaning belongs to the caller.
function departmentAt(chain, index) {
  check(Number.isSafeInteger(index), 'DEPARTMENT_CHAIN_INDEX_INVALID');
  return normalizeChain(chain).at(index) ?? null;
}

module.exports = {queryDepartmentChain, departmentAt};
