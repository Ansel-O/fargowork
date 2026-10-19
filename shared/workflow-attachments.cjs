'use strict';

// Pure mapping between a controlled workflow's attachment inputs, native form
// fields and visible preview. No network, file reads, identity or target lookup.
const path = require('node:path');
const {check} = require('../scripts/lib/common.cjs');
const clone = value => JSON.parse(JSON.stringify(value));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;
const reserved = new Set(['__proto__', 'prototype', 'constructor']);
const safeKey = value => typeof value === 'string' && value.length > 0 && value.length <= 160
  && !reserved.has(value) && !/[.\[\]\\/\x00-\x1f]/.test(value);
const inputKey = value => safeKey(value) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
const nativeField = (value, type) => typeof value === 'string'
  && new RegExp('^' + type + '_[A-Za-z0-9_]+$').test(value);

function mapping(prepared) {
  check(object(prepared), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  const field = prepared.attachmentField || null, spec = prepared.attachmentInputs || null;
  const topFields = prepared.attachmentFields || null;
  check(!field || nativeField(field, 'attachmentField'), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  check([field, spec, topFields].filter(Boolean).length <= 1, 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  check(!prepared.attachmentPreviewField || safeKey(prepared.attachmentPreviewField),
    'WORKFLOW_ATTACHMENT_PREVIEW_INVALID');
  if (spec) {
    check(object(spec) && inputKey(spec.rowArrayField) && inputKey(spec.rowFileInputField)
      && nativeField(spec.tableField, 'tableField') && nativeField(spec.rowAttachmentField, 'attachmentField'),
    'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
    check(safeKey(spec.previewRowsField) && safeKey(spec.previewFilesField), 'WORKFLOW_ATTACHMENT_PREVIEW_INVALID');
  }
  if (topFields) {
    check(Array.isArray(topFields) && topFields.length > 0 && topFields.every(item => object(item)
      && nativeField(item.field, 'attachmentField') && inputKey(item.inputField) && item.inputField !== 'attachments'
      && safeKey(item.previewField)), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
    for (const key of ['field', 'inputField', 'previewField']) {
      check(new Set(topFields.map(item => item[key])).size === topFields.length, 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
    }
  }
  return {field, spec, topFields};
}

function formRows(formData, spec) {
  const rows = formData?.[spec.tableField];
  check(Array.isArray(rows) && rows.every(object), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  return rows;
}

function attachmentGroupKey(item) {
  check(object(item) && nativeField(item.field, 'attachmentField')
    && (item.rowIndex === undefined || Number.isSafeInteger(item.rowIndex) && item.rowIndex >= 0),
  'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  return item.rowIndex === undefined ? item.field : `${item.field}:${item.rowIndex}`;
}

function attachmentJobs(input, files, prepared, isFieldAllowed) {
  const {field, spec, topFields} = mapping(prepared), jobs = [];
  check(object(input) && Array.isArray(files) && files.every(file => typeof file === 'string' && path.isAbsolute(file)),
    'ATTACHMENT_INPUT_INVALID');
  check(typeof isFieldAllowed === 'function', 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  if (field) {
    check(isFieldAllowed(field) === true, 'WORKFLOW_ATTACHMENT_NOT_SUPPORTED');
    jobs.push(...files.map(filePath => ({filePath, field})));
  } else check(files.length === 0, 'WORKFLOW_ATTACHMENT_NOT_SUPPORTED');
  for (const item of topFields || []) {
    check(isFieldAllowed(item.field) === true, 'WORKFLOW_ATTACHMENT_NOT_SUPPORTED');
    const selected = input[item.inputField] ?? [];
    check(Array.isArray(selected) && selected.every(file => typeof file === 'string' && path.isAbsolute(file)),
      'ATTACHMENT_INPUT_INVALID');
    jobs.push(...selected.map(filePath => ({filePath, field: item.field})));
  }
  if (spec) {
    check(isFieldAllowed(spec.rowAttachmentField) === true, 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
    const rows = input[spec.rowArrayField];
    check(Array.isArray(rows) && rows.every(object), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
    rows.forEach((row, rowIndex) => {
      const rowFiles = row[spec.rowFileInputField] ?? [];
      check(Array.isArray(rowFiles) && rowFiles.every(file => typeof file === 'string' && path.isAbsolute(file)),
        'ATTACHMENT_INPUT_INVALID');
      jobs.push(...rowFiles.map(filePath => ({filePath, field: spec.rowAttachmentField,
        tableField: spec.tableField, rowIndex, rowFileInputField: spec.rowFileInputField})));
    });
  }
  const seen = new Set();
  for (const job of jobs) {
    const key = JSON.stringify([attachmentGroupKey(job), path.resolve(job.filePath).toLowerCase()]);
    check(!seen.has(key), 'ATTACHMENT_DUPLICATE');
    seen.add(key);
  }
  return jobs;
}

function attachmentRuleGroups(input, prepared, jobs) {
  const {field, spec, topFields} = mapping(prepared), groups = [];
  check(Array.isArray(jobs), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  if (field) groups.push({field, inputField: 'attachments',
    jobs: jobs.filter(job => job.field === field && job.rowIndex === undefined)});
  for (const item of topFields || []) groups.push({field: item.field, inputField: item.inputField,
    previewField: item.previewField,
    jobs: jobs.filter(job => job.field === item.field && job.rowIndex === undefined && job.tableField === undefined)});
  if (spec) {
    const rows = formRows(prepared.formData, spec);
    check(Array.isArray(input?.[spec.rowArrayField]) && rows.length === input[spec.rowArrayField].length,
      'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
    rows.forEach((row, rowIndex) => groups.push({field: spec.rowAttachmentField, rowIndex,
      inputField: `${spec.rowArrayField}[${rowIndex}].${spec.rowFileInputField}`,
      jobs: jobs.filter(job => job.field === spec.rowAttachmentField && job.rowIndex === rowIndex
        && job.tableField === spec.tableField)}));
  }
  check(groups.reduce((count, group) => count + group.jobs.length, 0) === jobs.length,
    'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  return groups;
}

// Workflows compute conditional requirements from their business facts. They
// can only strengthen Schema.required for their declared native fields; they
// cannot supply expressions, change limits or address another attachment field.
function resolveAttachmentRules(prepared, schemaRulesForField) {
  const {field, spec, topFields} = mapping(prepared);
  const allowed = new Set([field, spec?.rowAttachmentField, ...(topFields || []).map(item => item.field)].filter(Boolean));
  const declared = prepared.attachmentRequirements === undefined ? {} : prepared.attachmentRequirements;
  check(object(declared) && Object.entries(declared).every(([key, value]) => allowed.has(key) && typeof value === 'boolean'),
    'WORKFLOW_ATTACHMENT_REQUIREMENTS_INVALID');
  check(typeof schemaRulesForField === 'function', 'WORKFLOW_ATTACHMENT_REQUIREMENTS_INVALID');
  const rulesByField = new Map();
  for (const id of allowed) {
    const schemaRules = schemaRulesForField(id);
    check(object(schemaRules) && typeof schemaRules.required === 'boolean', 'WORKFLOW_ATTACHMENT_REQUIREMENTS_INVALID');
    rulesByField.set(id, {...schemaRules, required:schemaRules.required || declared[id] === true});
  }
  return {requirements:{...declared}, rulesByField};
}

function attachmentCounts(items) {
  const counts = new Map();
  for (const item of items) {
    const key = attachmentGroupKey(item);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function bindUploadedAttachments(prepared, uploaded) {
  const {field, spec, topFields} = mapping(prepared);
  const formData = clone(prepared.formData), preview = clone(prepared.preview);
  check(object(formData) && object(preview) && Array.isArray(uploaded), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  // Explicit empty arrays freeze the selection too, so unexpected saved files
  // cannot silently pass readback when the employee selected no attachment.
  if (field) formData[field] = [];
  for (const item of topFields || []) formData[item.field] = [];
  const rows = spec ? formRows(formData, spec) : null;
  if (rows) for (const row of rows) row[spec.rowAttachmentField] = [];
  const seen = new Set();
  const attachments = uploaded.map(item => {
    const group = attachmentGroupKey(item);
    check(object(item.reference) && typeof item.reference.fileUuid === 'string'
      && item.reference.fileUuid.length > 0, 'ATTACHMENT_SNAPSHOT_MISMATCH');
    const duplicateKey = JSON.stringify([group, item.reference.fileUuid]);
    check(!seen.has(duplicateKey), 'ATTACHMENT_DUPLICATE_CONTENT');
    seen.add(duplicateKey);
    let destination;
    if (item.rowIndex !== undefined) {
      check(spec && item.field === spec.rowAttachmentField && item.tableField === spec.tableField
        && item.rowIndex < rows.length, 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
      destination = rows[item.rowIndex][spec.rowAttachmentField];
    } else {
      check((field === item.field || topFields?.some(group => group.field === item.field))
        && item.tableField === undefined, 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
      destination = formData[item.field];
    }
    destination.push(clone(item.reference));
    return {fileUuid: item.reference.fileUuid, name: item.reference.name, size: item.reference.size, sha256: item.sha256, field: item.field,
      ...(item.rowIndex === undefined ? {} : {rowIndex: item.rowIndex})};
  });
  if (field) {
    const listed = attachments.map(item => ({名称: item.name, 字节数: item.size}));
    preview[prepared.attachmentPreviewField || '附件'] = prepared.attachmentPreviewField
      ? listed.map(item => item.名称) : listed;
  }
  for (const item of topFields || []) {
    preview[item.previewField] = attachments.filter(file => file.field === item.field).map(file => file.name);
  }
  if (spec) {
    const previewRows = preview[spec.previewRowsField];
    check(Array.isArray(previewRows) && previewRows.length === rows.length && previewRows.every(object),
      'WORKFLOW_ATTACHMENT_PREVIEW_INVALID');
    previewRows.forEach((row, rowIndex) => {
      row[spec.previewFilesField] = attachments.filter(item => item.rowIndex === rowIndex).map(item => item.name);
    });
  }
  return {formData, preview, attachments};
}

function withoutAttachmentReferences(formData, attachmentField, attachmentInputs, attachmentFields) {
  const {field, spec, topFields} = mapping({attachmentField, attachmentInputs, attachmentFields});
  const value = clone(formData);
  check(object(value), 'WORKFLOW_ATTACHMENT_MAPPING_INVALID');
  // Normalize omitted/empty attachment fields before computing business facts.
  if (field) value[field] = null;
  for (const item of topFields || []) value[item.field] = null;
  if (spec) for (const row of formRows(value, spec)) row[spec.rowAttachmentField] = null;
  return value;
}

function referenceFor(snapshot, saved, item) {
  const {field, spec, topFields} = mapping(saved);
  attachmentGroupKey(item);
  let references;
  if (item.rowIndex !== undefined) {
    check(spec && spec.rowAttachmentField === item.field, 'ATTACHMENT_SNAPSHOT_MISMATCH');
    references = snapshot.formData[spec.tableField]?.[item.rowIndex]?.[spec.rowAttachmentField];
  } else {
    check((field === item.field || topFields?.some(group => group.field === item.field))
      && item.tableField === undefined, 'ATTACHMENT_SNAPSHOT_MISMATCH');
    references = snapshot.formData[item.field];
  }
  check(Array.isArray(references), 'ATTACHMENT_SNAPSHOT_MISMATCH');
  const matches = references.filter(ref => ref.name === item.name && Number(ref.size) === Number(item.size)
    && (item.fileUuid === undefined || ref.fileUuid === item.fileUuid));
  check(matches.length <= 1, 'ATTACHMENT_SNAPSHOT_MISMATCH');
  return matches[0];
}

module.exports = {attachmentJobs, attachmentGroupKey, attachmentRuleGroups, resolveAttachmentRules, attachmentCounts,
  bindUploadedAttachments, withoutAttachmentReferences, referenceFor};
