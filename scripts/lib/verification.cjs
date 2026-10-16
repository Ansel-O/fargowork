'use strict';

// Pure readback verification for the four workflow contracts. No I/O or writes.
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.length > 0;
const clone = value => JSON.parse(JSON.stringify(value));

function unpack(value, expected) {
  if (typeof value === 'string') {
    if (value.length > 4 * 1024 * 1024) return null;
    try { value = JSON.parse(value); } catch { return null; }
  }
  return (expected === 'array' ? Array.isArray(value) : plain(value)) ? value : null;
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (plain(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value);
}

function readData(instance) {
  const values = ['data', 'formData', 'formDataJson']
    .filter(key => instance[key] !== undefined && instance[key] !== null)
    .map(key => unpack(instance[key], 'object'));
  if (!values.length || values.some(value => value === null)) return null;
  // Conflicting envelopes must not be silently resolved by choosing one.
  return values.every(value => stable(value) === stable(values[0])) ? values[0] : null;
}

function numeric(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length > 100
      || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function numbersEqual(actual, expected) {
  const left = numeric(actual), right = numeric(expected);
  return left !== null && right !== null && left === right;
}

function identifierSetEqual(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)
      || !actual.every(nonempty) || !expected.every(nonempty)) return false;
  const left = new Set(actual), right = new Set(expected);
  // Duplicated identifiers are an unexpected representation, not extra people.
  return left.size === actual.length && right.size === expected.length
    && left.size === right.size && [...left].every(id => right.has(id));
}

function scalarFieldEqual(field, actual, expected) {
  if (/^(numberField|dateField)_/.test(field)) return numbersEqual(actual, expected);
  if (/^(textField|textareaField|selectField|serialNumberField|radioField)_/.test(field)) {
    return typeof actual === 'string' && typeof expected === 'string' && actual === expected;
  }
  return false;
}

function tableEqual(actual, expected) {
  actual = unpack(actual, 'array');
  if (!actual || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return expected.every((row, index) => plain(row) && plain(actual[index]) && Object.keys(row).length > 0
    && Object.keys(row).every(field => scalarFieldEqual(field, actual[index][field], row[field])));
}

function attachmentsEqual(actual, expected) {
  actual = unpack(actual, 'array');
  if (!actual || !Array.isArray(expected) || actual.length !== expected.length) return false;
  return expected.every((file, index) => {
    const saved = actual[index];
    const size = numeric(saved?.size), expectedSize = numeric(file?.size);
    return plain(file) && plain(saved) && nonempty(file.fileUuid) && saved.fileUuid === file.fileUuid
      && nonempty(file.name) && saved.name === file.name
      && Number.isSafeInteger(size) && size >= 0 && size === expectedSize;
  });
}

function associationsEqual(actual,expected) {
  actual=unpack(actual,'array');
  if(!actual||!Array.isArray(expected)||actual.length!==expected.length)return false;
  const keys=['appType','formUuid','formType','instanceId'];
  const id=row=>plain(row)&&keys.every(k=>nonempty(row[k]))?keys.map(k=>row[k]).join('\u0000'):null;
  const wanted=expected.map(id),saved=actual.map(id);
  return wanted.every(nonempty)&&saved.every(nonempty)&&new Set(wanted).size===wanted.length
    &&new Set(saved).size===saved.length&&wanted.every(x=>saved.includes(x));
}

function validateInstance({ instance, snapshot, expectedInstanceId } = {}) {
  const checks = { instanceShape: plain(instance), snapshotShape: plain(snapshot)
    && plain(snapshot.target) && plain(snapshot.actor) && plain(snapshot.formData)
    && Object.keys(snapshot.formData).length > 0 };
  if (!checks.instanceShape || !checks.snapshotShape) return { checks, allPassed: false };
  checks.instanceId = nonempty(expectedInstanceId) && instance.processInstanceId === expectedInstanceId;
  checks.formTarget = nonempty(snapshot.target.formUuid) && instance.formUuid === snapshot.target.formUuid;
  checks.processTarget = nonempty(snapshot.target.processCode) && instance.processCode === snapshot.target.processCode;
  checks.originator = nonempty(snapshot.actor.userid) && plain(instance.originator)
    && instance.originator.userId === snapshot.actor.userid;
  checks.originatorCompany = nonempty(snapshot.actor.corp_id) && instance.originatorCorpId === snapshot.actor.corp_id;
  if (instance.appType !== undefined) checks.applicationTarget = instance.appType === snapshot.target.appType;
  const data = readData(instance);
  checks.formDataShape = data !== null;
  if (!data) return { checks, allPassed: false };
  const references = [];
  for (const [field, expected] of Object.entries(snapshot.formData)) {
    let passed = false;
    if (/^(employeeField|departmentSelectField)_/.test(field)) {
      passed = identifierSetEqual(data[field + '_id'], expected);
    } else if (/^tableField_/.test(field)) {
      passed = tableEqual(data[field], expected);
    } else if (/^attachmentField_/.test(field)) {
      passed = attachmentsEqual(data[field], expected);
      if (passed) references.push(...unpack(data[field], 'array'));
    } else if (/^associationFormField_/.test(field)) {
      passed=associationsEqual(data[field],expected);
    } else {
      passed = scalarFieldEqual(field, data[field], expected);
    }
    checks['field:' + field] = passed;
  }
  const expectedAttachments=Object.entries(snapshot.formData)
    .filter(([field])=>/^attachmentField_/.test(field)).reduce((n,[,files])=>n+(Array.isArray(files)?files.length:0),0);
  checks.nativeAttachmentCount=references.length===expectedAttachments;
  checks.nativeAttachmentUnique=references.length===new Set(references.map(x=>x.fileUuid)).size;
  const allPassed = Object.values(checks).every(value => value === true);
  return { checks, allPassed, ...(allPassed ? {attachmentReferences:clone(references),
    ...(references.length===1?{attachmentReference:clone(references[0])}:{})} : {}) };
}

module.exports = { validateInstance };
