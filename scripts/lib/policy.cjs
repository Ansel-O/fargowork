'use strict';

const company = require('../../config/company.json');
const sources = require('../../config/sources.json');
const {check} = require('./common.cjs');
const workflowIndex = require('../../config/workflow-index.json');
const categories = new Set(['finance','leave','assets','business','hr']);
check(Array.isArray(workflowIndex) && workflowIndex.length > 0
  && workflowIndex.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && Object.keys(item).length === 2 && typeof item.key === 'string'
    && /^[a-z][a-z0-9_]*$/.test(item.key) && categories.has(item.category))
  && new Set(workflowIndex.map(item => item.key)).size === workflowIndex.length, 'WORKFLOW_INDEX_INVALID');
workflowIndex.forEach(Object.freeze);
Object.freeze(workflowIndex);
const workflowKeys = Object.freeze(workflowIndex.map(item => item.key));
const configs = Object.freeze(Object.fromEntries(workflowIndex.map(({key,category}) =>
  [key, require('../../config/workflows/' + category + '/' + key + '.json')])));

const APP = company.appType;
const CORP = company.corpId;
const ROOT = company.rootUrl;
const TENANT = company.tenantUrl;
const roster = Object.freeze({...company.roster});
const rosterAgentId = company.rosterAgentId;
const relatedSources = Object.freeze(sources.relatedProcesses);

const registry = Object.freeze(Object.fromEntries(workflowIndex.map(({key,category}) =>
  [key, require('../../workflows/' + category + '/' + key.replaceAll('_', '-') + '.cjs')])));

function workflowCategory(key) {
  check(Object.hasOwn(configs,key), 'WORKFLOW_NOT_ALLOWED');
  return workflowIndex.find(item => item.key === key).category;
}

function workflow(key) {
  check(Object.hasOwn(registry, key), 'WORKFLOW_NOT_ALLOWED');
  return registry[key];
}
function workflowConfig(key) {
  check(Object.hasOwn(configs, key), 'WORKFLOW_NOT_ALLOWED');
  return configs[key];
}
function workflowAvailability(key) {
  const configured = workflowConfig(key).availability;
  if (configured === undefined) return {status: 'active', canStart: true};
  check(configured && typeof configured === 'object' && !Array.isArray(configured)
    && ['active', 'disabled', 'migrated'].includes(configured.status), 'WORKFLOW_AVAILABILITY_INVALID');
  if (configured.status === 'active') return {status: 'active', canStart: true};
  check(typeof configured.message === 'string' && configured.message.trim()
    && configured.message.length <= 500 && !/[\x00-\x1f\x7f]/.test(configured.message),
  'WORKFLOW_AVAILABILITY_INVALID');
  return {status: configured.status, canStart: false, message: configured.message};
}
function workflowGroup(key) {
  const configured = workflowConfig(key).group;
  check(configured === undefined || configured === 'demo', 'WORKFLOW_GROUP_INVALID');
  return configured === 'demo' ? 'demo' : workflowAvailability(key).canStart ? 'formal' : 'moka';
}
function assertWorkflowStartAllowed(key) {
  const availability = workflowAvailability(key);
  if (!availability.canStart) {
    const error = new Error('WORKFLOW_UNAVAILABLE');
    Object.assign(error, {code: error.message, workflow: key, availability});
    throw error;
  }
}
function assertTargetStartAllowed(appType, formUuid, code) {
  const keys = appType === APP ? Object.keys(configs).filter(key => {
    const target = configs[key].target;
    return target?.formUuid === formUuid;
  }) : [];
  check(keys.length > 0 && (code === undefined || keys.some(key => configs[key].target.processCode === code)),
    'WORKFLOW_TARGET_NOT_ALLOWED');
  // A disabled target cannot be re-enabled through an alias of the same form.
  for (const key of keys) assertWorkflowStartAllowed(key);
}
function processCode(key) {
  const code = workflowConfig(key).target?.processCode;
  check(typeof code === 'string' && /^TPROC--[A-Za-z0-9_-]+$/.test(code), 'FIXED_PROCESS_CODE_UNAVAILABLE');
  return code;
}
function registeredTarget(appType, formUuid, code) {
  return appType === APP && Object.values(configs).some(config =>
    config.target?.formUuid === formUuid && config.target?.processCode === code);
}
function registeredForm(appType, formUuid) {
  return appType === APP && Object.values(configs).some(config => config.target?.formUuid === formUuid);
}
function attachmentAllowed(appType, formUuid, field) {
  return appType === APP && Object.keys(configs).some(key => {
    const config = effectiveWorkflowConfig(key);
    if (config.target?.formUuid !== formUuid || !workflowAvailability(key).canStart) return false;
    const attachment = config.attachments;
    return attachment?.field === field || attachment?.rowAttachmentField === field
      || Array.isArray(attachment?.fields) && attachment.fields.some(item => item?.field === field);
  });
}
function source(key) {
  check(Object.hasOwn(sources, key), 'SOURCE_NOT_ALLOWED');
  return sources[key];
}

function effectiveWorkflowConfig(key) {
  return workflowConfig(key);
}

for (const [key, module] of Object.entries(registry)) {
  const config = effectiveWorkflowConfig(key);
  check(module.key === key && module.formUuid === config.target.formUuid,
    'WORKFLOW_REGISTRATION_MISMATCH');
}

module.exports = {
  APP, CORP, ROOT, TENANT, roster, rosterAgentId, sources, relatedSources, workflowIndex, workflowKeys, configs, registry,
  workflow, workflowConfig, workflowCategory, workflowAvailability, workflowGroup, assertWorkflowStartAllowed, assertTargetStartAllowed,
  effectiveWorkflowConfig, processCode,
  registeredTarget, registeredForm, attachmentAllowed, source
};
