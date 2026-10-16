'use strict';

// Pure readback verification for the four workflow contracts. No I/O or writes.
const plain = value => value !== null && typeof value === 'object'
  && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
const nonempty = value => typeof value === 'string' && value.length > 0;
const clone = value => JSON.parse(JSON.stringify(value));
// These labels are scoped to the checked payment form. The two fields use
// opposite codes, so HIDDEN/NORMAL must never be translated globally.
const PAYMENT_FORM = 'FORM-AEE70BC941234A97B25DE3D5340B7DA7IXT3';
const PAYMENT_ENUMS = Object.freeze({
  radioField_m41da53k: Object.freeze({ HIDDEN: '否', NORMAL: '是' }),
  radioField_m88g5767: Object.freeze({ HIDDEN: '是', NORMAL: '否' }),
});
const absent = value => value === undefined || value === null;
const emptyDisplay = value => absent(value) || value === '' || (Array.isArray(value) && value.length === 0);
const emptyIdentifiers = value => absent(value) || (Array.isArray(value) && value.length === 0);

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

function radioComparison(field, actual, expected, target) {
  const map = target.appType === 'APP_GITLRTH76PM6J4M29F5D' && target.formUuid === PAYMENT_FORM
    ? PAYMENT_ENUMS[field] : undefined;
  if (!map) return actual === expected ? 'verified'
    : ['HIDDEN', 'NORMAL'].includes(actual) && ['HIDDEN', 'NORMAL'].includes(expected) ? 'mismatch' : 'partial';
  const code = value => Object.hasOwn(map, value) ? value
    : Object.keys(map).find(key => map[key] === value);
  const left = code(actual), right = code(expected);
  return left && right ? left === right ? 'verified' : 'mismatch' : 'partial';
}

function fieldComparison(field, data, expected, target, optional) {
  const actual = data[field];
  if (/^(employeeField|departmentSelectField)_/.test(field)) {
    const ids = data[field + '_id'];
    if (Array.isArray(expected) && expected.length === 0) {
      // A nonempty display without identifiers is not an empty person field.
      if (!emptyDisplay(actual)) return 'mismatch';
      if (optional && emptyIdentifiers(ids)) return 'verified';
    }
    if (absent(ids)) return 'partial';
    return identifierSetEqual(ids, expected) ? 'verified' : 'mismatch';
  }
  if (optional && expected === '' && /^(textField|textareaField|selectField|serialNumberField|radioField)_/.test(field)
      && (absent(actual) || actual === '')) return 'verified';
  // An explicitly frozen empty attachment list means no file was selected.
  // Yida can omit that empty component; any returned file must still fail.
  if (/^attachmentField_/.test(field) && Array.isArray(expected) && expected.length === 0) {
    return absent(actual) || unpack(actual, 'array')?.length === 0 ? 'verified' : 'mismatch';
  }
  if (absent(actual)) return 'partial';
  if (/^radioField_/.test(field)) {
    if (typeof actual !== 'string' || typeof expected !== 'string') return 'mismatch';
    return radioComparison(field, actual, expected, target);
  }
  if (/^tableField_/.test(field)) return tableEqual(actual, expected) ? 'verified' : 'mismatch';
  if (/^attachmentField_/.test(field)) return attachmentsEqual(actual, expected) ? 'verified' : 'mismatch';
  if (/^associationFormField_/.test(field)) return associationsEqual(actual, expected) ? 'verified' : 'mismatch';
  if (!/^(numberField|dateField|textField|textareaField|selectField|serialNumberField)_/.test(field)) return 'partial';
  return scalarFieldEqual(field, actual, expected) ? 'verified' : 'mismatch';
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
  const unavailable = () => ({ checks, allPassed: false, status: 'unavailable', attachmentStatus: 'unavailable' });
  if (!checks.instanceShape || !checks.snapshotShape) return unavailable();
  const optional = snapshot.verification?.optionalEmptyFields === undefined ? [] : snapshot.verification.optionalEmptyFields;
  checks.verificationContract = (snapshot.verification === undefined || plain(snapshot.verification))
    && Array.isArray(optional) && optional.every(field => nonempty(field) && Object.hasOwn(snapshot.formData, field))
    && optional.length === new Set(optional).size;
  if (!checks.verificationContract) return unavailable();
  checks.instanceId = nonempty(expectedInstanceId) && instance.processInstanceId === expectedInstanceId;
  checks.formTarget = nonempty(snapshot.target.formUuid) && instance.formUuid === snapshot.target.formUuid;
  checks.processTarget = nonempty(snapshot.target.processCode) && instance.processCode === snapshot.target.processCode;
  checks.originator = nonempty(snapshot.actor.userid) && plain(instance.originator)
    && instance.originator.userId === snapshot.actor.userid;
  checks.originatorCompany = nonempty(snapshot.actor.corp_id) && instance.originatorCorpId === snapshot.actor.corp_id;
  if (instance.appType !== undefined) checks.applicationTarget = instance.appType === snapshot.target.appType;
  const identityVerified = Object.values(checks).every(value => value === true);
  const identityMismatch = [
    [instance.processInstanceId, expectedInstanceId], [instance.formUuid, snapshot.target.formUuid],
    [instance.processCode, snapshot.target.processCode], [instance.originator?.userId, snapshot.actor.userid],
    [instance.originatorCorpId, snapshot.actor.corp_id], [instance.appType, snapshot.target.appType],
  ].some(([actual, expected]) => !absent(actual) && actual !== expected);
  const data = readData(instance);
  checks.formDataShape = data !== null;
  if (!data) return { ...unavailable(), ...(identityMismatch ? { status: 'mismatch', attachmentStatus: 'mismatch' } : {}) };
  const references = [];
  const fieldStatuses = {};
  const attachmentStatuses = [];
  for (const [field, expected] of Object.entries(snapshot.formData)) {
    const status = fieldComparison(field, data, expected, snapshot.target, optional.includes(field));
    const passed = status === 'verified';
    fieldStatuses['field:' + field] = status;
    if (/^attachmentField_/.test(field)) {
      attachmentStatuses.push(status);
      if (passed) references.push(...(unpack(data[field], 'array') || []));
    }
    checks['field:' + field] = passed;
  }
  const expectedAttachments=Object.entries(snapshot.formData)
    .filter(([field])=>/^attachmentField_/.test(field)).reduce((n,[,files])=>n+(Array.isArray(files)?files.length:0),0);
  checks.nativeAttachmentCount=references.length===expectedAttachments;
  checks.nativeAttachmentUnique=references.length===new Set(references.map(x=>x.fileUuid)).size;
  const allPassed = Object.values(checks).every(value => value === true);
  const attachmentStatus = !identityVerified ? identityMismatch ? 'mismatch' : 'unavailable'
    : attachmentStatuses.includes('mismatch') || !checks.nativeAttachmentUnique ? 'mismatch'
    : attachmentStatuses.includes('partial') ? 'unavailable'
    : checks.nativeAttachmentCount ? 'verified' : 'mismatch';
  const status = allPassed ? 'verified'
    : identityMismatch || Object.values(fieldStatuses).includes('mismatch') || attachmentStatus === 'mismatch' ? 'mismatch'
    : !identityVerified ? 'unavailable' : 'partial';
  return { checks, allPassed, status, attachmentStatus, fieldStatuses,
    ...(attachmentStatus === 'verified' ? {attachmentReferences:clone(references),
    ...(references.length===1?{attachmentReference:clone(references[0])}:{})} : {}) };
}

module.exports = { validateInstance };
