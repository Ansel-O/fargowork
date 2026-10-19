'use strict';

const {check} = require('../scripts/lib/common.cjs');

// A draft's editable defaults are distinct from continuously derived facts.
// Source keys are supplied by the workflow, never interpreted by this tool.
function initialValues(previous, allowedFields) {
  const allowed = new Set(allowedFields);
  const saved = {};
  if (previous !== undefined && previous !== null) {
    check(previous.version === 1 && previous.fields && typeof previous.fields === 'object'
      && !Array.isArray(previous.fields), 'INITIAL_VALUES_STATE_INVALID');
    for (const [key, entry] of Object.entries(previous.fields)) {
      check(allowed.has(key) && entry && typeof entry.source === 'string'
        && typeof entry.value === 'string' && typeof entry.manual === 'boolean', 'INITIAL_VALUES_STATE_INVALID');
      saved[key] = {...entry};
    }
  }
  function resolve(input, key, source, defaultValue) {
    check(allowed.has(key) && typeof source === 'string', 'INITIAL_VALUES_FIELD_INVALID');
    if (Object.hasOwn(input, key)) {
      const value = input[key] ?? '';
      check(typeof value === 'string', 'INITIAL_VALUES_TEXT_INVALID');
      saved[key] = {source, value, manual:true};
    } else if (!saved[key]?.manual && saved[key]?.source !== source) {
      const value = defaultValue();
      // Undefined means an unresolved choice; do not freeze an empty default.
      if (value === undefined) return '';
      check(typeof value === 'string', 'INITIAL_VALUES_TEXT_INVALID');
      saved[key] = {source, value, manual:false};
    }
    return saved[key].value;
  }
  return {
    resolve,
    manual: key => saved[key]?.manual === true,
    snapshot: () => ({version:1, fields:JSON.parse(JSON.stringify(saved))})
  };
}

module.exports = {initialValues};
